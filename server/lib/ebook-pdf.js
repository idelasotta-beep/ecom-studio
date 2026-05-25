/**
 * Renders ebook HTML to a PDF file on disk using Puppeteer.
 *
 * On Railway, the Nixpacks builder picks up `puppeteer` and installs Chromium
 * as part of the postinstall hook. The launch args below disable the sandbox,
 * which is required when running as root inside a container.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (_) { puppeteer = null; }

// Locate a Chromium binary. Priority:
//   1) PUPPETEER_EXECUTABLE_PATH (explicit override)
//   2) `which chromium` / `chromium-browser` (Railway/Nix install via nixpacks)
//   3) undefined → Puppeteer falls back to its own bundled Chromium (dev local)
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const cmd of ['chromium', 'chromium-browser', 'google-chrome']) {
    try {
      const out = execSync(`which ${cmd} 2>/dev/null`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out;
    } catch (_) {}
  }
  return undefined;
}

async function renderEbookPDF(html, outputPath) {
  if (!puppeteer) {
    throw new Error('puppeteer no está instalado. Ejecutá `npm install` antes de generar PDFs.');
  }
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const executablePath = findChromium();
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 });
    // Wait for web fonts; without this the cover renders with system fallback.
    await page.evaluateHandle('document.fonts.ready');
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return outputPath;
  } finally {
    await browser.close();
  }
}

module.exports = { renderEbookPDF };
