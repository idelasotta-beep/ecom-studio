/**
 * Pool de conexiones Postgres compartido para toda la app.
 *
 * Soporta dos modos:
 *  - Si DATABASE_URL está definido, usa Postgres (Supabase u otro).
 *  - Si no, deja `pool = null` y el módulo db.js fallback al JSON local.
 *
 * El pool se inicializa una vez por proceso y se reutiliza en todas las queries.
 * SSL configurado con rejectUnauthorized:false porque el pooler de Supabase
 * presenta un certificado de proxy que no está en el store de Node.
 */
const { Pool } = require('pg');

let pool = null;

function init() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 10,                   // máx conexiones concurrentes — el pooler de Supabase ya hace pooling extra
    idleTimeoutMillis: 30_000, // cerrar conexiones idle > 30s
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    console.error('[pg] pool error:', err.message);
  });

  return pool;
}

function getPool() {
  if (!pool) pool = init();
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('Postgres no configurado (falta DATABASE_URL)');
  return p.query(text, params);
}

// Helper para escribir queries cortas: query y devolver primera fila o null.
async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

// Helper para escribir queries cortas: query y devolver el array de rows.
async function queryAll(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

// Transaction helper: pasa el client al callback y maneja BEGIN/COMMIT/ROLLBACK.
async function transaction(fn) {
  const p = getPool();
  if (!p) throw new Error('Postgres no configurado (falta DATABASE_URL)');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function isEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

module.exports = { init, getPool, query, queryOne, queryAll, transaction, isEnabled };
