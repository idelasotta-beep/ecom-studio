const express = require('express');
const { products, product_pricings, product_research } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/pricing — products with pricing counts ──────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    pricing_count:  products.pricingCount(p.id),
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/pricing/:id — product + pricing scenarios + research
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:   p,
    pricings:  product_pricings.forProduct(p.id),
    research:  product_research.forProduct(p.id),
  });
});

// ── POST /api/pricing/:id — create new scenario ──────────────────
router.post('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const { name, inputs } = req.body;
  if (!inputs || typeof inputs !== 'object')
    return res.status(400).json({ error: 'inputs requeridos' });
  const r = product_pricings.insert({
    product_id: p.id,
    user_id:    req.user.id,
    name:       (name || '').trim() || 'Escenario sin nombre',
    inputs,
  });
  res.status(201).json({ id: r.id });
});

// ── PUT /api/pricing/:id/:pricingId — update scenario ────────────
router.put('/:id/:pricingId', (req, res) => {
  const { name, inputs } = req.body;
  const changes = {};
  if (name !== undefined)   changes.name   = (name || '').trim() || 'Escenario sin nombre';
  if (inputs !== undefined) changes.inputs = inputs;
  const ok = product_pricings.update(req.params.pricingId, req.user.id, changes);
  if (!ok) return res.status(404).json({ error: 'Escenario no encontrado' });
  res.json({ message: 'Escenario actualizado' });
});

// ── DELETE /api/pricing/:id/:pricingId ───────────────────────────
router.delete('/:id/:pricingId', (req, res) => {
  const ok = product_pricings.delete(req.params.pricingId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Escenario no encontrado' });
  res.json({ message: 'Escenario eliminado' });
});

module.exports = router;
