const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { meta_spy_searches, meta_spy_ads, meta_spy_folders, meta_spy_saved, meta_spy_competitors, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir, dbFile } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const META_DIR = mediaDir('meta-ads');
const DB_FILE  = dbFile();

// ── Configurable via env (sensible defaults) ─────────────────────
const APIFY_ACTOR_ID  = process.env.APIFY_ACTOR_ID  || 'curious_coder~facebook-ads-library-scraper';
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || 90_000);
const APIFY_MEMORY_MB  = Number(process.env.APIFY_MEMORY_MB  || 512);
const RATE_LIMIT_PER_HOUR = Number(process.env.META_SPY_RATE_LIMIT || 10);
const MAX_RESULTS_CAP     = 100;
const DOWNLOAD_TIMEOUT_MS = 12_000;

// ── GET /api/meta-spy/searches — list user's saved searches ──────
router.get('/searches', (req, res) => {
  const list = meta_spy_searches.forUser(req.user.id, 50);
  res.json({ searches: list });
});

// ── GET /api/meta-spy/searches/:id — get cached results ──────────
router.get('/searches/:id', (req, res) => {
  const search = meta_spy_searches.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!search) return res.status(404).json({ error: 'Búsqueda no encontrada' });
  const ads = meta_spy_ads.forSearch(search.id).map(a => mapAdForResponse(a));
  res.json({ search, ads });
});

// ── DELETE /api/meta-spy/searches/:id ────────────────────────────
router.delete('/searches/:id', (req, res) => {
  const ads = meta_spy_ads.forSearch(Number(req.params.id));
  ads.forEach(a => {
    if (a.local_path) {
      try { fs.unlinkSync(path.join(META_DIR, a.local_path)); } catch (_) {}
    }
  });
  const ok = meta_spy_searches.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Búsqueda no encontrada' });
  res.json({ message: 'Búsqueda eliminada' });
});

