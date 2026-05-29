# Estilo de español

> PROHIBIDO usar voseo argentino o conjugaciones rioplatenses en CUALQUIER
> texto: respuestas al usuario, comentarios de código, mensajes de commit,
> textos en la UI, prompts a la IA, copy de los productos, etc.
>
> NO usar: configurá, elegí, hacé, mirá, fijate, dale, andá, tenés, querés,
> sos, vení, mandame, decime, contame, avisame, probalo, esperá, dejame,
> cuidate, etc.
>
> SÍ usar español neutro / castellano estándar: configura, elige, haz,
> mira, fíjate, ve, tienes, quieres, eres, ven, mándame, dime, cuéntame,
> avísame, pruébalo, espera, déjame, cuídate.
>
> Esta regla aplica SIEMPRE, sin excepción, incluso si el usuario escribe
> en argentino. Responde en neutro.

# Entorno: Windows + PowerShell

> Todos los comandos de terminal DEBEN usar sintaxis de PowerShell.
> NO usar `//` para flags (usar `/`), NO usar `2>/dev/null` (usar `2>$null`),
> NO usar `/dev/null` (usar `$null`).

# El proyecto: Ecom Studio IA (a.k.a. "Mi Dropi")

App de escritorio single-user para dropshippers LATAM. Genera con IA todo el
material de marketing y producto: anuncios, landings, mockups, logos, copys,
descripciones, audios (voiceover + síntesis ElevenLabs), pricing, testimonios,
ebooks como lead magnet, e incluye un spy de Meta y TikTok para encontrar
productos ganadores. Integraciones con Shopify (sincronización de productos /
landings) y Dropi (fulfillment LATAM, ver skill `dropi-integration`).

**Arquitectura**: app Electron que embebe el server Express en el mismo
proceso. No hay servidor remoto — toda la data vive en el AppData del usuario.
La app antes corría como SaaS en Railway; el cutover a Electron se ejecutó en
las fases del 27-29 de mayo de 2026 (ver commits `bef9057` → `5e58554`).

## Stack

- **Shell desktop**: Electron 42 + electron-builder 26.
- **Backend embebido**: Node.js (el embebido de Electron, v24.15.0) + Express. Entry point [server/server.js](server/server.js).
- **Frontend**: HTML estático servido por el Express embebido. [dashboard.html](dashboard.html), [admin.html](admin.html), [login.html](login.html), [register.html](register.html). Tailwind CSS por CDN. Sin framework JS — vanilla. [index.html](index.html) es la landing pública vieja, no se usa en la app de escritorio pero queda en el repo.
- **DB activa**: JSON flat-file ([server/db.js](server/db.js)) — `ecommagic.json` con escritura atómica (tmp + rename + .bak fallback). Síncrono.
- **DB de cutover (no activa)**: Postgres / Supabase ([server/db-pg.js](server/db-pg.js), [server/lib/pg.js](server/lib/pg.js), [server/sql/schema.sql](server/sql/schema.sql)). Preparada cuando esto era SaaS; con la app desktop single-user, este plan quedó obsoleto. Se conserva en el repo solo como referencia.
- **Auth**: JWT (bcryptjs + jsonwebtoken). En desktop hay autologin del admin (ver "Autologin" más abajo).
- **PDFs**: Puppeteer con su Chromium descargado en `~/.cache/puppeteer/`. Usado por el generador de ebooks.
- **Imágenes**: sharp + optimizador propio ([server/lib/image-optim.js](server/lib/image-optim.js)).

## Cómo correr en desarrollo

```powershell
npm run electron
```

Esto invoca [scripts/run-electron.js](scripts/run-electron.js), que limpia la
variable de entorno `ELECTRON_RUN_AS_NODE` antes de spawnear Electron (algunos
IDEs como VS Code la setean, y si está activa Electron arranca como Node CLI
y rompe el main process).

Para correr solo el server (sin Electron), `npm start` sigue funcionando — útil
para probar endpoints con curl/Postman.

## Cómo empaquetar el portable .exe

```powershell
npm run electron:build
```

Salida: `dist\Ecom Studio IA-1.0.0-portable.exe` (~97 MB).

