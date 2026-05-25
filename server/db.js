/**
 * Pure-JS JSON database — no native compilation required.
 * Stores all data in ecommagic.json next to this file.
 */
const fs   = require('fs');
const path = require('path');
const { dbFile } = require('./lib/paths');

const DB_FILE = dbFile();

const DEFAULTS = {
  users: [], user_settings: [],
  products: [], product_research: [], product_angles: [], product_ads: [], product_landings: [], product_assembled_landings: [], product_descriptions: [], product_audios: [], product_pricings: [], product_copys: [], product_testimonials: [], product_mockups: [], product_logos: [], product_ebooks: [],
  text_to_image_outputs: [],
  shopify_connections: [],
  ad_templates: [],
  meta_spy_searches: [], meta_spy_ads: [], meta_spy_folders: [], meta_spy_saved: [], meta_spy_competitors: [],
  tiktok_spy_searches: [], tiktok_spy_products: [], tiktok_spy_folders: [], tiktok_spy_saved: [],
  _seq: { users: 0, products: 0, product_research: 0, product_angles: 0, product_ads: 0, product_landings: 0, product_assembled_landings: 0, product_descriptions: 0, product_audios: 0, product_pricings: 0, product_copys: 0, product_testimonials: 0, product_mockups: 0, product_logos: 0, product_ebooks: 0, text_to_image_outputs: 0, shopify_connections: 0, ad_templates: 0, meta_spy_searches: 0, meta_spy_ads: 0, meta_spy_folders: 0, meta_spy_saved: 0, meta_spy_competitors: 0, tiktok_spy_searches: 0, tiktok_spy_products: 0, tiktok_spy_folders: 0, tiktok_spy_saved: 0 },
};

function load() {
  if (!fs.existsSync(DB_FILE)) return JSON.parse(JSON.stringify(DEFAULTS));
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    // Corrupted file (partial write) — try the .bak fallback
    const BAK = DB_FILE + '.bak';
    if (fs.existsSync(BAK)) {
      try { db = JSON.parse(fs.readFileSync(BAK, 'utf8')); }
      catch { db = JSON.parse(JSON.stringify(DEFAULTS)); }
    } else {
      db = JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  // Forward-compat: ensure every table/seq exists
  Object.keys(DEFAULTS).forEach(k => { if (db[k] === undefined) db[k] = JSON.parse(JSON.stringify(DEFAULTS[k])); });
  Object.keys(DEFAULTS._seq).forEach(k => { if (!db._seq[k]) db._seq[k] = 0; });
  return db;
}

// Atomic write: backup current → write to .tmp → rename onto real file.
// Prevents partial-write corruption if the process is killed mid-write, and
// guarantees the file is never seen in an inconsistent state by another reader.
function save(data) {
  const tmp = DB_FILE + '.tmp';
  const bak = DB_FILE + '.bak';
  const json = JSON.stringify(data);
  // Keep a backup of the previous good state BEFORE overwriting
  if (fs.existsSync(DB_FILE)) {
    try { fs.copyFileSync(DB_FILE, bak); } catch (_) {}
  }
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_FILE);
}

function nextId(data, col) {
  data._seq[col] = (data._seq[col] || 0) + 1;
  return data._seq[col];
}

function now() { return new Date().toISOString(); }

// ── Filter helper ──────────────────────────────────────────────────
function matches(row, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (typeof v === 'string' && v.startsWith('%') && v.endsWith('%')) {
      return String(row[k] || '').toLowerCase().includes(v.slice(1,-1).toLowerCase());
    }
    return row[k] == v;  // loose equality handles 1/true, 0/false
  });
}

// ── Users ──────────────────────────────────────────────────────────
const users = {
  all(filter = {}) {
    return load().users.filter(r => matches(r, filter));
  },
  one(filter) {
    return load().users.find(r => matches(r, filter)) || null;
  },
  insert(data) {
    const db = load();
    const id = nextId(db, 'users');
    const row = {
      id,
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
      created_at:   now(),
      updated_at:   now(),
    };
    db.users.push(row);
    save(db);
    return { id };
  },
  update(id, changes) {
    const db = load();
    const idx = db.users.findIndex(u => u.id == id);
    if (idx === -1) return false;
    Object.assign(db.users[idx], changes, { updated_at: now() });
    save(db);
    return true;
  },
  delete(id) {
    const db = load();
    const before = db.users.length;
    db.users = db.users.filter(u => u.id != id);
    save(db);
    return db.users.length < before;
  },
  count(filter = {}) {
    return load().users.filter(r => matches(r, filter)).length;
  },
  page(filter = {}, { limit = 20, offset = 0 } = {}) {
    const all = load().users
      .filter(r => matches(r, filter))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { rows: all.slice(offset, offset + limit), total: all.length };
  },
  search(term, extraFilter = {}, { limit = 20, offset = 0 } = {}) {
    const t = term.toLowerCase();
    const all = load().users
      .filter(r =>
        matches(r, extraFilter) &&
        (r.first_name?.toLowerCase().includes(t) ||
         r.last_name?.toLowerCase().includes(t)  ||
         r.email?.toLowerCase().includes(t))
      )
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { rows: all.slice(offset, offset + limit), total: all.length };
  },
};

