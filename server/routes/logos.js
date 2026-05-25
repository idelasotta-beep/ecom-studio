const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { products, product_logos, product_research, ad_templates, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const LOGOS_DIR     = mediaDir('logos');
const TEMPLATES_DIR = mediaDir('ad-templates');

// Nano Banana family (Gemini image generation)
const NANO_BANANA_MODELS = {
  nano_banana_2:   'gemini-3.1-flash-image-preview',
  nano_banana_pro: 'gemini-3-pro-image-preview',
};
const isNanoBanana = (m) => m === 'nano_banana_2' || m === 'nano_banana_pro';

// Long-running fetch agent (15 min for large image gen calls)
const longRunningAgent = new UndiciAgent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout:    15 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

// ── Size maps (same shape as ads.js but without 'original' — that means "auto from template") ──
const SIZE_MAP = {
  fb_square:   '1024x1024',
  ig_square:   '1024x1024',
  ig_stories:  '1024x1792',
  fb_linkedin: '1792x1024',
  banner:      '1024x1024',
};

const GPT_IMAGE_SIZE_MAP = {
  fb_square:   '1024x1024',
  ig_square:   '1024x1024',
  ig_stories:  '1024x1536',
  fb_linkedin: '1536x1024',
  banner:      '1024x1024',
};

const GEMINI_ASPECT_MAP = {
  fb_square:   '1:1',
  ig_square:   '1:1',
  ig_stories:  '9:16',
  fb_linkedin: '16:9',
  banner:      '4:3',
};

// ── GET /api/logos — products with logo counts ─────────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    logo_count:   (product_logos.forProduct(p.id) || []).length,
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/logos/templates — list logo templates ─────────────
router.get('/templates', (req, res) => {
  const { source } = req.query;
  let list;
  if (source === 'mine') {
    list = ad_templates.forUserByKind(req.user.id, 'logo');
  } else if (source === 'ecom') {
    list = ad_templates.globalByKind('logo');
  } else {
    list = ad_templates.visibleByKind(req.user.id, 'logo');
  }
  const templates = list.map(t => ({
    ...t,
    image_url: `/ad-templates/${t.image_path}`,
    is_mine: t.owner_id != null && t.owner_id == req.user.id,
  }));
  res.json({ templates });
});

// ── GET /api/logos/:id — product + logos + research ─────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:  p,
    logos:  product_logos.forProduct(p.id),
    research: product_research.forProduct(p.id),
  });
});