// ── POST /api/meta-spy/search — run Apify scrape ─────────────────
router.post('/search', async (req, res) => {
  const settings = user_settings.get(req.user.id);
  const apifyKey = settings?.apify_key;
  if (!apifyKey)
    return res.status(402).json({ error: 'Configura tu API key de Apify en Ajustes → APIs' });

  // ── Rate limiting (per-user, last hour) ──────────────────────────
  const recent = meta_spy_searches.countLastHour(req.user.id);
  if (recent >= RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({
      error: `Has alcanzado el límite de ${RATE_LIMIT_PER_HOUR} búsquedas por hora. Intenta más tarde.`,
      retry_after_minutes: 60,
    });
  }

  // ── Validate inputs ──────────────────────────────────────────────
  const {
    query,
    country          = 'all',
    media_type       = 'all',  // 'image' | 'video' | 'meme' | 'image-meme' | 'all'
    days_active      = 'all',  // 'all' | '0-100' | '100-200' | '200-300' | '300-500' | '500+'
    active_ads_count = 'all',  // 'all' | '1' | '2-5' | '6-10' | '10-20' | '20+'
    search_type      = 'broad',// 'broad' | 'exact'
  } = req.body;

  if (!query || !String(query).trim())
    return res.status(400).json({ error: 'Falta el término de búsqueda' });

  // Cap fixed at server level — we always scrape "active" ads from Meta
  const safeMax  = MAX_RESULTS_CAP;
  const adActive = 'active';

  // ── Build Facebook Ads Library URL the actor will scrape ─────────
  const fbUrl = buildAdsLibraryUrl({
    query:       String(query).trim(),
    country,
    ad_active:   adActive,
    search_type,
  });

  // ── Apify Actor input — Residential proxy is MANDATORY ───────────
  const actorInput = {
    urls:  [{ url: fbUrl, method: 'GET' }],
    count: safeMax,
    'scrapeAdDetails': true,
    'scrapePageAds.activeStatus': adActive,
    proxyConfiguration: {
      useApifyProxy:    true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  };

  // ── Call Apify with hard timeout ─────────────────────────────────
  const startedAt = Date.now();
  let datasetItems;
  try {
    datasetItems = await callApifyActor(apifyKey, APIFY_ACTOR_ID, actorInput, APIFY_TIMEOUT_MS);
  } catch (err) {
    console.error('[meta-spy] Apify call failed:', err.message);
    return res.status(502).json({
      error: `Error al consultar Meta Ads Library: ${err.message}`,
      details: 'Verifica tu API key de Apify.',
    });
  }

  if (!Array.isArray(datasetItems) || datasetItems.length === 0) {
    return res.status(404).json({ error: 'No se encontraron anuncios para esa búsqueda' });
  }

  // ── Detect actor error envelope (e.g. memory/URL ratio violations) ──
  if (datasetItems[0]) {
    const sample = datasetItems[0];
    const keys = Object.keys(sample);
    if (keys.length <= 3 && (sample.error || sample.message || sample.errorMessage)) {
      console.error('[meta-spy] Actor returned error envelope:', JSON.stringify(sample));
      return res.status(502).json({
        error: 'El actor de Apify devolvió un error',
        details: sample.error || sample.message || sample.errorMessage,
      });
    }
  }

  // ── Persist a search row to anchor the ads ───────────────────────
  const search = meta_spy_searches.insert({
    user_id:     req.user.id,
    query:       String(query).trim(),
    country,
    ad_active:   adActive,
    media_type,
    days_active,
    active_ads_count,
    search_type,
    max_results: safeMax,
  });

  // ── Pre-compute # active ads per page_id for the active_ads_count filter ──
  const adsPerPage = {};
  for (const item of datasetItems) {
    const pid = item?.page_id || item?.snapshot?.page_id;
    if (pid) adsPerPage[pid] = (adsPerPage[pid] || 0) + 1;
  }

  // ── Normalize, filter, download media, and persist ads ───────────
  const adsToInsert = [];
  for (const item of datasetItems) {
    const norm = normalizeApifyAd(item);

    // Tipo de medio (Apify sólo distingue image/video; meme = image)
    if ((media_type === 'image' || media_type === 'meme') && norm.media_type !== 'image') continue;
    if (media_type === 'video' && norm.media_type !== 'video') continue;
    // 'image-meme' incluye todo lo que sea imagen — el meme es imagen, ya pasa.
    if (media_type === 'image-meme' && norm.media_type !== 'image') continue;

    // Días activos (calculado desde start_date)
    if (days_active && days_active !== 'all') {
      const days = computeDaysActive(norm.start_date);
      if (!matchesDaysRange(days, days_active)) continue;
    }

    // # anuncios activos por página
    if (active_ads_count && active_ads_count !== 'all') {
      const cnt = adsPerPage[norm.page_id] || 0;
      if (!matchesCountRange(cnt, active_ads_count)) continue;
    }

    let localFile = null;
    if (norm.original_url) {
      try {
        localFile = await downloadAndStore(norm.original_url, norm.media_type);
      } catch (err) {
        console.warn('[meta-spy] media download failed:', err.message, norm.original_url);
      }
    }

    adsToInsert.push({
      search_id:        search.id,
      user_id:          req.user.id,
      page_id:          norm.page_id,
      page_name:        norm.page_name,
      page_profile_pic: norm.page_profile_pic,
      ad_text:          norm.ad_text,
      title:            norm.title,
      caption:          norm.caption,
      link_description: norm.link_description,
      cta_text:         norm.cta_text,
      cta_type:         norm.cta_type,
      link_url:         norm.link_url,
      media_type:       norm.media_type,
      local_path:       localFile,
      original_url:     norm.original_url,
      start_date:       norm.start_date,
      end_date:         norm.end_date,
      platforms:        norm.platforms,
      display_format:   norm.display_format,
      ad_archive_id:    norm.ad_archive_id,
      collation_count:  norm.collation_count,
      categories:       norm.categories,
      is_active:        norm.is_active,
      snapshot_url:     norm.snapshot_url,
    });
  }

  const inserted = meta_spy_ads.insertMany(adsToInsert);

  // ── Update search metadata (results_count + duration_ms) ────────
  try {
    const dbFile = DB_FILE;
    const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const idx = (raw.meta_spy_searches || []).findIndex(r => r.id === search.id);
    if (idx !== -1) {
      raw.meta_spy_searches[idx].results_count = inserted.length;
      raw.meta_spy_searches[idx].duration_ms   = Date.now() - startedAt;
      const tmp = dbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(raw));
      fs.renameSync(tmp, dbFile);
    }
  } catch (err) {
    console.warn('[meta-spy] No se pudo actualizar metadata de búsqueda:', err.message);
  }

  // ── Build clean response ────────────────────────────────────────
  res.json({
    search_id:     search.id,
    query:         String(query).trim(),
    country,
    media_type, days_active, active_ads_count, search_type,
    results_count: inserted.length,
    duration_ms:   Date.now() - startedAt,
    ads: inserted.map(a => mapAdForResponse(a)),
  });
});

