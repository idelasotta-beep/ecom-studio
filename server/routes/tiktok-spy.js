const express = require('express');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');
const { tiktok_spy_searches, tiktok_spy_products, tiktok_spy_folders, tiktok_spy_saved, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Long-running undici agent — needed because coregent actor processes products
// one-by-one and can take 1-6 minutes. Default Node fetch aborts headers at 5min.
const longRunningAgent = new UndiciAgent({
  headersTimeout: 10 * 60 * 1000,  // 10 min waiting for headers
  bodyTimeout:    10 * 60 * 1000,  // 10 min waiting for body
  connectTimeout: 30 * 1000,
});

// ── Configurable via env ─────────────────────────────────────────
// Default actor: pratikdani/tiktok-shop-search-scraper
//   Purpose:  keyword search across TikTok Shop with region support
//   Pricing:  pay-per-event (free trial available)
//   Output:   40+ fields per product — title, price, currency, sold_count,
//             rating, images/videos, seller, category, weekly_sales, country_code...
// Actor alternatives (swap via env APIFY_TIKTOK_ACTOR_ID):
//   - pratikdani~tiktok-shop-search-scraper   (DEFAULT — only viable FREE option, capped at 10/query)
//   - pro100chok~tiktok-shop-scraper          (50 products US-only — trial expires, then $20/mo subscription)
//   - novi~tiktok-shop-scraper                ($38/mo subscription, under maintenance — paid)
//
// Actors evaluated and rejected:
//   - coregent~tiktok-shop-product-scraper    (mislabeled — returns TikTok videos, not products)
//   - charitable_aquarium~tiktok-shop-scraper (broken — returns "Unknown" placeholder data, 1.6/5 stars)
const APIFY_ACTOR_ID    = process.env.APIFY_TIKTOK_ACTOR_ID || 'pratikdani~tiktok-shop-search-scraper';

// Countries supported by charitable_aquarium (subset of all TikTok Shop markets)
const CHARITABLE_AQUARIUM_COUNTRIES = ['US', 'UK', 'GB', 'ID', 'MY', 'SG', 'PH'];
const APIFY_TIMEOUT_MS  = Number(process.env.APIFY_TIKTOK_TIMEOUT_MS || 240_000); // 4 min for pratikdani
const APIFY_MEMORY_MB   = Number(process.env.APIFY_TIKTOK_MEMORY_MB  || 1024);
const RATE_LIMIT_PER_HOUR = Number(process.env.TIKTOK_SPY_RATE_LIMIT || 10);
const MAX_RESULTS_CAP   = Number(process.env.APIFY_TIKTOK_MAX_RESULTS || 30);      // pratikdani caps at 10 internally; sending 30 still works

// ── Supported TikTok Shop countries (ISO-2) ──────────────────────
// Only countries where TikTok Shop is officially operating. Mexico, Brazil,
// Japan, Germany, France, Italy, Spain, Ireland are NOT TikTok Shop markets.
const COUNTRIES = [
  { code: 'US', name: 'United States',  flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'ID', name: 'Indonesia',      flag: '🇮🇩' },
  { code: 'TH', name: 'Thailand',       flag: '🇹🇭' },
  { code: 'VN', name: 'Vietnam',        flag: '🇻🇳' },
  { code: 'MY', name: 'Malaysia',       flag: '🇲🇾' },
  { code: 'PH', name: 'Philippines',    flag: '🇵🇭' },
  { code: 'SG', name: 'Singapore',      flag: '🇸🇬' },
];
const COUNTRY_CODES = new Set(COUNTRIES.map(c => c.code));

router.get('/countries', (_req, res) => {
  res.json({ countries: COUNTRIES });
});

// ── Searches ─────────────────────────────────────────────────────
router.get('/searches', (req, res) => {
  res.json({ searches: tiktok_spy_searches.forUser(req.user.id, 50) });
});

router.get('/searches/:id', (req, res) => {
  const search = tiktok_spy_searches.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!search) return res.status(404).json({ error: 'Búsqueda no encontrada' });
  const products = tiktok_spy_products.forSearch(search.id).map(mapProductForResponse(req.user.id));
  res.json({ search, products });
});

