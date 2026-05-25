const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { products, product_mockups, product_research, ad_templates, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const MOCKUPS_DIR   = mediaDir('mockups');
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

// ── GET /api/mockups — products with mockup counts ───────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    mockup_count:   (product_mockups.forProduct(p.id) || []).length,
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/mockups/templates — list mockup templates ───────────
router.get('/templates', (req, res) => {
  const { source } = req.query;
  let list;
  if (source === 'mine') {
    list = ad_templates.forUserByKind(req.user.id, 'mockup');
  } else if (source === 'ecom') {
    list = ad_templates.globalByKind('mockup');
  } else {
    list = ad_templates.visibleByKind(req.user.id, 'mockup');
  }
  const templates = list.map(t => ({
    ...t,
    image_url: `/ad-templates/${t.image_path}`,
    is_mine: t.owner_id != null && t.owner_id == req.user.id,
  }));
  res.json({ templates });
});

// ── GET /api/mockups/:id — product + mockups + research ─────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:  p,
    mockups:  product_mockups.forProduct(p.id),
    research: product_research.forProduct(p.id),
  });
});

// ── POST /api/mockups/:id/generate ───────────────────────────────
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
      researchContent = research.content.slice(0, 6000); // cap to avoid bloating the prompt
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
  const prompt = buildMockupPrompt({
    productName: p.name,
    brandName:   (brand_name || '').trim(),
    brandSlogan: (brand_slogan || '').trim(),
    research:    researchContent,
    extra:       (additional_instructions || '').trim(),
    lang:        language || 'Spanish',
    hasProductPhotos,
    hasTemplate,
  });

  console.log('[mockups] Image prompt sent to', image_model, ':\n', prompt);

  // Generate image
  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(prompt, imgAspect, geminiKey, refImages, image_model);
    } else {
      imgBuffer = await generateWithGptImage2(prompt, imgSizeGpt, openaiKey, refImages);
    }
    filename = `mockup_${p.id}_${Date.now()}.png`;
    if (!fs.existsSync(MOCKUPS_DIR)) fs.mkdirSync(MOCKUPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(MOCKUPS_DIR, filename), imgBuffer);
  } catch (err) {
    console.error('[mockups] image generation failed:', err.message);
    if (err.cause) console.error('  cause:', err.cause.code || err.cause.message);
    return res.status(502).json({ error: `Error al generar mockup: ${err.message}` });
  }

  const saved = product_mockups.insert({
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
    image_url:   `/mockups/${filename}`,
    prompt_used: prompt,
    template:    template_id || null,
    template_image_url: template_id && template_id !== 'custom' ? `/ad-templates/${ad_templates.one(template_id)?.image_path}` : null,
  });
});

