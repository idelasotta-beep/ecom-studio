/**
 * Shopify integration — multi-tenant, one connection per user.
 *
 * Auth flow: Custom Distribution App via `client_credentials` grant.
 *   1. User creates a Custom Distribution app in their Shopify Dev Dashboard,
 *      configures the required scopes, and installs it in their store.
 *   2. User pastes domain + client_id + client_secret into our app.
 *   3. We POST to https://{shop}/admin/oauth/access_token with grant_type=client_credentials
 *      and receive a 24h-valid access_token + the granted scope list.
 *   4. Token is auto-refreshed on each test/use when < 1h to expiry.
 *
 * Stored:
 *   - store_domain (plaintext)
 *   - client_id    (plaintext)
 *   - client_secret_encrypted (AES-256-GCM, key in env var SHOPIFY_ENCRYPTION_KEY)
 *   - access_token + access_token_expires_at (cached, refreshed automatically)
 */
const express = require('express');
const fs   = require('fs');
const path = require('path');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { shopify_connections, product_assembled_landings, product_landings, products } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../lib/shopify-crypto');
const { ensureWebP } = require('../lib/image-optim');
const { buildAssembledTemplate } = require('../lib/shopify-section-builder');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const LANDINGS_DIR = mediaDir('landings');

// Shopify API version — bump periodically. As of 2026 the stable version is 2026-04.
const SHOPIFY_API_VERSION = '2026-04';

// Token TTL safety window — refresh when < 1h to expiry. Shopify client_credentials tokens last 24h.
const REFRESH_BEFORE_MS = 60 * 60 * 1000;

const apiAgent = new UndiciAgent({
  headersTimeout: 30_000,
  bodyTimeout:    30_000,
  connectTimeout: 10_000,
});

// Image uploads can be large + Shopify processes them server-side → use a more patient agent
const uploadAgent = new UndiciAgent({
  headersTimeout: 120_000,
  bodyTimeout:    120_000,
  connectTimeout: 10_000,
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function normalizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let d = raw.trim().toLowerCase();
  // strip protocol + path
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\s+/g, '');
  if (!d.endsWith('.myshopify.com')) return null;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(d)) return null;
  return d;
}

