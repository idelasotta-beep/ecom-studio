/**
 * TEMPORARY restore endpoints — used ONCE to migrate the local JSON DB and
 * media files to the Railway volume. Delete this file (and its mount in
 * server.js) right after the migration succeeds.
 *
 * Auth: admin role required.
 * Body limits: raise express.json limit if your DB is bigger than 50 MB.
 */
const express = require('express');
const fs   = require('fs');
const path = require('path');
const { requireAdmin } = require('../middleware/auth');
const { ROOT, mediaDir, dbFile } = require('../lib/paths');

const router = express.Router();
router.use(requireAdmin);

const ALLOWED_FOLDERS = new Set(['ads', 'landings', 'mockups', 'logos', 'ad-templates', 'text-to-image']);

// POST /api/restore/db  (Content-Type: application/json)
// Body: the full ecommagic.json object. Overwrites the DB atomically.
router.post('/db', express.json({ limit: '100mb' }), (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object' || !Array.isArray(data.users)) {
    return res.status(400).json({ error: 'Payload no parece una DB válida (falta users[])' });
  }
  const file = dbFile();
  const tmp  = file + '.tmp';
  const bak  = file + '.bak';
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, bak);
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    res.json({ ok: true, path: file, size_bytes: fs.statSync(file).size });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo escribir la DB', details: err.message });
  }
});

// POST /api/restore/media/:folder/:filename  (Content-Type: application/octet-stream)
// Body: raw bytes of the file. Writes to <volume>/<folder>/<filename>.
router.post('/media/:folder/:filename',
  express.raw({ type: '*/*', limit: '50mb' }),
  (req, res) => {
    const { folder, filename } = req.params;
    if (!ALLOWED_FOLDERS.has(folder)) {
      return res.status(400).json({ error: 'Carpeta no permitida' });
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Body vacío o no binario' });
    }
    const dest = path.join(mediaDir(folder), filename);
    try {
      fs.writeFileSync(dest, req.body);
      res.json({ ok: true, path: dest, size_bytes: req.body.length });
    } catch (err) {
      res.status(500).json({ error: 'No se pudo escribir el archivo', details: err.message });
    }
  }
);

// GET /api/restore/status — quick check of what's on the volume.
router.get('/status', (_req, res) => {
  const result = { root: ROOT, db: null, folders: {} };
  const f = dbFile();
  if (fs.existsSync(f)) result.db = { exists: true, size_bytes: fs.statSync(f).size };
  for (const folder of ALLOWED_FOLDERS) {
    const dir = path.join(ROOT, folder);
    if (!fs.existsSync(dir)) { result.folders[folder] = { exists: false }; continue; }
    const files = fs.readdirSync(dir);
    let total = 0;
    for (const file of files) {
      try { total += fs.statSync(path.join(dir, file)).size; } catch {}
    }
    result.folders[folder] = { exists: true, count: files.length, size_bytes: total };
  }
  res.json(result);
});

module.exports = router;