**Gotcha conocido — winCodeSign en Windows**: electron-builder descarga
`winCodeSign-2.6.0.7z` y al extraerlo falla porque contiene symlinks de macOS
(`libcrypto.dylib`, `libssl.dylib`) y Windows no permite crear symlinks sin
admin. El cache ya está poblado manualmente en
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` con
stubs vacíos para los dylibs. Si por alguna razón hay que regenerarlo:

```powershell
# Bajar y extraer ignorando los errores de symlink
$url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
Invoke-WebRequest -Uri $url -OutFile c:\tmp\wincs.7z
& "node_modules\7zip-bin\win\x64\7za.exe" x -snld -bd c:\tmp\wincs.7z -oc:\tmp\wincs\
# Crear stubs para los dylibs que fallaron
$lib = 'c:\tmp\wincs\darwin\10.12\lib'
New-Item -ItemType File "$lib\libcrypto.dylib"
New-Item -ItemType File "$lib\libssl.dylib"
# Mover al cache de electron-builder
Copy-Item c:\tmp\wincs "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0" -Recurse
```

Alternativa más limpia: activar Developer Mode en Windows (Settings → Update
& Security → For developers → Developer Mode = ON). Eso habilita la creación
de symlinks sin admin y electron-builder funciona sin el hack del cache.

## Estructura de carpetas

```
electron/
  main.js                # Main process: seed inicial, server embebido,
                         # autologin, BrowserWindow.
  preload.js             # Inyecta token+user en localStorage antes del documento.
server/
  server.js              # Entry point Express: middleware, static guard, rutas, listen.
  db.js                  # JSON flat-file DB (activa).
  db-pg.js               # Postgres equivalente (preparado, no activo — obsoleto).
  ecommagic.json         # Solo en dev local (en Electron vive en userData).
  lib/
    paths.js             # Resolución de ROOT: Electron userData → env → server/.
    pg.js                # Pool de Postgres (no activo).
    kie.js               # Caller unificado de Kie.ai (Claude / GPT-5 / Gemini).
    image-optim.js       # Compresión / conversión a WebP.
    ebook-pdf.js         # Render de PDFs de ebook con Puppeteer.
    ebook-template.js    # Plantilla HTML del ebook.
    shopify-crypto.js
    shopify-section-builder.js
  routes/                # ~22 routers Express, uno por feature.
  middleware/
  sql/
    schema.sql           # Schema Postgres (no activo).
    CUTOVER.md           # Plan de migración SaaS → Postgres (obsoleto).
scripts/
  run-electron.js        # Wrapper que limpia ELECTRON_RUN_AS_NODE y lanza Electron.
  test-native.js         # Diagnóstico: ¿sharp y puppeteer cargan en Electron?
  init-pg-schema.js      # Obsoleto.
  migrate-json-to-pg.js  # Obsoleto.
  dropi-test.js
  test-kie-models.js
  generate-kickoff-doc.js
dashboard.html  admin.html  login.html  register.html  index.html
package.json    package-lock.json
```

## Paths de media — regla crítica

NUNCA hardcodear `path.join(__dirname, 'ads')` o similares para directorios
de media o para `ecommagic.json`. SIEMPRE usar
[server/lib/paths.js](server/lib/paths.js):

```js
const { mediaDir, dbFile } = require('./lib/paths');
const dir = mediaDir('ebooks');
```

`paths.js` resuelve `ROOT` en este orden:
1. **Main process de Electron** → `app.getPath('userData')` (per-user, per-app), normalmente `C:\Users\<user>\AppData\Roaming\Ecom Studio IA\`.
2. **Variable `PERSISTENT_DATA_DIR`** → fallback histórico (era el Volume `/data` de Railway). Sigue funcionando si la variable está seteada.
3. **Fallback dev** → la propia carpeta `server/` del repo (útil para `npm start`).

## Autologin

[electron/main.js](electron/main.js) firma un JWT del admin con el
`JWT_SECRET` del server (efímero, regenerado por sesión) y lo pasa al
renderer vía `webPreferences.additionalArguments`.
[electron/preload.js](electron/preload.js) lee esos argumentos y escribe
`token` + `user` en `localStorage` antes de que cualquier script del
documento corra. Por eso `dashboard.html` se carga directo sin pantalla de
login.

Si en el futuro hay un escenario multi-user, basta con desactivar el bloque
"autologin" en `main.js` y cargar `login.html` como landing.

## URLs del API en el frontend

Siempre URLs relativas (`/api/...`). El server escucha en `127.0.0.1:47711`
en Electron. NO usar `http://localhost:3000/...` ni nada hardcodeado.

## Modelos de IA (Kie.ai)

El proyecto consume modelos de Kie.ai vía [server/lib/kie.js](server/lib/kie.js).
Soporta 3 familias con formatos distintos:

- **Claude** (`claude-*`) → endpoint `/claude/v1/messages`, formato Anthropic-nativo (system + messages).
- **GPT-5** (`gpt-5*`, incluye GPT-5.2) → `/{model}/v1/chat/completions` con `max_completion_tokens` y rol `developer` para el system.
- **Gemini y otros** → `/{model}/v1/chat/completions` estándar OpenAI.

