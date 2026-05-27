/**
 * Cliente Postgres con la MISMA interfaz pública que server/db.js (flat-file).
 *
 * IMPORTANTE: los métodos acá son ASYNC (devuelven Promise) — incompatible
 * con el código actual de las routes (que asume sincronía del flat-file).
 * Para hacer cutover, hay que await en cada llamada de db.* en las routes.
 *
 * Hasta el cutover, este archivo NO se usa en runtime. El switch lo hace
 * server/db.js (router) según esté DATABASE_URL en el entorno.
 */
const pg = require('./lib/pg');

// ─────────────────────────────────────────────────────────────────
// Helpers genéricos
// ─────────────────────────────────────────────────────────────────

function buildWhere(filter, startIdx = 1) {
  const keys = Object.keys(filter || {});
  if (keys.length === 0) return { clause: '', values: [] };
  const parts = [];
  const values = [];
  let i = startIdx;
  for (const k of keys) {
    const v = filter[k];
    if (typeof v === 'string' && v.startsWith('%') && v.endsWith('%')) {
      parts.push(`${k} ILIKE $${i}`);
      values.push('%' + v.slice(1, -1).toLowerCase() + '%');
    } else {
      parts.push(`${k} = $${i}`);
      values.push(v);
    }
    i++;
  }
  return { clause: 'WHERE ' + parts.join(' AND '), values };
}

// Build INSERT statement from a plain object. Returns { sql, values }.
function buildInsert(table, data) {
  const keys = Object.keys(data);
  const cols = keys.join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map(k => data[k]);
  return {
    sql: `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
    values,
  };
}

// Build UPDATE statement from a plain object, scoped by WHERE.
function buildUpdate(table, data, whereFilter) {
  const dataKeys = Object.keys(data);
  if (dataKeys.length === 0) return null;
  const setParts = dataKeys.map((k, i) => `${k} = $${i + 1}`);
  const dataValues = dataKeys.map(k => data[k]);
  const { clause, values: whereValues } = buildWhere(whereFilter, dataKeys.length + 1);
  return {
    sql: `UPDATE ${table} SET ${setParts.join(', ')}, updated_at = NOW() ${clause} RETURNING *`,
    values: [...dataValues, ...whereValues],
  };
}

// ─────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────
const users = {
  async all(filter = {}) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM users ${clause} ORDER BY created_at DESC`, values);
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM users ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      first_name:   data.first_name,
      last_name:    data.last_name,
      email:        data.email,
      country:      data.country  || null,
      phone_prefix: data.phone_prefix || null,
      phone:        data.phone    || null,
      password:     data.password,
      role:         data.role     || 'user',
      plan:         data.plan     || 'trial',
      is_active:    1,
    };
    const { sql, values } = buildInsert('users', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, changes) {
    const built = buildUpdate('users', changes, { id });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id) {
    const { rowCount } = await pg.query(`DELETE FROM users WHERE id = $1`, [id]);
    return rowCount > 0;
  },
  async count(filter = {}) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM users ${clause}`, values);
    return Number(rows[0].c);
  },
  async page(filter = {}, { limit = 20, offset = 0 } = {}) {
    const { clause, values } = buildWhere(filter);
    const total = await this.count(filter);
    const { rows } = await pg.query(
      `SELECT * FROM users ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    return { rows, total };
  },
  async search(term, extraFilter = {}, { limit = 20, offset = 0 } = {}) {
    const t = '%' + String(term || '').toLowerCase() + '%';
    const extra = buildWhere(extraFilter, 2);
    const extraClauseInline = extra.clause ? extra.clause.replace(/^WHERE /, 'AND ') : '';
    const params = [t, ...extra.values];
    const totalRes = await pg.query(
      `SELECT COUNT(*) AS c FROM users
       WHERE (LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(email) LIKE $1)
       ${extraClauseInline}`,
      params
    );
    const total = Number(totalRes.rows[0].c);
    const { rows } = await pg.query(
      `SELECT * FROM users
       WHERE (LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(email) LIKE $1)
       ${extraClauseInline}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { rows, total };
  },
};

// ─────────────────────────────────────────────────────────────────
// USER SETTINGS (1:1)
// ─────────────────────────────────────────────────────────────────
const user_settings = {
  async get(userId) {
    const { rows } = await pg.query(`SELECT * FROM user_settings WHERE user_id = $1`, [userId]);
    return rows[0] || null;
  },
  async upsert(userId, changes) {
    const existing = await this.get(userId);
    if (existing) {
      const built = buildUpdate('user_settings', changes, { user_id: userId });
      if (built) await pg.query(built.sql, built.values);
    } else {
      const row = {
        user_id:        userId,
        claude_key:     null,
        gemini_key:     null,
        openai_key:     null,
        kieai_key:      null,
        elevenlabs_key: null,
        ...changes,
      };
      const { sql, values } = buildInsert('user_settings', row);
      await pg.query(sql, values);
    }
  },
};

// ─────────────────────────────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────────────────────────────
const products = {
  async allForUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM products WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM products ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id:     data.user_id,
      name:        data.name,
      description: data.description || null,
      image:       data.image || null,
    };
    const { sql, values } = buildInsert('products', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, userId, changes) {
    const built = buildUpdate('products', changes, { id, user_id: userId });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id, userId) {
    // ON DELETE CASCADE en el schema se encarga de las tablas hijas.
    const { rowCount } = await pg.query(
      `DELETE FROM products WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async researchCount(productId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM product_research WHERE product_id = $1`, [productId]);
    return Number(rows[0].c);
  },
  async descriptionCount(productId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM product_descriptions WHERE product_id = $1`, [productId]);
    return Number(rows[0].c);
  },
  async audioCount(productId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM product_audios WHERE product_id = $1`, [productId]);
    return Number(rows[0].c);
  },
  async pricingCount(productId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM product_pricings WHERE product_id = $1`, [productId]);
    return Number(rows[0].c);
  },
};

