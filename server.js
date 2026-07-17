// Proxy Express para la API pública (sin login) de Mercadona.
// Llama directamente a Algolia (búsqueda y precios). Sin dependencia de binarios externos.

try { require('dotenv').config(); } catch {}
const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_WAREHOUSE = process.env.MERCADONA_WH || 'mad1';
const CRON_SECRET = process.env.CRON_SECRET || '';
const HISTORICO_PATH = path.join(__dirname, 'data', 'historico.json');

// Carga / guarda el JSON de histórico
function loadHistorico() {
  try { return JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8')); }
  catch { return { snapshots: {}, catalog: {} }; }
}
function saveHistorico(data) {
  fs.mkdirSync(path.dirname(HISTORICO_PATH), { recursive: true });
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(data));
}

// Itera TODOS los productos del índice Algolia usando /browse
async function algoliaBrowseAll(warehouse, lang = 'es') {
  const indexName = `${ALGOLIA_INDEX_BASE}_${warehouse}_${lang}`;
  const hostname = `${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net`;
  const allHits = [];

  // Intenta /browse (cursor-based, devuelve todos los registros)
  const tryBrowse = async (cursor) => {
    const body = cursor ? { cursor } : { hitsPerPage: 1000 };
    const { status, body: resp } = await httpsPost(
      hostname,
      `/1/indexes/${indexName}/browse`,
      body,
      { 'X-Algolia-Application-Id': ALGOLIA_APP_ID, 'X-Algolia-API-Key': ALGOLIA_API_KEY }
    );
    if (status !== 200) throw new Error(`browse ${status}`);
    allHits.push(...(resp.hits || []));
    if (resp.cursor) await tryBrowse(resp.cursor);
  };

  try {
    await tryBrowse(null);
    return allHits;
  } catch {
    // Fallback: búsquedas paginadas con query vacía (máx 1000 hits por Algolia)
    const { body: resp } = await httpsPost(
      hostname,
      `/1/indexes/${indexName}/query`,
      { query: '', hitsPerPage: 1000, page: 0 },
      { 'X-Algolia-Application-Id': ALGOLIA_APP_ID, 'X-Algolia-API-Key': ALGOLIA_API_KEY }
    );
    return resp.hits || [];
  }
}

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

// GET /api/cron/snapshot?token=SECRET  — llamar desde cron job diario
app.get('/api/cron/snapshot', async (req, res) => {
  if (CRON_SECRET && req.query.token !== CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const wh = resolveWarehouse(req);
  const today = new Date().toISOString().slice(0, 10);
  let hits;
  try {
    hits = await algoliaBrowseAll(wh);
  } catch (err) {
    return res.status(502).json({ error: 'Error obteniendo catálogo', detail: err.message });
  }

  const historico = loadHistorico();
  const snapshot = {};
  for (const h of hits) {
    const id = h.id;
    const price = parseFloat(h.price_instructions?.unit_price);
    if (!id || isNaN(price)) continue;
    snapshot[id] = price;
    if (!historico.catalog[id]) {
      historico.catalog[id] = {
        name: h.display_name,
        thumbnail: h.thumbnail || null,
        pricePerKg: parseFloat(h.price_instructions?.bulk_price) || null,
        unit: h.price_instructions?.reference_format || null,
      };
    }
  }
  historico.snapshots[today] = snapshot;

  // Mantener solo 365 días
  const dates = Object.keys(historico.snapshots).sort();
  if (dates.length > 365) {
    dates.slice(0, dates.length - 365).forEach(d => delete historico.snapshots[d]);
  }

  saveHistorico(historico);
  res.json({ date: today, products: Object.keys(snapshot).length, totalDays: Object.keys(historico.snapshots).length });
});

// GET /api/history?id=PRODUCT_ID  — historial de precio de un producto
app.get('/api/history', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const historico = loadHistorico();
  const meta = historico.catalog[id] || null;
  const history = [];
  for (const [date, snap] of Object.entries(historico.snapshots).sort()) {
    if (snap[id] !== undefined) history.push({ date, price: snap[id] });
  }
  if (!history.length) return res.json({ id, meta, history: [] });
  const prices = history.map(h => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  res.json({ id, meta, history, min, max, change: parseFloat((last - first).toFixed(2)), changePct: parseFloat(((last - first) / first * 100).toFixed(1)) });
});

// GET /api/history/basket  — inflación de una lista de IDs
app.post('/api/history/basket', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Falta array ids' });
  const historico = loadHistorico();
  const dates = Object.keys(historico.snapshots).sort();
  if (dates.length < 2) return res.json({ available: false });

  const today = dates[dates.length - 1];
  const ago30 = dates.find(d => d <= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) || dates[0];
  const ago90 = dates.find(d => d <= new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)) || dates[0];

  let total = 0, total30 = 0, total90 = 0, compared = 0;
  for (const id of ids) {
    const now = historico.snapshots[today]?.[id];
    const p30 = historico.snapshots[ago30]?.[id];
    const p90 = historico.snapshots[ago90]?.[id];
    if (now !== undefined) {
      total += now;
      if (p30 !== undefined) { total30 += p30; compared++; }
      if (p90 !== undefined) total90 += p90;
    }
  }
  res.json({
    available: true,
    today,
    total: parseFloat(total.toFixed(2)),
    vs30: ago30 !== today ? { date: ago30, total: parseFloat(total30.toFixed(2)), diff: parseFloat((total - total30).toFixed(2)), pct: parseFloat(((total - total30) / total30 * 100).toFixed(1)) } : null,
    vs90: ago90 !== today && ago90 !== ago30 ? { date: ago90, total: parseFloat(total90.toFixed(2)), diff: parseFloat((total - total90).toFixed(2)), pct: parseFloat(((total - total90) / total90 * 100).toFixed(1)) } : null,
    compared,
  });
});

