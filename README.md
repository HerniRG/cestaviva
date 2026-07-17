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

## Instalación local

```bash
git clone https://github.com/HerniRG/cestaviva.git
cd cestaviva
npm install
npm install -g @ivorpad/mercadona   # requisito: el CLI debe estar en el PATH
npm start                            # arranca en http://localhost:3000
```

## Requisitos para desplegarlo (cualquier proveedor)

Esto es una app Node.js estándar (Express) — funciona en cualquier
hosting que soporte procesos Node de larga duración: Railway, Render,
Fly.io, un VPS propio, Hostinger con Node.js habilitado, etc. Solo
necesitas:

1. **Node.js 18+** disponible en el servidor.
2. **El CLI `mercadona` en el `PATH`** del proceso — instálalo con
   `npm install -g @ivorpad/mercadona` en el servidor (necesita acceso
   por terminal/SSH). Si tu proveedor no permite instalar paquetes
   globales, añade `"@ivorpad/mercadona": "latest"` a las
   dependencias de `package.json` y cambia en `server.js` la llamada
   `execFile('mercadona', ...)` por `execFile('npx', ['mercadona', ...])`.
3. **Comando de arranque:** `node server.js` (o `npm start`).
4. **Variable de entorno opcional** `MERCADONA_WH` para fijar tu
   almacén (por defecto `mad1`, Madrid). Averigua el tuyo con
   `mercadona set-postal <tu_código_postal>`.
5. Tras desplegar, comprueba que responde:
   ```bash
   curl "https://tu-dominio.com/api/search?q=pollo"
   ```

⚠️ Nota sobre IPs: el propio `mercadona-cli` recomienda ejecutar la
parte de búsqueda/lectura desde cualquier IP sin problema, pero evita
datacenters muy señalados si vas a escalar tráfico — revisa el README
de [mercadona-cli](https://github.com/ivorpad/mercadona-cli) para el
detalle completo.

```js
const res = await fetch('https://tu-dominio.com/api/search?q=pollo');
const data = await res.json();
```

Sin problemas de CORS, porque la petición ya no va del navegador a
Mercadona — va del navegador a TU dominio, y tu servidor habla con
Mercadona por detrás.