// ── Products ───────────────────────────────────────────────────────
const products = {
  allForUser(userId) {
    return load().products
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return load().products.find(r => matches(r, filter)) || null;
  },
  insert(data) {
    const db = load();
    const id = nextId(db, 'products');
    db.products.push({
      id,
      user_id:     data.user_id,
      name:        data.name,
      description: data.description || null,
      image:       data.image || null,
      created_at:  now(),
    });
    save(db);
    return { id };
  },
  update(id, userId, changes) {
    const db = load();
    const idx = db.products.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    Object.assign(db.products[idx], changes, { updated_at: now() });
    save(db);
    return true;
  },
  delete(id, userId) {
    const db = load();
    const before = db.products.length;
    db.products = db.products.filter(r => !(r.id == id && r.user_id == userId));
    db.product_research     = db.product_research.filter(r => r.product_id != id);
    db.product_angles       = (db.product_angles       || []).filter(r => r.product_id != id);
    db.product_ads          = (db.product_ads          || []).filter(r => r.product_id != id);
    db.product_landings     = (db.product_landings     || []).filter(r => r.product_id != id);
    db.product_copys        = (db.product_copys        || []).filter(r => r.product_id != id);
    db.product_testimonials = (db.product_testimonials || []).filter(r => r.product_id != id);
    db.product_descriptions = (db.product_descriptions || []).filter(r => r.product_id != id);
    db.product_audios       = (db.product_audios       || []).filter(r => r.product_id != id);
    db.product_pricings     = (db.product_pricings     || []).filter(r => r.product_id != id);
    db.product_mockups      = (db.product_mockups      || []).filter(r => r.product_id != id);
    db.product_logos        = (db.product_logos        || []).filter(r => r.product_id != id);
    db.product_ebooks       = (db.product_ebooks       || []).filter(r => r.product_id != id);
    save(db);
    return db.products.length < before;
  },
  researchCount(productId) {
    return load().product_research.filter(r => r.product_id == productId).length;
  },
  descriptionCount(productId) {
    return (load().product_descriptions || []).filter(r => r.product_id == productId).length;
  },
  audioCount(productId) {
    return (load().product_audios || []).filter(r => r.product_id == productId).length;
  },
  pricingCount(productId) {
    return (load().product_pricings || []).filter(r => r.product_id == productId).length;
  },
};