// Shared formatter used by all endpoints that return ad rows
function mapAdForResponse(a) {
  return {
    id:               a.id,
    page_id:          a.page_id,
    page_name:        a.page_name,
    page_profile_pic: a.page_profile_pic || null,
    ad_text:          a.ad_text,
    title:            a.title || null,
    caption:          a.caption || null,
    link_description: a.link_description || null,
    cta_text:         a.cta_text,
    cta_type:         a.cta_type || null,
    link_url:         a.link_url,
    media_type:       a.media_type,
    image_url:        a.local_path ? `/meta-ads/${a.local_path}` : null,
    start_date:       a.start_date,
    end_date:         a.end_date || null,
    platforms:        a.platforms,
    display_format:   a.display_format || null,
    ad_archive_id:    a.ad_archive_id || null,
    collation_count:  a.collation_count || null,
    categories:       a.categories || [],
    is_active:        a.is_active !== undefined ? a.is_active : true,
    snapshot_url:     a.snapshot_url,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function buildAdsLibraryUrl({ query, country, ad_active, search_type }) {
  // Meta supports 'keyword_unordered' (broad/amplia) y 'keyword_exact_phrase' (exacta)
  const fbSearchType = search_type === 'exact' ? 'keyword_exact_phrase' : 'keyword_unordered';
  const params = new URLSearchParams({
    active_status: ad_active === 'all' ? 'all' : (ad_active === 'active' ? 'active' : 'inactive'),
    ad_type:       'all',
    country:       (country || 'ALL').toUpperCase(),
    q:             query,
    search_type:   fbSearchType,
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function computeDaysActive(startDate) {
  if (startDate == null || startDate === '') return null;

  let ms;
  if (typeof startDate === 'number') {
    // Unix timestamp: <10^11 → seconds, else milliseconds
    ms = startDate < 1e11 ? startDate * 1000 : startDate;
  } else {
    // String: try as ISO; if pure digits, treat as Unix seconds
    const s = String(startDate).trim();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      ms = n < 1e11 ? n * 1000 : n;
    } else {
      ms = new Date(s).getTime();
    }
  }

  if (!ms || isNaN(ms)) return null;
  const diffMs = Date.now() - ms;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function matchesDaysRange(days, range) {
  if (days == null) return false;
  switch (range) {
    case '0-100':   return days >= 0   && days <= 100;
    case '100-200': return days >  100 && days <= 200;
    case '200-300': return days >  200 && days <= 300;
    case '300-500': return days >  300 && days <= 500;
    case '500+':    return days >  500;
    default:        return true;
  }
}

function matchesCountRange(count, range) {
  switch (range) {
    case '1':     return count === 1;
    case '2-5':   return count >= 2  && count <= 5;
    case '6-10':  return count >= 6  && count <= 10;
    case '10-20': return count >= 10 && count <= 20;
    case '20+':   return count >  20;
    default:      return true;
  }
}

async function callApifyActor(apiKey, actorId, input, timeoutMs) {
  // run-sync-get-dataset-items: blocks until run finishes, returns dataset items as JSON.
  // We add ?timeout (Apify-side) and a client-side AbortController for hard control.
  const apifyTimeoutSec = Math.floor(timeoutMs / 1000);
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(apiKey)}&timeout=${apifyTimeoutSec}&memory=${APIFY_MEMORY_MB}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs + 5_000);

  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(input),
      signal:  ctrl.signal,
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

// Normalize the raw Apify ad object into a stable shape
function normalizeApifyAd(item) {
  // The exact field names vary across actors; we try several common shapes.
  const snap = item?.snapshot || item;
  const text =
    snap?.body?.text ||
    snap?.body ||
    item?.ad_creative_body ||
    item?.adCreativeBody ||
    item?.body_text ||
    item?.text ||
    '';

  const pageName = snap?.page_name || item?.page_name || item?.pageName || null;
  const pageId   = snap?.page_id   || item?.page_id   || item?.pageId   || null;
  const pageProfilePic = snap?.page_profile_picture_url || snap?.page_profile_pic_url || item?.page_profile_picture_url || null;

  // Prefer video URL when present, fall back to first image
  let mediaType   = 'image';
  let mediaUrl    = null;
  const videos    = snap?.videos || item?.videos || [];
  const images    = snap?.images || item?.images || [];
  const cards     = snap?.cards  || item?.cards  || [];

  if (Array.isArray(videos) && videos.length) {
    mediaType = 'video';
    mediaUrl  = videos[0]?.video_hd_url || videos[0]?.video_sd_url || videos[0]?.url || videos[0]?.video_preview_image_url || videos[0]?.preview_image_url || null;
  } else if (Array.isArray(images) && images.length) {
    mediaUrl  = images[0]?.original_image_url || images[0]?.resized_image_url || images[0]?.url || null;
  } else if (Array.isArray(cards) && cards.length) {
    mediaUrl  = cards[0]?.original_image_url || cards[0]?.resized_image_url || cards[0]?.video_hd_url || cards[0]?.video_sd_url || null;
  }
  // Some actor variants flatten the URL on the root
  if (!mediaUrl) mediaUrl = item?.image || item?.imageUrl || item?.video || null;

  // Start / End dates
  const startDate =
    snap?.start_date ||
    item?.start_date ||
    item?.startDate  ||
    item?.first_seen ||
    null;
  const endDate = snap?.end_date || item?.end_date || null;

  // Platforms (where the ad runs)
  let platforms = item?.publisher_platform || item?.publisherPlatform || snap?.publisher_platform || [];
  if (!Array.isArray(platforms)) platforms = platforms ? [String(platforms)] : [];

  // CTA / link / domain / headline / description
  const cta         = snap?.cta_text  || item?.cta_text || item?.ctaText || null;
  const ctaType     = snap?.cta_type  || item?.cta_type || null;
  const linkUrl     = snap?.link_url  || item?.link_url || item?.url     || item?.landingUrl || null;
  const title       = snap?.title || snap?.headline || item?.title || null;
  const caption     = snap?.caption || item?.caption || null;
  const linkDescription = snap?.link_description || snap?.description || item?.link_description || null;

  // Display format (single_image, video, carousel, dpa, dco, etc.)
  const displayFormat = snap?.display_format || item?.display_format || null;

  // Library / archive ID (Meta's official ID)
  const adArchiveId = item?.ad_archive_id || item?.adArchiveID || snap?.ad_archive_id || null;

  // Variants (number of similar ads grouped)
  const collationCount = item?.collation_count || item?.collationCount || null;

  // Categories (industry hints)
  let categories = item?.categories || snap?.categories || [];
  if (!Array.isArray(categories)) categories = categories ? [String(categories)] : [];

  // Active / paused
  const isActive = item?.is_active !== undefined ? !!item.is_active : (snap?.is_active !== undefined ? !!snap.is_active : true);

  // Snapshot / library link — prefer Meta's official permalink
  const snapshotUrl = item?.url || item?.permalink_url || item?.snapshot_url ||
    (adArchiveId ? `https://www.facebook.com/ads/library/?id=${adArchiveId}` : null);

  return {
    page_id:          pageId,
    page_name:        pageName,
    page_profile_pic: pageProfilePic,
    ad_text:          String(text || '').slice(0, 5000),
    title:            title ? String(title).slice(0, 500) : null,
    caption:          caption ? String(caption).slice(0, 300) : null,
    link_description: linkDescription ? String(linkDescription).slice(0, 800) : null,
    cta_text:         cta,
    cta_type:         ctaType,
    link_url:         linkUrl,
    media_type:       mediaType,
    original_url:     mediaUrl,
    start_date:       startDate,
    end_date:         endDate,
    platforms:        platforms.slice(0, 10),
    display_format:   displayFormat,
    ad_archive_id:    adArchiveId ? String(adArchiveId) : null,
    collation_count:  collationCount ? Number(collationCount) : null,
    categories:       categories.slice(0, 5),
    is_active:        isActive,
    snapshot_url:     snapshotUrl,
  };
}

// Download a Meta CDN URL and persist it under server/meta-ads/{filename}
async function downloadAndStore(url, mediaType) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) throw new Error('archivo descargado muy pequeño'); // likely an error page
    const ext  = mediaType === 'video' ? 'mp4' : detectImageExt(buf, url) || 'jpg';
    const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(META_DIR, name), buf);
    return name;
  } finally {
    clearTimeout(t);
  }
}

