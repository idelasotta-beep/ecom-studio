// Electron main process — embeds the Express server in-process and
// opens a BrowserWindow pointing at it.
//
// Flow:
//   1. Choose a fixed high port and set process.env.PORT so server.js
//      uses it when it self-starts on require().
//   2. require() the Express app — it does app.listen() synchronously
//      but we still poll /api/health before showing the window so the
//      renderer never hits a connection-refused on first load.
//   3. Open BrowserWindow on dashboard.html (login bypass arrives in
//      Fase 3 — for now the user still sees login.html if not authed).

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 47711;
process.env.PORT = String(PORT);

// Server embebido. Lanza app.listen() durante el require.
require(path.join(__dirname, '..', 'server', 'server.js'));

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
    },
  });

  win.once('ready-to-show', () => win.show());

  // Abrir links externos (target=_blank, window.open) en el navegador del SO.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://127.0.0.1:${PORT}/login.html`);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('[electron] fallo al arrancar:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