// ── Product Research ───────────────────────────────────────────────
const product_research = {
  forProduct(productId) {
    return load().product_research
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    const id = nextId(db, 'product_research');
    db.product_research.push({ id, product_id: data.product_id, user_id: data.user_id, title: data.title, content: data.content, model: data.model || null, provider: data.provider || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    const before = db.product_research.length;
    db.product_research = db.product_research.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_research.length < before;
  },
};

// ── Product Angles ─────────────────────────────────────────────────
const product_angles = {
  forProduct(productId) {
    const db = load();
    return (db.product_angles || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_angles) db.product_angles = [];
    const id = nextId(db, 'product_angles');
    db.product_angles.push({ id, product_id: data.product_id, user_id: data.user_id, content: data.content, model: data.model || null, provider: data.provider || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_angles) db.product_angles = [];
    const before = db.product_angles.length;
    db.product_angles = db.product_angles.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_angles.length < before;
  },
};

// ── Product Ads ────────────────────────────────────────────────────
const product_ads = {
  forProduct(productId) {
    return (load().product_ads || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_ads) db.product_ads = [];
    const id = nextId(db, 'product_ads');
    db.product_ads.push({ id, product_id: data.product_id, user_id: data.user_id, image_path: data.image_path, prompt: data.prompt || null, size: data.size || null, template: data.template || null, headline: data.headline || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_ads) db.product_ads = [];
    const before = db.product_ads.length;
    db.product_ads = db.product_ads.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_ads.length < before;
  },
  one(filter) {
    return (load().product_ads || []).find(r => Object.entries(filter).every(([k,v]) => r[k] == v)) || null;
  },
};

// ── Product Landings (mirrors Product Ads structure) ──────────────
const product_landings = {
  forProduct(productId) {
    return (load().product_landings || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_landings) db.product_landings = [];
    const id = nextId(db, 'product_landings');
    db.product_landings.push({ id, product_id: data.product_id, user_id: data.user_id, image_path: data.image_path, prompt: data.prompt || null, size: data.size || null, template: data.template || null, category: data.category || null, headline: data.headline || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_landings) db.product_landings = [];
    const before = db.product_landings.length;
    db.product_landings = db.product_landings.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_landings.length < before;
  },
  one(filter) {
    return (load().product_landings || []).find(r => Object.entries(filter).every(([k,v]) => r[k] == v)) || null;
  },
};

// ── Product Assembled Landings (composed from selected landings) ──
// Schema:
//   id, user_id, product_id, sequence_number (per-product, used for "Landing #N"),
//   sections: [{ id, source_ad_id }]  — ordered list of section instances
//   elements: [{ id, type, after_section_id, config }]  — inserted UI elements (Bundle, CTA, etc.)
//   created_at, updated_at
const product_assembled_landings = {
  forProduct(productId) {
    return (load().product_assembled_landings || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return (load().product_assembled_landings || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.product_assembled_landings) db.product_assembled_landings = [];
    const id = nextId(db, 'product_assembled_landings');
    // Per-product sequence number (Landing #1, #2, #3 within the product)
    const seq = db.product_assembled_landings.filter(r => r.product_id == data.product_id).length + 1;
    const row = {
      id,
      user_id:         data.user_id,
      product_id:      data.product_id,
      sequence_number: seq,
      sections:        Array.isArray(data.sections) ? data.sections : [],
      elements:        Array.isArray(data.elements) ? data.elements : [],
      created_at:      now(),
      updated_at:      now(),
    };
    db.product_assembled_landings.push(row);
    save(db);
    return row;
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.product_assembled_landings) db.product_assembled_landings = [];
    const idx = db.product_assembled_landings.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return null;
    const allowed = ['sections', 'elements'];
    for (const k of allowed) if (changes[k] !== undefined) db.product_assembled_landings[idx][k] = changes[k];
    db.product_assembled_landings[idx].updated_at = now();
    save(db);
    return db.product_assembled_landings[idx];
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_assembled_landings) db.product_assembled_landings = [];
    const before = db.product_assembled_landings.length;
    db.product_assembled_landings = db.product_assembled_landings.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_assembled_landings.length < before;
  },
};

// ── Product Mockups (product staging / packaging mockups) ─────────
const product_mockups = {
  forProduct(productId) {
    return (load().product_mockups || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_mockups) db.product_mockups = [];
    const id = nextId(db, 'product_mockups');
    db.product_mockups.push({ id, product_id: data.product_id, user_id: data.user_id, image_path: data.image_path, prompt: data.prompt || null, size: data.size || null, template: data.template || null, brand_name: data.brand_name || null, brand_slogan: data.brand_slogan || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_mockups) db.product_mockups = [];
    const before = db.product_mockups.length;
    db.product_mockups = db.product_mockups.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_mockups.length < before;
  },
  one(filter) {
    return (load().product_mockups || []).find(r => Object.entries(filter).every(([k,v]) => r[k] == v)) || null;
  },
};

// ── Product Logos (brand logo designs) ────────────────────────────
const product_logos = {
  forProduct(productId) {
    return (load().product_logos || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_logos) db.product_logos = [];
    const id = nextId(db, 'product_logos');
    db.product_logos.push({ id, product_id: data.product_id, user_id: data.user_id, image_path: data.image_path, prompt: data.prompt || null, size: data.size || null, template: data.template || null, brand_name: data.brand_name || null, brand_slogan: data.brand_slogan || null, created_at: now() });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_logos) db.product_logos = [];
    const before = db.product_logos.length;
    db.product_logos = db.product_logos.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_logos.length < before;
  },
  one(filter) {
    return (load().product_logos || []).find(r => Object.entries(filter).every(([k,v]) => r[k] == v)) || null;
  },
};

// ── Product Ebooks (lead-magnet PDFs generated from angles) ───────
// Schema:
//   id, user_id, product_id, status ('generating'|'ready'|'failed'),
//   title, subtitle, intro_content, conclusion_content,
//   angle_ref, angle_content (snapshot), pages_target,
//   text_model, text_provider, image_model,
//   chapters: [{ id, num, title, content, image_path }],
//   cover_image_path, back_cover_image_path,
//   pdf_path, theme_color,
//   progress: { step, current, total, message },
//   error,
//   created_at, updated_at
const product_ebooks = {
  forProduct(productId) {
    return (load().product_ebooks || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  forUser(userId) {
    return (load().product_ebooks || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return (load().product_ebooks || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.product_ebooks) db.product_ebooks = [];
    const id = nextId(db, 'product_ebooks');
    const t = now();
    const row = {
      id,
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
      chapters:              Array.isArray(data.chapters) ? data.chapters : [],
      cover_image_path:      data.cover_image_path || null,
      back_cover_image_path: data.back_cover_image_path || null,
      pdf_path:              data.pdf_path || null,
      theme_color:           data.theme_color || '#2d8b6f',
      progress:              data.progress || { step: 'init', current: 0, total: 0, message: '' },
      error:                 data.error || null,
      created_at:            t,
      updated_at:            t,
    };
    db.product_ebooks.push(row);
    save(db);
    return row;
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.product_ebooks) db.product_ebooks = [];
    const idx = db.product_ebooks.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return null;
    Object.assign(db.product_ebooks[idx], changes, { updated_at: now() });
    save(db);
    return db.product_ebooks[idx];
  },
  // Quick partial update for the async generation job (avoids needing user_id scope).
  updateById(id, changes) {
    const db = load();
    if (!db.product_ebooks) db.product_ebooks = [];
    const idx = db.product_ebooks.findIndex(r => r.id == id);
    if (idx === -1) return null;
    Object.assign(db.product_ebooks[idx], changes, { updated_at: now() });
    save(db);
    return db.product_ebooks[idx];
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_ebooks) db.product_ebooks = [];
    const before = db.product_ebooks.length;
    db.product_ebooks = db.product_ebooks.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_ebooks.length < before;
  },
  // Recovery on server restart: any ebook left mid-generation should be marked failed.
  markStaleAsFailed() {
    const db = load();
    if (!db.product_ebooks) return 0;
    let count = 0;
    db.product_ebooks.forEach(r => {
      if (r.status === 'generating') {
        r.status = 'failed';
        r.error = 'Generación interrumpida por reinicio del servidor';
        r.updated_at = now();
        count++;
      }
    });
    if (count > 0) save(db);
    return count;
  },
};

// ── Shopify connections (one-to-many per user — user may connect several stores) ──
const shopify_connections = {
  // Return all connections for the user, oldest first (stable display order).
  forUser(userId) {
    return (load().shopify_connections || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  },
  // Lookup a specific connection. `filter` accepts { id, user_id, store_domain }.
  one(filter) {
    return (load().shopify_connections || []).find(r =>
      Object.entries(filter).every(([k, v]) => r[k] == v)
    ) || null;
  },
  // Upsert by (user_id, store_domain) — if a connection already exists for that exact domain
  // refresh its credentials/tokens; otherwise insert a brand-new row.
  upsertByDomain(userId, data) {
    const db = load();
    if (!db.shopify_connections) db.shopify_connections = [];
    const existing = db.shopify_connections.find(r => r.user_id == userId && r.store_domain === data.store_domain);
    if (existing) {
      Object.assign(existing, data, { updated_at: now() });
      save(db);
      return existing;
    }
    const id = nextId(db, 'shopify_connections');
    const row = {
      id,
      user_id: userId,
      store_domain: null,
      client_id: null,
      client_secret_encrypted: null,
      access_token: null,
      access_token_expires_at: null,
      scope: null,
      store_name: null,
      last_verified_at: null,
      ...data,
      created_at: now(),
      updated_at: now(),
    };
    db.shopify_connections.push(row);
    save(db);
    return row;
  },
  // Update a specific connection (by id + user scope) — used to refresh tokens.
  updateById(id, userId, data) {
    const db = load();
    const idx = db.shopify_connections.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return null;
    Object.assign(db.shopify_connections[idx], data, { updated_at: now() });
    save(db);
    return db.shopify_connections[idx];
  },
  // Delete a specific connection by id + user scope.
  deleteById(id, userId) {
    const db = load();
    if (!db.shopify_connections) db.shopify_connections = [];
    const before = db.shopify_connections.length;
    db.shopify_connections = db.shopify_connections.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.shopify_connections.length < before;
  },
};

// ── Text-to-Image outputs (standalone tool — not tied to any product) ──
const text_to_image_outputs = {
  forUser(userId) {
    return (load().text_to_image_outputs || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.text_to_image_outputs) db.text_to_image_outputs = [];
    const id = nextId(db, 'text_to_image_outputs');
    db.text_to_image_outputs.push({
      id,
      user_id:      data.user_id,
      image_path:   data.image_path,
      prompt:       data.prompt || '',
      model:        data.model || null,
      photos_count: data.photos_count || 0,
      created_at:   now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.text_to_image_outputs) db.text_to_image_outputs = [];
    const before = db.text_to_image_outputs.length;
    db.text_to_image_outputs = db.text_to_image_outputs.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.text_to_image_outputs.length < before;
  },
  one(filter) {
    return (load().text_to_image_outputs || []).find(r => Object.entries(filter).every(([k,v]) => r[k] == v)) || null;
  },
};

// ── Product Testimonials (WhatsApp-style conversation scripts) ─────
const product_testimonials = {
  forProduct(productId) {
    return (load().product_testimonials || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_testimonials) db.product_testimonials = [];
    const id = nextId(db, 'product_testimonials');
    db.product_testimonials.push({
      id,
      product_id:    data.product_id,
      user_id:       data.user_id,
      contact_name:  data.contact_name || null,
      customer_name: data.customer_name || null,
      tone:          data.tone || 'casual',
      language:      data.language || 'es',
      messages:      data.messages || [],   // [{role:'customer'|'support', text, time}]
      model:         data.model || null,
      provider:      data.provider || null,
      date:          data.date || null,     // YYYY-MM-DD for the chat day-divider
      created_at:    now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_testimonials) db.product_testimonials = [];
    const before = db.product_testimonials.length;
    db.product_testimonials = db.product_testimonials.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_testimonials.length < before;
  },
};

// ── Product Copys (Meta Ads copy text) ─────────────────────────────
const product_copys = {
  forProduct(productId) {
    return (load().product_copys || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  insert(data) {
    const db = load();
    if (!db.product_copys) db.product_copys = [];
    const id = nextId(db, 'product_copys');
    db.product_copys.push({
      id,
      product_id:    data.product_id,
      user_id:       data.user_id,
      angle_ref:     data.angle_ref || null,      // human-readable angle title used
      angle_content: data.angle_content || null,  // snapshot of angle content
      length:        data.length || 'medium',     // 'short' | 'medium' | 'long'
      content:       data.content,
      model:         data.model || null,
      provider:      data.provider || null,
      created_at:    now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_copys) db.product_copys = [];
    const before = db.product_copys.length;
    db.product_copys = db.product_copys.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_copys.length < before;
  },
};

// ── Product Descriptions (LucidSales-style) ───────────────────────
const product_descriptions = {
  forProduct(productId) {
    return (load().product_descriptions || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return (load().product_descriptions || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.product_descriptions) db.product_descriptions = [];
    const id = nextId(db, 'product_descriptions');
    db.product_descriptions.push({
      id,
      product_id:           data.product_id,
      user_id:              data.user_id,
      description:          data.description          || '',
      usage:                data.usage                || '',
      technical_features:   data.technical_features   || '',
      package_contents:     data.package_contents     || '',
      model:                data.model    || null,
      provider:             data.provider || null,
      created_at:           now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_descriptions) db.product_descriptions = [];
    const before = db.product_descriptions.length;
    db.product_descriptions = db.product_descriptions.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_descriptions.length < before;
  },
};

// ── Product Audios (WhatsApp voice-note scripts) ──────────────────
const product_audios = {
  forProduct(productId) {
    return (load().product_audios || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return (load().product_audios || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.product_audios) db.product_audios = [];
    const id = nextId(db, 'product_audios');
    db.product_audios.push({
      id,
      product_id: data.product_id,
      user_id:    data.user_id,
      script:     data.script     || '',
      voice_type: data.voice_type || null,
      category:   data.category   || null,
      country:    data.country    || 'cl',
      model:      data.model      || null,
      provider:   data.provider   || null,
      created_at: now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_audios) db.product_audios = [];
    const before = db.product_audios.length;
    db.product_audios = db.product_audios.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_audios.length < before;
  },
};

// ── Product Pricings (rentabilidad scenarios) ─────────────────────
const product_pricings = {
  forProduct(productId) {
    return (load().product_pricings || [])
      .filter(r => r.product_id == productId)
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  },
  one(filter) {
    return (load().product_pricings || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.product_pricings) db.product_pricings = [];
    const id = nextId(db, 'product_pricings');
    const t = now();
    db.product_pricings.push({
      id,
      product_id: data.product_id,
      user_id:    data.user_id,
      name:       data.name   || 'Escenario sin nombre',
      inputs:     data.inputs || {},
      created_at: t,
      updated_at: t,
    });
    save(db);
    return { id };
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.product_pricings) db.product_pricings = [];
    const idx = db.product_pricings.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    Object.assign(db.product_pricings[idx], changes, { updated_at: now() });
    save(db);
    return true;
  },
  delete(id, userId) {
    const db = load();
    if (!db.product_pricings) db.product_pricings = [];
    const before = db.product_pricings.length;
    db.product_pricings = db.product_pricings.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.product_pricings.length < before;
  },
};

// ── Meta Ads Spy ──────────────────────────────────────────────────
const meta_spy_searches = {
  forUser(userId, limit = 100) {
    return (load().meta_spy_searches || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  },
  one(filter) {
    return (load().meta_spy_searches || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.meta_spy_searches) db.meta_spy_searches = [];
    const id = nextId(db, 'meta_spy_searches');
    db.meta_spy_searches.push({
      id,
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
      created_at:       now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.meta_spy_searches) db.meta_spy_searches = [];
    const before = db.meta_spy_searches.length;
    db.meta_spy_searches = db.meta_spy_searches.filter(r => !(r.id == id && r.user_id == userId));
    db.meta_spy_ads      = (db.meta_spy_ads || []).filter(r => r.search_id != id);
    save(db);
    return db.meta_spy_searches.length < before;
  },
  countLastHour(userId) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return (load().meta_spy_searches || [])
      .filter(r => r.user_id == userId && new Date(r.created_at).getTime() > cutoff).length;
  },
};

const meta_spy_ads = {
  forSearch(searchId) {
    return (load().meta_spy_ads || [])
      .filter(r => r.search_id == searchId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  },
  insertMany(rows) {
    const db = load();
    if (!db.meta_spy_ads) db.meta_spy_ads = [];
    const inserted = [];
    rows.forEach(data => {
      const id = nextId(db, 'meta_spy_ads');
      const row = {
        id,
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
        platforms:        data.platforms        || [],
        display_format:   data.display_format   || null,
        ad_archive_id:    data.ad_archive_id    || null,
        collation_count:  data.collation_count  || null,
        categories:       data.categories       || [],
        is_active:        data.is_active !== undefined ? data.is_active : true,
        snapshot_url:     data.snapshot_url     || null,
        created_at:       now(),
      };
      db.meta_spy_ads.push(row);
      inserted.push(row);
    });
    save(db);
    return inserted;
  },
};

// ── Meta Ads Spy: Folders ─────────────────────────────────────────
const meta_spy_folders = {
  forUser(userId) {
    return (load().meta_spy_folders || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  },
  one(filter) {
    return (load().meta_spy_folders || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.meta_spy_folders) db.meta_spy_folders = [];
    const id = nextId(db, 'meta_spy_folders');
    db.meta_spy_folders.push({
      id,
      user_id:    data.user_id,
      name:       data.name || 'Carpeta sin nombre',
      created_at: now(),
    });
    save(db);
    return { id };
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.meta_spy_folders) db.meta_spy_folders = [];
    const idx = db.meta_spy_folders.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    Object.assign(db.meta_spy_folders[idx], changes);
    save(db);
    return true;
  },
  delete(id, userId) {
    const db = load();
    if (!db.meta_spy_folders) db.meta_spy_folders = [];
    const before = db.meta_spy_folders.length;
    db.meta_spy_folders = db.meta_spy_folders.filter(r => !(r.id == id && r.user_id == userId));
    // Move saved items in that folder back to "Todos" (folder_id = null)
    db.meta_spy_saved = (db.meta_spy_saved || []).map(r =>
      (r.folder_id == id && r.user_id == userId) ? { ...r, folder_id: null } : r
    );
    save(db);
    return db.meta_spy_folders.length < before;
  },
};

// ── Meta Ads Spy: Saved ads (Library) ─────────────────────────────
const meta_spy_saved = {
  forUser(userId, folderId) {
    return (load().meta_spy_saved || [])
      .filter(r => r.user_id == userId && (folderId == null || r.folder_id == folderId))
      .sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
  },
  one(filter) {
    return (load().meta_spy_saved || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  countForUser(userId) {
    return (load().meta_spy_saved || []).filter(r => r.user_id == userId).length;
  },
  isSaved(userId, adId) {
    return !!(load().meta_spy_saved || []).find(r => r.user_id == userId && r.ad_id == adId);
  },
  insert(data) {
    const db = load();
    if (!db.meta_spy_saved) db.meta_spy_saved = [];
    // Prevent duplicates per (user_id, ad_id)
    const existing = db.meta_spy_saved.find(r => r.user_id == data.user_id && r.ad_id == data.ad_id);
    if (existing) {
      // Just move to the new folder
      existing.folder_id = data.folder_id || null;
      save(db);
      return { id: existing.id, existed: true };
    }
    const id = nextId(db, 'meta_spy_saved');
    db.meta_spy_saved.push({
      id,
      user_id:   data.user_id,
      ad_id:     data.ad_id,
      folder_id: data.folder_id || null,
      saved_at:  now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.meta_spy_saved) db.meta_spy_saved = [];
    const before = db.meta_spy_saved.length;
    db.meta_spy_saved = db.meta_spy_saved.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.meta_spy_saved.length < before;
  },
  deleteByAdId(userId, adId) {
    const db = load();
    if (!db.meta_spy_saved) db.meta_spy_saved = [];
    const before = db.meta_spy_saved.length;
    db.meta_spy_saved = db.meta_spy_saved.filter(r => !(r.user_id == userId && r.ad_id == adId));
    save(db);
    return db.meta_spy_saved.length < before;
  },
  move(id, userId, folderId) {
    const db = load();
    if (!db.meta_spy_saved) db.meta_spy_saved = [];
    const idx = db.meta_spy_saved.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    db.meta_spy_saved[idx].folder_id = folderId || null;
    save(db);
    return true;
  },
};

// ── Meta Ads Spy: Followed competitor pages ───────────────────────
const meta_spy_competitors = {
  forUser(userId) {
    return (load().meta_spy_competitors || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  one(filter) {
    return (load().meta_spy_competitors || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  countForUser(userId) {
    return (load().meta_spy_competitors || []).filter(r => r.user_id == userId).length;
  },
  insert(data) {
    const db = load();
    if (!db.meta_spy_competitors) db.meta_spy_competitors = [];
    // Prevent duplicates per (user_id, page_id)
    const existing = db.meta_spy_competitors.find(r => r.user_id == data.user_id && r.page_id == data.page_id);
    if (existing) return { id: existing.id, existed: true };
    const id = nextId(db, 'meta_spy_competitors');
    db.meta_spy_competitors.push({
      id,
      user_id:        data.user_id,
      page_id:        data.page_id,
      page_name:      data.page_name      || null,
      last_ads_count: data.last_ads_count || 0,
      last_checked:   data.last_checked   || null,
      created_at:     now(),
    });
    save(db);
    return { id };
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.meta_spy_competitors) db.meta_spy_competitors = [];
    const idx = db.meta_spy_competitors.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    Object.assign(db.meta_spy_competitors[idx], changes);
    save(db);
    return true;
  },
  delete(id, userId) {
    const db = load();
    if (!db.meta_spy_competitors) db.meta_spy_competitors = [];
    const before = db.meta_spy_competitors.length;
    db.meta_spy_competitors = db.meta_spy_competitors.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.meta_spy_competitors.length < before;
  },
};

// ── User settings ─────────────────────────────────────────────────
const user_settings = {
  get(userId) {
    const db = load();
    return db.user_settings.find(r => r.user_id == userId) || null;
  },
  upsert(userId, changes) {
    const db = load();
    const idx = db.user_settings.findIndex(r => r.user_id == userId);
    if (idx === -1) {
      db.user_settings.push({ user_id: userId, claude_key: null, gemini_key: null, openai_key: null, kieai_key: null, ...changes, updated_at: now() });
    } else {
      Object.assign(db.user_settings[idx], changes, { updated_at: now() });
    }
    save(db);
  },
};

// ── Seed admin ────────────────────────────────────────────────────
function seedAdmin() {
  const existing = users.one({ role: 'admin' });
  if (existing) return;

  const bcrypt = require('bcryptjs');
  const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@ecommagic.ai';
  let   adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: ADMIN_PASSWORD no está definido. Define la variable de entorno antes de arrancar.');
      process.exit(1);
    }
    // Generate a strong random password for dev environments and print it ONCE.
    adminPassword = require('crypto').randomBytes(12).toString('base64').replace(/[/+=]/g, '').slice(0, 16);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  ADMIN GENERADO (guarda esta contraseña — sólo se muestra una vez):');
    console.log(`    Email:    ${adminEmail}`);
    console.log(`    Password: ${adminPassword}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  const hash = bcrypt.hashSync(adminPassword, 10);
  users.insert({ first_name:'Admin', last_name:'Ecom', email: adminEmail, password: hash, role:'admin', plan:'agency' });
}

seedAdmin();

// ── Ad/Landing Templates ───────────────────────────────────────────
// Landing section categories — single source of truth, exposed via API
const LANDING_CATEGORIES = [
  'Hero',
  'Oferta',
  'Antes/Después',
  'Beneficios',
  'Tabla Comparativa',
  'Prueba de Autoridad',
  'Testimonios',
  'Modo de Uso',
  'Logística',
  'Preguntas Frecuentes',
];

function normalizeTemplate(t) {
  if (!t) return t;
  return {
    ...t,
    kind: t.kind || 'ad',
    category: t.category || null,
    owner_id: t.owner_id != null ? t.owner_id : null,  // null = global (Ecom Magic)
  };
}

const ad_templates = {
  all() {
    return (load().ad_templates || []).map(normalizeTemplate);
  },
  byKind(kind) {
    return this.all().filter(t => t.kind === kind);
  },
  // Global = admin-uploaded (owner_id null). Equivalent to "Ecom Magic" in the UI.
  globalByKind(kind) {
    return this.byKind(kind).filter(t => t.owner_id == null);
  },
  // User-owned templates only.
  forUserByKind(userId, kind) {
    return this.byKind(kind).filter(t => t.owner_id != null && t.owner_id == userId);
  },
  // Templates a user can SEE / USE: globals + their own.
  visibleByKind(userId, kind) {
    return this.byKind(kind).filter(t => t.owner_id == null || t.owner_id == userId);
  },
  one(id) {
    const t = (load().ad_templates || []).find(x => x.id == id) || null;
    return t ? normalizeTemplate(t) : null;
  },
  insert(data) {
    const db = load();
    if (!db.ad_templates) db.ad_templates = [];
    const id = nextId(db, 'ad_templates');
    const VALID_KINDS = ['ad', 'landing', 'mockup', 'logo', 'authority'];
    const kind = VALID_KINDS.includes(data.kind) ? data.kind : 'ad';
    let category = null;
    if (kind === 'landing' && typeof data.category === 'string' && LANDING_CATEGORIES.includes(data.category)) {
      category = data.category;
    }
    db.ad_templates.push({
      id,
      name: data.name,
      image_path: data.image_path,
      kind,
      category,
      owner_id: data.owner_id != null ? data.owner_id : null,
      created_by: data.created_by || null,
      created_at: now(),
    });
    save(db);
    return { id };
  },
  update(id, patch) {
    const db = load();
    if (!db.ad_templates) db.ad_templates = [];
    const t = db.ad_templates.find(x => x.id == id);
    if (!t) return false;
    if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim();
    if (['ad', 'landing', 'mockup', 'logo', 'authority'].includes(patch.kind)) t.kind = patch.kind;
    if (patch.category === null || patch.category === '') {
      t.category = null;
    } else if (typeof patch.category === 'string' && LANDING_CATEGORIES.includes(patch.category)) {
      t.category = patch.category;
    }
    if ((t.kind || 'ad') === 'ad') t.category = null;
    save(db);
    return true;
  },
  delete(id) {
    const db = load();
    if (!db.ad_templates) db.ad_templates = [];
    const before = db.ad_templates.length;
    db.ad_templates = db.ad_templates.filter(t => t.id != id);
    save(db);
    return db.ad_templates.length < before;
  },
  // Returns true if the user is allowed to USE this template (global or owns it).
  isUsableBy(template, userId) {
    if (!template) return false;
    return template.owner_id == null || template.owner_id == userId;
  },
};

// ── TikTok Shop Spy ────────────────────────────────────────────────
const tiktok_spy_searches = {
  forUser(userId, limit = 50) {
    return (load().tiktok_spy_searches || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  },
  one(filter) {
    return (load().tiktok_spy_searches || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.tiktok_spy_searches) db.tiktok_spy_searches = [];
    const id = nextId(db, 'tiktok_spy_searches');
    db.tiktok_spy_searches.push({
      id,
      user_id: data.user_id,
      query: data.query,
      country: data.country || null,
      results_count: data.results_count || 0,
      created_at: now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.tiktok_spy_searches) db.tiktok_spy_searches = [];
    const before = db.tiktok_spy_searches.length;
    db.tiktok_spy_searches = db.tiktok_spy_searches.filter(r => !(r.id == id && r.user_id == userId));
    // Cascade: remove products of this search
    db.tiktok_spy_products = (db.tiktok_spy_products || []).filter(r => r.search_id != id);
    save(db);
    return db.tiktok_spy_searches.length < before;
  },
  countLastHour(userId) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return (load().tiktok_spy_searches || [])
      .filter(r => r.user_id == userId && new Date(r.created_at).getTime() >= cutoff)
      .length;
  },
};

const tiktok_spy_products = {
  forSearch(searchId) {
    return (load().tiktok_spy_products || [])
      .filter(r => r.search_id == searchId);
  },
  one(filter) {
    return (load().tiktok_spy_products || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insertBatch(records) {
    const db = load();
    if (!db.tiktok_spy_products) db.tiktok_spy_products = [];
    const inserted = [];
    records.forEach(data => {
      const id = nextId(db, 'tiktok_spy_products');
      const row = {
        id,
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
        created_at:   now(),
      };
      db.tiktok_spy_products.push(row);
      inserted.push(row);
    });
    save(db);
    return inserted;
  },
};

const tiktok_spy_folders = {
  forUser(userId) {
    return (load().tiktok_spy_folders || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  },
  one(filter) {
    return (load().tiktok_spy_folders || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  insert(data) {
    const db = load();
    if (!db.tiktok_spy_folders) db.tiktok_spy_folders = [];
    const id = nextId(db, 'tiktok_spy_folders');
    db.tiktok_spy_folders.push({
      id,
      user_id: data.user_id,
      name: data.name,
      color: data.color || '#8b5cf6',
      created_at: now(),
    });
    save(db);
    return { id };
  },
  update(id, userId, changes) {
    const db = load();
    if (!db.tiktok_spy_folders) db.tiktok_spy_folders = [];
    const idx = db.tiktok_spy_folders.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    Object.assign(db.tiktok_spy_folders[idx], changes);
    save(db);
    return true;
  },
  delete(id, userId) {
    const db = load();
    if (!db.tiktok_spy_folders) db.tiktok_spy_folders = [];
    const before = db.tiktok_spy_folders.length;
    db.tiktok_spy_folders = db.tiktok_spy_folders.filter(r => !(r.id == id && r.user_id == userId));
    // Move saved items from this folder to "Todos" (null folder_id)
    db.tiktok_spy_saved = (db.tiktok_spy_saved || []).map(r =>
      r.user_id == userId && r.folder_id == id ? { ...r, folder_id: null } : r
    );
    save(db);
    return db.tiktok_spy_folders.length < before;
  },
};

const tiktok_spy_saved = {
  forUser(userId) {
    return (load().tiktok_spy_saved || [])
      .filter(r => r.user_id == userId)
      .sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
  },
  one(filter) {
    return (load().tiktok_spy_saved || []).find(r => Object.entries(filter).every(([k, v]) => r[k] == v)) || null;
  },
  countByUser(userId) {
    return (load().tiktok_spy_saved || []).filter(r => r.user_id == userId).length;
  },
  isSaved(userId, productId) {
    return !!(load().tiktok_spy_saved || []).find(r => r.user_id == userId && r.product_id == productId);
  },
  insert(data) {
    const db = load();
    if (!db.tiktok_spy_saved) db.tiktok_spy_saved = [];
    const existing = db.tiktok_spy_saved.find(r => r.user_id == data.user_id && r.product_id == data.product_id);
    if (existing) {
      if (data.folder_id !== undefined) existing.folder_id = data.folder_id || null;
      save(db);
      return { id: existing.id, already_saved: true };
    }
    const id = nextId(db, 'tiktok_spy_saved');
    db.tiktok_spy_saved.push({
      id,
      user_id: data.user_id,
      product_id: data.product_id,
      folder_id: data.folder_id || null,
      saved_at: now(),
    });
    save(db);
    return { id };
  },
  delete(id, userId) {
    const db = load();
    if (!db.tiktok_spy_saved) db.tiktok_spy_saved = [];
    const before = db.tiktok_spy_saved.length;
    db.tiktok_spy_saved = db.tiktok_spy_saved.filter(r => !(r.id == id && r.user_id == userId));
    save(db);
    return db.tiktok_spy_saved.length < before;
  },
  deleteByProduct(productId, userId) {
    const db = load();
    if (!db.tiktok_spy_saved) db.tiktok_spy_saved = [];
    const before = db.tiktok_spy_saved.length;
    db.tiktok_spy_saved = db.tiktok_spy_saved.filter(r => !(r.user_id == userId && r.product_id == productId));
    save(db);
    return db.tiktok_spy_saved.length < before;
  },
  moveToFolder(id, userId, folderId) {
    const db = load();
    if (!db.tiktok_spy_saved) db.tiktok_spy_saved = [];
    const idx = db.tiktok_spy_saved.findIndex(r => r.id == id && r.user_id == userId);
    if (idx === -1) return false;
    db.tiktok_spy_saved[idx].folder_id = folderId || null;
    save(db);
    return true;
  },
};

module.exports = { users, user_settings, products, product_research, product_angles, product_ads, product_landings, product_assembled_landings, product_descriptions, product_audios, product_pricings, product_copys, product_testimonials, product_mockups, product_logos, product_ebooks, text_to_image_outputs, shopify_connections, ad_templates, LANDING_CATEGORIES, meta_spy_searches, meta_spy_ads, meta_spy_folders, meta_spy_saved, meta_spy_competitors, tiktok_spy_searches, tiktok_spy_products, tiktok_spy_folders, tiktok_spy_saved };
