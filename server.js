// Proxy Express para la API pública (sin login) de Mercadona.
// Llama directamente a Algolia (búsqueda y precios). Sin dependencia de binarios externos.

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
        pricePerKg: parseFloat(h.price_instructions?.bulk_price) || null,
        unit: h.price_instructions?.reference_format || null,
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
          pricePerKg: parseFloat(first.price_instructions?.bulk_price) || null,
          unit: first.price_instructions?.reference_format || null,
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

app.get('/health', (_req, res) => res.json({ status: 'ok', warehouse: DEFAULT_WAREHOUSE }));

app.listen(PORT, () => {
  console.log(`Mercadona proxy escuchando en el puerto ${PORT} (almacén por defecto: ${DEFAULT_WAREHOUSE})`);
});