// ─────────────────────────────────────────────────────────────────
// Factory genérica para tablas hijas con (forProduct + insert + delete + one).
// La mayoría de las colecciones siguen el mismo patrón.
// ─────────────────────────────────────────────────────────────────
function makeChildCrud(table, allowedInsertCols) {
  return {
    async forProduct(productId) {
      const { rows } = await pg.query(
        `SELECT * FROM ${table} WHERE product_id = $1 ORDER BY created_at DESC`,
        [productId]
      );
      return rows;
    },
    async one(filter) {
      const { clause, values } = buildWhere(filter);
      const { rows } = await pg.query(`SELECT * FROM ${table} ${clause} LIMIT 1`, values);
      return rows[0] || null;
    },
    async insert(data) {
      const row = {};
      for (const col of allowedInsertCols) {
        row[col] = data[col] !== undefined ? data[col] : null;
      }
      const { sql, values } = buildInsert(table, row);
      const { rows } = await pg.query(sql, values);
      return { id: rows[0].id };
    },
    async delete(id, userId) {
      const { rowCount } = await pg.query(
        `DELETE FROM ${table} WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return rowCount > 0;
    },
  };
}

const product_research = makeChildCrud('product_research',
  ['product_id', 'user_id', 'title', 'content', 'model', 'provider']);

const product_angles = makeChildCrud('product_angles',
  ['product_id', 'user_id', 'content', 'model', 'provider']);

const product_ads = makeChildCrud('product_ads',
  ['product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'headline']);

const product_landings = makeChildCrud('product_landings',
  ['product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'category', 'headline']);

const product_mockups = makeChildCrud('product_mockups',
  ['product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'brand_name', 'brand_slogan']);

const product_logos = makeChildCrud('product_logos',
  ['product_id', 'user_id', 'image_path', 'prompt', 'size', 'template', 'brand_name', 'brand_slogan']);

const product_descriptions = makeChildCrud('product_descriptions',
  ['product_id', 'user_id', 'description', 'usage', 'technical_features', 'package_contents', 'model', 'provider']);

const product_audios = makeChildCrud('product_audios',
  ['product_id', 'user_id', 'script', 'voice_type', 'category', 'country', 'model', 'provider']);

const product_copys = makeChildCrud('product_copys',
  ['product_id', 'user_id', 'angle_ref', 'angle_content', 'length', 'content', 'model', 'provider']);

const product_testimonials = makeChildCrud('product_testimonials',
  ['product_id', 'user_id', 'contact_name', 'customer_name', 'tone', 'language', 'messages', 'model', 'provider', 'date']);

const product_voiceovers = makeChildCrud('product_voiceovers',
  ['user_id', 'product_id', 'source_type', 'source_script_id', 'angle_ref', 'angle_data',
   'text', 'voice_type', 'voice_id', 'voice_name', 'model_id', 'audio_path', 'audio_format',
   'original_filename', 'char_count', 'file_size_bytes']);

// ─────────────────────────────────────────────────────────────────
// PRICINGS — tiene update() además del CRUD básico
// ─────────────────────────────────────────────────────────────────
const product_pricings = {
  async forProduct(productId) {
    const { rows } = await pg.query(
      `SELECT * FROM product_pricings WHERE product_id = $1 ORDER BY COALESCE(updated_at, created_at) DESC`,
      [productId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM product_pricings ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      product_id: data.product_id,
      user_id:    data.user_id,
      name:       data.name   || 'Escenario sin nombre',
      inputs:     data.inputs || {},
    };
    const { sql, values } = buildInsert('product_pricings', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, userId, changes) {
    const built = buildUpdate('product_pricings', changes, { id, user_id: userId });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM product_pricings WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

// ─────────────────────────────────────────────────────────────────
// ASSEMBLED LANDINGS — tiene sequence_number autocalculado e insert returns row
// ─────────────────────────────────────────────────────────────────
const product_assembled_landings = {
  async forProduct(productId) {
    const { rows } = await pg.query(
      `SELECT * FROM product_assembled_landings WHERE product_id = $1 ORDER BY created_at DESC`,
      [productId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM product_assembled_landings ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    // sequence_number = count(rows del mismo producto) + 1
    const { rows: cntRows } = await pg.query(
      `SELECT COUNT(*)::int AS c FROM product_assembled_landings WHERE product_id = $1`,
      [data.product_id]
    );
    const seq = cntRows[0].c + 1;
    const row = {
      user_id:         data.user_id,
      product_id:      data.product_id,
      sequence_number: seq,
      sections:        Array.isArray(data.sections) ? JSON.stringify(data.sections) : '[]',
      elements:        Array.isArray(data.elements) ? JSON.stringify(data.elements) : '[]',
    };
    const { sql, values } = buildInsert('product_assembled_landings', row);
    const { rows } = await pg.query(sql, values);
    return rows[0];
  },
  async update(id, userId, changes) {
    const patch = {};
    if (changes.sections !== undefined) patch.sections = JSON.stringify(changes.sections);
    if (changes.elements !== undefined) patch.elements = JSON.stringify(changes.elements);
    if (Object.keys(patch).length === 0) return null;
    const built = buildUpdate('product_assembled_landings', patch, { id, user_id: userId });
    const { rows } = await pg.query(built.sql, built.values);
    return rows[0] || null;
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM product_assembled_landings WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

// ─────────────────────────────────────────────────────────────────
// EBOOKS — múltiples métodos especiales (updateById, markStaleAsFailed, etc.)
// ─────────────────────────────────────────────────────────────────
const EBOOK_COLS = [
  'user_id', 'product_id', 'status', 'title', 'subtitle', 'intro_content', 'conclusion_content',
  'angle_ref', 'angle_content', 'pages_target', 'text_model', 'text_provider', 'image_model',
  'text_model_id', 'image_model_id', 'angle_data', 'idea_data', 'chapters',
  'cover_image_path', 'back_cover_image_path', 'pdf_path', 'theme_color', 'progress', 'error',
];

const product_ebooks = {
  async forProduct(productId) {
    const { rows } = await pg.query(
      `SELECT * FROM product_ebooks WHERE product_id = $1 ORDER BY created_at DESC`,
      [productId]
    );
    return rows;
  },
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM product_ebooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM product_ebooks ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id:               data.user_id,
      product_id:            data.product_id,
      status:                data.status || 'generating',
      title:                 data.title || '',
      subtitle:              data.subtitle || '',
      intro_content:         data.intro_content || '',
      conclusion_content:    data.conclusion_content || '',
      angle_ref:             data.angle_ref || null,
      angle_content:         data.angle_content || null,
      pages_target:          data.pages_target || 20,
      text_model:            data.text_model || null,
      text_provider:         data.text_provider || null,
      image_model:           data.image_model || null,
      text_model_id:         data.text_model_id || null,
      image_model_id:        data.image_model_id || null,
      angle_data:            data.angle_data ? JSON.stringify(data.angle_data) : null,
      idea_data:             data.idea_data ? JSON.stringify(data.idea_data) : null,
      chapters:              JSON.stringify(Array.isArray(data.chapters) ? data.chapters : []),
      cover_image_path:      data.cover_image_path || null,
      back_cover_image_path: data.back_cover_image_path || null,
      pdf_path:              data.pdf_path || null,
      theme_color:           data.theme_color || '#2d8b6f',
      progress:              JSON.stringify(data.progress || { step: 'init', current: 0, total: 0, message: '' }),
      error:                 data.error || null,
    };
    const { sql, values } = buildInsert('product_ebooks', row);
    const { rows } = await pg.query(sql, values);
    return rows[0];
  },
  async update(id, userId, changes) {
    const patch = normalizeEbookPatch(changes);
    const built = buildUpdate('product_ebooks', patch, { id, user_id: userId });
    if (!built) return null;
    const { rows } = await pg.query(built.sql, built.values);
    return rows[0] || null;
  },
  async updateById(id, changes) {
    const patch = normalizeEbookPatch(changes);
    const built = buildUpdate('product_ebooks', patch, { id });
    if (!built) return null;
    const { rows } = await pg.query(built.sql, built.values);
    return rows[0] || null;
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM product_ebooks WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async markStaleAsFailed() {
    const { rowCount } = await pg.query(
      `UPDATE product_ebooks
         SET status = 'failed',
             error = 'Generación interrumpida por reinicio del servidor',
             updated_at = NOW()
       WHERE status = 'generating'`
    );
    return rowCount;
  },
};

function normalizeEbookPatch(changes) {
  const patch = { ...changes };
  // Los campos JSONB deben enviarse stringificados a pg cuando son objects/arrays.
  for (const k of ['angle_data', 'idea_data', 'chapters', 'progress']) {
    if (patch[k] !== undefined && patch[k] !== null && typeof patch[k] !== 'string') {
      patch[k] = JSON.stringify(patch[k]);
    }
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────
// SHOPIFY CONNECTIONS — upsert por (user_id, store_domain)
// ─────────────────────────────────────────────────────────────────
const shopify_connections = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM shopify_connections WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM shopify_connections ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async upsertByDomain(userId, data) {
    const existing = await this.one({ user_id: userId, store_domain: data.store_domain });
    if (existing) {
      const built = buildUpdate('shopify_connections', data, { id: existing.id });
      const { rows } = await pg.query(built.sql, built.values);
      return rows[0];
    }
    const row = {
      user_id:                 userId,
      store_domain:            null,
      client_id:               null,
      client_secret_encrypted: null,
      access_token:            null,
      access_token_expires_at: null,
      scope:                   null,
      store_name:              null,
      last_verified_at:        null,
      ...data,
    };
    const { sql, values } = buildInsert('shopify_connections', row);
    const { rows } = await pg.query(sql, values);
    return rows[0];
  },
  async updateById(id, userId, changes) {
    const built = buildUpdate('shopify_connections', changes, { id, user_id: userId });
    const { rows } = await pg.query(built.sql, built.values);
    return rows[0] || null;
  },
  async deleteById(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM shopify_connections WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

// ─────────────────────────────────────────────────────────────────
// TEXT-TO-IMAGE OUTPUTS
// ─────────────────────────────────────────────────────────────────
const text_to_image_outputs = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM text_to_image_outputs WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM text_to_image_outputs ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id:      data.user_id,
      image_path:   data.image_path,
      prompt:       data.prompt || '',
      model:        data.model || null,
      photos_count: data.photos_count || 0,
    };
    const { sql, values } = buildInsert('text_to_image_outputs', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM text_to_image_outputs WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

// ─────────────────────────────────────────────────────────────────
// AD TEMPLATES (admin-owned templates + globals)
// ─────────────────────────────────────────────────────────────────
const LANDING_CATEGORIES = [
  'Hero', 'Oferta', 'Antes/Después', 'Beneficios', 'Tabla Comparativa',
  'Prueba de Autoridad', 'Testimonios', 'Modo de Uso', 'Logística', 'Preguntas Frecuentes',
];

const ad_templates = {
  async all() {
    const { rows } = await pg.query(`SELECT * FROM ad_templates ORDER BY created_at DESC`);
    return rows;
  },
  async byKind(kind) {
    const { rows } = await pg.query(`SELECT * FROM ad_templates WHERE kind = $1`, [kind]);
    return rows;
  },
  async globalByKind(kind) {
    const { rows } = await pg.query(`SELECT * FROM ad_templates WHERE kind = $1 AND owner_id IS NULL`, [kind]);
    return rows;
  },
  async forUserByKind(userId, kind) {
    const { rows } = await pg.query(
      `SELECT * FROM ad_templates WHERE kind = $1 AND owner_id = $2`,
      [kind, userId]
    );
    return rows;
  },
  async visibleByKind(userId, kind) {
    const { rows } = await pg.query(
      `SELECT * FROM ad_templates WHERE kind = $1 AND (owner_id IS NULL OR owner_id = $2)`,
      [kind, userId]
    );
    return rows;
  },
  async one(id) {
    const { rows } = await pg.query(`SELECT * FROM ad_templates WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] || null;
  },
  async insert(data) {
    const VALID_KINDS = ['ad', 'landing', 'mockup', 'logo', 'authority'];
    const kind = VALID_KINDS.includes(data.kind) ? data.kind : 'ad';
    let category = null;
    if (kind === 'landing' && typeof data.category === 'string' && LANDING_CATEGORIES.includes(data.category)) {
      category = data.category;
    }
    const row = {
      name: data.name || null,
      image_path: data.image_path,
      kind,
      category,
      owner_id:   data.owner_id != null ? data.owner_id : null,
      created_by: data.created_by || null,
    };
    const { sql, values } = buildInsert('ad_templates', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, patch) {
    const allowed = {};
    if (typeof patch.name === 'string' && patch.name.trim()) allowed.name = patch.name.trim();
    if (['ad', 'landing', 'mockup', 'logo', 'authority'].includes(patch.kind)) allowed.kind = patch.kind;
    if (patch.category === null || patch.category === '') allowed.category = null;
    else if (typeof patch.category === 'string' && LANDING_CATEGORIES.includes(patch.category)) allowed.category = patch.category;
    if (allowed.kind === 'ad') allowed.category = null;
    if (Object.keys(allowed).length === 0) return false;
    const built = buildUpdate('ad_templates', allowed, { id });
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id) {
    const { rowCount } = await pg.query(`DELETE FROM ad_templates WHERE id = $1`, [id]);
    return rowCount > 0;
  },
  isUsableBy(template, userId) {
    if (!template) return false;
    return template.owner_id == null || template.owner_id == userId;
  },
};

// ─────────────────────────────────────────────────────────────────
// META SPY (searches / ads / folders / saved / competitors)
// ─────────────────────────────────────────────────────────────────
const meta_spy_searches = {
  async forUser(userId, limit = 100) {
    const { rows } = await pg.query(
      `SELECT * FROM meta_spy_searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM meta_spy_searches ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id:          data.user_id,
      query:            data.query             || '',
      country:          data.country           || 'all',
      ad_active:        data.ad_active         || 'all',
      media_type:       data.media_type        || 'all',
      days_active:      data.days_active       || 'all',
      active_ads_count: data.active_ads_count  || 'all',
      search_type:      data.search_type       || 'broad',
      max_results:      data.max_results       || 50,
      results_count:    data.results_count     || 0,
      duration_ms:      data.duration_ms       || 0,
    };
    const { sql, values } = buildInsert('meta_spy_searches', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async delete(id, userId) {
    // ON DELETE CASCADE en meta_spy_ads se encarga del bulk delete.
    const { rowCount } = await pg.query(
      `DELETE FROM meta_spy_searches WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async countLastHour(userId) {
    const { rows } = await pg.query(
      `SELECT COUNT(*) AS c FROM meta_spy_searches
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId]
    );
    return Number(rows[0].c);
  },
};

const meta_spy_ads = {
  async forSearch(searchId) {
    const { rows } = await pg.query(
      `SELECT * FROM meta_spy_ads WHERE search_id = $1 ORDER BY created_at ASC`,
      [searchId]
    );
    return rows;
  },
  async insertMany(rowsIn) {
    if (!rowsIn || !rowsIn.length) return [];
    const inserted = [];
    for (const data of rowsIn) {
      const row = {
        search_id:        data.search_id,
        user_id:          data.user_id,
        page_id:          data.page_id          || null,
        page_name:        data.page_name        || null,
        page_profile_pic: data.page_profile_pic || null,
        ad_text:          data.ad_text          || '',
        title:            data.title            || null,
        caption:          data.caption          || null,
        link_description: data.link_description || null,
        cta_text:         data.cta_text         || null,
        cta_type:         data.cta_type         || null,
        link_url:         data.link_url         || null,
        media_type:       data.media_type       || 'image',
        local_path:       data.local_path       || null,
        original_url:     data.original_url     || null,
        start_date:       data.start_date       || null,
        end_date:         data.end_date         || null,
        platforms:        JSON.stringify(data.platforms || []),
        display_format:   data.display_format   || null,
        ad_archive_id:    data.ad_archive_id    || null,
        collation_count:  data.collation_count  || null,
        categories:       JSON.stringify(data.categories || []),
        is_active:        data.is_active !== undefined ? data.is_active : true,
        snapshot_url:     data.snapshot_url     || null,
      };
      const { sql, values } = buildInsert('meta_spy_ads', row);
      const { rows } = await pg.query(sql, values);
      inserted.push(rows[0]);
    }
    return inserted;
  },
};

const meta_spy_folders = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM meta_spy_folders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM meta_spy_folders ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = { user_id: data.user_id, name: data.name || 'Carpeta sin nombre' };
    const { sql, values } = buildInsert('meta_spy_folders', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, userId, changes) {
    const built = buildUpdate('meta_spy_folders', changes, { id, user_id: userId });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id, userId) {
    // Mover saved a "Todos" antes de borrar la folder.
    await pg.query(
      `UPDATE meta_spy_saved SET folder_id = NULL WHERE folder_id = $1 AND user_id = $2`,
      [id, userId]
    );
    const { rowCount } = await pg.query(
      `DELETE FROM meta_spy_folders WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

const meta_spy_saved = {
  async forUser(userId, folderId) {
    const params = [userId];
    let clause = `WHERE user_id = $1`;
    if (folderId != null) {
      params.push(folderId);
      clause += ` AND folder_id = $2`;
    }
    const { rows } = await pg.query(
      `SELECT * FROM meta_spy_saved ${clause} ORDER BY saved_at DESC`,
      params
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM meta_spy_saved ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async countForUser(userId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM meta_spy_saved WHERE user_id = $1`, [userId]);
    return Number(rows[0].c);
  },
  async isSaved(userId, adId) {
    const { rows } = await pg.query(
      `SELECT 1 FROM meta_spy_saved WHERE user_id = $1 AND ad_id = $2 LIMIT 1`,
      [userId, adId]
    );
    return rows.length > 0;
  },
  async insert(data) {
    const { rows: ex } = await pg.query(
      `SELECT id FROM meta_spy_saved WHERE user_id = $1 AND ad_id = $2 LIMIT 1`,
      [data.user_id, data.ad_id]
    );
    if (ex[0]) {
      // Update folder y devolver "existed".
      await pg.query(`UPDATE meta_spy_saved SET folder_id = $1 WHERE id = $2`, [data.folder_id || null, ex[0].id]);
      return { id: ex[0].id, existed: true };
    }
    const row = {
      user_id:   data.user_id,
      ad_id:     data.ad_id,
      folder_id: data.folder_id || null,
    };
    const { sql, values } = buildInsert('meta_spy_saved', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM meta_spy_saved WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async deleteByAdId(userId, adId) {
    const { rowCount } = await pg.query(
      `DELETE FROM meta_spy_saved WHERE user_id = $1 AND ad_id = $2`,
      [userId, adId]
    );
    return rowCount > 0;
  },
  async move(id, userId, folderId) {
    const { rowCount } = await pg.query(
      `UPDATE meta_spy_saved SET folder_id = $1 WHERE id = $2 AND user_id = $3`,
      [folderId || null, id, userId]
    );
    return rowCount > 0;
  },
};

const meta_spy_competitors = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM meta_spy_competitors WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM meta_spy_competitors ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async countForUser(userId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM meta_spy_competitors WHERE user_id = $1`, [userId]);
    return Number(rows[0].c);
  },
  async insert(data) {
    const { rows: ex } = await pg.query(
      `SELECT id FROM meta_spy_competitors WHERE user_id = $1 AND page_id = $2 LIMIT 1`,
      [data.user_id, data.page_id]
    );
    if (ex[0]) return { id: ex[0].id, existed: true };
    const row = {
      user_id:        data.user_id,
      page_id:        data.page_id,
      page_name:      data.page_name      || null,
      last_ads_count: data.last_ads_count || 0,
      last_checked:   data.last_checked   || null,
    };
    const { sql, values } = buildInsert('meta_spy_competitors', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, userId, changes) {
    const built = buildUpdate('meta_spy_competitors', changes, { id, user_id: userId });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM meta_spy_competitors WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

// ─────────────────────────────────────────────────────────────────
// TIKTOK SPY
// ─────────────────────────────────────────────────────────────────
const tiktok_spy_searches = {
  async forUser(userId, limit = 50) {
    const { rows } = await pg.query(
      `SELECT * FROM tiktok_spy_searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM tiktok_spy_searches ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id:       data.user_id,
      query:         data.query,
      country:       data.country || null,
      results_count: data.results_count || 0,
    };
    const { sql, values } = buildInsert('tiktok_spy_searches', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM tiktok_spy_searches WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async countLastHour(userId) {
    const { rows } = await pg.query(
      `SELECT COUNT(*) AS c FROM tiktok_spy_searches
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
      [userId]
    );
    return Number(rows[0].c);
  },
};

const tiktok_spy_products = {
  async forSearch(searchId) {
    const { rows } = await pg.query(
      `SELECT * FROM tiktok_spy_products WHERE search_id = $1`,
      [searchId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM tiktok_spy_products ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insertBatch(records) {
    if (!records || !records.length) return [];
    const inserted = [];
    for (const data of records) {
      const row = {
        search_id:    data.search_id,
        external_id:  data.external_id || null,
        title:        data.title || '',
        price:        data.price != null ? data.price : null,
        currency:     data.currency || null,
        sold_count:   data.sold_count != null ? data.sold_count : null,
        rating:       data.rating != null ? data.rating : null,
        image_url:    data.image_url || null,
        shop_name:    data.shop_name || null,
        shop_id:      data.shop_id || null,
        product_url:  data.product_url || null,
        country:      data.country || null,
        raw:          data.raw ? JSON.stringify(data.raw).slice(0, 8000) : null,
      };
      const { sql, values } = buildInsert('tiktok_spy_products', row);
      const { rows } = await pg.query(sql, values);
      inserted.push(rows[0]);
    }
    return inserted;
  },
};

const tiktok_spy_folders = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM tiktok_spy_folders WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM tiktok_spy_folders ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async insert(data) {
    const row = {
      user_id: data.user_id,
      name:    data.name,
      color:   data.color || '#8b5cf6',
    };
    const { sql, values } = buildInsert('tiktok_spy_folders', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async update(id, userId, changes) {
    const built = buildUpdate('tiktok_spy_folders', changes, { id, user_id: userId });
    if (!built) return false;
    const { rowCount } = await pg.query(built.sql, built.values);
    return rowCount > 0;
  },
  async delete(id, userId) {
    await pg.query(
      `UPDATE tiktok_spy_saved SET folder_id = NULL WHERE user_id = $1 AND folder_id = $2`,
      [userId, id]
    );
    const { rowCount } = await pg.query(
      `DELETE FROM tiktok_spy_folders WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
};

const tiktok_spy_saved = {
  async forUser(userId) {
    const { rows } = await pg.query(
      `SELECT * FROM tiktok_spy_saved WHERE user_id = $1 ORDER BY saved_at DESC`,
      [userId]
    );
    return rows;
  },
  async one(filter) {
    const { clause, values } = buildWhere(filter);
    const { rows } = await pg.query(`SELECT * FROM tiktok_spy_saved ${clause} LIMIT 1`, values);
    return rows[0] || null;
  },
  async countByUser(userId) {
    const { rows } = await pg.query(`SELECT COUNT(*) AS c FROM tiktok_spy_saved WHERE user_id = $1`, [userId]);
    return Number(rows[0].c);
  },
  async isSaved(userId, productId) {
    const { rows } = await pg.query(
      `SELECT 1 FROM tiktok_spy_saved WHERE user_id = $1 AND product_id = $2 LIMIT 1`,
      [userId, productId]
    );
    return rows.length > 0;
  },
  async insert(data) {
    const { rows: ex } = await pg.query(
      `SELECT id FROM tiktok_spy_saved WHERE user_id = $1 AND product_id = $2 LIMIT 1`,
      [data.user_id, data.product_id]
    );
    if (ex[0]) {
      if (data.folder_id !== undefined) {
        await pg.query(`UPDATE tiktok_spy_saved SET folder_id = $1 WHERE id = $2`, [data.folder_id || null, ex[0].id]);
      }
      return { id: ex[0].id, already_saved: true };
    }
    const row = {
      user_id:    data.user_id,
      product_id: data.product_id,
      folder_id:  data.folder_id || null,
    };
    const { sql, values } = buildInsert('tiktok_spy_saved', row);
    const { rows } = await pg.query(sql, values);
    return { id: rows[0].id };
  },
  async delete(id, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM tiktok_spy_saved WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return rowCount > 0;
  },
  async deleteByProduct(productId, userId) {
    const { rowCount } = await pg.query(
      `DELETE FROM tiktok_spy_saved WHERE user_id = $1 AND product_id = $2`,
      [userId, productId]
    );
    return rowCount > 0;
  },
  async moveToFolder(id, userId, folderId) {
    const { rowCount } = await pg.query(
      `UPDATE tiktok_spy_saved SET folder_id = $1 WHERE id = $2 AND user_id = $3`,
      [folderId || null, id, userId]
    );
    return rowCount > 0;
  },
};

module.exports = {
  users, user_settings,
  products, product_research, product_angles, product_ads, product_landings,
  product_assembled_landings, product_descriptions, product_audios, product_pricings,
  product_copys, product_testimonials, product_mockups, product_logos, product_ebooks,
  product_voiceovers,
  text_to_image_outputs, shopify_connections, ad_templates, LANDING_CATEGORIES,
  meta_spy_searches, meta_spy_ads, meta_spy_folders, meta_spy_saved, meta_spy_competitors,
  tiktok_spy_searches, tiktok_spy_products, tiktok_spy_folders, tiktok_spy_saved,
};