function detectImageExt(buf, url) {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  // WebP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // Fall back to URL extension
  const m = (url || '').match(/\.(png|jpg|jpeg|webp|gif|mp4)(\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
}

// ─────────────────────────────────────────────────────────────────
// LIBRARY: Folders + Saved ads
// ─────────────────────────────────────────────────────────────────

// GET /api/meta-spy/library/summary — counts for the header chips
router.get('/library/summary', (req, res) => {
  res.json({
    saved_count:      meta_spy_saved.countForUser(req.user.id),
    competitor_count: meta_spy_competitors.countForUser(req.user.id),
  });
});

// GET /api/meta-spy/folders — list user's folders + ad count per folder
router.get('/folders', (req, res) => {
  const folders = meta_spy_folders.forUser(req.user.id);
  const allSaved = meta_spy_saved.forUser(req.user.id, null);
  const counts = { all: allSaved.length };
  folders.forEach(f => {
    counts[f.id] = allSaved.filter(s => s.folder_id == f.id).length;
  });
  counts.unfiled = allSaved.filter(s => s.folder_id == null).length;
  res.json({ folders, counts });
});

// POST /api/meta-spy/folders — create folder
router.post('/folders', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre de la carpeta' });
  const f = meta_spy_folders.insert({ user_id: req.user.id, name });
  res.status(201).json({ id: f.id, name });
});

// PUT /api/meta-spy/folders/:id — rename
router.put('/folders/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre' });
  const ok = meta_spy_folders.update(req.params.id, req.user.id, { name });
  if (!ok) return res.status(404).json({ error: 'Carpeta no encontrada' });
  res.json({ message: 'Carpeta actualizada' });
});