// GET /api/product/:id  — ficha completa del producto (fotos, nutrición, alergias…)
app.get('/api/product/:id', async (req, res) => {
  const id = req.params.id;
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const { status, body } = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'tienda.mercadona.es',
        path: `/api/products/${id}/`,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Accept-Language': 'es', 'User-Agent': 'Mozilla/5.0' },
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: resp.statusCode, body: data }); } });
      });
      r.on('error', reject); r.end();
    });
    if (status !== 200) return res.status(status).json({ error: 'Producto no encontrado' });
    const p = body;
    res.json({
      id: p.id,
      name: p.display_name,
      brand: p.brand,
      legalName: p.details?.legal_name,
      description: p.details?.description,
      origin: p.origin,
      packaging: p.packaging,
      photos: (p.photos || []).map(ph => ph.regular || ph.thumbnail),
      thumbnail: p.thumbnail,
      price: parseFloat(p.price_instructions?.unit_price),
      pricePerKg: parseFloat(p.price_instructions?.bulk_price) || null,
      unit: p.price_instructions?.reference_format || null,
      unitSize: p.price_instructions?.unit_size,
      unitName: p.price_instructions?.unit_name,
      totalUnits: p.price_instructions?.total_units,
      taxPct: p.price_instructions?.tax_percentage,
      isPack: p.price_instructions?.is_pack,
      isNew: p.price_instructions?.is_new,
      priceDecreased: p.price_instructions?.price_decreased,
      allergens: p.nutrition_information?.allergens || null,
      ingredients: p.nutrition_information?.ingredients || null,
      storageInstructions: p.details?.storage_instructions || null,
      usageInstructions: p.details?.usage_instructions || null,
      mandatoryMentions: p.details?.mandatory_mentions || null,
      suppliers: (p.details?.suppliers || []).map(s => s.name),
      category: (() => {
        const cats = p.categories?.[0];
        if (!cats) return null;
        const sub = cats.categories?.[0];
        const subsub = sub?.categories?.[0];
        return [cats.name, sub?.name, subsub?.name].filter(Boolean).join(' › ');
      })(),
      shareUrl: p.share_url,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error obteniendo ficha del producto', detail: err.message });
  }
});

// GET /api/ranking/subidas?dias=7&top=10  — productos que más han subido
app.get('/api/ranking/subidas', (req, res) => {
  const dias = Math.min(parseInt(req.query.dias) || 7, 90);
  const top = Math.min(parseInt(req.query.top) || 10, 50);
  const historico = loadHistorico();
  const dates = Object.keys(historico.snapshots).sort();
  if (dates.length < 2) return res.json({ available: false, items: [] });

  const latest = dates[dates.length - 1];
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const baseDate = dates.find(d => d <= cutoff) || dates[0];
  const snapNow = historico.snapshots[latest];
  const snapBase = historico.snapshots[baseDate];

  const items = [];
  for (const [id, priceNow] of Object.entries(snapNow)) {
    const priceBase = snapBase[id];
    if (priceBase === undefined || priceBase <= 0) continue;
    const diff = priceNow - priceBase;
    const pct = (diff / priceBase) * 100;
    if (diff <= 0) continue;
    const meta = historico.catalog[id];
    if (!meta) continue;
    items.push({ id, name: meta.name, thumbnail: meta.thumbnail || null, priceNow, priceBase, diff: parseFloat(diff.toFixed(2)), pct: parseFloat(pct.toFixed(1)) });
  }
  items.sort((a, b) => b.pct - a.pct);
  res.json({ available: true, dateFrom: baseDate, dateTo: latest, dias, items: items.slice(0, top) });
});