// ── DELETE /api/mockups/:id/items/:mockupId ──────────────────────
router.delete('/:id/items/:mockupId', (req, res) => {
  const ok = product_mockups.delete(req.params.mockupId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Mockup no encontrado' });
  res.json({ message: 'Mockup eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Prompt builder — focused on PRODUCT MOCKUPS (staging/packaging)
// ─────────────────────────────────────────────────────────────────
function buildMockupPrompt({ productName, brandName, brandSlogan, research, extra, lang, hasProductPhotos, hasTemplate }) {
  // ───────── PRODUCT block ─────────
  const productBlock = hasProductPhotos
    ? `Reference image(s) of the EXACT product are attached AFTER the template reference. You MUST faithfully reproduce this NEW product, keeping its exact bottle/box/object shape, color, material finish, label graphics, ALL printed text on the label (brand name, dosage, weight, every word — preserve identically and legibly), cap, proportions, and orientation. Do NOT invent or alter the new product.`
    : `Product name: ${productName}. Render the product as a clean, professional packaging/container appropriate to its category.`;

  // ───────── TEMPLATE block — THE CORE ─────────
  const templateBlock = hasTemplate
    ? `═══ MOCKUP TEMPLATE (FIRST attached image — the BLUEPRINT to replicate) ═══
The FIRST attached image is the MOCKUP TEMPLATE. Your job is to produce a NEW mockup that REPLICATES the template's photography setup EXACTLY, but with the new product swapped in.

REPLICATE FROM THE TEMPLATE (must match faithfully):
 • Camera angle and perspective (worm's-eye, eye-level, 3/4, top-down — whatever the template uses)
 • Composition and framing (where the product sits on the canvas, what fraction of the frame it occupies, rule-of-thirds positioning, negative space)
 • Surface / background (exact material, color, texture, finish — marble, wood, paper, gradient, lifestyle context, etc.)
 • Lighting setup (direction, hardness, color temperature, the way shadows fall, highlights on glossy surfaces)
 • Color palette and overall mood
 • Props arrangement (if the template has secondary objects: ingredients, ribbons, leaves, glass, fabric — keep the SAME types of props in the SAME spots, just adapted to the new product's category)
 • Depth of field and bokeh characteristics
 • Aspect ratio and crop

SWAP ONLY (the new product):
 • Replace the template's product with the NEW product (provided in the attached reference photos OR described above). Keep the new product in roughly the SAME position, scale, and orientation as the template's product. Adjust lighting on the product to match the template's lighting direction.
 • If the template's props are clearly tied to its original product category (e.g. coffee beans for a coffee product) and they don't fit the new product, REPLACE them with equivalent props that fit the new product's category — but keep the SAME visual placement, count, and proportions.

DO NOT clone from the template:
 • The template's specific product (the new product replaces it entirely).
 • The template's brand name, label text, or any text on the template's product. Use the new brand/text described below.`
    : '';

  // ───────── BRAND TEXT block ─────────
  const brandLine = brandName ? `Brand name to render on the new product's label/packaging: "${brandName}" — spell it CHARACTER-BY-CHARACTER IDENTICAL (every accent, every letter). It must be clean and legible.` : '';
  const sloganLine = brandSlogan ? `Brand slogan to render as small secondary text on the packaging (if it fits naturally): "${brandSlogan}" — spelled exactly as written.` : '';

  // ───────── RESEARCH block ─────────
  const researchBlock = research
    ? `═══ STRATEGIC RESEARCH CONTEXT (informs the MOOD of the staging — do NOT render any of this as visible text on the mockup) ═══
${research}
═══ END OF RESEARCH ═══

Use the research above to fine-tune the staging mood: if the brand is premium/aspirational, lean into clean lighting and minimal props; if it's earthy/natural, use warm tones and organic textures; if it's clinical/medical, use cool tones and white surfaces. The research informs FEELING, not visible content.`
    : '';

  const extraLine = extra ? `═══ ADDITIONAL USER INSTRUCTIONS ═══\n${extra.slice(0, 700)}` : '';

  return sanitizeText(`ROLE
You are a senior advertising product photographer and digital mockup artist. Your specialty is producing premium, magazine-grade product mockups indistinguishable from real studio photography — the kind that appears on luxury brand catalogs, Vogue advertising, and Apple-tier product pages.

GOAL
Produce a single, photorealistic PRODUCT MOCKUP that takes the attached MOCKUP TEMPLATE and faithfully replicates its photography setup for the NEW product. The output should be visually 95%+ identical to the template — same lighting, same surface, same composition, same mood — with only the product itself replaced.

═══ PRIORITIES (apply in this order — each rule overrides the rules below it) ═══
 1. Replicate the template's photography setup (camera angle, surface, lighting, composition, props) — this is the MOST IMPORTANT rule. The viewer should feel they're looking at the same shoot, just with a different product.
 2. Reproduce the new product accurately — shape, color, label, every word of text on its label exactly as in the reference photo.
 3. Render the brand name and slogan (if provided) clean and legible, character-by-character identical to what's specified below.
 4. Maintain premium photographic quality: real-camera realism, perfect focus, natural shadows and reflections, no AI-generic look.

${templateBlock}

═══ NEW PRODUCT (the only element that changes from the template) ═══
${productBlock}
${brandLine}
${sloganLine}

${researchBlock}

═══ ABSOLUTE PROHIBITIONS ═══
 ✗ NO PEOPLE, NO HANDS, NO FINGERS, NO BODY PARTS, NO SILHOUETTES, NO HUMAN-SHAPED ELEMENTS anywhere in the frame.
 ✗ NO promotional headlines, NO marketing slogans on the canvas (the product's own label is the only place text appears).
 ✗ NO call-to-action buttons, NO "Buy now" overlays, NO price tags floating in the frame.
 ✗ NO invented text — only what's on the product label, the brand name, and optional slogan (if specified above).
 ✗ NO AI-generic aesthetics: NO purple/pink gradients, NO over-saturated colors, NO Photoshop "fake" glow, NO cartoonish renderings, NO low-effort stock-photo look.
 ✗ Do NOT change the template's surface, lighting direction, camera angle, or composition unless the new product physically requires it (e.g. a tall bottle vs a flat box).
 ✗ NO text spelling errors: every letter, every accent (á, é, í, ñ, etc.) must be perfect.

═══ TEXT RULES (CRITICAL) ═══
 • The product's own label/packaging text must be reproduced EXACTLY as in the attached product reference (every word, accent, special character — IDENTICAL).
 • The brand name "${brandName || productName}" must be spelled CHARACTER-BY-CHARACTER as written: ${[...(brandName || productName)].map(c => `"${c}"`).join(' ')}. No drift, no missing accents, no creative variations.
 ${brandSlogan ? `• The slogan "${brandSlogan}" appears once, small, naturally placed.` : ''}
 • All text in ${lang}. Letters perfectly formed — no fused, partial, mangled, or invented characters.

═══ QUALITY ═══
 • Photorealistic, magazine-grade. The image should look like it was shot on a Sony A7R V or Hasselblad — not generated. Hyper-realistic textures, perfect product focus, natural depth of field, accurate material reflections (matte vs glossy vs metallic).
 • Single coherent light source matching the template's direction. Shadows are physically accurate. Reflections on glossy surfaces match the template's reflective behavior.
 • Color accuracy: the new product's brand colors are vivid and true to the reference; the surface and props match the template's palette.
 • Final image is scroll-stopping, premium, and could go directly onto a luxury e-commerce product page without further editing.

═══ OUTPUT ═══
A premium, photorealistic PRODUCT MOCKUP that is visually a faithful sibling of the attached template — same shoot, new product. Brand text perfect. Quality of a top-tier advertising agency campaign.

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