router.delete('/searches/:id', (req, res) => {
  const ok = tiktok_spy_searches.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Búsqueda no encontrada' });
  res.json({ message: 'Búsqueda eliminada' });
});

// ── POST /api/tiktok-spy/search — run Apify scrape ──────────────
router.post('/search', async (req, res) => {
  const settings = user_settings.get(req.user.id);
  const apifyKey = settings?.apify_key;
  if (!apifyKey)
    return res.status(402).json({ error: 'Configura tu API key de Apify en Ajustes → APIs' });

  // Rate limiting
  const recent = tiktok_spy_searches.countLastHour(req.user.id);
  if (recent >= RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({
      error: `Has alcanzado el límite de ${RATE_LIMIT_PER_HOUR} búsquedas por hora. Intenta más tarde.`,
      retry_after_minutes: 60,
    });
  }

  const { query, country = 'US' } = req.body;
  if (!query || !String(query).trim())
    return res.status(400).json({ error: 'Falta el término de búsqueda' });

  const safeCountry = COUNTRY_CODES.has(country) ? country : 'US';
  const safeQuery   = String(query).trim().slice(0, 120);

  // ── Build actor input — flexible schema covering several actors ──
  // pratikdani/tiktok-shop-search-scraper accepts keyword + country_code + max.
  // We also pass alternate keys (region, query, searchQuery, ...) so swapping
  // actors via env still works without code changes.
  // Build actor input — schema varies per actor; some actors reject unknown fields.
  // Detect actor by ID prefix and send only the fields it expects.
  const actorIdLower = APIFY_ACTOR_ID.toLowerCase();
  let actorInput;
  if (actorIdLower.includes('charitable_aquarium') || actorIdLower.includes('charitable-aquarium')) {
    // charitable_aquarium/tiktok-shop-scraper — searchQueries (array) + region + maxProducts
    // Only supports US/UK/ID/MY/SG/PH — fall back to US for unsupported markets
    const normalizedCountry = CHARITABLE_AQUARIUM_COUNTRIES.includes(safeCountry) ? safeCountry : 'US';
    actorInput = {
      searchQueries: [safeQuery],
      region:        normalizedCountry === 'UK' ? 'GB' : normalizedCountry, // some schemas use GB instead of UK
      maxProducts:   MAX_RESULTS_CAP,
    };
  } else if (actorIdLower.includes('coregent')) {
    // coregent/tiktok-shop-product-scraper — DO NOT USE (returns videos)
    actorInput = {
      keywords:   [safeQuery],
      countries:  [safeCountry],
      maxResults: MAX_RESULTS_CAP,
    };
  } else if (actorIdLower.includes('pro100chok')) {
    // pro100chok/tiktok-shop-scraper — US-only, uses searchKeywords array + maxItems
    actorInput = {
      searchKeywords: [safeQuery],
      maxItems:       Math.min(MAX_RESULTS_CAP, 50), // actor's hard cap is 50
      sortType:       'best_sellers',
    };
  } else if (actorIdLower.includes('novi')) {
    // novi/tiktok-shop-scraper — keyword + region + limit
    actorInput = {
      keyword: safeQuery,
      region:  safeCountry,
      limit:   MAX_RESULTS_CAP,
    };
  } else {
    // pratikdani/tiktok-shop-search-scraper or other — kitchen-sink approach
    actorInput = {
      keyword:       safeQuery,
      country_code:  safeCountry,
      countryCode:   safeCountry,
      max:           MAX_RESULTS_CAP,
      query:         safeQuery,
      searchQuery:   safeQuery,
      searchTerm:    safeQuery,
      country:       safeCountry,
      limit:         Math.min(MAX_RESULTS_CAP, 10),
      maxItems:      MAX_RESULTS_CAP,
      maxProducts:   MAX_RESULTS_CAP,
      sortType:      'BEST_SELLERS',
      sortBy:        'best_selling',
    };
  }
  // Add proxy config only for actors that accept it (coregent rejects unknown fields)
  if (!actorIdLower.includes('coregent')) {
    actorInput.proxyConfiguration = {
      useApifyProxy:    true,
      apifyProxyGroups: ['RESIDENTIAL'],
    };
  }

  console.log(`[tiktok-spy] search query="${safeQuery}" country=${safeCountry} actor=${APIFY_ACTOR_ID}`);
  let datasetItems;
  try {
    datasetItems = await callApifyActor(apifyKey, APIFY_ACTOR_ID, actorInput, APIFY_TIMEOUT_MS);
    console.log(`[tiktok-spy] Apify returned ${Array.isArray(datasetItems) ? datasetItems.length : 'non-array'} items`);
  } catch (err) {
    console.error('[tiktok-spy] Apify call failed:', err.message);
    // Parse common Apify error types and rewrite to friendly messages
    const msg = String(err.message || '');
    if (msg.includes('actor-is-not-rented') || msg.includes('You must rent a paid Actor')) {
      return res.status(402).json({
        error: 'El actor de TikTok Shop requiere alquiler en Apify',
        details: `El trial gratuito del actor ${APIFY_ACTOR_ID.replace('~','/')} expiró. Tienes dos opciones: (1) Alquílalo en https://console.apify.com/actors → busca el actor → "Rent actor". (2) Cambia a otro actor seteando la variable de entorno APIFY_TIKTOK_ACTOR_ID en el .env del servidor (ej: pratikdani~tiktok-shop-scraper).`,
      });
    }
    if (msg.includes('record-not-found') || msg.includes('Actor with this name was not found')) {
      return res.status(502).json({
        error: 'El actor configurado no existe en Apify',
        details: `Actor: ${APIFY_ACTOR_ID}. Verifica el ID o cambia con APIFY_TIKTOK_ACTOR_ID en .env.`,
      });
    }
    if (msg.includes('Apify 401') || msg.includes('Authentication')) {
      return res.status(401).json({
        error: 'API key de Apify inválida',
        details: 'Revisa tu Apify token en Ajustes → APIs.',
      });
    }
    if (msg.includes('TIMED-OUT') || msg.includes('Timeout') || msg.includes('run-failed')) {
      return res.status(504).json({
        error: 'La búsqueda en TikTok Shop tardó demasiado',
        details: 'El actor de Apify no terminó a tiempo. Esto suele pasar con keywords muy populares. Prueba: (1) un término más específico, (2) volver a intentar (TikTok puede estar bloqueando), o (3) aumentar el timeout subiendo APIFY_TIKTOK_TIMEOUT_MS en .env.',
      });
    }
    return res.status(502).json({
      error: `Error al consultar TikTok Shop: ${msg}`,
      details: 'Verifica tu API key de Apify y que el actor esté disponible.',
    });
  }

  if (!Array.isArray(datasetItems) || datasetItems.length === 0) {
    return res.status(404).json({ error: 'No se encontraron productos para esa búsqueda' });
  }

  // Detect actor error envelope
  if (datasetItems[0]) {
    const sample = datasetItems[0];
    const keys = Object.keys(sample);
    if (keys.length <= 3 && (sample.error || sample.message || sample.errorMessage)) {
      console.error('[tiktok-spy] Actor returned error envelope:', JSON.stringify(sample));
      return res.status(502).json({
        error: 'El actor de Apify devolvió un error',
        details: sample.error || sample.message || sample.errorMessage,
      });
    }
  }

  // Persist
  const search = tiktok_spy_searches.insert({
    user_id: req.user.id,
    query:   safeQuery,
    country: safeCountry,
    results_count: 0,
  });

  const productsToInsert = datasetItems
    .map(item => normalizeProduct(item, safeCountry))
    .filter(p => p && p.title)
    .map(p => ({ ...p, search_id: search.id }));

  const inserted = tiktok_spy_products.insertBatch(productsToInsert);

  // Update the count
  const db = require('../db');
  // Quick-and-dirty in-place update: re-fetch + save count via re-insert pattern isn't ideal,
  // but for now we just return the count.
  res.json({
    search: { ...search, query: safeQuery, country: safeCountry, results_count: inserted.length },
    products: inserted.map(mapProductForResponse(req.user.id)),
  });
});

