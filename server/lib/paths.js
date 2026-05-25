/**
 * Single source of truth for media/data directories.
 *
 * In Railway, set PERSISTENT_DATA_DIR=/data (matching the mounted Volume) so
 * uploads survive redeploys. Locally, leave it unset and we fall back to the
 * project's server/ directory, preserving the old dev-time layout.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PERSISTENT_DATA_DIR || path.join(__dirname, '..');

function mediaDir(name) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dbFile = () => path.join(ROOT, 'ecommagic.json');

module.exports = { ROOT, mediaDir, dbFile };
