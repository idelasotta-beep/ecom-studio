/**
 * Builds the full HTML of an ebook ready to be rendered to PDF by Puppeteer.
 *
 * Visual layout mirrors the reference ebook design:
 *   - Cover (solid theme color, white title bar)
 *   - Table of Contents
 *   - Intro
 *   - One chapter per spread: header → image → text
 *   - Conclusion
 *   - Back cover (solid theme color, white title bar)
 *
 * Image references are inlined as data URIs by the caller (so the HTML is
 * fully self-contained and Puppeteer doesn't need to fetch from disk/network).
 */

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render markdown-ish text into paragraphs. We keep it minimal: blank lines
// separate paragraphs. No bold/italics/lists for v1 — the model is instructed
// to return plain prose anyway.
function renderProse(text) {
  if (!text) return '';
  return String(text)
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function buildEbookHTML(ebook) {
  const theme = ebook.theme_color || '#2d8b6f';
  const themeSoft = '#e6f0eb';
  const title = escapeHtml(ebook.title || 'Ebook');
  const subtitle = escapeHtml(ebook.subtitle || '');
  const chapters = ebook.chapters || [];

  const coverImg = ebook.cover_image_data_url || null;
  const backImg  = ebook.back_cover_image_data_url || null;

  const css = `
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; -webkit-font-smoothing: antialiased; }
    .page { width: 210mm; height: 297mm; page-break-after: always; position: relative; background: white; overflow: hidden; }
    .page:last-child { page-break-after: auto; }

    /* ─── Cover & back cover (solid theme) ─── */
    .cover { background: ${theme}; color: white; display: flex; flex-direction: column; padding: 55mm 22mm 30mm 22mm; }
    .cover .tag { display: inline-block; background: rgba(255,255,255,.18); color: white; font-size: 10pt; font-weight: 600; letter-spacing: 2px; padding: 6px 18px; border-radius: 999px; align-self: flex-start; }
    .cover h1 { font-size: 36pt; font-weight: 800; line-height: 1.1; margin-top: 18mm; letter-spacing: -0.5px; text-transform: uppercase; }
    .cover .divider { width: 50mm; height: 4px; background: white; opacity: .85; margin-top: 14mm; }
    .cover .sub { font-size: 13pt; line-height: 1.5; margin-top: 12mm; max-width: 140mm; color: rgba(255,255,255,.92); }
    .cover .cover-img { position: absolute; left: 0; right: 0; bottom: 0; height: 95mm; background-size: cover; background-position: center; opacity: 0; }
    .cover.has-img .cover-img { opacity: 1; }

    /* ─── Standard inner page ─── */
    .inner { padding: 22mm 22mm 28mm 22mm; }
    .inner h2 { color: ${theme}; font-size: 24pt; font-weight: 800; line-height: 1.15; margin-bottom: 5mm; letter-spacing: -0.3px; }
    .inner .kicker { font-size: 9pt; font-weight: 700; letter-spacing: 3px; color: ${theme}; text-transform: uppercase; margin-bottom: 4mm; }
    .inner .hr { width: 18mm; height: 3px; background: ${theme}; margin-bottom: 8mm; }
    .inner p { font-size: 11pt; line-height: 1.65; text-align: justify; margin-bottom: 3.5mm; color: #2c2f33; }
    .inner .chapter-img { width: 100%; height: 80mm; background-size: cover; background-position: center; border-radius: 8px; margin: 4mm 0 7mm 0; box-shadow: 0 1px 0 rgba(0,0,0,.04); }

    .footer { position: absolute; left: 22mm; right: 22mm; bottom: 12mm; padding-top: 4mm; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 8pt; color: #9ca3af; letter-spacing: 1.5px; text-transform: uppercase; }

    /* ─── TOC ─── */
    .toc { padding: 28mm 22mm; }
    .toc h2 { color: ${theme}; font-size: 32pt; font-weight: 800; margin-bottom: 4mm; }
    .toc .hr { width: 22mm; height: 4px; background: ${theme}; margin-bottom: 14mm; }
    .toc-row { display: flex; align-items: center; gap: 6mm; margin-bottom: 8mm; }
    .toc-num { width: 12mm; height: 12mm; border-radius: 50%; background: ${theme}; color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13pt; flex-shrink: 0; }
    .toc-text { font-size: 12pt; color: #2c2f33; line-height: 1.4; }
  `;

  const pages = [];

  // ─── Cover ───
  pages.push(`
    <section class="page cover ${coverImg ? 'has-img' : ''}">
      <span class="tag">GUÍA COMPLETA</span>
      <h1>${title}</h1>
      <div class="divider"></div>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
      ${coverImg ? `<div class="cover-img" style="background-image:url('${coverImg}')"></div>` : ''}
    </section>
  `);

  // ─── Table of Contents ───
  const tocRows = chapters.map((c, i) => `
    <div class="toc-row">
      <div class="toc-num">${i + 1}</div>
      <div class="toc-text">${escapeHtml(c.title || `Capítulo ${i + 1}`)}</div>
    </div>
  `).join('\n');

  pages.push(`
    <section class="page toc">
      <h2>Contenido</h2>
      <div class="hr"></div>
      ${tocRows}
    </section>
  `);

  // ─── Intro ───
  if (ebook.intro_content) {
    pages.push(`
      <section class="page inner">
        <h2>Introducción</h2>
        <div class="hr"></div>
        ${renderProse(ebook.intro_content)}
        <div class="footer"><span>${title}</span><span>3</span></div>
      </section>
    `);
  }

  // ─── Chapters ───
  chapters.forEach((c, i) => {
    const img = c.image_data_url || null;
    pages.push(`
      <section class="page inner">
        <div class="kicker">CAPÍTULO ${i + 1}</div>
        <h2>${escapeHtml(c.title || `Capítulo ${i + 1}`)}</h2>
        <div class="hr"></div>
        ${img ? `<div class="chapter-img" style="background-image:url('${img}')"></div>` : ''}
        ${renderProse(c.content || '')}
        <div class="footer"><span>${title}</span><span>${i + 4}</span></div>
      </section>
    `);
  });

  // ─── Conclusion ───
  if (ebook.conclusion_content) {
    pages.push(`
      <section class="page inner">
        <h2>Conclusión</h2>
        <div class="hr"></div>
        ${renderProse(ebook.conclusion_content)}
        <div class="footer"><span>${title}</span><span>${chapters.length + 4}</span></div>
      </section>
    `);
  }

  // ─── Back cover ───
  pages.push(`
    <section class="page cover ${backImg ? 'has-img' : ''}">
      <div style="flex:1;"></div>
      <h1>${title}</h1>
      ${subtitle ? `<div class="sub" style="margin-top:8mm;">Gracias por leer esta guía. Esperamos que la información te sea de gran utilidad para aprovechar al máximo tu producto.</div>` : ''}
      ${backImg ? `<div class="cover-img" style="background-image:url('${backImg}')"></div>` : ''}
    </section>
  `);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${css}</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>`;
}

module.exports = { buildEbookHTML };
