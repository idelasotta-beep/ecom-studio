const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

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
const BLOCKED_PATTERN = /^\/(?:server\b|\.|node_modules\b)|\.(?:env|bak|log|json|lock|md)$/i;
const STATIC_ALLOWLIST = new Set([
  '/index.html', '/login.html', '/register.html', '/dashboard.html', '/admin.html',
]);
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ads') ||
      req.path.startsWith('/landings') || req.path.startsWith('/mockups') ||
      req.path.startsWith('/logos') || req.path.startsWith('/text-to-image') ||
      req.path.startsWith('/ad-templates') || req.path.startsWith('/meta-ads')) {
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

// Serve generated ad images
const ADS_DIR = path.join(__dirname, 'ads');
if (!fs.existsSync(ADS_DIR)) fs.mkdirSync(ADS_DIR, { recursive: true });
app.use('/ads', express.static(ADS_DIR));

// Serve generated landing page images (mirror of ads, used by /api/landings)
const LANDINGS_DIR = path.join(__dirname, 'landings');
if (!fs.existsSync(LANDINGS_DIR)) fs.mkdirSync(LANDINGS_DIR, { recursive: true });
app.use('/landings', express.static(LANDINGS_DIR));

// Serve generated mockup images
const MOCKUPS_DIR = path.join(__dirname, 'mockups');
if (!fs.existsSync(MOCKUPS_DIR)) fs.mkdirSync(MOCKUPS_DIR, { recursive: true });
app.use('/mockups', express.static(MOCKUPS_DIR));

// Serve generated logo images
const LOGOS_DIR = path.join(__dirname, 'logos');
if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });
app.use('/logos', express.static(LOGOS_DIR));

// Serve standalone text-to-image outputs
const T2I_DIR = path.join(__dirname, 'text-to-image');
if (!fs.existsSync(T2I_DIR)) fs.mkdirSync(T2I_DIR, { recursive: true });
app.use('/text-to-image', express.static(T2I_DIR));

// Serve admin-uploaded ad template images
const TEMPLATES_DIR = path.join(__dirname, 'ad-templates');
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
app.use('/ad-templates', express.static(TEMPLATES_DIR));

// Serve scraped Meta Ads media (downloaded from CDN to break expiring URLs)
const META_ADS_DIR = path.join(__dirname, 'meta-ads');
if (!fs.existsSync(META_ADS_DIR)) fs.mkdirSync(META_ADS_DIR, { recursive: true });
app.use('/meta-ads', express.static(META_ADS_DIR));

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
const server = app.listen(PORT, () => {
  console.log(`\n⚡ Ecom Studio IA Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📝 Register: http://localhost:${PORT}/register.html`);
  console.log(`🔐 Login:    http://localhost:${PORT}/login.html`);
  console.log(`⚙️  Admin:    http://localhost:${PORT}/admin.html`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
server.setTimeout(600000); // 10 minutes — AI generation can take several minutes
