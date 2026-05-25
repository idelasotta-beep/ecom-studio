const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { ad_templates, LANDING_CATEGORIES } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const TEMPLATES_DIR = mediaDir('ad-templates');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_USER_KINDS = ['ad', 'landing', 'mockup', 'logo', 'authority'];

// ── GET /api/my-templates ─────────────────────────────────────────────
// Lists the current user's own templates (optionally filtered by kind/category).
router.get('/', (req, res) => {
  const { kind, category } = req.query;
  const safeKind = ALLOWED_USER_KINDS.includes(kind) ? kind : 'ad';
  const list = ad_templates.forUserByKind(req.user.id, safeKind)
    .filter(t => !category || t.category === category)
    .map(t => ({
      ...t,
      image_url: `/ad-templates/${t.image_path}`,
      is_mine: true,
    }));
  res.json({ templates: list, total: list.length });
});

// ── POST /api/my-templates ────────────────────────────────────────────
// User uploads their own template(s). Accepts single `image` or batch `images[]`.
router.post('/', (req, res) => {
  const { image, images, kind, category } = req.body;
  const safeKind = ALLOWED_USER_KINDS.includes(kind) ? kind : 'ad';
  let safeCategory = null;
  if (safeKind === 'landing') {
    if (!category || !LANDING_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Las plantillas de Landing requieren una categoría válida' });
    }
    safeCategory = category;
  }

  const items = Array.isArray(images) && images.length ? images : (image ? [image] : []);
  if (!items.length) return res.status(400).json({ error: 'Falta la imagen' });

  const created = [];
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const dataUrl = items[i];
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(\w+);base64,/);
    if (!match) { errors.push({ index: i, error: 'Formato de imagen inválido' }); continue; }
    const ext      = match[1];
    const base64   = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = `usr${req.user.id}_${Date.now()}_${i}.${ext}`;
    try {
      fs.writeFileSync(path.join(TEMPLATES_DIR, filename), Buffer.from(base64, 'base64'));
    } catch (_) {
      errors.push({ index: i, error: 'No se pudo guardar la imagen' });
      continue;
    }
    const t = ad_templates.insert({
      name: '',
      image_path: filename,
      kind: safeKind,
      category: safeCategory,
      owner_id: req.user.id,
      created_by: req.user.id,
    });
    created.push({
      id: t.id,
      kind: safeKind,
      category: safeCategory,
      image_url: `/ad-templates/${filename}`,
      is_mine: true,
    });
  }

  const status = created.length ? 201 : 400;
  res.status(status).json({ created, errors, total: created.length });
});

// ── DELETE /api/my-templates/:id ──────────────────────────────────────
// Only allowed if the template is owned by the requesting user.
router.delete('/:id', (req, res) => {
  const t = ad_templates.one(req.params.id);
  if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
  if (t.owner_id == null || String(t.owner_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'No puedes eliminar esta plantilla' });
  }
  const file = path.join(TEMPLATES_DIR, t.image_path);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  ad_templates.delete(t.id);
  res.json({ message: 'Plantilla eliminada' });
});

module.exports = router;
