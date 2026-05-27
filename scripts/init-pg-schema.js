/**
 * Conecta a la DB Postgres definida por DATABASE_URL y aplica server/sql/schema.sql.
 * Es idempotente — si las tablas ya existen, las saltea (CREATE TABLE IF NOT EXISTS).
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://postgres.xxxx:password@aws-1-us-east-1.pooler.supabase.com:6543/postgres"
 *   node scripts/init-pg-schema.js
 *
 * Uso (CMD):
 *   set DATABASE_URL=postgresql://postgres.xxxx:password@...
 *   node scripts/init-pg-schema.js
 */
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL en el entorno.');
  process.exit(1);
}

const schemaPath = path.join(__dirname, '..', 'server', 'sql', 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

(async () => {
  const client = new Client({
    connectionString: DATABASE_URL,
    // Supabase pooler usa SSL pero certificate self-signed → desactivamos verify.
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('→ Conectando a Postgres…');
    await client.connect();
    const v = await client.query('SELECT version()');
    console.log('✅ Conectado:', v.rows[0].version.split(' on ')[0]);

    console.log(`\n→ Aplicando schema (${(sql.length / 1024).toFixed(1)} KB)…`);
    const t0 = Date.now();
    await client.query(sql);
    console.log(`✅ Schema aplicado en ${Date.now() - t0}ms`);

    // Contar tablas creadas
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    );
    console.log(`\n📋 Tablas en el esquema 'public' (${tables.rows.length}):`);
    tables.rows.forEach(r => console.log(`   • ${r.table_name}`));
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.detail) console.error('   detail:', err.detail);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
