// Electron main process — embeds the Express server in-process and
// opens a BrowserWindow pointing at it.
//
// Flow:
//   1. Set product name so userData is "Ecom Studio IA", not "mi-dropi".
//   2. Seed userData from c:\tmp\railway-export ONCE if ecommagic.json
//      is missing — first-run import of the production data.
//   3. Set process.env.PORT and require the Express app — server.js
//      calls app.listen() during require.
//   4. Poll /api/health, then open BrowserWindow on login.html (the
//      auth bypass arrives in Fase 3).

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');

app.setName('Ecom Studio IA');

const PORT = 47711;
process.env.PORT = String(PORT);

// ── Seed de primer arranque ──────────────────────────────────────
// Si userData está vacío, copia la export bajada de Railway.
const userDataDir = app.getPath('userData');
const seedSource  = 'c:\\tmp\\railway-export';
const dbPath      = path.join(userDataDir, 'ecommagic.json');

if (!fs.existsSync(dbPath) && fs.existsSync(seedSource)) {
  console.log('[seed] Sembrando data inicial desde', seedSource);
  console.log('[seed] Destino:', userDataDir);
  copyRecursiveSync(seedSource, userDataDir);
  console.log('[seed] OK.');
}

function copyRecursiveSync(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    const name = path.basename(src);
    if (name === 'lost+found') return; // artefacto del ext4 del volume de Railway
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ── Server embebido ──────────────────────────────────────────────
// require dispara app.listen() en server.js.
require(path.join(__dirname, '..', 'server', 'server.js'));

// ── Autologin: firmar JWT del admin para inyectar en localStorage ─
// JWT_SECRET es efímero por sesión (no hay env var JWT_SECRET en desktop),
// así que el token vale solo mientras esté abierta esta instancia.
let injectedToken = null;
let injectedUser  = null;
try {
  const { users } = require(path.join(__dirname, '..', 'server', 'db'));
  const { JWT_SECRET } = require(path.join(__dirname, '..', 'server', 'middleware', 'auth'));
  const jwt = require('jsonwebtoken');
  const admin = users.one({ role: 'admin' });
  if (admin) {
    injectedToken = jwt.sign({ id: admin.id }, JWT_SECRET, { expiresIn: '30d' });
    const { password: _pw, ...adminSafe } = admin;
    injectedUser = JSON.stringify(adminSafe);
  } else {
    console.warn('[electron] no hay admin en la DB — la app abrirá login.html');
  }
} catch (err) {
  console.error('[electron] no se pudo firmar el token de autologin:', err.message);
}

function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('server no respondió en ' + timeoutMs + 'ms'));
      setTimeout(tryOnce, 200);
    };
    tryOnce();
  });
}

async function createWindow() {
  await waitForServer();

  const additionalArguments = [];
  if (injectedToken) additionalArguments.push(`--injected-token=${injectedToken}`);
  if (injectedUser)  additionalArguments.push(`--injected-user=${encodeURIComponent(injectedUser)}`);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Si hay autologin, salta directo al dashboard. Si no, pasa por login.html.
  const landing = injectedToken ? 'dashboard.html' : 'login.html';
  await win.loadURL(`http://127.0.0.1:${PORT}/${landing}`);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('[electron] fallo al arrancar:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
