const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { users } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/register ──────────────────────────────────────
router.post('/register', (req, res) => {
  const { first_name, last_name, email, country, phone_prefix, phone, password, confirm_password } = req.body;

  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: 'Nombre, apellido, email y contraseña son requeridos.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres.' });
  if (password !== confirm_password)
    return res.status(400).json({ error: 'Las contraseñas no coinciden.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Email inválido.' });

  if (users.one({ email: email.toLowerCase().trim() }))
    return res.status(409).json({ error: 'Este email ya está registrado.' });

  const hash   = bcrypt.hashSync(password, 10);
  const result = users.insert({
    first_name: first_name.trim(),
    last_name:  last_name.trim(),
    email:      email.toLowerCase().trim(),
    country, phone_prefix, phone,
    password:   hash,
  });

  const user = users.one({ id: result.id });
  const { password: _pw, ...safeUser } = user;
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

  res.status(201).json({ message: '¡Cuenta creada exitosamente!', token, user: safeUser });
});

// ── POST /api/auth/login ─────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos.' });

  const user = users.one({ email: email.toLowerCase().trim(), is_active: 1 });
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, ...safeUser } = user;
  res.json({ message: 'Sesión iniciada', token, user: safeUser });
});

// ── GET /api/auth/me ─────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { password: _pw, ...safeUser } = req.user;
  res.json({ user: safeUser });
});

router.post('/logout', requireAuth, (_req, res) => res.json({ message: 'Sesión cerrada' }));

module.exports = router;
