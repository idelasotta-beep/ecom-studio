// Preload — corre antes que los scripts del documento, con acceso al
// localStorage del origin (http://127.0.0.1:PORT).
//
// Inyecta el token JWT del admin (firmado por main.js) en localStorage
// para que dashboard.html lo lea como si el usuario se hubiera logueado
// normalmente. Single-user, sin pantalla de login.

(function injectAuth() {
  try {
    const tokenArg = process.argv.find((a) => a.startsWith('--injected-token='));
    const userArg  = process.argv.find((a) => a.startsWith('--injected-user='));
    if (tokenArg) {
      localStorage.setItem('token', tokenArg.slice('--injected-token='.length));
    }
    if (userArg) {
      localStorage.setItem('user', decodeURIComponent(userArg.slice('--injected-user='.length)));
    }
  } catch (e) {
    console.error('[preload] no se pudo inyectar token de autologin:', e);
  }
})();
