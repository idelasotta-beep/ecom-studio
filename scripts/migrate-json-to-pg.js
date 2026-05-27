/**
 * Migra el flat-file ecommagic.json a la DB Postgres apuntada por DATABASE_URL.
 *
 * Preserva los IDs originales (importante para no romper referencias guardadas
 * en archivos, URLs, etc. — ej. cover_image_path contiene el ebook_id).
 * Tras insertar, resetea cada SERIAL sequence al MAX(id)+1 para que los
 * próximos INSERT no choquen.
 *
 * Idempotente: usa ON CONFLICT (id) DO UPDATE para que reejecutar pise los
 * datos previos en lugar de fallar.
 *
 * Uso (CMD):
 *   set DATABASE_URL=postgresql://postgres.xxxx:password@...
 *   node scripts/migrate-json-to-pg.js
 *
 * Uso (PowerShell):
 *   $env:DATABASE_URL = "postgresql://..."
 *   node scripts/migrate-json-to-pg.js
 *
 * Flags opcionales:
 *   DRY_RUN=1   solo imprime cuántas filas se moverían, no escribe.
 *   JSON_PATH   sobrescribir la ruta del JSON (default: server/ecommagic.json).
 */
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL en el entorno.');
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN === '1';
const JSON_PATH = process.env.JSON_PATH || path.join(__dirname, '..', 'server', 'ecommagic.json');