// DELETE /api/meta-spy/folders/:id
router.delete('/folders/:id', (req, res) => {
  const ok = meta_spy_folders.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Carpeta no encontrada' });
  res.json({ message: 'Carpeta eliminada' });
});

// GET /api/meta-spy/library?folder_id=X — saved ads (joined with ad data)
router.get('/library', (req, res) => {
  const folderId = req.query.folder_id ? Number(req.query.folder_id) : null;
  const saved = meta_spy_saved.forUser(req.user.id, folderId);
  const adIds = saved.map(s => s.ad_id);

  // Join with full ad records — no "in" helper, so load once
  let fullAds = [];
  try {
    const dbFile = DB_FILE;
    const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    fullAds = (raw.meta_spy_ads || []).filter(a => adIds.includes(a.id));
  } catch (err) {
    console.warn('[meta-spy] No se pudo leer meta_spy_ads:', err.message);
  }

  const byId = Object.fromEntries(fullAds.map(a => [a.id, a]));
  const list = saved.map(s => {
    const ad = byId[s.ad_id];
    if (!ad) return null;
    return {
      saved_id:  s.id,
      folder_id: s.folder_id,
      saved_at:  s.saved_at,
      ...mapAdForResponse(ad),
    };
  }).filter(Boolean);

  res.json({ ads: list });
});

// POST /api/meta-spy/library — save ad to library (optionally to folder)
router.post('/library', (req, res) => {
  const { ad_id, folder_id } = req.body;
  if (!ad_id) return res.status(400).json({ error: 'Falta ad_id' });

  // Verify ad belongs to a search owned by this user
  let ad = null;
  try {
    const dbFile = DB_FILE;
    const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    ad = (raw.meta_spy_ads || []).find(a => a.id == ad_id && a.user_id == req.user.id);
  } catch (err) {
    console.warn('[meta-spy] No se pudo leer meta_spy_ads:', err.message);
  }
  if (!ad) return res.status(404).json({ error: 'Anuncio no encontrado' });

  // Optionally validate folder belongs to user
  if (folder_id) {
    const folder = meta_spy_folders.one({ id: Number(folder_id), user_id: req.user.id });
    if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' });
  }

  const r = meta_spy_saved.insert({
    user_id:   req.user.id,
    ad_id:     Number(ad_id),
    folder_id: folder_id ? Number(folder_id) : null,
  });
  res.status(r.existed ? 200 : 201).json({ id: r.id, already_saved: !!r.existed });
});

// PUT /api/meta-spy/library/:id — move to another folder
router.put('/library/:id', (req, res) => {
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  if (folderId) {
    const folder = meta_spy_folders.one({ id: folderId, user_id: req.user.id });
    if (!folder) return res.status(404).json({ error: 'Carpeta no encontrada' });
  }
  const ok = meta_spy_saved.move(req.params.id, req.user.id, folderId);
  if (!ok) return res.status(404).json({ error: 'Anuncio guardado no encontrado' });
  res.json({ message: 'Movido a carpeta' });
});

// DELETE /api/meta-spy/library/:id
router.delete('/library/:id', (req, res) => {
  const ok = meta_spy_saved.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Removido de la biblioteca' });
});

