const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { mediaDir } = require('./lib/paths');
const { product_ebooks } = require('./db');

// Recovery: ebooks left mid-generation by a previous process crash should be
// marked failed so the UI doesn't show them spinning forever.
const staleCount = product_ebooks.markStaleAsFailed();
if (staleCount > 0) console.warn(`[ebooks] marked ${staleCount} stale ebook(s) as failed (server restart)`);

const app = express();
app.disable('x-powered-by');

// ── Security headers ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── Middleware ───────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  credentials: false,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Block sensitive paths from being served as static files ──────
// Without this, the backend folder, DB file, secrets, and config are all exposed.
// La extensión `.js` y el directorio `scripts/` se bloquean también para no
// exponer scripts server-side (ej. migrate-to-railway.js) por static.
const BLOCKED_PATTERN = /^\/(?:server\b|\.|node_modules\b|scripts\b)|\.(?:env|bak|log|json|lock|md|js|cjs|mjs|ts|sh)$/i;
const STATIC_ALLOWLIST = new Set([
  '/index.html', '/login.html', '/register.html', '/dashboard.html', '/admin.html',
]);
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ads') ||
      req.path.startsWith('/landings') || req.path.startsWith('/mockups') ||
      req.path.startsWith('/logos') || req.path.startsWith('/text-to-image') ||
      req.path.startsWith('/ad-templates') || req.path.startsWith('/meta-ads') ||
      req.path.startsWith('/ebooks') || req.path.startsWith('/ebook-images') ||
      req.path.startsWith('/voiceovers')) {
    return next();
  }
  if (STATIC_ALLOWLIST.has(req.path)) return next();
  if (BLOCKED_PATTERN.test(req.path)) return res.status(404).send('Not found');
  next();
});

// Serve static frontend files (after the guard above)
app.use(express.static(path.join(__dirname, '..'), {
  dotfiles: 'deny',
  index: false,
}));

// Uploaded/generated media dirs — single source of truth in server/lib/paths.js.
// In Railway, PERSISTENT_DATA_DIR=/data (volume mount); locally falls back to ./server/.
app.use('/ads',           express.static(mediaDir('ads')));
app.use('/landings',      express.static(mediaDir('landings')));
app.use('/mockups',       express.static(mediaDir('mockups')));
app.use('/logos',         express.static(mediaDir('logos')));
app.use('/text-to-image', express.static(mediaDir('text-to-image')));
app.use('/ad-templates',  express.static(mediaDir('ad-templates')));
app.use('/meta-ads',      express.static(mediaDir('meta-ads')));
app.use('/ebooks',        express.static(mediaDir('ebooks')));
app.use('/ebook-images',  express.static(mediaDir('ebook-images')));
app.use('/voiceovers',    express.static(mediaDir('voiceovers')));

// ── Routes ───────────────────────────────────────────────────────
app.use('/api/auth',  require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/user',     require('./routes/user'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/ads',          require('./routes/ads'));
app.use('/api/landings',     require('./routes/landings'));
app.use('/api/mockups',      require('./routes/mockups'));
app.use('/api/logos',        require('./routes/logos'));
app.use('/api/text-to-image', require('./routes/text-to-image'));
app.use('/api/shopify',      require('./routes/shopify'));
app.use('/api/copys',        require('./routes/copys'));
app.use('/api/testimonials', require('./routes/testimonials'));
app.use('/api/descriptions', require('./routes/descriptions'));
app.use('/api/audios',       require('./routes/audios'));
app.use('/api/pricing',      require('./routes/pricing'));
app.use('/api/meta-spy',     require('./routes/meta-spy'));
app.use('/api/tiktok-spy',   require('./routes/tiktok-spy'));
app.use('/api/my-templates', require('./routes/my-templates'));
app.use('/api/ebooks',       require('./routes/ebooks'));
app.use('/api/voiceovers',   require('./routes/voiceovers'));

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Fallback: serve index.html for unknown routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  } else {
    res.status(404).json({ error: 'Ruta no encontrada' });
  }
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// Bind explícito a 0.0.0.0 — Railway/Render/Docker requieren que el server
// escuche en todas las interfaces, no solo localhost, para que el proxy externo
// pueda llegar al container.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ Ecom Studio IA Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌐 Listening on 0.0.0.0:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
server.setTimeout(600000); // 10 minutes — AI generation can take several minutes
