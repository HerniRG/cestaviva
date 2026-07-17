# CestaViva

Web que consulta precios reales de Mercadona en directo — sin login,
sin fricción, para cualquiera. Dos modos: búsqueda libre (añade
cualquier producto y compara precios) y un generador de menú semanal
por objetivo (equilibrado, alto en proteína, ligero, vegetariano,
familiar).

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

Llama directamente a la API de Algolia que usa la propia web de
Mercadona — credenciales públicas de solo lectura embebidas en su
JavaScript.

## Endpoints

- `GET /api/search?q=pechuga+pollo` → producto + precio (primer resultado)
- `GET /api/warehouse?cp=28001` → almacén asociado a un código postal
- `POST /api/batch` con body `{ "terms": ["pollo", "huevos", "avena"] }`
  → lista de productos + precio total
- `GET /health` → comprobación rápida de que está vivo

## Instalación local

```bash
git clone https://github.com/HerniRG/cestaviva.git
cd cestaviva
npm install
npm start   # arranca en http://localhost:3000
```

## Requisitos para desplegarlo (cualquier proveedor)

App Node.js estándar (Express) — funciona en cualquier hosting que
soporte procesos Node de larga duración: Railway, Render, Fly.io,
un VPS propio, Hostinger con Node.js habilitado, etc. Solo necesitas:

1. **Node.js 18+** disponible en el servidor.
2. **Comando de arranque:** `node server.js` (o `npm start`).
3. **Variable de entorno opcional** `MERCADONA_WH` para fijar tu
   almacén (por defecto `mad1`, Madrid).
4. Tras desplegar, comprueba que responde:
   ```bash
   curl "https://tu-dominio.com/api/search?q=pollo"
   ```

```js
const res = await fetch('https://tu-dominio.com/api/search?q=pollo');
const data = await res.json();
```

Sin problemas de CORS, porque la petición ya no va del navegador a
Mercadona — va del navegador a TU dominio, y tu servidor habla con
Mercadona por detrás.