Cuando agregues un modelo nuevo:
1. Verifica el slug exacto en la docs oficial de Kie.ai (los slugs cambian — ver commit `bc00678`).
2. Agrégalo a los registries de cada feature que lo expone (ads, copys, descriptions, etc.) y a sus selectores en el frontend.
3. Si es un modelo frontier (GPT-5.2, Claude Opus 4.x, etc.), promóvelo al grupo "frontier" en los selectores.
4. Prueba contra el endpoint real con [scripts/test-kie-models.js](scripts/test-kie-models.js).

## Audios

Síntesis de voz con ElevenLabs (API key configurable en Ajustes).
Endpoint en [server/routes/voiceovers.js](server/routes/voiceovers.js) y
[server/routes/audios.js](server/routes/audios.js). También permite subir
un archivo de audio externo asociado a un producto+ángulo.

## Ebooks (generador de lead magnets)

Pipeline en fases. Estado vive en la tabla `product_ebooks`. Al iniciar el
server, ebooks en estado intermedio (probable crash) se marcan como `failed`
para que la UI no los muestre girando para siempre — ver
[server/server.js](server/server.js#L8-L11).

Soporta:
- Reanudar ebooks fallidos (Fase 2.1)
- Regenerar capítulos individuales (Fase 2.2)
- Editar texto del capítulo inline (Fase 2.3)
- Editar título, subtítulo, introducción y conclusión (Fase 2.4)

## Spy (Meta + TikTok)

[server/routes/meta-spy.js](server/routes/meta-spy.js) y
[server/routes/tiktok-spy.js](server/routes/tiktok-spy.js). Carpetas, búsquedas,
guardados y competidores. **Google Ads Spy ya no está en el sidebar** (ver
commit `3adca2c`).

## Antes de hacer cambios grandes

- Si agregas un directorio de media nuevo, recuérdate registrarlo tanto en
  [server/server.js](server/server.js) (los `app.use('/x', express.static(mediaDir('x')))`)
  como añadirlo a la lista de prefijos permitidos en el static guard, y excluirlo
  del `BLOCKED_PATTERN`.
- Si agregas una tabla nueva al JSON DB, añádela a `DEFAULTS` y a `_seq` en
  [server/db.js](server/db.js).
- Si agregas una dependencia nativa nueva (algo que compile binarios .node),
  hay que (a) agregarla a `asarUnpack` en el `build` de [package.json](package.json)
  para que no quede atrapada dentro del asar, y (b) verificar con
  [scripts/test-native.js](scripts/test-native.js) que carga en el Node embebido
  de Electron.

# Recreación de Diseño Web

## Flujo de Trabajo

Cuando el usuario proporcione una imagen de referencia (captura de pantalla) y opcionalmente algunas clases CSS o notas de estilo:

1. **Generar** un único archivo `index.html` usando Tailwind CSS (vía CDN). Incluye todo el contenido en línea — sin archivos externos a menos que se solicite.
2. **Capturar** la página renderizada usando Puppeteer (`npx puppeteer screenshot index.html --fullpage` o equivalente). Si la página tiene secciones distintas, captúralas individualmente también.
3. **Comparar** tu captura de pantalla con la imagen de referencia. Busca discrepancias en:
   - Espaciado y relleno (medir en px)
   - Tamaños de fuente, grosores y alturas de línea
   - Colores (valores hex exactos)
   - Alineación y posicionamiento
   - Radios de borde, sombras y efectos
   - Comportamiento responsive
   - Tamaño y ubicación de imágenes/iconos
4. **Corregir** cada discrepancia encontrada. Edita el código HTML/Tailwind.
5. **Volver a capturar** y comparar de nuevo.
6. **Repetir** los pasos 3–5 hasta que el resultado esté dentro de ~2–3px de la referencia en todas partes.

NO te detengas después de una sola pasada. Realiza siempre al menos 2 rondas de comparación. Solo detente cuando el usuario lo diga o cuando no queden diferencias visibles.

## Valores Técnicos Predeterminados

- Usar Tailwind CSS vía CDN (`<script src="https://cdn.tailwindcss.com"></script>`)
- Usar imágenes de marcador de posición de `https://placehold.co/` cuando no se proporcionen imágenes de origen
- Diseño responsive mobile-first
- Un único archivo `index.html` a menos que el usuario solicite lo contrario

## Reglas

- No añadas características, secciones o contenido que no estén presentes en la imagen de referencia
- Iguala la referencia exactamente — no "mejores" el diseño
- Si el usuario proporciona clases CSS o tokens de estilo, úsalos literalmente
- Mantén el código limpio pero no lo abstraigas demasiado — las clases de Tailwind en línea están bien
- Al comparar capturas de pantalla, sé específico sobre lo que está mal (p. ej., "el encabezado es de 32px pero la referencia muestra ~24px", "el espacio entre tarjetas es de 16px pero debería ser de 24px")