// GET /api/ranking/bajadas?dias=7&top=10  — productos que más han bajado
app.get('/api/ranking/bajadas', (req, res) => {
  const dias = Math.min(parseInt(req.query.dias) || 7, 90);
  const top = Math.min(parseInt(req.query.top) || 10, 50);
  const historico = loadHistorico();
  const dates = Object.keys(historico.snapshots).sort();
  if (dates.length < 2) return res.json({ available: false, items: [] });

  const latest = dates[dates.length - 1];
  const cutoff = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const baseDate = dates.find(d => d <= cutoff) || dates[0];
  const snapNow = historico.snapshots[latest];
  const snapBase = historico.snapshots[baseDate];

  const items = [];
  for (const [id, priceNow] of Object.entries(snapNow)) {
    const priceBase = snapBase[id];
    if (priceBase === undefined || priceBase <= 0) continue;
    const diff = priceNow - priceBase;
    const pct = (diff / priceBase) * 100;
    if (diff >= 0) continue;
    const meta = historico.catalog[id];
    if (!meta) continue;
    items.push({ id, name: meta.name, thumbnail: meta.thumbnail || null, priceNow, priceBase, diff: parseFloat(diff.toFixed(2)), pct: parseFloat(pct.toFixed(1)) });
  }
  items.sort((a, b) => a.pct - b.pct);
  res.json({ available: true, dateFrom: baseDate, dateTo: latest, dias, items: items.slice(0, top) });
});

// Cesta de referencia para el índice de inflación (~30 productos básicos)
const CESTA_REFERENCIA = [
  'leche entera hacendado', 'pan molde', 'huevos camperos', 'aceite oliva virgen extra',
  'arroz redondo hacendado', 'pasta espagueti', 'tomate frito hacendado', 'atún claro aceite',
  'yogur natural hacendado', 'mantequilla hacendado', 'queso tierno', 'jamón cocido',
  'pechuga pollo', 'carne picada mixta', 'merluza congelada',
  'patatas', 'tomate', 'cebolla', 'zanahoria', 'manzana golden',
  'plátano', 'naranja', 'lechuga', 'brócoli congelado',
  'agua mineral hacendado', 'zumo naranja', 'cerveza hacendado',
  'papel higiénico', 'detergente ropa', 'champú',
];

// GET /api/inflacion  — índice de inflación Mercadona (cesta fija de 30 productos)
app.get('/api/inflacion', async (req, res) => {
  const historico = loadHistorico();
  const dates = Object.keys(historico.snapshots).sort();

  // Buscar los IDs de la cesta si no los tenemos ya
  const wh = req.query.wh || DEFAULT_WAREHOUSE;
  const cestaIds = {};
  try {
    await Promise.all(CESTA_REFERENCIA.map(term =>
      algoliaSearch(term, wh, 'es', 1).then(data => {
        const h = data?.hits?.[0];
        if (h) cestaIds[term] = { id: h.id, name: h.display_name, price: parseFloat(h.price_instructions?.unit_price) };
      }).catch(() => {})
    ));
  } catch { return res.status(502).json({ error: 'Error consultando precios actuales' }); }

  const totalActual = Object.values(cestaIds).reduce((s, p) => s + (p.price || 0), 0);

  const calcVs = (daysAgo) => {
    if (dates.length < 1) return null;
    const cutoff = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    const baseDate = dates.find(d => d <= cutoff);
    if (!baseDate) return null;
    const snap = historico.snapshots[baseDate];
    let total = 0, matched = 0;
    for (const { id, price } of Object.values(cestaIds)) {
      const old = snap[id];
      if (old !== undefined) { total += old; matched++; }
    }
    if (!matched) return null;
    const diff = totalActual - total;
    return { date: baseDate, total: parseFloat(total.toFixed(2)), diff: parseFloat(diff.toFixed(2)), pct: parseFloat((diff / total * 100).toFixed(1)), matched };
  };

  res.json({
    fecha: new Date().toISOString().slice(0, 10),
    productos: Object.values(cestaIds).length,
    totalActual: parseFloat(totalActual.toFixed(2)),
    vs30: calcVs(30),
    vs90: calcVs(90),
    vs365: calcVs(365),
    cesta: Object.values(cestaIds).map(p => ({ name: p.name, price: p.price })),
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', warehouse: DEFAULT_WAREHOUSE }));

app.listen(PORT, () => {
  console.log(`Mercadona proxy escuchando en el puerto ${PORT} (almacén por defecto: ${DEFAULT_WAREHOUSE})`);
});
