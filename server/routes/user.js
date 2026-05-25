const express = require('express');
const { user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ALLOWED_KEYS = ['claude_key', 'gemini_key', 'openai_key', 'kieai_key', 'apify_key', 'elevenlabs_key'];

// ── GET /api/user/settings ───────────────────────────────────────
router.get('/settings', (req, res) => {
  const s = user_settings.get(req.user.id) || {};
  const result = {};
  ALLOWED_KEYS.forEach(k => {
    const val = s[k] || null;
    result[k] = val ? maskKey(val) : null;
    result[k + '_set'] = !!val;
  });
  res.json(result);
});

// ── PUT /api/user/settings ───────────────────────────────────────
router.put('/settings', (req, res) => {
  const changes = {};
  ALLOWED_KEYS.forEach(k => {
    if (req.body[k] !== undefined) {
      const v = String(req.body[k]).trim();
      changes[k] = v === '' ? null : v;
    }
  });
  if (!Object.keys(changes).length)
    return res.status(400).json({ error: 'No se enviaron cambios' });
  user_settings.upsert(req.user.id, changes);
  res.json({ message: 'Configuración guardada' });
});

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.slice(0, 8) + '•'.repeat(Math.min(key.length - 12, 20)) + key.slice(-4);
}

module.exports = router;
