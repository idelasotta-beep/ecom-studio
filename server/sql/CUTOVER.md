# Cutover a Postgres / Supabase

Cuando decidas dejar de usar el flat-file `ecommagic.json` y pasar a Postgres
en producción, este es el camino. Hoy (mayo 2026) la infraestructura ya está
preparada pero el código de las rutas sigue usando la versión síncrona del
flat-file.

## Estado actual (preparado, no activo)

- ✅ `server/sql/schema.sql` — schema completo con 29 tablas. Aplicado a Supabase.
- ✅ `server/lib/pg.js` — pool de conexiones reutilizable.
- ✅ `server/db-pg.js` — implementación equivalente a `server/db.js` con **interfaz async**.
- ✅ `scripts/migrate-json-to-pg.js` — vuelca el JSON actual a Postgres preservando IDs. Idempotente (ON CONFLICT DO UPDATE).
- ✅ Datos ya copiados una vez a Supabase (1479 filas en 28 tablas, mayo 2026) — sirven como mirror inicial.

## Qué falta para activarlo

Las ~22 rutas de `server/routes/` llaman a métodos como `users.one(...)` de
forma síncrona porque el JSON es sync. Postgres es async (es network I/O).
**Hay que añadir `await` en cada llamada y marcar el handler como `async`** —
~200-300 lugares en total. Trabajo mecánico, ~1-2 días.

## Pasos del cutover

### 1. Migrar la data más reciente (~1 min)

```cmd
set DATABASE_URL=postgresql://postgres.mggfytrgkhfdxmlhjecn:[YOUR-PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres
node scripts/migrate-json-to-pg.js
```

Idempotente: si las filas existen, las actualiza. Si son nuevas, las inserta.

### 2. Refactor de routes a async

Cada archivo en `server/routes/`:

- Marcar el handler como `async` si no lo es.
- Cambiar cada `users.one(...)` → `await users.one(...)`. Igual para `products.allForUser`, `product_ads.insert`, etc.
- Para todas las colecciones del módulo `db`.

Sugerencia para hacerlo eficiente:

```
grep -n "= users\." server/routes/*.js
grep -n "= products\." server/routes/*.js
grep -n " products\." server/routes/*.js
```

E ir agregando `await` en cada match. Cuidado especial con `forEach` (que
no soporta `await`) — cambiar a `for...of` cuando aplique.

### 3. Convertir `server/db.js` en router

Reemplazar el contenido actual de `server/db.js` por:

```js
module.exports = require('./db-pg');
```

(O un router condicional: si `DATABASE_URL` está seteado, exporta db-pg.js;
sino, exporta la versión JSON. Ver más abajo).

### 4. Setear DATABASE_URL en Railway

Settings → Variables → agregar:

```
DATABASE_URL=postgresql://postgres.mggfytrgkhfdxmlhjecn:[YOUR-PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres
```

### 5. Eliminar el seedAdmin de db.js viejo

`db-pg.js` no tiene seedAdmin porque asume que ya hay un admin migrado.
Si querés mantener el comportamiento de auto-crear admin si no hay
ninguno, replicar `seedAdmin()` en un script de bootstrap separado.

### 6. Push + redeploy

Cuando Railway termine de redesplegar, hace conexión al pool de Supabase.
El primer request demora ~200ms más (cold pool) pero después funciona
normal.

### 7. Verificar

- Login con tu cuenta.
- Crear un producto de prueba.
- Generar un copy / ángulo / etc.
- Verificar que todo se persiste en Supabase (dashboard de Supabase → Table Editor).

### 8. Setup cron de keep-alive (evita pause del Free tier)

Supabase pausa proyectos Free tras 7 días sin queries. Para evitarlo, un
endpoint `/api/health` que toca la DB resuelve. Crear cron en Railway:

```cmd
# Cron job en Railway que pega al /api/health cada 6 días
0 0 */6 * * curl -s https://ecom-studio-production.up.railway.app/api/health
```

O alternativa más simple: el health-check del propio Railway ya pega a `/api/health`
cada minuto. Si ese endpoint ejecuta una query trivial contra Postgres
(p.ej. `SELECT 1`), nunca se pausa el proyecto Supabase.

Actualizar `server/server.js`:

```js
app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try {
    const pg = require('./lib/pg');
    if (pg.isEnabled()) await pg.query('SELECT 1');
    dbOk = true;
  } catch (_) {}
  res.json({ status: 'ok', db: dbOk, time: new Date().toISOString() });
});
```

### 9. Setup backups manuales (Free no incluye backups automáticos)

Crear un script que corra `pg_dump` y guarde el output en el volume de Railway:

```cmd
# scripts/backup-pg.sh (en Railway con cron diario)
pg_dump $DATABASE_URL > /data/backups/pg-$(date +%Y%m%d).sql
# Retener últimos 14 días
find /data/backups -name 'pg-*.sql' -mtime +14 -delete
```

## Router condicional opcional (rollback-friendly)

Si querés poder volver al flat-file fácilmente, reemplazar `server/db.js` con:

```js
// Router: si DATABASE_URL existe, usa Postgres; sino, mantiene el flat-file.
if (process.env.DATABASE_URL) {
  module.exports = require('./db-pg');
} else {
  module.exports = require('./db-json'); // mover el contenido actual aquí
}
```

Luego mover el contenido actual de `db.js` a `db-json.js`. Permite hacer
cutover quitando solo `DATABASE_URL` de las env vars si algo sale mal.

## Cosas a no olvidar tras el cutover

1. **Rotar la database password de Supabase** (Settings → Database → Reset
   database password) — la actual quedó en el chat de Claude.
2. **Si querés también migrar Storage** (imágenes, PDFs, audios) a Supabase
   Storage en el futuro, ese trabajo es separado y queda para una Fase 2.
3. **El volume de Railway** sigue conteniendo todos los archivos. No tocar
   hasta confirmar que la app funciona contra Postgres por al menos 1-2
   semanas.

## Rollback de emergencia

Si tras el cutover algo crítico falla:

1. Sacar `DATABASE_URL` de Railway → Variables.
2. Si usaste el router condicional, la app vuelve al flat-file
   inmediatamente.
3. Si no usaste el router (cambiaste `db.js` directo), hacer un `git revert`
   del commit del cutover.