// ── POST /api/logos/:id/generate ───────────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  const {
    image_model = 'gpt_image_2',
    template_id, template_url, photos, size, language,
    research_id,
    brand_name, brand_slogan,
    additional_instructions,
  } = req.body;

  // Load research content if a research_id was passed
  let researchContent = '';
  if (research_id) {
    const research = product_research.forProduct(p.id).find(r => r.id == research_id);
    if (research && research.content) {
      researchContent = research.content.slice(0, 6000);
    }
  }

  // Validate API key for the selected engine
  if (isNanoBanana(image_model)) {
    if (!geminiKey) return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana' });
  } else {
    if (!openaiKey) return res.status(402).json({ error: 'Se requiere API key de OpenAI para GPT Image 2' });
  }

  let imgSize    = SIZE_MAP[size]           || '1024x1024';
  let imgSizeGpt = GPT_IMAGE_SIZE_MAP[size] || '1024x1024';
  let imgAspect  = GEMINI_ASPECT_MAP[size]  || '1:1';

  // Permission check: template must be owned or global
  if (template_id && template_id !== 'custom') {
    const tplCheck = ad_templates.one(template_id);
    if (!ad_templates.isUsableBy(tplCheck, req.user.id)) {
      return res.status(403).json({ error: 'No puedes usar esta plantilla' });
    }
  }

  // Build reference images: TEMPLATE first, then product photos
  const refImages = [];
  let templateBuffer = null;
  if (template_id && template_id !== 'custom') {
    const tpl = ad_templates.one(template_id);
    if (tpl) {
      const file = path.join(TEMPLATES_DIR, tpl.image_path);
      if (fs.existsSync(file)) {
        try {
          const ext = (tpl.image_path.split('.').pop() || 'png').toLowerCase();
          templateBuffer = fs.readFileSync(file);
          const b64 = templateBuffer.toString('base64');
          refImages.push(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`);
        } catch (_) {}
      }
    }
  } else if (typeof template_url === 'string' && template_url.startsWith('data:')) {
    refImages.push(template_url);
    const m = template_url.match(/^data:image\/\w+;base64,(.+)$/);
    if (m) templateBuffer = Buffer.from(m[1], 'base64');
  }

  // User-selected size always wins. Fall back to template aspect only when no explicit size.
  const userPickedSize = typeof size === 'string' && size.length > 0 && SIZE_MAP[size];
  if (templateBuffer && !userPickedSize) {
    const dims = getImageDimensions(templateBuffer);
    if (dims) {
      imgSize    = pickSizeForAspect(dims.width, dims.height, 'dall-e-3');
      imgSizeGpt = pickSizeForAspect(dims.width, dims.height, 'gpt_image_2');
      imgAspect  = pickSizeForAspect(dims.width, dims.height, 'nano_banana_2');
    }
  }

  if (Array.isArray(photos)) {
    photos.forEach(ph => {
      if (typeof ph === 'string' && ph.startsWith('data:')) refImages.push(ph);
    });
  }

  const hasProductPhotos = refImages.length > (templateBuffer ? 1 : 0);
  const hasTemplate      = templateBuffer != null;

  // Build prompt
  const prompt = buildLogoPrompt({
    productName: p.name,
    brandName:   (brand_name || '').trim(),
    brandSlogan: (brand_slogan || '').trim(),
    research:    researchContent,
    extra:       (additional_instructions || '').trim(),
    lang:        language || 'Spanish',
    hasProductPhotos,
    hasTemplate,
  });

  console.log('[logos] Image prompt sent to', image_model, ':\n', prompt);

  // Generate image
  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(prompt, imgAspect, geminiKey, refImages, image_model);
    } else {
      imgBuffer = await generateWithGptImage2(prompt, imgSizeGpt, openaiKey, refImages);
    }
    filename = `logo_${p.id}_${Date.now()}.png`;
    if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGOS_DIR, filename), imgBuffer);
  } catch (err) {
    console.error('[logos] image generation failed:', err.message);
    if (err.cause) console.error('  cause:', err.cause.code || err.cause.message);
    return res.status(502).json({ error: `Error al generar logo: ${err.message}` });
  }

  const saved = product_logos.insert({
    product_id: p.id,
    user_id:    req.user.id,
    image_path: filename,
    prompt,
    size:        imgSize,
    template:    template_id || null,
    brand_name:  brand_name || null,
    brand_slogan: brand_slogan || null,
  });

  res.json({
    id:          saved.id,
    image_url:   `/logos/${filename}`,
    prompt_used: prompt,
    template:    template_id || null,
    template_image_url: template_id && template_id !== 'custom' ? `/ad-templates/${ad_templates.one(template_id)?.image_path}` : null,
  });
});

// ── DELETE /api/logos/:id/items/:logoId ────────────────────────
router.delete('/:id/items/:logoId', (req, res) => {
  const ok = product_logos.delete(req.params.logoId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Logo no encontrado' });
  res.json({ message: 'Logo eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Prompt builder — focused on LOGO / BRAND IDENTITY design
// ─────────────────────────────────────────────────────────────────
function buildLogoPrompt({ productName, brandName, brandSlogan, research, extra, lang, hasProductPhotos, hasTemplate }) {
  const finalBrand = brandName || productName;

  // ───────── PRODUCT context block (informational only — never rendered) ─────────
  const productContext = hasProductPhotos
    ? `Product context (for inspiration only — the product itself does NOT appear in the logo): the brand is for a product called "${productName}". Reference photos of that product are attached AFTER the template. Use them ONLY to understand the product's category and visual personality; do NOT draw, illustrate, or include the product in the logo.`
    : `Product/brand context: "${productName}".`;

  // ───────── TEMPLATE block — THE CORE ─────────
  const templateBlock = hasTemplate
    ? `═══ LOGO TEMPLATE (FIRST attached image — the DESIGN BLUEPRINT to replicate) ═══
The FIRST attached image is the LOGO TEMPLATE. Your job is to produce a NEW logo that REPLICATES the template's design language EXACTLY, but for a different brand name.

REPLICATE FROM THE TEMPLATE (must match faithfully):
 • Logo TYPE (wordmark / lettermark / combination / emblem / symbol+text) — use exactly the same type as the template.
 • Typography family / typeface character (serif, sans-serif, slab, script, geometric, humanist, etc.) — use the same family character.
 • Typography weight (thin/light/regular/medium/bold/black) and case (uppercase, lowercase, title case).
 • Letter spacing (tight, normal, loose) and any custom letter treatments visible in the template.
 • Color palette — use the SAME hex values as the template (or near-identical).
 • Mark / icon style (if the template has one): same geometric language (rounded vs angular vs organic), same line weight, same complexity level.
 • Layout — relationship between text and mark (icon-above-text, icon-left-of-text, text-only, etc.) and proportional sizing.
 • Background treatment (solid color, transparent, gradient) — use the same.
 • Overall mood and "design era" feel (modern minimalist / vintage / retro / luxury serif / sporty / playful / techy).

SWAP ONLY (the new brand identity):
 • Replace the template's brand name with the NEW brand name "${finalBrand}".
 • If the template has a slogan/tagline, replace it with the new slogan (if provided) or remove it.
 • If the template has an icon/symbol, you MAY adapt the icon to subtly reflect the NEW brand's category — but keep the icon's STYLE (line weight, geometry, complexity) IDENTICAL to the template. Do NOT change to a completely different design language.

DO NOT clone from the template:
 • The template's brand name or any other text on it.
 • Any taglines or descriptors that came with the template (use only the new slogan if specified).`
    : '';

  // ───────── BRAND block ─────────
  const brandLine = `Brand name to feature in the new logo: "${finalBrand}" — spelled CHARACTER-BY-CHARACTER IDENTICAL. Every letter, every accent (á é í ó ú ñ ç etc.), every uppercase/lowercase. No drift, no missing letters, no extra letters, no creative misspellings.`;
  const sloganLine = brandSlogan ? `Tagline / slogan (small, secondary text — usually below or beside the wordmark): "${brandSlogan}" — spelled exactly.` : '';

  // ───────── RESEARCH block ─────────
  const researchBlock = research
    ? `═══ STRATEGIC RESEARCH CONTEXT (informs the visual TONE of the logo — do NOT render any of this as text) ═══
${research}
═══ END OF RESEARCH ═══

Use the research above to FINE-TUNE design choices: brand personality, value proposition, target audience, emotional feeling. If the template gives the structural design and color, the research informs WHY this brand should feel a certain way. When in doubt, the TEMPLATE wins over the research.`
    : '';

  const extraLine = extra ? `═══ ADDITIONAL USER INSTRUCTIONS ═══\n${extra.slice(0, 700)}` : '';

  // Spell out the brand name character-by-character to fight letter-drift in image models
  const spelledBrand = [...finalBrand].map(c => `"${c}"`).join(' ');

  return sanitizeText(`ROLE
You are a senior brand identity designer at a top-tier studio (think Pentagram, Sagmeister & Walsh, Landor, Collins). Your specialty is producing logos with the polish, restraint, and conceptual clarity of award-winning brand systems — never generic AI-stock-logo look.

GOAL
${hasTemplate
  ? `Produce a single, polished LOGO that takes the attached LOGO TEMPLATE and faithfully replicates its design language — typography, mark style, color palette, layout, mood — for the new brand "${finalBrand}". The output should feel like the same designer made both logos for sibling brands.`
  : `Produce a single, polished, professional LOGO for the new brand "${finalBrand}". Distinctive, on-brand, vector-look quality, ready for use across web/print/packaging/app icons.`}

═══ PRIORITIES (apply in this order — each rule overrides the rules below it) ═══
 ${hasTemplate
   ? ` 1. Replicate the template's design language (typography family, weight, color palette, mark style, layout) — this is the MOST IMPORTANT rule. The new logo should look like a "sibling" of the template, not a different design.
 2. Spell the brand name "${finalBrand}" with character-by-character accuracy.
 3. Apply the research context to subtly inform the tone — only where it doesn't conflict with the template.
 4. Maintain premium design quality: clean edges, generous spacing, vector-style precision.`
   : ` 1. Spell the brand name "${finalBrand}" with character-by-character accuracy.
 2. Pick the most appropriate logo type for the brand personality (research-driven).
 3. Maintain premium design quality: clean edges, generous spacing, vector-style precision, distinctive — never generic AI-style.`}

${templateBlock}

═══ BRAND ═══
${brandLine}
${sloganLine}
${productContext}

${researchBlock}

${!hasTemplate ? `═══ LOGO TYPE & STYLE (no template — design from scratch using the research) ═══
Pick the most appropriate logo type based on the brand personality from the research:
 • WORDMARK: Brand name only with expressive typography (e.g. Google, Coca-Cola). Best for: distinctive brand names worth featuring.
 • LETTERMARK: Stylized initials (e.g. HBO, IBM). Best for: long or hard-to-pronounce names.
 • COMBINATION: Wordmark + small icon/symbol next to or above it (most versatile — safe default).
 • EMBLEM: Brand name inside a contained symbol/shape (e.g. Starbucks, Harvard). Best for: heritage / artisanal / classic.

Typography: choose a typeface that matches the brand personality — sans-serif for modern/tech, serif for premium/editorial, script for elegant/handcrafted, slab for bold/utility, geometric for clean/minimal.
Use 1-3 colors max. Prefer a primary brand color + neutral (white/black/grey) accent.
` : ''}

═══ COMPOSITION ═══
 • A SINGLE logo composition centered on the canvas. Generous negative space (logo occupies ~50-70% of the canvas).
 • Background: solid color${hasTemplate ? ' matching the template' : ' (white, light grey, dark navy, or a soft brand-color background)'}. NEVER busy, photographic, or textured.
 • Vector-look quality — sharp clean edges, no blur, no JPEG artifacts, no AI rendering tells.
 • Logo must read at thumbnail size (test mentally: would this work as a 32×32 favicon?).

═══ ABSOLUTE PROHIBITIONS ═══
 ✗ NO photographs, NO photographic textures, NO realistic product imagery.
 ✗ NO PEOPLE, NO HANDS, NO BODY PARTS, NO HUMAN FIGURES.
 ✗ NO multiple logo variations side-by-side — ONE single composition only.
 ✗ NO mockup framing (no business cards, no t-shirts, no brand-guide layouts) — just the logo on a clean background.
 ✗ NO invented text — only the brand name and optional slogan listed above.
 ✗ NO AI-generic clichés: purple-pink gradients, generic flower icons, swoosh checkmarks, cliché stock-logo lightbulbs/leaves/mountains.
 ✗ NO text spelling errors: every letter, every accent must be perfect.
 ${hasTemplate ? '✗ Do NOT change the template\'s typography family, weight, mark style, or color palette unless explicitly required by the new brand category.' : ''}

═══ TEXT RULES (CRITICAL) ═══
 • The brand name "${finalBrand}" must be spelled CHARACTER-BY-CHARACTER as written: ${spelledBrand}. No drift, no missing accents, no creative misspellings.
 ${brandSlogan ? `• The slogan "${brandSlogan}" appears once, small, naturally placed near the wordmark.` : ''}
 • Render all text in ${lang}, but keep the brand name spelled as provided regardless of language.
 • Letters perfectly formed — no fused, partial, mangled, or invented characters.

═══ QUALITY ═══
 • Professional brand identity work, indistinguishable from a top design agency deliverable.
 • Crisp, scalable, instantly recognizable. The kind of logo that would survive a brand audit.
 • Suitable for: website header, business card, app icon, social media profile picture, product packaging, signage.

═══ OUTPUT ═══
A single premium logo for "${finalBrand}"${hasTemplate ? ' — a faithful sibling of the attached template, with the new brand name and (optional) slogan' : ' — distinctive, on-brand, vector-quality'}. Clean background. Brand text perfect. Ready for production use.

${extraLine}`);
}

// Light sanitizer — collapses multiple blank lines for cleaner prompts
function sanitizeText(s) {
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ─────────────────────────────────────────────────────────────────
// Image generation engines
// ─────────────────────────────────────────────────────────────────

async function generateWithGptImage2(prompt, size, apiKey, referenceImages = []) {
  // No reference images → simple text-to-image
  if (!referenceImages.length) {
    const r = await undiciFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' }),
      dispatcher: longRunningAgent,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
    return Buffer.from(d.data[0].b64_json, 'base64');
  }

  // With reference images → use /images/edits multipart (native FormData + Blob)
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', 'high');
  referenceImages.slice(0, 4).forEach((dataUrl, idx) => {
    const p = parseDataUrl(dataUrl);
    if (p) form.append('image[]', new Blob([p.buffer], { type: p.mime }), `ref_${idx}.${p.ext}`);
  });
  const r = await undiciFetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
    dispatcher: longRunningAgent,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
  return Buffer.from(d.data[0].b64_json, 'base64');
}

async function generateWithNanoBanana(prompt, aspectRatio, apiKey, referenceImages = [], imageModel = 'nano_banana_2') {
  const refs = (referenceImages || []).map(parseDataUrl).filter(Boolean).slice(0, 4);
  const geminiModelId = NANO_BANANA_MODELS[imageModel] || NANO_BANANA_MODELS.nano_banana_2;

  const parts = [{ text: prompt }];
  refs.forEach(ref => parts.push({ inlineData: { mimeType: ref.mime, data: ref.b64 } }));

  const r = await undiciFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['image', 'text'], imageConfig: { aspectRatio } },
      }),
      dispatcher: longRunningAgent,
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `Gemini error ${r.status}`);
  const part = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part?.inlineData?.data) throw new Error('No se recibieron datos de imagen de Gemini');
  return Buffer.from(part.inlineData.data, 'base64');
}

