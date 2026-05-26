const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { users, ad_templates, LANDING_CATEGORIES } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const TEMPLATES_DIR = mediaDir('ad-templates');

const router = express.Router();
router.use(requireAdmin);

// ── GET /api/admin/users ─────────────────────────────────────────
router.get('/users', (req, res) => {
  const { search, plan, role, page = 1, limit = 15 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const extraFilter = {};
  if (plan) extraFilter.plan = plan;
  if (role) extraFilter.role = role;

  let result;
  if (search) {
    result = users.search(search, extraFilter, { limit: Number(limit), offset });
  } else {
    result = users.page(extraFilter, { limit: Number(limit), offset });
  }

  const safeUsers = result.rows.map(({ password: _pw, ...u }) => u);
  res.json({
    users: safeUsers,
    total: result.total,
    page:  Number(page),
    pages: Math.ceil(result.total / Number(limit)),
  });
});

// ── GET /api/admin/users/:id ─────────────────────────────────────
router.get('/users/:id', (req, res) => {
  const user = users.one({ id: Number(req.params.id) });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { password: _pw, ...safe } = user;
  res.json({ user: safe });
});

// ── PUT /api/admin/users/:id ─────────────────────────────────────
const ALLOWED_ROLES = ['user', 'admin'];

router.put('/users/:id', (req, res) => {
  const { first_name, last_name, email, country, phone, role, plan, is_active } = req.body;
  const targetId = Number(req.params.id);
  const user = users.one({ id: targetId });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const isSelf = targetId === req.user.id;

  // Validar role contra enum cerrado
  if (role !== undefined && !ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role inválido. Permitidos: ${ALLOWED_ROLES.join(', ')}` });
  }
  // No permitir auto-degradación / auto-desactivación — bloquearía el panel para
  // este admin y, si es el único admin del sistema, deja al producto sin acceso
  // admin (seedAdmin sólo corre si NO existe ningún admin).
  if (isSelf && role !== undefined && role !== user.role) {
    return res.status(400).json({ error: 'No puedes cambiar tu propio role. Pídeselo a otro admin.' });
  }
  if (isSelf && is_active !== undefined && Number(is_active) === 0) {
    return res.status(400).json({ error: 'No puedes desactivarte a ti mismo.' });
  }

  const changes = {};
  if (first_name !== undefined) changes.first_name = first_name;
  if (last_name  !== undefined) changes.last_name  = last_name;
  if (email      !== undefined) changes.email      = email;
  if (country    !== undefined) changes.country    = country;
  if (phone      !== undefined) changes.phone      = phone;
  if (role       !== undefined) changes.role       = role;
  if (plan       !== undefined) changes.plan       = plan;
  if (is_active  !== undefined) changes.is_active  = Number(is_active);

  users.update(targetId, changes);
  res.json({ message: 'Usuario actualizado' });
});

// ── PUT /api/admin/users/:id/plan ────────────────────────────────
router.put('/users/:id/plan', (req, res) => {
  const { plan } = req.body;
  const plans = ['trial', 'on_demand', 'basic', 'pro', 'business', 'agency'];
  if (!plans.includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  users.update(req.params.id, { plan });
  res.json({ message: `Plan actualizado a ${plan}` });
});

// ── DELETE /api/admin/users/:id ──────────────────────────────────
router.delete('/users/:id', (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  users.delete(req.params.id);
  res.json({ message: 'Usuario eliminado' });
});

// ── GET /api/admin/stats ─────────────────────────────────────────
router.get('/stats', (req, res) => {
  const allUsers    = users.all({ role: 'user' });
  const today       = new Date().toISOString().slice(0, 10);
  const activeToday = allUsers.filter(u => u.created_at.startsWith(today)).length;

  const planMap = {};
  allUsers.forEach(u => { planMap[u.plan] = (planMap[u.plan] || 0) + 1; });
  const byPlan = Object.entries(planMap).map(([plan, count]) => ({ plan, count }));

  const recentUsers  = [...allUsers]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5)
    .map(({ password: _pw, ...u }) => u);

  res.json({ totalUsers: allUsers.length, activeToday, byPlan, recentUsers });
});

// ── GET /api/admin/landing-categories ────────────────────────────
router.get('/landing-categories', (_req, res) => {
  res.json({ categories: LANDING_CATEGORIES });
});

// ── GET /api/admin/ad-templates ──────────────────────────────────
router.get('/ad-templates', (req, res) => {
  const { kind, category } = req.query;
  let list = ad_templates.all();
  if (['ad', 'landing', 'mockup', 'logo'].includes(kind)) list = list.filter(t => t.kind === kind);
  if (category) list = list.filter(t => t.category === category);
  const templates = list.map(t => ({
    ...t,
    image_url: `/ad-templates/${t.image_path}`,
  }));
  res.json({ templates, total: templates.length });
});

// ── POST /api/admin/ad-templates ─────────────────────────────────
// Accepts either a single `image` or a batch via `images` array.
router.post('/ad-templates', (req, res) => {
  const { image, images, kind, category } = req.body;
  console.log(`[admin/ad-templates] UPLOAD received: kind="${kind}" (typeof=${typeof kind}) category="${category}" imagesCount=${(images || []).length || (image ? 1 : 0)}`);
  const VALID_KINDS = ['ad', 'landing', 'mockup', 'logo'];
  const safeKind = VALID_KINDS.includes(kind) ? kind : 'ad';
  console.log(`[admin/ad-templates] safeKind resolved to: "${safeKind}"`);
  let safeCategory = null;
  if (safeKind === 'landing') {
    if (!category || !LANDING_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Las plantillas de Landing requieren una categoría válida' });
    }
    safeCategory = category;
  }

  const items = Array.isArray(images) && images.length ? images : (image ? [image] : []);
  if (!items.length) return res.status(400).json({ error: 'Falta la imagen' });

  // Whitelist de extensiones aceptadas. Bloquea explícitamente svg/svg+xml/xml
  // porque al servirlos como estáticos el browser los renderiza como
  // image/svg+xml y ejecuta el <script> embebido (stored XSS en el origen).
  const ALLOWED_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

  const created = [];
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const dataUrl = items[i];
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(\w+);base64,/);
    if (!match) { errors.push({ index: i, error: 'Formato de imagen inválido' }); continue; }
    const ext = match[1].toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      errors.push({ index: i, error: `Formato no permitido (${ext}). Sólo PNG, JPG, GIF y WebP.` });
      continue;
    }
    const base64   = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = `tpl_${Date.now()}_${i}.${ext}`;
    try {
      fs.writeFileSync(path.join(TEMPLATES_DIR, filename), Buffer.from(base64, 'base64'));
    } catch (e) {
      errors.push({ index: i, error: 'No se pudo guardar la imagen' });
      continue;
    }
    const t = ad_templates.insert({
      name: '',
      image_path: filename,
      kind: safeKind,
      category: safeCategory,
      created_by: req.user.id,
    });
    created.push({
      id: t.id,
      kind: safeKind,
      category: safeCategory,
      image_url: `/ad-templates/${filename}`,
    });
  }

  const status = created.length ? 201 : 400;
  res.status(status).json({ created, errors, total: created.length });
});

// ── PATCH /api/admin/ad-templates/:id ────────────────────────────
router.patch('/ad-templates/:id', (req, res) => {
  const { name, kind, category } = req.body;
  if (kind && !['ad', 'landing', 'mockup', 'logo'].includes(kind)) {
    return res.status(400).json({ error: 'kind inválido' });
  }
  if (kind === 'landing' && category && !LANDING_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'categoría inválida' });
  }
  const ok = ad_templates.update(req.params.id, { name, kind, category });
  if (!ok) return res.status(404).json({ error: 'Plantilla no encontrada' });
  res.json({ message: 'Plantilla actualizada' });
});

// ── DELETE /api/admin/ad-templates/:id ───────────────────────────
router.delete('/ad-templates/:id', (req, res) => {
  const t = ad_templates.one(req.params.id);
  if (t) {
    const file = path.join(TEMPLATES_DIR, t.image_path);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }
  const ok = ad_templates.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Plantilla no encontrada' });
  res.json({ message: 'Plantilla eliminada' });
});

module.exports = router;
