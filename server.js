// Proxy Express para la API pública (sin login) de Mercadona.
// Llama directamente a Algolia (búsqueda) y a OpenRouter (generación de menú con IA).
// Sin dependencia de binarios externos — funciona en cualquier hosting Node.js.

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_WAREHOUSE = process.env.MERCADONA_WH || 'mad1';

// Credenciales públicas de solo lectura de Algolia (embebidas en la web de Mercadona)
const ALGOLIA_APP_ID = '7UZJKL1DJ0';
const ALGOLIA_API_KEY = '9d8f2e39e90df472b4f2e559a116fe17';
const ALGOLIA_INDEX_BASE = 'products_prod';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function resolveWarehouse(req) {
  const wh = req.query.wh || req.body?.wh;
  return (wh && /^[a-z0-9]{3,6}$/i.test(wh)) ? wh : DEFAULT_WAREHOUSE;
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible)',
        ...headers,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const url = new URL(res.headers.location);
        return resolve(httpsGet(url.hostname, url.pathname + url.search, headers));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function algoliaSearch(query, warehouse, lang = 'es', hitsPerPage = 5) {
  const indexName = `${ALGOLIA_INDEX_BASE}_${warehouse}_${lang}`;
  const hostname = `${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net`;
  const path = `/1/indexes/${indexName}/query`;
  const { status, body } = await httpsPost(hostname, path, { query, hitsPerPage }, {
    'X-Algolia-Application-Id': ALGOLIA_APP_ID,
    'X-Algolia-API-Key': ALGOLIA_API_KEY,
  });
  if (status !== 200) throw new Error(`Algolia ${status}: ${JSON.stringify(body)}`);
  return body;
}