// ─────────────────────────────────────────────────────────────────
// Image utilities
// ─────────────────────────────────────────────────────────────────

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  const subtype = m[1].toLowerCase();
  const mime    = `image/${subtype === 'jpg' ? 'jpeg' : subtype}`;
  const ext     = subtype === 'jpeg' ? 'jpg' : subtype;
  return { mime, ext, b64: m[2], buffer: Buffer.from(m[2], 'base64') };
}

function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let i = 2;
    while (i < buffer.length) {
      if (buffer[i] !== 0xFF) return null;
      const marker = buffer[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      i += 2 + buffer.readUInt16BE(i + 2);
    }
  }
  return null;
}

function pickSizeForAspect(width, height, model) {
  const r = width / height;
  if (model === 'gpt_image_2') {
    if (r > 1.25) return '1536x1024';
    if (r < 0.8)  return '1024x1536';
    return '1024x1024';
  }
  if (model === 'nano_banana_2' || model === 'nano_banana_pro') {
    if (r > 1.6) return '16:9';
    if (r > 1.2) return '4:3';
    if (r < 0.6) return '9:16';
    if (r < 0.85) return '3:4';
    return '1:1';
  }
  // dall-e-3 fallback
  if (r > 1.25) return '1792x1024';
  if (r < 0.8)  return '1024x1792';
  return '1024x1024';
}

module.exports = router;
