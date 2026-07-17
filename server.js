// Proxy Express para la API pública (sin login) de Mercadona.
// El navegador no puede llamar a tienda.mercadona.es directamente (CORS),
// pero tu servidor sí puede — así que este backend hace la llamada por ti
// y se la devuelve a tu web/artifact con cabeceras CORS abiertas.

const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WAREHOUSE = process.env.MERCADONA_WH || 'mad1'; // ajusta a tu almacén real

// Usa el binario global si existe; si no, el local de node_modules
const CLI_BIN = (() => {
  const local = path.join(__dirname, 'node_modules', '.bin', 'mercadona');
  try { require('fs').accessSync(local, require('fs').constants.X_OK); return local; } catch { return 'mercadona'; }
})();

// Permite que tu artifact publicado (o cualquier web) llame a este proxy.
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

async function runCli(args) {
  const { stdout } = await execFileAsync(CLI_BIN, [...args, '--json', '--wh', WAREHOUSE], {
    timeout: 15000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// GET /api/search?q=pechuga+pollo
// Ejecuta el CLI (server-to-server, sin CORS) y devuelve el primer resultado.
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  try {
    const data = await runCli(['search', q, '--limit', '1']);
    const first = data?.hits?.[0];
    if (!first) return res.status(404).json({ error: 'Sin resultados', query: q });
    res.json({
      query: q,
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

// POST /api/batch  body: { "terms": ["pollo", "salmón", ...] }
app.post('/api/batch', async (req, res) => {
  const terms = req.body?.terms;
  if (!Array.isArray(terms) || terms.length === 0) {
    return res.status(400).json({ error: 'Falta un array "terms" en el body' });
  }

  try {
    const fs = require('fs');
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), `batch-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, terms.join('\n'));

    const data = await runCli(['batch', '-f', tmpFile]);
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
    res.json({ items, total: Math.round(total * 100) / 100 });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error consultando Mercadona (vía CLI)', detail: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Mercadona proxy escuchando en el puerto ${PORT}`);
});
