# CestaViva

Web que consulta precios reales de Mercadona en directo — sin login,
sin fricción, para cualquiera. Dos modos: búsqueda libre (añade
cualquier producto y compara precios) y un generador de menú semanal
por objetivo (equilibrado, alto en proteína, ligero, vegetariano,
familiar).

Construida como una capa de producto encima de
[`mercadona-cli`](https://github.com/ivorpad/mercadona-cli), de **Ivor
Padilla** — un CLI en Go pensado para agentes de IA (búsqueda, carrito,
checkout, con guardarraíles de gasto). Ese CLI está hecho para terminal;
esta web resuelve el problema de que un navegador no puede hablarle
directamente (bloqueo CORS + descubrimiento de credenciales de Algolia),
así que aquí un proxy Express ejecuta el CLI por detrás y expone dos
endpoints simples y públicos.

No toca ni reimplementa el código de Ivor — lo usa tal cual, como
dependencia.

## Qué hace

- **Búsqueda libre**: añade cualquier producto (o lista de la compra
  ya hecha) y ve su precio real al instante, con total acumulado.
- **Generador de menú**: elige objetivo, nivel de cocina y nº de
  personas, y recibe un menú semanal + lista de la compra con precios
  reales, en un ticket de recibo animado.
- Botón para copiar la lista y pegarla en la app de Mercadona.

## Qué NO hace (a propósito)

- No inicia sesión en Mercadona ni añade nada a ningún carrito real —
  eso requeriría custodiar credenciales de terceros, y esta capa
  evita ese problema por diseño.

---

# Backend — despliegue

Backend Express que evita el bloqueo CORS del navegador para consultar
precios reales de Mercadona (búsqueda y listas, sin login).

Envuelve el CLI oficial `@ivorpad/mercadona` — así que la lógica de
descubrir credenciales de Algolia, etc. la sigue llevando el CLI, no
este proxy (mucho más fiable que reimplementarla).

## Endpoints

- `GET /api/search?q=pechuga+pollo` → producto + precio (primer resultado)
- `POST /api/batch` con body `{ "terms": ["pollo", "huevos", "avena"] }`
  → lista de productos + precio total
- `GET /health` → comprobación rápida de que está vivo

## Desplegar en Hostinger (Node.js App)

1. En hPanel, ve a **Websites → [tu dominio] → Node.js** (o "Avanzado → Node.js").
2. Crea una nueva app Node.js:
   - Versión de Node: 18 o superior
   - Application root: la carpeta donde subas estos archivos (ej. `mercadona-proxy`)
   - Application startup file: `server.js`
3. Sube estos archivos (`server.js`, `package.json`) por el gestor de
   archivos de hPanel o por Git/FTP.
4. **Importante:** el CLI `mercadona` tiene que estar instalado en el
   servidor para que `execFile` lo encuentre. Desde la terminal SSH de
   Hostinger (si tu plan la incluye):
   ```
   npm install -g @ivorpad/mercadona
   ```
   Si tu plan no tiene SSH, instala el paquete como dependencia local
   añadiendo `"@ivorpad/mercadona": "latest"` a `package.json` y cambia
   en `server.js` la llamada `execFile('mercadona', ...)` por
   `execFile('npx', ['mercadona', ...])`.
5. En el panel de la app Node.js, pulsa **NPM Install** (instala `express`
   y `cors` de `package.json`).
6. Arranca/reinicia la app. hPanel te dará una URL tipo
   `https://tu-dominio.com` o un puerto interno con proxy — comprueba
   cuál usa tu plan concretamente en la pantalla de la app.
7. Prueba desde fuera:
   ```
   curl "https://tu-dominio.com/api/search?q=pollo"
   ```

## Ajustar el almacén (warehouse)

Por defecto usa `mad1` (Madrid). Si tu zona es otra, ponlo como variable
de entorno en la configuración de la app Node de hPanel:

```
MERCADONA_WH=tu_codigo_de_almacen
```

(Puedes averiguar tu código con `mercadona set-postal <tu_cp>` desde
cualquier terminal con el CLI instalado.)

## Uso desde el artifact / la web

```js
const res = await fetch('https://tu-dominio.com/api/search?q=pollo');
const data = await res.json();
```

Sin problemas de CORS, porque la petición ya no va del navegador a
Mercadona — va del navegador a TU dominio, y tu servidor habla con
Mercadona por detrás.