// Exchange client_id + client_secret for a 24h access token via the
// `client_credentials` grant. Used at initial connect time and on every refresh.
async function fetchAccessToken(storeDomain, clientId, clientSecret) {
  const r = await undiciFetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'client_credentials',
    }),
    dispatcher: apiAgent,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (!r.ok) {
    const msg = data.error_description || data.error || data.errors || `Shopify ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  if (!data.access_token) throw new Error('Shopify no devolvió access_token');
  const ttlSec = Number(data.expires_in) || (24 * 60 * 60);
  return {
    access_token: data.access_token,
    expires_at:   new Date(Date.now() + (ttlSec * 1000)).toISOString(),
    scope:        data.scope || null,
  };
}

// Returns a connection with a plaintext, currently-valid access_token.
// If the cached token is still > 1h from expiry, returns it as-is.
// Otherwise decrypts client_secret and exchanges for a fresh token,
// persisting the new token to disk for next time.
//
// With the persistent encryption key (server/.shopify-encryption-key),
// decryption survives server restarts indefinitely — so as long as the
// merchant doesn't rotate their client_secret in Shopify, this loop runs
// transparently forever.
async function ensureFreshToken(conn) {
  if (!conn) throw new Error('Conexión inexistente');
  const now = Date.now();
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
  if (conn.access_token && (expiresAt - now > REFRESH_BEFORE_MS)) {
    return conn; // cached token still good
  }
  const secret = decrypt(conn.client_secret_encrypted);
  if (!secret) throw new Error('No se puede descifrar el client_secret. Reconectá la tienda.');
  const fresh = await fetchAccessToken(conn.store_domain, conn.client_id, secret);
  const updated = shopify_connections.updateById(conn.id, conn.user_id, {
    access_token:            fresh.access_token,
    access_token_expires_at: fresh.expires_at,
    scope:                   fresh.scope,
  });
  return updated || conn;
}

async function shopifyAdminFetch(conn, pathAfterAdmin, options = {}) {
  const url = `https://${conn.store_domain}/admin/api/${SHOPIFY_API_VERSION}${pathAfterAdmin}`;
  const r = await undiciFetch(url, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': conn.access_token,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...(options.headers || {}),
    },
    dispatcher: options.dispatcher || apiAgent,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (!r.ok) {
    const msg = data.errors || data.error || `Shopify ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function publicShape(conn) {
  if (!conn) return null;
  return {
    id:           conn.id,
    connected:    Boolean(conn.access_token),
    store_domain: conn.store_domain,
    store_name:   conn.store_name,
    scope:        conn.scope,
    last_verified_at:        conn.last_verified_at,
    access_token_expires_at: conn.access_token_expires_at,
    created_at:   conn.created_at,
    updated_at:   conn.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────

// GET /api/shopify/stores — list every store this user has connected
router.get('/stores', (req, res) => {
  const list = shopify_connections.forUser(req.user.id);
  res.json({ stores: list.map(publicShape) });
});

// GET /api/shopify/status — back-compat summary endpoint used across the app.
// Returns `connected: true` whenever the user has ≥1 connected store + the full list.
router.get('/status', (req, res) => {
  const list = shopify_connections.forUser(req.user.id);
  const stores = list.map(publicShape);
  res.json({
    connected: stores.length > 0,
    count:     stores.length,
    stores,
  });
});

// POST /api/shopify/connect — body: { store_domain, client_id, client_secret }
// Connects a Shopify store using a Custom Distribution App's OAuth `client_credentials` grant.
// The exchanged 24h token is auto-refreshed transparently on subsequent requests.
// If the same store_domain is already connected, the credentials are updated in place.
router.post('/connect', async (req, res) => {
  const { store_domain, client_id, client_secret } = req.body || {};
  const normalized = normalizeDomain(store_domain);
  if (!normalized) return res.status(400).json({ error: 'Dominio inválido. Debe terminar en .myshopify.com (ej: mi-tienda.myshopify.com)' });
  if (!client_id || typeof client_id !== 'string' || client_id.length < 8) {
    return res.status(400).json({ error: 'Falta o es inválido el Client ID' });
  }
  if (!client_secret || typeof client_secret !== 'string' || client_secret.length < 8) {
    return res.status(400).json({ error: 'Falta o es inválido el Client Secret' });
  }

  // Exchange credentials for an access token + validate scopes work on this store.
  let tokenInfo;
  try {
    tokenInfo = await fetchAccessToken(normalized, client_id, client_secret);
  } catch (err) {
    console.error('[shopify/connect] token fetch failed:', err.message);
    return res.status(400).json({ error: `No se pudo validar la conexión: ${err.message}` });
  }

  let shopName = null;
  try {
    const tempConn = { store_domain: normalized, access_token: tokenInfo.access_token };
    const shopData = await shopifyAdminFetch(tempConn, '/shop.json');
    shopName = shopData?.shop?.name || null;
  } catch (err) {
    console.error('[shopify/connect] shop.json fetch failed:', err.message);
    return res.status(400).json({ error: `Token obtenido pero no se pudo consultar /shop.json: ${err.message}. Verificá los scopes configurados en tu app.` });
  }

  const saved = shopify_connections.upsertByDomain(req.user.id, {
    store_domain:            normalized,
    client_id,
    client_secret_encrypted: encrypt(client_secret),
    access_token:            tokenInfo.access_token,
    access_token_expires_at: tokenInfo.expires_at,
    scope:                   tokenInfo.scope,
    // Wipe leftover Admin-API-token flow fields if reconnecting
    access_token_encrypted:  null,
    store_name:              shopName,
    last_verified_at:        new Date().toISOString(),
  });
  console.log(`[shopify/connect] user_id=${req.user.id} connected store=${normalized} (${shopName}) id=${saved.id}`);
  res.json({ store: publicShape(saved), message: `Tienda "${shopName}" conectada correctamente` });
});

// POST /api/shopify/stores/:id/test — verify a specific store
router.post('/stores/:id/test', async (req, res) => {
  const conn = shopify_connections.one({ id: req.params.id, user_id: req.user.id });
  if (!conn) return res.status(404).json({ error: 'Tienda no encontrada' });
  try {
    const fresh = await ensureFreshToken(conn);
    const shopData = await shopifyAdminFetch(fresh, '/shop.json');
    const shopName = shopData?.shop?.name || fresh.store_name;
    const updated = shopify_connections.updateById(conn.id, req.user.id, {
      store_name:       shopName,
      last_verified_at: new Date().toISOString(),
    });
    res.json({ store: publicShape(updated), message: `Conexión verificada — Shopify confirmó "${shopName}"` });
  } catch (err) {
    console.error('[shopify/test] failed:', err.message);
    res.status(502).json({ error: `Error al verificar conexión: ${err.message}` });
  }
});

// DELETE /api/shopify/stores/:id — disconnect a specific store
router.delete('/stores/:id', (req, res) => {
  const ok = shopify_connections.deleteById(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Tienda no encontrada' });
  console.log(`[shopify/disconnect] user_id=${req.user.id} disconnected store ${req.params.id}`);
  res.json({ message: 'Tienda desconectada', disconnected: true });
});

// GET /api/shopify/stores/:id/products?q=...
// Search the store's existing products (used by the "Vincular producto existente"
// step in the publish wizard). Returns up to 20 results ordered by relevance.
router.get('/stores/:id/products', async (req, res) => {
  const conn = shopify_connections.one({ id: req.params.id, user_id: req.user.id });
  if (!conn) return res.status(404).json({ error: 'Tienda no encontrada' });
  const q = String(req.query.q || '').trim();
  let fresh;
  try { fresh = await ensureFreshToken(conn); }
  catch (err) { return res.status(502).json({ error: `Sesión Shopify caducada: ${err.message}` }); }

  // GraphQL — REST product search doesn't support substring on title.
  // `body_html` length tells us whether we'd overwrite an existing description.
  const gqlQuery = q
    ? `title:*${q.replace(/[*"\\]/g,'')}* OR handle:*${q.replace(/[*"\\]/g,'')}*`
    : '';
  const body = {
    query: `query($q: String) {
      products(first: 20, query: $q, sortKey: UPDATED_AT, reverse: true) {
        edges { node {
          id handle title status bodyHtml templateSuffix
          featuredImage { url }
        } }
      }
    }`,
    variables: { q: gqlQuery },
  };

  try {
    const r = await undiciFetch(`https://${fresh.store_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': fresh.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: apiAgent,
    });
    const data = await r.json();
    if (!r.ok || data.errors) {
      console.error('[shopify/stores/:id/products] gql error:', JSON.stringify(data.errors || data));
      return res.status(502).json({ error: 'No se pudo buscar productos' });
    }
    const items = (data.data?.products?.edges || []).map(e => {
      const n = e.node;
      // legacy numeric id from gid://shopify/Product/12345
      const m = String(n.id).match(/Product\/(\d+)/);
      const legacyId = m ? Number(m[1]) : null;
      return {
        id:              legacyId,
        gid:             n.id,
        title:           n.title,
        handle:          n.handle,
        status:          (n.status || '').toLowerCase(),
        has_body_html:   Boolean(n.bodyHtml && n.bodyHtml.replace(/<[^>]+>/g,'').trim().length > 0),
        template_suffix: n.templateSuffix || null,
        image_url:       n.featuredImage?.url || null,
      };
    });
    res.json({ items });
  } catch (err) {
    console.error('[shopify/stores/:id/products] failed:', err.message);
    res.status(502).json({ error: `Error al buscar productos: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────
// Publish assembled landing to Shopify
// ─────────────────────────────────────────────────────────────────
//
// Body: { assembled_id, store_id, mode, target_product_id?, title?, price?, vendor?, status? }
//   mode: 'new' (default) | 'existing'
//   For 'new': title + price required; we create a new product.
//   For 'existing': target_product_id required; we update that product
//                   (clear body_html, set template_suffix, attach landing images).
//                   title/price/vendor/status are ignored.
//
// Flow:
//   1. Resolve connection + assembled landing + inputs
//   2. Refresh token if stale
//   3a. If mode='new': create product on Shopify
//   3b. If mode='existing': fetch & validate existing product
//   4. Upload landing images to product
//   5. Upload element images, build URL map
//   6. Install section files + JSON template
//   7. Update product (template_suffix + body_html)
//   8. Return admin + storefront URLs
router.post('/publish-landing', async (req, res) => {
  const { assembled_id, store_id, mode, target_product_id, title, price, vendor, status } = req.body || {};
  const publishMode = (mode === 'existing') ? 'existing' : 'new';

  // 1. Resolve connection — store_id required if user has >1 store
  const stores = shopify_connections.forUser(req.user.id);
  if (!stores.length) return res.status(404).json({ error: 'No tienes una tienda conectada. Configúrala en Ajustes → Integraciones.' });
  let conn;
  if (store_id) {
    conn = stores.find(s => s.id == store_id);
    if (!conn) return res.status(404).json({ error: 'Tienda no encontrada en tu cuenta' });
  } else if (stores.length === 1) {
    conn = stores[0];
  } else {
    return res.status(400).json({ error: 'Tienes varias tiendas conectadas. Indica a cuál enviar la landing.' });
  }

  // 2. Assembled landing
  const assembled = product_assembled_landings.one({ id: Number(assembled_id), user_id: req.user.id });
  if (!assembled) return res.status(404).json({ error: 'Landing ensamblada no encontrada' });

  // 3. Inputs — different validations per mode
  let cleanTitle  = '';
  let priceNum    = 0;
  let cleanVendor = null;
  let cleanStatus = 'draft';
  if (publishMode === 'new') {
    if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
    cleanTitle = title.trim().slice(0, 255);
    priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return res.status(400).json({ error: 'Precio inválido' });
    cleanVendor = (vendor && typeof vendor === 'string') ? vendor.trim().slice(0, 80) : null;
    cleanStatus = status === 'active' ? 'active' : 'draft';
  } else {
    // 'existing' mode
    if (!target_product_id) return res.status(400).json({ error: 'Falta el ID del producto destino' });
  }

  // 4. Resolve section files — prefer the WebP-optimized copy (smaller payload + faster storefront).
  // ensureWebP is idempotent: if a .webp sibling already exists we just use it.
  // Track the section_id alongside each file so we can re-align inline elements after upload.
  const orderedFiles = [];
  for (const s of (assembled.sections || [])) {
    const ad = product_landings.one({ id: Number(s.source_ad_id) });
    if (!ad) continue;
    const sourcePath = path.join(LANDINGS_DIR, ad.image_path);
    if (!fs.existsSync(sourcePath)) {
      console.warn(`[shopify/publish-landing] file missing for ad ${ad.id}: ${sourcePath}`);
      continue;
    }
    const webp = await ensureWebP(sourcePath);
    const filePath = (webp.ok ? webp.path : sourcePath);
    orderedFiles.push({ ad, filePath, isWebp: !!webp.ok, sectionId: s.id });
  }
  if (!orderedFiles.length) return res.status(400).json({ error: 'No hay imágenes válidas para publicar' });

  // 5. Refresh the 24h token if it's close to expiry (transparent to the user).
  try {
    conn = await ensureFreshToken(conn);
  } catch (err) {
    console.error('[shopify/publish-landing] token refresh failed:', err.message);
    return res.status(502).json({ error: `No se pudo refrescar la sesión de Shopify: ${err.message}` });
  }

  // 6. Get the target product — create new or fetch existing
  let productPayload;
  let preExistingBodyHtml = '';
  if (publishMode === 'new') {
    try {
      productPayload = await shopifyAdminFetch(conn, '/products.json', {
        method: 'POST',
        body: JSON.stringify({
          product: {
            title:     cleanTitle,
            vendor:    cleanVendor || (conn.store_name || 'Ecom Studio'),
            body_html: '',
            status:    cleanStatus,
            variants:  [{ price: priceNum.toFixed(2) }],
          },
        }),
      });
    } catch (err) {
      console.error('[shopify/publish-landing] product create failed:', err.message);
      return res.status(502).json({ error: `Error al crear producto en Shopify: ${err.message}` });
    }
  } else {
    // 'existing' — fetch the product to validate + remember if there was prior body_html
    try {
      productPayload = await shopifyAdminFetch(conn, `/products/${encodeURIComponent(target_product_id)}.json`);
      preExistingBodyHtml = productPayload?.product?.body_html || '';
      cleanTitle = productPayload?.product?.title || cleanTitle;
      cleanStatus = (productPayload?.product?.status || 'draft').toLowerCase();
    } catch (err) {
      console.error('[shopify/publish-landing] existing product fetch failed:', err.message);
      return res.status(502).json({ error: `No se pudo cargar el producto seleccionado: ${err.message}` });
    }
  }

  const product = productPayload && productPayload.product;
  const productId = product && product.id;
  const productHandle = product && product.handle;
  if (!productId) return res.status(502).json({ error: 'Shopify no devolvió un ID de producto' });

  // 7. Upload images sequentially (gentle on rate limits)
  const uploadedSrcs = [];
  const uploadedSectionIds = [];
  const failedUploads = [];
  for (let i = 0; i < orderedFiles.length; i++) {
    const { ad, filePath, isWebp } = orderedFiles[i];
    try {
      const buf = fs.readFileSync(filePath);
      const sizeMB = buf.length / (1024 * 1024);
      if (sizeMB > 20) {
        console.warn(`[shopify/publish-landing] skipping oversized image (${sizeMB.toFixed(1)}MB): ${ad.image_path}`);
        failedUploads.push({ ad_id: ad.id, reason: `archivo muy grande (${sizeMB.toFixed(1)}MB, máx 20MB)` });
        continue;
      }
      const b64 = buf.toString('base64');
      const ext = isWebp ? 'webp' : path.extname(ad.image_path).slice(1);
      const base = path.basename(ad.image_path, path.extname(ad.image_path));
      const imgResp = await shopifyAdminFetch(conn, `/products/${productId}/images.json`, {
        method:     'POST',
        dispatcher: uploadAgent,
        body: JSON.stringify({
          image: {
            attachment: b64,
            filename:   `ecom-studio-${ad.id}-${base}.${ext}`,
            alt:        ad.headline || ad.category || cleanTitle,
            position:   i + 1,
          },
        }),
      });
      const src = imgResp?.image?.src;
      if (src) {
        uploadedSrcs.push(src);
        uploadedSectionIds.push(orderedFiles[i].sectionId);
      } else {
        failedUploads.push({ ad_id: ad.id, reason: 'sin URL en respuesta' });
      }
      // Polite delay to respect rate limits (REST: 2 calls/sec base)
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[shopify/publish-landing] image upload failed (ad ${ad.id}):`, err.message);
      failedUploads.push({ ad_id: ad.id, reason: err.message });
    }
  }

  if (!uploadedSrcs.length) {
    return res.status(502).json({
      error: 'Ninguna imagen pudo subirse a Shopify.',
      product_id: productId,
      failed_uploads: failedUploads,
    });
  }

  // 7b. Upload images referenced by elements (authority logos, floating CTA logos, etc.).
  // They live in server/ad-templates/ and need Shopify-CDN URLs for the Liquid to render.
  const elementsForLiquid = Array.isArray(assembled.elements) ? assembled.elements : [];
  const collectedUrls = [];
  for (const e of elementsForLiquid) {
    const c = e?.config || {};
    for (const v of Object.values(c)) {
      if (typeof v === 'string' && v.startsWith('/ad-templates/')) collectedUrls.push(v);
    }
  }
  const elementImageUrls = [...new Set(collectedUrls)];
  const elementUrlMap = {};  // local /ad-templates/xxx → Shopify CDN URL
  const TEMPLATES_DIR = mediaDir('ad-templates');
  for (const localUrl of elementImageUrls) {
    const rel  = localUrl.replace(/^\/ad-templates\//, '');
    const absSource = path.join(TEMPLATES_DIR, rel);
    if (!fs.existsSync(absSource)) {
      console.warn(`[shopify/publish-landing] element image missing: ${absSource}`);
      continue;
    }
    // Prefer the WebP-optimized copy (smaller payload)
    const webp = await ensureWebP(absSource);
    const filePath = (webp.ok ? webp.path : absSource);
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length > 20 * 1024 * 1024) {
        console.warn(`[shopify/publish-landing] element image oversized (${(buf.length/1048576).toFixed(1)}MB): ${filePath}`);
        continue;
      }
      const b64 = buf.toString('base64');
      const imgResp = await shopifyAdminFetch(conn, `/products/${productId}/images.json`, {
        method:     'POST',
        dispatcher: uploadAgent,
        body: JSON.stringify({
          image: {
            attachment: b64,
            filename:   `ecom-studio-elem-${path.basename(filePath)}`,
            alt:        'Ecom Studio element',
          },
        }),
      });
      const cdnSrc = imgResp?.image?.src;
      if (cdnSrc) elementUrlMap[localUrl] = cdnSrc;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error('[shopify/publish-landing] element image upload failed:', err.message);
    }
  }

  // 8. Find active theme
  let themeId = null;
  try {
    const themesResp = await shopifyAdminFetch(conn, '/themes.json');
    const main = (themesResp?.themes || []).find(t => t.role === 'main');
    themeId = main?.id;
  } catch (err) {
    console.error('[shopify/publish-landing] themes list failed:', err.message);
  }

  // 9. Build & install Shopify assets:
  //    a) reusable section files (one per element type used + image section)
  //    b) per-landing JSON template that references them with the user's settings
  //    Each section file carries a {% schema %}, so every setting becomes editable
  //    in the Shopify theme editor.
  const suffix = `ecomstudio-${assembled.id}-${Date.now()}`;
  let templateInstalled = false;
  if (themeId) {
    try {
      const safeTitle = cleanTitle.replace(/[<>"&]/g, c => ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', '&':'&amp;' }[c]));

      // Remap local /ad-templates/* URLs to Shopify CDN counterparts,
      // and normalize legacy inline elements that lost their `position`.
      const INLINE_TYPES = new Set(['connector', 'authority', 'cta']);
      const firstSectionId = uploadedSectionIds[0] || null;
      const elementsRemapped = elementsForLiquid.map(e => {
        const cfg = { ...(e.config || {}) };
        for (const k of Object.keys(cfg)) {
          if (typeof cfg[k] === 'string' && cfg[k].startsWith('/ad-templates/')) {
            const cdn = elementUrlMap[cfg[k]];
            if (cdn) cfg[k] = cdn;
          }
        }
        let position = e.position;
        if (INLINE_TYPES.has(e.type) && (!position || !position.kind) && firstSectionId) {
          position = { kind: 'before-section', section_id: firstSectionId };
        }
        return { ...e, config: cfg, position };
      });

      const { templateJson, sectionFiles } = buildAssembledTemplate({
        assembled,
        uploadedSrcs,
        uploadedSectionIds,
        elementsRemapped,
        safeTitle,
      });

      // Install all section files (idempotent — Shopify overwrites existing assets)
      for (const [sectionKey, liquid] of Object.entries(sectionFiles)) {
        await shopifyAdminFetch(conn, `/themes/${themeId}/assets.json`, {
          method: 'PUT',
          body: JSON.stringify({
            asset: { key: `sections/${sectionKey}.liquid`, value: liquid },
          }),
        });
        // Polite delay to avoid theme-asset rate limits
        await new Promise(r => setTimeout(r, 250));
      }

      // Install the JSON template
      await shopifyAdminFetch(conn, `/themes/${themeId}/assets.json`, {
        method: 'PUT',
        body: JSON.stringify({
          asset: { key: `templates/product.${suffix}.json`, value: templateJson },
        }),
      });

      templateInstalled = true;
    } catch (err) {
      console.error('[shopify/publish-landing] theme asset install failed:', err.message);
    }
  }

  // 10. Update product: clear body_html, assign template_suffix (if installed)
  try {
    const updates = { id: productId, body_html: '' };
    if (templateInstalled) updates.template_suffix = suffix;
    await shopifyAdminFetch(conn, `/products/${productId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ product: updates }),
    });
  } catch (err) {
    console.error('[shopify/publish-landing] product update failed:', err.message);
  }

  console.log(`[shopify/publish-landing] user=${req.user.id} assembled=${assembled.id} mode=${publishMode} → product ${productId} (${productHandle}), template=${templateInstalled ? suffix : 'none'} | ${uploadedSrcs.length}/${orderedFiles.length} images`);

  res.json({
    mode:               publishMode,
    shopify_product_id: productId,
    handle:             productHandle,
    admin_url:          `https://${conn.store_domain}/admin/products/${productId}`,
    storefront_url:     `https://${conn.store_domain}/products/${productHandle}`,
    images_uploaded:    uploadedSrcs.length,
    total_sections:     orderedFiles.length,
    failed_uploads:     failedUploads,
    status:             cleanStatus,
    template_suffix:    templateInstalled ? suffix : null,
    template_installed: templateInstalled,
    replaced_body_html: publishMode === 'existing' && preExistingBodyHtml && preExistingBodyHtml.replace(/<[^>]+>/g,'').trim().length > 0,
  });
});

