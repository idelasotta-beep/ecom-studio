// Diagnóstico: ¿sharp y puppeteer cargan en el Node embebido de Electron?
console.log('process.versions.node:', process.versions.node);
console.log('process.versions.electron:', process.versions.electron);
console.log('NODE_MODULE_VERSION:', process.versions.modules);
console.log('--');
try {
  const sharp = require('sharp');
  console.log('[sharp] OK — version:', sharp.versions ? sharp.versions.sharp : 'unknown');
  // pequeño test funcional
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer()
    .then((buf) => console.log('[sharp] PNG genera OK,', buf.length, 'bytes'))
    .catch((e) => console.error('[sharp] toBuffer falló:', e.message));
} catch (e) {
  console.error('[sharp] FALLO al require:', e.message);
}
try {
  const puppeteer = require('puppeteer');
  console.log('[puppeteer] OK — executablePath:', puppeteer.executablePath());
} catch (e) {
  console.error('[puppeteer] FALLO al require:', e.message);
}