// ── Folders ──────────────────────────────────────────────────────
router.get('/folders', (req, res) => {
  const folders = tiktok_spy_folders.forUser(req.user.id).map(f => {
    const count = (require('../db').tiktok_spy_saved.forUser(req.user.id) || []).filter(s => s.folder_id == f.id).length;
    return { ...f, count };
  });
  res.json({ folders });
});

router.post('/folders', (req, res) => {
  const { name, color } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta el nombre' });
  const f = tiktok_spy_folders.insert({ user_id: req.user.id, name: String(name).trim().slice(0, 60), color });
  res.status(201).json({ folder: { id: f.id, name, color: color || '#8b5cf6' } });
});

router.patch('/folders/:id', (req, res) => {
  const ok = tiktok_spy_folders.update(req.params.id, req.user.id, {
    ...(req.body.name  ? { name:  String(req.body.name).trim().slice(0, 60) } : {}),
    ...(req.body.color ? { color: req.body.color } : {}),
  });
  if (!ok) return res.status(404).json({ error: 'Carpeta no encontrada' });
  res.json({ message: 'Carpeta actualizada' });
});

router.delete('/folders/:id', (req, res) => {
  const ok = tiktok_spy_folders.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Carpeta no encontrada' });
  res.json({ message: 'Carpeta eliminada' });
});

