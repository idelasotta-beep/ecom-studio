/**
 * On-disk WebP cache for landing source images.
 *
 * Given a PNG/JPG landing in `server/landings/`, generates an optimized WebP
 * sibling on first request and returns the cached path on subsequent calls.
 * The WebP file lives next to the original with the same basename + `.webp`.
 *
 *   landings/landing_abc123.png   ← original
 *   landings/landing_abc123.webp  ← optimized cache (created on demand)
 *
 * Quality 78 is a good default for product photography: ~70-80% smaller than
 * the source PNG with no visible artifacts at landing-page resolutions.
 */
const fs   = require('fs');
const path = require('path');

let sharp;
try { sharp = require('sharp'); }
catch (err) {
  console.warn('[image-optim] sharp not installed — WebP optimization disabled. Run `npm install sharp`.');
}

const WEBP_QUALITY = 78;

function webpPathFor(sourcePath) {
  const dir  = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(dir, base + '.webp');
}

/**
 * Convert a source image to WebP if it doesn't already exist on disk.
 * Returns:
 *   { ok: true, path }       — WebP exists (cached or just generated)
 *   { ok: false, reason }    — couldn't generate (sharp missing, source missing, etc.)
 */
async function ensureWebP(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string') return { ok: false, reason: 'sin source' };
  if (!fs.existsSync(sourcePath)) return { ok: false, reason: 'source no existe' };

  const target = webpPathFor(sourcePath);
  if (fs.existsSync(target)) return { ok: true, path: target, cached: true };

  if (!sharp) return { ok: false, reason: 'sharp no instalado' };

  try {
    await sharp(sourcePath)
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toFile(target);
    return { ok: true, path: target, cached: false };
  } catch (err) {
    console.error('[image-optim] WebP conversion failed for', sourcePath, '—', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * Return the best public-serve path for a source image (prefer WebP, fallback to original).
 * Does NOT generate anything — read-only check.
 */
function bestImagePath(sourcePath) {
  if (!sourcePath) return null;
  const webp = webpPathFor(sourcePath);
  if (fs.existsSync(webp)) return webp;
  if (fs.existsSync(sourcePath)) return sourcePath;
  return null;
}

module.exports = { ensureWebP, webpPathFor, bestImagePath, WEBP_QUALITY };