// ─────────────────────────────────────────────────────────────────
// (Legacy Liquid builders removed — moved to ../lib/shopify-section-builder.js
//  in the refactor that switched to per-element Shopify sections with editable
//  schemas. Everything that used to live here is now generated per-element-type
//  and installed once per landing publish.)
// ─────────────────────────────────────────────────────────────────
/* legacy start
// Section: stacked image landing.
// `imageUrls` are absolute Shopify CDN URLs returned by the product-image upload.
// `elements` is the assembled landing's elements array (announcement-bar, connector, etc.).
// `sectionIds` are the section IDs in display order — used to anchor inline elements to images.
function buildSectionLiquid({ suffix, title, imageUrls, elements = [], sectionIds = [] }) {
  // Element-type → placement classification
  const placementFor = (type) => {
    if (type === 'announcement-bar') return 'global-top';
    if (type === 'connector' || type === 'authority' || type === 'cta') return 'inline';
    if (type === 'float-cta') return 'global-bottom';
    return null;
  };

  const globalTop    = elements.filter(e => placementFor(e.type) === 'global-top');
  const inlines      = elements.filter(e => placementFor(e.type) === 'inline');
  const globalBottom = elements.filter(e => placementFor(e.type) === 'global-bottom');

  const globalTopHtml    = globalTop.map(renderElementLiquid).filter(Boolean).join('\n');
  const globalBottomHtml = globalBottom.map(renderElementLiquid).filter(Boolean).join('\n');

  // Build the interleaved image + inline-element stack
  const parts = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const sid = sectionIds[i];
    // Inline elements before this section (only meaningful for the first section — slot 0)
    inlines
      .filter(e => e.position?.kind === 'before-section' && e.position?.section_id === sid)
      .forEach(e => { const h = renderElementLiquid(e); if (h) parts.push(h); });
    // The image itself
    const loading = i === 0 ? 'eager' : 'lazy';
    parts.push(`  <img src="${imageUrls[i]}" alt="${title} — sección ${i + 1}" loading="${loading}" style="width:100%;height:auto;display:block;max-width:100%">`);
    // Inline elements after this section
    inlines
      .filter(e => e.position?.kind === 'after-section' && e.position?.section_id === sid)
      .forEach(e => { const h = renderElementLiquid(e); if (h) parts.push(h); });
  }

  return `{%- comment -%}
  Auto-generated by Ecom Studio AI
  Suffix: ${suffix}
  Title:  ${title}
  Generated: ${new Date().toISOString()}
{%- endcomment -%}
${globalTopHtml ? globalTopHtml + '\n' : ''}<section class="ecom-studio-landing" style="display:block;line-height:0;font-size:0;max-width:1200px;margin:0 auto;width:100%">
${parts.join('\n')}
</section>
${globalBottomHtml || ''}
${needsReleasitBootstrap(elements) ? releasitBootstrapScript() : ''}

{% schema %}
{
  "name": "Ecom Studio Landing",
  "settings": [],
  "presets": [
    { "name": "Ecom Studio Landing" }
  ]
}
{% endschema %}
`;
}

// Returns true if any element on the page uses the Releasit action — we then
// emit the bootstrap script once at the bottom of the template.
function needsReleasitBootstrap(elements) {
  return (elements || []).some(e => e?.type && (e.type === 'cta' || e.type === 'float-cta') && e?.config?.action_type === 'releaseit');
}

// Bootstrap script: binds clicks on any [data-action="releasit_cod"] button to the
// Releasit SDK (V2 first, legacy fallback, then DOM-click fallback). Idempotent —
// guarded against double-binding via window.__ecomStudioReleasitBound.
// Adapted from the production Ecom Magic implementation.
function releasitBootstrapScript() {
  return `
<script>
(function(){
  'use strict';
  if (window.__ecomStudioReleasitBound) return;
  window.__ecomStudioReleasitBound = true;

  function openReleasitCodForm() {
    // Releasit ships two SDKs: V2/React (_rsiV2) and Legacy (_rsi). Try each in a
    // separate try/catch so a broken getter on one doesn't block the other.
    try {
      if (window._rsiV2 && typeof window._rsiV2.setState === 'function') {
        window._rsiV2.setState({ isOpen: true });
        return true;
      }
    } catch (e) { console.warn('[Ecom Studio] _rsiV2 fail:', e); }
    try {
      if (window._rsi && window._rsi.form && typeof window._rsi.form.open === 'function') {
        window._rsi.form.open();
        return true;
      }
    } catch (e) { console.warn('[Ecom Studio] _rsi.form fail:', e); }
    try {
      var fallback = document.getElementById('rsi_buy_now_button');
      if (fallback) { fallback.click(); return true; }
    } catch (e) { console.warn('[Ecom Studio] fallback DOM fail:', e); }
    return false;
  }

  var openInFlight = false;
  function openWhenReady(maxWaitMs) {
    if (openInFlight) return;
    openInFlight = true;
    maxWaitMs = maxWaitMs || 4000;
    var startedAt = Date.now();
    (function attempt() {
      if (openReleasitCodForm()) { openInFlight = false; return; }
      if (Date.now() - startedAt > maxWaitMs) {
        openInFlight = false;
        console.warn('[Ecom Studio] Releasit COD form no disponible. ¿App Embed activo?');
        return;
      }
      setTimeout(attempt, 100);
    })();
  }

  function handleClick(ev) {
    var btn = ev.currentTarget;
    if (!btn || btn.getAttribute('data-action') !== 'releasit_cod') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    openWhenReady();
  }

  function bind() {
    var nodes = document.querySelectorAll('[data-action="releasit_cod"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__ecomStudioReleasitBoundEl) continue;
      el.__ecomStudioReleasitBoundEl = true;
      el.addEventListener('click', handleClick, true);
    }
  }

  bind();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  new MutationObserver(bind).observe(document.body, { childList: true, subtree: true });
})();
</script>`;
}

// Element → Liquid/HTML renderer. Returns null for unknown types (silently skipped).
function renderElementLiquid(elem) {
  if (!elem || !elem.type) return null;
  if (elem.type === 'announcement-bar') return renderAnnouncementBar(elem.config || {});
  if (elem.type === 'connector')        return renderConnector(elem.config || {});
  if (elem.type === 'authority')        return renderAuthority(elem.config || {});
  if (elem.type === 'float-cta')        return renderFloatCta(elem);
  if (elem.type === 'cta')              return renderInlineCta(elem);
  return null;
}

function escAttr(v) {
  return String(v == null ? '' : v).replace(/[<>"&]/g, c => ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', '&':'&amp;' }[c]));
}

// Shared button-style + click-action HTML helpers — used by both float-cta and inline cta.
function ctaButtonStyle(c) {
  const fontFamily = c.font_family === 'system-ui' ? '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' : (c.font_family || 'sans-serif');
  const transform =
    c.text_style === 'uppercase' ? 'uppercase' :
    c.text_style === 'lowercase' ? 'lowercase' : 'none';
  return [
    'display:inline-block',
    'width:100%',
    'box-sizing:border-box',
    'cursor:pointer',
    'border:none',
    `background:${c.bg_color || '#000'}`,
    `color:${c.text_color || '#FFF'}`,
    `font-family:${fontFamily}`,
    `font-size:${c.font_size || 16}px`,
    `font-weight:${c.bold ? 700 : 500}`,
    `letter-spacing:${c.letter_spacing || 0}px`,
    `padding:${c.btn_pad_y ?? 15}px 16px`,
    `border-radius:${c.border_radius ?? 10}px`,
    `text-transform:${transform}`,
    'text-align:center',
    'line-height:1.2',
    'text-decoration:none',
  ].join(';');
}

// Returns the opening tag (no closing >) for the clickable element. Caller appends ` style="..."` + `>` + text + closing tag.
// `formId` is needed for shopify-related actions.
function ctaActionOpenTag(c, formId) {
  if (c.action_type === 'custom_url') {
    return { open: `<a href="${escAttr(c.custom_url || '#')}" target="_blank" rel="noopener"`, close: 'a' };
  }
  if (c.action_type === 'shopify_addtocart') {
    return { open: `<button type="submit" form="${formId}"`, close: 'button' };
  }
  if (c.action_type === 'releaseit') {
    // Releasit Cash-On-Delivery Form ships two SDKs in production:
    //   • V2/React : window._rsiV2.setState({isOpen:true})
    //   • Legacy   : window._rsi.form.open()
    // The bootstrap script (emitted once per section template) handles both, plus
    // a DOM-click fallback to `#rsi_buy_now_button`. Here we only need to flag the
    // button with the data-action attribute it watches.
    return {
      open: `<button type="button" data-action="releasit_cod" data-variant-id="{{ product.selected_or_first_available_variant.id }}"`,
      close: 'button',
    };
  }
  if (c.action_type === 'scroll_bundle') {
    return { open: `<a href="#ecom-studio-bundle"`, close: 'a' };
  }
  // shopify_checkout (default)
  return { open: `<button type="submit" form="${formId}" data-checkout="1"`, close: 'button' };
}

// Hidden cart form bound to the current variant (only emitted for shopify-related actions).
function ctaHiddenForm(c, formId) {
  if (c.action_type !== 'shopify_checkout' && c.action_type !== 'shopify_addtocart') return '';
  return `
<form id="${formId}" action="/cart/add" method="post" style="display:none">
  <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
  <input type="hidden" name="quantity" value="1">
</form>`;
}

// JS that intercepts the form submit and redirects to /checkout — only for shopify_checkout.
function ctaCheckoutScript(c, formId) {
  if (c.action_type !== 'shopify_checkout') return '';
  return `
<script>(function(){
  var f = document.getElementById('${formId}');
  if (!f) return;
  f.addEventListener('submit', function(ev){
    ev.preventDefault();
    fetch('/cart/add.js', { method:'POST', body: new FormData(f) })
      .then(function(r){ return r.json(); })
      .then(function(){ window.location.href = '/checkout'; })
      .catch(function(){ window.location.href = '/cart'; });
  });
})();</script>`;
}

function renderInlineCta(elem) {
  const c = elem.config || {};
  const id = `ecom-studio-cta-${elem.id || Math.random().toString(36).slice(2,8)}`;
  const formId = `${id}-form`;
  const bg = c.use_gradient
    ? `linear-gradient(180deg, ${c.bar_grad_top || '#000'}, ${c.bar_grad_bottom || '#FFF'})`
    : (c.bar_bg_color || '#FFFFFF');
  const barStyle = [
    'display:block',
    `background:${bg}`,
    `padding:${c.pad_top ?? 10}px ${c.pad_x ?? 20}px ${c.pad_bottom ?? 10}px`,
  ].join(';');
  const innerStyle = `max-width:${c.max_width || 760}px;margin:0 auto;width:100%;text-align:center`;
  const btnStyle = ctaButtonStyle(c);
  const text = c.text || '';
  const action = ctaActionOpenTag(c, formId);
  const topLogo = c.logo_top_url
    ? `<div style="margin-bottom:8px;line-height:0;text-align:center"><img src="${escAttr(c.logo_top_url)}" alt="" style="max-height:28px;max-width:60%"></div>` : '';
  const bottomLogo = c.logo_bottom_url
    ? `<div style="margin-top:8px;line-height:0;text-align:center"><img src="${escAttr(c.logo_bottom_url)}" alt="" style="max-height:22px;max-width:55%"></div>` : '';

  return `${ctaHiddenForm(c, formId)}
<div id="${id}" style="${barStyle}">
  <div style="${innerStyle}">
    ${topLogo}${action.open} style="${btnStyle}">${escAttr(text)}</${action.close}>${bottomLogo}
  </div>
</div>${ctaCheckoutScript(c, formId)}`;
}

function renderFloatCta(elem) {
  const c = elem.config || {};
  const id = `ecom-studio-float-${elem.id || Math.random().toString(36).slice(2,8)}`;
  const formId = `${id}-form`;
  const btnStyle = ctaButtonStyle(c);
  const action = ctaActionOpenTag(c, formId);

  const barStyle = [
    'position:fixed',
    'left:0','right:0','bottom:0',
    'z-index:90',
    'display:none',
    `background:${c.bar_bg_color || '#FFFFFF'}`,
    `padding:${c.pad_top ?? 10}px ${c.pad_x ?? 20}px ${c.pad_bottom ?? 10}px`,
    'box-shadow:0 -4px 16px rgba(0,0,0,.08)',
  ].join(';');
  const innerStyle = `max-width:${c.max_width || 880}px;margin:0 auto;width:100%;text-align:center`;

  const text = c.text || '';
  const topLogo = c.logo_top_url
    ? `<div style="margin-bottom:8px;line-height:0;text-align:center"><img src="${escAttr(c.logo_top_url)}" alt="" style="max-height:28px;max-width:60%"></div>` : '';
  const bottomLogo = c.logo_bottom_url
    ? `<div style="margin-top:8px;line-height:0;text-align:center"><img src="${escAttr(c.logo_bottom_url)}" alt="" style="max-height:22px;max-width:55%"></div>` : '';

  const threshold = Math.max(0, Number(c.scroll_threshold || 300));

  return `${ctaHiddenForm(c, formId)}
<div id="${id}" style="${barStyle}">
  <div style="${innerStyle}">
    ${topLogo}${action.open} style="${btnStyle}">${escAttr(text)}</${action.close}>${bottomLogo}
  </div>
</div>
<script>
(function(){
  var el = document.getElementById('${id}');
  if (!el) return;
  var threshold = ${threshold};
  function check(){ el.style.display = (window.scrollY > threshold) ? 'block' : 'none'; }
  window.addEventListener('scroll', check, { passive:true });
  window.addEventListener('resize', check);
  check();
})();
</script>${ctaCheckoutScript(c, formId)}`;
}

function renderAuthority(c) {
  if (!c.image_url) return null;  // no image picked — skip rendering
  const wrap = [
    'display:block',
    `background:${c.bg_color || '#FFFFFF'}`,
    `padding:${c.pad_top ?? 10}px ${c.pad_x ?? 20}px ${c.pad_bottom ?? 10}px`,
    'line-height:0',
    'font-size:0',
    'text-align:center',
  ].join(';');
  const inner = `max-width:${c.max_width || 880}px;margin:0 auto;width:100%`;
  const img   = `max-width:${c.img_width || 720}px;width:100%;height:auto;display:inline-block`;
  return `<div class="ecom-studio-authority" style="${wrap}">
  <div style="${inner}"><img src="${escAttr(c.image_url)}" alt="" loading="lazy" style="${img}"></div>
</div>`;
}

function renderConnector(c) {
  const variant = c.variant === 'gradient' ? 'gradient' : 'highlighted';
  if (variant === 'gradient') {
    const top    = c.grad_color_top    || '#000';
    const bottom = c.grad_color_bottom || '#fff';
    const h      = c.grad_height       || 60;
    return `<div class="ecom-studio-connector ecom-studio-connector-gradient" style="display:block;background:linear-gradient(180deg, ${top}, ${bottom});height:${h}px;line-height:0;font-size:0"></div>`;
  }
  // Highlighted variant
  const text = c.uppercase ? String(c.text || '').toUpperCase() : (c.text || '');
  const wrap = [
    'display:block',
    `background:${c.bg_color || '#000'}`,
    `color:${c.text_color || '#FFF'}`,
    `font-size:${c.font_size || 14}px`,
    `font-weight:${c.font_weight || 700}`,
    `letter-spacing:${c.letter_spacing || 0}px`,
    `padding:${c.pad_top ?? 10}px ${c.pad_x ?? 20}px ${c.pad_bottom ?? 10}px`,
    'line-height:1.35',
    'text-align:center',
  ].join(';');
  const inner = `max-width:${c.max_width || 880}px;margin:0 auto;width:100%`;
  return `<div class="ecom-studio-connector ecom-studio-connector-highlighted" style="${wrap}">
  <div style="${inner}">${escAttr(text)}</div>
</div>`;
}

function renderAnnouncementBar(c) {
  const fontMap = {
    'system-ui': '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
  };
  const fontFamily = fontMap[c.font_family] || (c.font_family || 'sans-serif');
  const bg = c.use_gradient && c.bg_gradient_to
    ? `linear-gradient(90deg, ${c.bg_color || '#000'}, ${c.bg_gradient_to})`
    : (c.bg_color || '#000');
  const text = c.uppercase ? String(c.text || '').toUpperCase() : (c.text || '');
  const stickyCss = c.sticky ? 'position:sticky;top:0;z-index:50;' : '';
  const styles = [
    'display:block',
    `background:${bg}`,
    `color:${c.text_color || '#fff'}`,
    `font-family:${fontFamily}`,
    `font-size:${c.font_size || 14}px`,
    `font-weight:${c.font_weight || 500}`,
    `letter-spacing:${c.letter_spacing || 0}px`,
    `padding:${c.padding_v ?? 15}px ${c.padding_h ?? 20}px`,
    'text-align:center',
    'line-height:1.35',
    stickyCss,
  ].join(';');
  const innerStyles = `max-width:${c.max_width || 1200}px;margin:0 auto;width:100%`;
  const anchor = c.anchor_id ? ` id="${escAttr(c.anchor_id)}"` : '';
  return `<div${anchor} class="ecom-studio-announcement-bar" style="${styles}">
  <div style="${innerStyles}">${escAttr(text)}</div>
</div>`;
}

// JSON template: a single section, full-bleed. No header/footer here — those live in layout/theme.liquid.
function buildTemplateJson({ suffix }) {
  const tpl = {
    sections: {
      main: { type: suffix, settings: {} },
    },
    order: ['main'],
  };
  return JSON.stringify(tpl, null, 2);
}
legacy end */

module.exports = router;
