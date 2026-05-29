/**
 * Single source of truth for media/data directories.
 *
 * Resolución del ROOT, en orden:
 *   1. Electron main process → app.getPath('userData') (single-user desktop).
 *   2. PERSISTENT_DATA_DIR env var → para Railway (Volume montado en /data).
 *   3. Fallback dev → el directorio server/ del propio repo.
 */
const fs   = require('fs');
const path = require('path');

function resolveRoot() {
  if (process.versions.electron && process.type === 'browser') {
    try {
      return require('electron').app.getPath('userData');
    } catch (_) { /* electron app no disponible aún — caer al fallback */ }
  }
  if (process.env.PERSISTENT_DATA_DIR) return process.env.PERSISTENT_DATA_DIR;
  return path.join(__dirname, '..');
}

const ROOT = resolveRoot();

function mediaDir(name) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dbFile = () => path.join(ROOT, 'ecommagic.json');

module.exports = { ROOT, mediaDir, dbFile };
