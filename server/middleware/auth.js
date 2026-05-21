const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { users } = require('../db');

// JWT_SECRET MUST come from env in production. In dev, generate an ephemeral one
// per-process so leaked old tokens stop working on restart and the secret is
// never a predictable known value.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET no está definido. Define la variable de entorno antes de arrancar.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET no definido — usando uno aleatorio para esta sesión (dev only).');
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token requerido' });

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user    = users.one({ id: payload.id, is_active: 1 });
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin')
      return res.status(403).json({ error: 'Acceso denegado. Se requiere rol admin.' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