// GET /api/search?q=leche&wh=mad1
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });
  const wh = resolveWarehouse(req);
  try {
    const data = await algoliaSearch(q, wh, 'es', 5);
    const hits = data?.hits || [];
    if (!hits.length) return res.status(404).json({ error: 'Sin resultados', query: q });
    res.json({
      query: q,
      warehouse: wh,
      results: hits.map(h => ({
        id: h.id,
        name: h.display_name,
        price: parseFloat(h.price_instructions?.unit_price),
        pricePerKg: parseFloat(h.price_instructions?.bulk_price),
        unit: h.price_instructions?.reference_format,
        thumbnail: h.thumbnail,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando Mercadona', detail: err.message });
  }
});

// POST /api/batch  body: { "terms": ["pollo", "salmón", ...], "wh": "mad1" }
app.post('/api/batch', async (req, res) => {
  const terms = req.body?.terms;
  if (!Array.isArray(terms) || terms.length === 0) {
    return res.status(400).json({ error: 'Falta un array "terms" en el body' });
  }
  const wh = resolveWarehouse(req);
  try {
    const results = await Promise.all(
      terms.map(term => algoliaSearch(term, wh, 'es', 1).then(data => {
        const first = data?.hits?.[0];
        if (!first) return { term, error: 'Sin resultados' };
        return {
          term,
          id: first.id,
          name: first.display_name,
          price: parseFloat(first.price_instructions?.unit_price),
          pricePerKg: parseFloat(first.price_instructions?.bulk_price),
          unit: first.price_instructions?.reference_format,
        };
      }).catch(err => ({ term, error: err.message })))
    );
    const total = results.reduce((sum, item) => sum + (item.price || 0), 0);
    res.json({ items: results, total: Math.round(total * 100) / 100, warehouse: wh });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando Mercadona', detail: err.message });
  }
});

// POST /api/menu  body: { goal, skill, people, exercise, wh }
app.post('/api/menu', async (req, res) => {
  const { goal = 'equilibrado', skill = '0', people = 1, exercise = 'moderado' } = req.body || {};
  const wh = resolveWarehouse(req);

  const goalLabels = { equilibrado: 'equilibrado', proteina: 'alto en proteína', ligero: 'ligero y bajo en calorías', vegetariano: 'vegetariano', familiar: 'familiar y rápido de cocinar' };
  const skillLabel = skill === '0' ? 'prefiere platos ya listos o muy sencillos (sin apenas cocinar)' : 'cocina sin problema y puede preparar recetas normales';
  const exerciseLabel = { sedentario: 'sedentaria (oficina, poco movimiento)', moderado: 'moderadamente activa (camina, algo de deporte)', deportista: 'muy activa (entrena 4+ días a la semana, necesita más calorías y proteína)' }[exercise] || 'moderada';

  const exerciseNote = exercise === 'deportista' ? ' Más proteína y carbohidratos.' : exercise === 'sedentario' ? ' Porciones más pequeñas.' : '';
  const peopleNote = people > 1 ? ` Para ${people} personas (multiplica qty).` : '';

  const prompt = `Nutricionista. Menú semanal ${goalLabels[goal] || goal}, actividad ${exercise}, ${skillLabel}.${exerciseNote}${peopleNote}

JSON COMPACTO (sin texto antes ni después):
{"days":[{"day":"Lun","meals":"<b>Des:</b> X · <b>Com:</b> X · <b>Cen:</b> X"},{"day":"Mar","meals":"..."},{"day":"Mié","meals":"..."},{"day":"Jue","meals":"..."},{"day":"Vie","meals":"..."},{"day":"Sáb","meals":"..."},{"day":"Dom","meals":"..."}],"ingredients":[{"term":"producto mercadona","qty":1}]}

Reglas: 12 ingredientes máx, qty=unidades/semana, nombres cortos en español (ej: "huevos","pechuga pollo","arroz","brócoli congelado"), sin aceite/sal/pimienta.`;

  let menuData;
  try {
    const orBody = {
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 4000,
    };
    const { status, body } = await httpsPost('openrouter.ai', '/api/v1/chat/completions', orBody, {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://cestaviva.hernan-rodriguez.com',
      'X-Title': 'CestaViva',
    });
    if (status !== 200) throw new Error(`OpenRouter ${status}: ${JSON.stringify(body)}`);
    const content = body?.choices?.[0]?.message?.content || '';
    // Busca el objeto JSON principal que empieza con {"days" o { "days" (ignora texto de razonamiento)
    const jsonMatch = content.match(/(\{[\s\n]*"days"[\s\S]*\})\s*$/);
    if (!jsonMatch) throw new Error('OpenRouter no devolvió JSON con "days"');
    menuData = JSON.parse(jsonMatch[1]);
    if (!menuData.days || !menuData.ingredients) throw new Error('JSON incompleto');
  } catch (err) {
    console.error('OpenRouter error:', err);
    return res.status(502).json({ error: 'Error generando el menú con IA', detail: err.message });
  }

  const peopleN = parseInt(people, 10) || 1;
  try {
    const priceResults = await Promise.all(
      menuData.ingredients.map(ing => {
        const qty = Math.max(1, Math.ceil((ing.qty || 1) * peopleN));
        return algoliaSearch(ing.term, wh, 'es', 1).then(data => {
          const first = data?.hits?.[0];
          if (!first) return { term: ing.term, qty, error: 'Sin resultados' };
          return {
            term: ing.term,
            qty,
            id: first.id,
            name: first.display_name,
            price: parseFloat(first.price_instructions?.unit_price),
          };
        }).catch(err => ({ term: ing.term, qty: Math.max(1, Math.ceil((ing.qty || 1) * peopleN)), error: err.message }));
      })
    );
    const total = priceResults.reduce((sum, it) => sum + (it.price ? it.price * it.qty : 0), 0);
    res.json({ days: menuData.days, items: priceResults, total: Math.round(total * 100) / 100, goal, people: peopleN });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando precios', detail: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', warehouse: DEFAULT_WAREHOUSE }));

app.listen(PORT, () => {
  console.log(`Mercadona proxy escuchando en el puerto ${PORT} (almacén por defecto: ${DEFAULT_WAREHOUSE})`);
});