// ── My Library (saved products) ──────────────────────────────────
router.get('/saved', (req, res) => {
  const savedRows = tiktok_spy_saved.forUser(req.user.id);
  const productsById = new Map();
  (require('../db').tiktok_spy_products || []).forEach?.(() => {}); // noop guard
  // Pull product detail for each saved row
  const items = savedRows.map(s => {
    const prod = tiktok_spy_products.one({ id: s.product_id });
    if (!prod) return null;
    return {
      ...mapProductRow(prod),
      saved_id:  s.id,
      folder_id: s.folder_id,
      saved_at:  s.saved_at,
      is_saved:  true,
    };
  }).filter(Boolean);
  res.json({ items, total: items.length });
});

router.post('/saved', (req, res) => {
  const { product_id, folder_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Falta product_id' });
  const prod = tiktok_spy_products.one({ id: product_id });
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const r = tiktok_spy_saved.insert({ user_id: req.user.id, product_id, folder_id });
  res.status(201).json({ id: r.id, already_saved: !!r.already_saved });
});

router.delete('/saved/:id', (req, res) => {
  const ok = tiktok_spy_saved.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Quitado de la biblioteca' });
});

router.delete('/saved/by-product/:productId', (req, res) => {
  const ok = tiktok_spy_saved.deleteByProduct(req.params.productId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Quitado de la biblioteca' });
});

router.patch('/saved/:id', (req, res) => {
  const ok = tiktok_spy_saved.moveToFolder(req.params.id, req.user.id, req.body.folder_id || null);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Movido' });
});

// ── Apify utility ────────────────────────────────────────────────
async function callApifyActor(apiKey, actorId, input, timeoutMs) {
  const apifyTimeoutSec = Math.floor(timeoutMs / 1000);
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(apiKey)}&timeout=${apifyTimeoutSec}&memory=${APIFY_MEMORY_MB}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs + 5_000);
  try {
    const r = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
      dispatcher: longRunningAgent,
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`Apify ${r.status}: ${errBody.slice(0, 200) || r.statusText}`);
    }
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('Respuesta inesperada de Apify (no es array)');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms) al esperar respuesta de Apify`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ── Normalization: TikTok Shop scrapers vary in field names. Try many. ──
// pratikdani:      product_id, product_name, product_url, price, discounted_price, currency,
//                  image_url, rating, rating_count, sales_count, country_code,
//                  shop_name, shop_id, shop_url, weekly_sales, stock, ...
// sovereigntaylor: title, price, originalPrice, currency, productLink, productId,
//                  images[], seller{name,rating,sales}, salesVolume, rating
// novi:            product_id, title, price, cover, sold_count, product_rating,
//                  seller_product_info, format_price, currency
function normalizeProduct(item, defaultCountry) {
  if (!item || typeof item !== 'object') return null;
  const get = (...keys) => {
    for (const k of keys) {
      const v = item[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const num = v => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // Image: try several locations, including nested arrays
  let image = get('cover_url', 'image_url', 'imageUrl', 'cover', 'img', 'cover_image', 'image', 'thumbnail', 'main_image', 'product_image', 'product_image_url');
  if (!image && Array.isArray(item.images) && item.images.length) image = item.images[0];
  if (!image && Array.isArray(item.image_list) && item.image_list.length) image = item.image_list[0];
  if (image && typeof image === 'object') image = image.url || image.src || image.url_list?.[0] || null;
  // Seller info (varies by actor: nested object, or flat keys)
  const seller = item.seller || item.seller_product_info || item.shop || null;
  const shopName = seller && typeof seller === 'object'
    ? (seller.name || seller.seller_name || seller.shop_name || null)
    : (typeof seller === 'string' ? seller : null);
  const shopId = seller && typeof seller === 'object'
    ? (seller.id || seller.seller_id || seller.shop_id || null)
    : null;
  // Sales count — pratikdani uses total_sale_cnt, charitable_aquarium uses soldCount
  const sold = num(get('soldCount', 'total_sale_cnt', 'sales_count', 'sold_count', 'sold', 'sales', 'total_sold', 'salesVolume', 'sales_volume', 'total_sale_30d_cnt')) ??
               num(seller && typeof seller === 'object' ? seller.sales : null);
  const rating = num(get('rating', 'product_rating', 'score', 'avg_rating', 'stars', 'ratingAverage')) ??
                 num(seller && typeof seller === 'object' ? seller.rating : null);

  return {
    external_id: String(get('productId', 'product_id', 'product_id_str', 'id', 'sku_id') || ''),
    title:       String(get('productName', 'product_name', 'title', 'product_title', 'name') || '').slice(0, 300),
    price:       num(get('price', 'avg_price', 'discounted_price', 'salePrice', 'currentPrice', 'sale_price', 'current_price', 'min_price', 'format_price', 'real_price')),
    currency:    String(get('currency', 'currency_code', 'currencyCode') || '').slice(0, 5) || null,
    sold_count:  sold,
    rating:      rating,
    image_url:   image || null,
    shop_name:   shopName ? String(shopName).slice(0, 200) : (String(get('shopName', 'shop_name', 'sellerName', 'store_name', 'shop') || '').slice(0, 200) || null),
    shop_id:     shopId ? String(shopId) : (String(get('shopId', 'shop_id', 'sellerId', 'store_id') || '') || null),
    product_url: String(get('productUrl', 'product_url', 'productLink', 'url', 'link', 'detail_url') || '') || null,
    country:     String(get('country_code', 'country', 'region') || defaultCountry || '').toUpperCase(),
    raw:         item,
  };
}

function mapProductRow(p) {
  return {
    id: p.id,
    external_id: p.external_id,
    title: p.title,
    price: p.price,
    currency: p.currency,
    sold_count: p.sold_count,
    rating: p.rating,
    image_url: p.image_url,
    shop_name: p.shop_name,
    shop_id: p.shop_id,
    product_url: p.product_url,
    country: p.country,
  };
}

function mapProductForResponse(userId) {
  return p => {
    const base = mapProductRow(p);
    base.is_saved = tiktok_spy_saved.isSaved(userId, p.id);
    return base;
  };
}

module.exports = router;