// Columnas oficiales por tabla, en el orden a insertar. Las columnas no listadas
// son ignoradas (campo extra en el JSON que no existe en el schema Postgres).
// Las columnas marcadas como JSONB se serializan con JSON.stringify().
const TABLES = [
  { name: 'users',
    cols: ['id', 'first_name', 'last_name', 'email', 'country', 'phone_prefix', 'phone',
           'password', 'role', 'plan', 'credits', 'is_active', 'created_at', 'updated_at'] },
  { name: 'user_settings',
    pk: 'user_id',
    cols: ['user_id', 'claude_key', 'gemini_key', 'openai_key', 'kieai_key', 'apify_key',
           'elevenlabs_key', 'updated_at'] },
  { name: 'products',
    cols: ['id', 'user_id', 'name', 'description', 'image', 'created_at', 'updated_at'] },
  { name: 'product_research',
    cols: ['id', 'product_id', 'user_id', 'title', 'content', 'model', 'provider', 'created_at'] },
  { name: 'product_angles',
    cols: ['id', 'product_id', 'user_id', 'content', 'model', 'provider', 'created_at'] },
  { name: 'product_ads',
    cols: ['id', 'product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'headline', 'created_at'] },
  { name: 'product_landings',
    cols: ['id', 'product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'category', 'headline', 'created_at'] },
  { name: 'product_assembled_landings',
    cols: ['id', 'user_id', 'product_id', 'sequence_number', 'sections', 'elements', 'created_at', 'updated_at'],
    jsonb: ['sections', 'elements'] },
  { name: 'product_descriptions',
    cols: ['id', 'product_id', 'user_id', 'description', 'usage', 'technical_features', 'package_contents',
           'model', 'provider', 'created_at'] },
  { name: 'product_audios',
    cols: ['id', 'product_id', 'user_id', 'script', 'voice_type', 'category', 'country', 'model', 'provider', 'created_at'] },
  { name: 'product_voiceovers',
    cols: ['id', 'user_id', 'product_id', 'source_type', 'source_script_id', 'angle_ref', 'angle_data',
           'text', 'voice_type', 'voice_id', 'voice_name', 'model_id', 'audio_path', 'audio_format',
           'original_filename', 'char_count', 'file_size_bytes', 'created_at'],
    jsonb: ['angle_data'] },
  { name: 'product_pricings',
    cols: ['id', 'product_id', 'user_id', 'name', 'inputs', 'created_at', 'updated_at'],
    jsonb: ['inputs'] },
  { name: 'product_copys',
    cols: ['id', 'product_id', 'user_id', 'angle_ref', 'angle_content', 'length', 'content', 'model', 'provider', 'created_at'] },
  { name: 'product_testimonials',
    cols: ['id', 'product_id', 'user_id', 'contact_name', 'customer_name', 'tone', 'language', 'messages',
           'model', 'provider', 'date', 'created_at'],
    jsonb: ['messages'] },
  { name: 'product_mockups',
    cols: ['id', 'product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'brand_name', 'brand_slogan', 'created_at'] },
  { name: 'product_logos',
    cols: ['id', 'product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'brand_name', 'brand_slogan', 'created_at'] },
  { name: 'product_ebooks',
    cols: ['id', 'user_id', 'product_id', 'status', 'title', 'subtitle', 'intro_content', 'conclusion_content',
           'angle_ref', 'angle_content', 'pages_target', 'text_model', 'text_provider', 'image_model',
           'text_model_id', 'image_model_id', 'angle_data', 'idea_data', 'chapters',
           'cover_image_path', 'back_cover_image_path', 'pdf_path', 'theme_color', 'progress', 'error',
           'created_at', 'updated_at'],
    jsonb: ['angle_data', 'idea_data', 'chapters', 'progress'] },
  { name: 'text_to_image_outputs',
    cols: ['id', 'user_id', 'image_path', 'prompt', 'model', 'photos_count', 'created_at'] },
  { name: 'shopify_connections',
    cols: ['id', 'user_id', 'store_domain', 'client_id', 'client_secret_encrypted', 'access_token',
           'access_token_expires_at', 'scope', 'store_name', 'last_verified_at', 'created_at', 'updated_at'] },
  { name: 'ad_templates',
    cols: ['id', 'name', 'image_path', 'kind', 'category', 'owner_id', 'created_by', 'created_at'] },
  { name: 'meta_spy_searches',
    cols: ['id', 'user_id', 'query', 'country', 'ad_active', 'media_type', 'days_active', 'active_ads_count',
           'search_type', 'max_results', 'results_count', 'duration_ms', 'created_at'] },
  { name: 'meta_spy_ads',
    cols: ['id', 'search_id', 'user_id', 'page_id', 'page_name', 'page_profile_pic', 'ad_text', 'title',
           'caption', 'link_description', 'cta_text', 'cta_type', 'link_url', 'media_type', 'local_path',
           'original_url', 'start_date', 'end_date', 'platforms', 'display_format', 'ad_archive_id',
           'collation_count', 'categories', 'is_active', 'snapshot_url', 'created_at'],
    jsonb: ['platforms', 'categories'] },
  { name: 'meta_spy_folders',
    cols: ['id', 'user_id', 'name', 'created_at'] },
  { name: 'meta_spy_saved',
    cols: ['id', 'user_id', 'ad_id', 'folder_id', 'saved_at'] },
  { name: 'meta_spy_competitors',
    cols: ['id', 'user_id', 'page_id', 'page_name', 'last_ads_count', 'last_checked', 'created_at'] },
  { name: 'tiktok_spy_searches',
    cols: ['id', 'user_id', 'query', 'country', 'results_count', 'created_at'] },
  { name: 'tiktok_spy_products',
    cols: ['id', 'search_id', 'external_id', 'title', 'price', 'currency', 'sold_count', 'rating',
           'image_url', 'shop_name', 'shop_id', 'product_url', 'country', 'raw', 'created_at'] },
  { name: 'tiktok_spy_folders',
    cols: ['id', 'user_id', 'name', 'color', 'created_at'] },
  { name: 'tiktok_spy_saved',
    cols: ['id', 'user_id', 'product_id', 'folder_id', 'saved_at'] },
];

function serializeValue(value, isJsonb) {
  if (value === undefined || value === null) return null;
  if (isJsonb) return typeof value === 'string' ? value : JSON.stringify(value);
  return value;
}

// Aplica defaults para columnas que el schema marca NOT NULL pero el JSON
// puede tener vacías por inconsistencias históricas.
function applyDefaults(tableName, row) {
  if (tableName === 'ad_templates') {
    if (row.kind == null) row.kind = 'ad';
    if (!row.image_path) row.image_path = '';
  }
  if (tableName === 'product_voiceovers') {
    if (!row.source_type) row.source_type = 'generated';
  }
  if (tableName === 'product_ebooks') {
    if (!row.status) row.status = 'failed';
  }
  if (tableName === 'tiktok_spy_products' && row.raw) {
    // El flat-file truncaba `raw` a 8000 chars, lo que producía JSON corrupto.
    // Si no parsea, lo nullifyamos antes de insertar.
    try { JSON.parse(row.raw); }
    catch (_) { row.raw = null; }
  }
  return row;
}

async function migrate() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`No existe el JSON: ${JSON_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`📂 JSON cargado: ${(fs.statSync(JSON_PATH).size / 1024).toFixed(1)} KB`);

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('✅ Conectado a Postgres');

  const summary = [];
  let totalInserted = 0;
  let totalSkipped = 0;

  for (const t of TABLES) {
    const rows = raw[t.name] || [];
    if (!rows.length) {
      summary.push({ table: t.name, count: 0, inserted: 0 });
      continue;
    }

    const colList = t.cols.join(', ');
    const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(', ');
    const jsonbSet = new Set(t.jsonb || []);
    const pk = t.pk || 'id';

    const updateAssignments = t.cols
      .filter(c => c !== pk)
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');
    const sql = `
      INSERT INTO ${t.name} (${colList})
      VALUES (${placeholders})
      ON CONFLICT (${pk}) DO UPDATE SET ${updateAssignments}
    `;

    let inserted = 0;
    let skipped = 0;
    // Cada INSERT es su propio statement (auto-commit) para que un error en
    // una fila no aborte la transacción de las demás. Más lento pero robusto.
    for (const rawRow of rows) {
      const row = applyDefaults(t.name, { ...rawRow });
      const values = t.cols.map(c => serializeValue(row[c], jsonbSet.has(c)));
      if (DRY_RUN) {
        inserted++;
        continue;
      }
      try {
        await client.query(sql, values);
        inserted++;
      } catch (err) {
        skipped++;
        console.warn(`  ⚠ ${t.name}#${row[pk]}: ${err.message}`);
      }
    }

    // Resetear el sequence después de insertar IDs explícitos (solo SERIAL tables).
    if (!DRY_RUN && pk === 'id') {
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                         GREATEST(COALESCE((SELECT MAX(id) FROM ${t.name}), 0), 1),
                         true)`
        );
      } catch (err) {
        console.warn(`  ⚠ setval ${t.name}: ${err.message}`);
      }
    }

    summary.push({ table: t.name, count: rows.length, inserted, skipped });
    totalInserted += inserted;
    totalSkipped += skipped;
  }

  await client.end();

  console.log('\n=== Resumen ===');
  console.log('Tabla'.padEnd(35) + 'Encontrado'.padStart(12) + 'Insertado'.padStart(12) + 'Saltado'.padStart(10));
  summary.forEach(s => {
    console.log(s.table.padEnd(35) + String(s.count).padStart(12) + String(s.inserted).padStart(12) + String(s.skipped || 0).padStart(10));
  });
  console.log('TOTAL'.padEnd(35) + ''.padStart(12) + String(totalInserted).padStart(12) + String(totalSkipped).padStart(10));

  if (DRY_RUN) {
    console.log('\n🔵 DRY_RUN — nada se escribió. Ejecutá sin DRY_RUN=1 para migrar de verdad.');
  } else {
    console.log('\n✅ Migración completa.');
  }
}

migrate().catch(err => {
  console.error('❌ Migración falló:', err.message);
  if (err.detail) console.error('   detail:', err.detail);
  process.exit(1);
});