// DELETE /api/meta-spy/library/by-ad/:adId — convenience for unsaving from search
router.delete('/library/by-ad/:adId', (req, res) => {
  const ok = meta_spy_saved.deleteByAdId(req.user.id, req.params.adId);
  if (!ok) return res.status(404).json({ error: 'No encontrado' });
  res.json({ message: 'Removido' });
});

// ─────────────────────────────────────────────────────────────────
// COMPETITORS: Followed pages
// ─────────────────────────────────────────────────────────────────

// GET /api/meta-spy/competitors
router.get('/competitors', (req, res) => {
  res.json({ competitors: meta_spy_competitors.forUser(req.user.id) });
});

// POST /api/meta-spy/competitors — follow a page
router.post('/competitors', (req, res) => {
  const { page_id, page_name } = req.body;
  if (!page_id) return res.status(400).json({ error: 'Falta page_id' });
  const r = meta_spy_competitors.insert({
    user_id:   req.user.id,
    page_id:   String(page_id),
    page_name: page_name || null,
  });
  res.status(r.existed ? 200 : 201).json({ id: r.id, already_followed: !!r.existed });
});

// DELETE /api/meta-spy/competitors/:id — unfollow
router.delete('/competitors/:id', (req, res) => {
  const ok = meta_spy_competitors.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Competidor no encontrado' });
  res.json({ message: 'Dejaste de seguir esta página' });
});

// POST /api/meta-spy/competitors/:id/refresh — re-scrape this page's current ads
router.post('/competitors/:id/refresh', async (req, res) => {
  const comp = meta_spy_competitors.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!comp) return res.status(404).json({ error: 'Competidor no encontrado' });

  const settings = user_settings.get(req.user.id);
  const apifyKey = settings?.apify_key;
  if (!apifyKey) return res.status(402).json({ error: 'Configura tu API key de Apify en Ajustes → APIs' });

  // Build a Page-scoped Ads Library URL
  const fbUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${encodeURIComponent(comp.page_id)}`;
  const actorInput = {
    urls:  [{ url: fbUrl, method: 'GET' }],
    count: 30,
    'scrapeAdDetails': true,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  };

  const startedAt = Date.now();
  let datasetItems;
  try {
    datasetItems = await callApifyActor(apifyKey, APIFY_ACTOR_ID, actorInput, APIFY_TIMEOUT_MS);
  } catch (err) {
    console.error('[meta-spy] competitor refresh failed:', err.message);
    return res.status(502).json({ error: `Error refrescando competidor: ${err.message}` });
  }

  // Persist as a search anchored to this user/page
  const search = meta_spy_searches.insert({
    user_id:     req.user.id,
    query:       `[Competidor] ${comp.page_name || comp.page_id}`,
    country:     'ALL',
    ad_active:   'all',
    max_results: 30,
  });

  const adsToInsert = [];
  for (const item of datasetItems || []) {
    const norm = normalizeApifyAd(item);
    let localFile = null;
    if (norm.original_url) {
      try { localFile = await downloadAndStore(norm.original_url, norm.media_type); }
      catch (_) {}
    }
    adsToInsert.push({
      search_id: search.id, user_id: req.user.id,
      page_id: norm.page_id, page_name: norm.page_name, page_profile_pic: norm.page_profile_pic,
      ad_text: norm.ad_text, title: norm.title, caption: norm.caption, link_description: norm.link_description,
      cta_text: norm.cta_text, cta_type: norm.cta_type, link_url: norm.link_url,
      media_type: norm.media_type, local_path: localFile, original_url: norm.original_url,
      start_date: norm.start_date, end_date: norm.end_date, platforms: norm.platforms,
      display_format: norm.display_format, ad_archive_id: norm.ad_archive_id,
      collation_count: norm.collation_count, categories: norm.categories, is_active: norm.is_active,
      snapshot_url: norm.snapshot_url,
    });
  }
  const inserted = meta_spy_ads.insertMany(adsToInsert);

  // Update competitor metadata
  meta_spy_competitors.update(comp.id, req.user.id, {
    last_ads_count: inserted.length,
    last_checked:   new Date().toISOString(),
    page_name:      comp.page_name || (datasetItems?.[0] && normalizeApifyAd(datasetItems[0]).page_name) || comp.page_name,
  });

  res.json({
    search_id:     search.id,
    results_count: inserted.length,
    duration_ms:   Date.now() - startedAt,
    ads: inserted.map(a => mapAdForResponse(a)),
  });
});

module.exports = router;
