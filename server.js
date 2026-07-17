// Proxy Express para la API pública (sin login) de Mercadona.
// El navegador no puede llamar a tienda.mercadona.es directamente (CORS),
// pero tu servidor sí puede — así que este backend hace la llamada por ti
// y se la devuelve a tu web/artifact con cabeceras CORS abiertas.

const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_WAREHOUSE = process.env.MERCADONA_WH || 'mad1';

// Usa el binario global si existe; si no, el local de node_modules
const CLI_BIN = (() => {
  const local = path.join(__dirname, 'node_modules', '.bin', 'mercadona');
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch { return 'mercadona'; }
})();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// wh puede venir del query param (preferencia del usuario) o del env
function resolveWarehouse(req) {
  const wh = req.query.wh || req.body?.wh;
  return (wh && /^[a-z0-9]{3,6}$/i.test(wh)) ? wh : DEFAULT_WAREHOUSE;
}

async function runCli(args, warehouse) {
  const { stdout } = await execFileAsync(CLI_BIN, [...args, '--json', '--wh', warehouse], {
    timeout: 15000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// GET /api/warehouse?cp=28001
// Resuelve un código postal español → código de almacén de Mercadona.
app.get('/api/warehouse', async (req, res) => {
  const cp = (req.query.cp || '').trim();
  if (!/^\d{5}$/.test(cp)) {
    return res.status(400).json({ error: 'Introduce un código postal válido de 5 dígitos' });
  }
  try {
    const { stdout, stderr } = await execFileAsync(CLI_BIN, ['set-postal', cp, '--json'], {
      timeout: 10000,
    });
    // El CLI puede devolver el JSON por stdout o por stderr según la versión
    const raw = stdout || stderr;
    const data = JSON.parse(raw);
    res.json({ postal_code: data.postal_code, warehouse: data.warehouse });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('outside of our working area') || msg.includes('404')) {
      return res.status(404).json({ error: 'Tu código postal está fuera de la zona de reparto de Mercadona' });
    }
    console.error(err);
    res.status(502).json({ error: 'No se pudo resolver el código postal', detail: msg });
  }
});

// GET /api/search?q=pechuga+pollo&wh=mad1
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });
  const wh = resolveWarehouse(req);
  try {
    const data = await runCli(['search', q, '--limit', '1'], wh);
    const first = data?.hits?.[0];
    if (!first) return res.status(404).json({ error: 'Sin resultados', query: q });
    res.json({
      query: q,
      warehouse: wh,
      id: first.id,
      name: first.display_name,
      price: parseFloat(first.price_instructions?.unit_price),
      pricePerKg: parseFloat(first.price_instructions?.bulk_price),
      unit: first.price_instructions?.reference_format,
      thumbnail: first.thumbnail,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando Mercadona (vía CLI)', detail: err.message });
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
    const tmpFile = path.join(os.tmpdir(), `batch-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, terms.join('\n'));
    const data = await runCli(['batch', '-f', tmpFile], wh);
    fs.unlinkSync(tmpFile);

    const items = (Array.isArray(data) ? data : []).map((entry) => {
      const first = entry?.hits?.[0];
      if (!first) return { term: entry.query, error: 'Sin resultados' };
      return {
        term: entry.query,
        id: first.id,
        name: first.display_name,
        price: parseFloat(first.price_instructions?.unit_price),
        pricePerKg: parseFloat(first.price_instructions?.bulk_price),
        unit: first.price_instructions?.reference_format,
      };
    });

    const total = items.reduce((sum, item) => sum + (item.price || 0), 0);
    res.json({ items, total: Math.round(total * 100) / 100, warehouse: wh });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando Mercadona (vía CLI)', detail: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', warehouse: DEFAULT_WAREHOUSE }));

app.listen(PORT, () => {
  console.log(`Mercadona proxy escuchando en el puerto ${PORT} (almacén por defecto: ${DEFAULT_WAREHOUSE})`);
});
