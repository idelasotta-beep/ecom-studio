const express = require('express');
const { callKie } = require('../lib/kie');
const fs      = require('fs');
const path    = require('path');
const { products, product_research, product_angles, product_landings, product_assembled_landings, ad_templates, LANDING_CATEGORIES, user_settings } = require('../db');
const { ensureWebP, webpPathFor } = require('../lib/image-optim');
const crypto = require('crypto');
function uid() { return crypto.randomBytes(6).toString('hex'); }
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const LANDINGS_DIR  = mediaDir('landings');
const TEMPLATES_DIR = mediaDir('ad-templates');

// ── Model registry (same as products.js) ────────────────────────
const MODELS = {
  'gpt-4.1':                  { provider: 'openai',    label: 'GPT-4.1',          key_field: 'openai_key' },
  'gpt-4.1-mini':             { provider: 'openai',    label: 'GPT-4.1 mini',     key_field: 'openai_key' },
  'gpt-4.1-nano':             { provider: 'openai',    label: 'GPT-4.1 nano',     key_field: 'openai_key' },
  'gpt-4o':                   { provider: 'openai',    label: 'GPT-4o',           key_field: 'openai_key' },
  'gpt-4o-mini':              { provider: 'openai',    label: 'GPT-4o mini',      key_field: 'openai_key' },
  'o3':                       { provider: 'openai',    label: 'o3',               key_field: 'openai_key' },
  'o4-mini':                  { provider: 'openai',    label: 'o4-mini',          key_field: 'openai_key' },
  'claude-opus-4-7':          { provider: 'anthropic', label: 'Claude Opus 4.7',  key_field: 'claude_key' },
  'claude-sonnet-4-6':        { provider: 'anthropic', label: 'Claude Sonnet 4.6',key_field: 'claude_key' },
  'claude-haiku-4-5-20251001':{ provider: 'anthropic', label: 'Claude Haiku 4.5', key_field: 'claude_key' },
  'gemini-2.5-pro':           { provider: 'google',    label: 'Gemini 2.5 Pro',   key_field: 'gemini_key' },
  'gemini-2.5-flash':         { provider: 'google',    label: 'Gemini 2.5 Flash', key_field: 'gemini_key' },
  'gemini-2.0-flash':         { provider: 'google',    label: 'Gemini 2.0 Flash', key_field: 'gemini_key' },
  // Kie.ai — sólo modelos en formato Chat Completions / Messages.
  // Kie.ai 2026 frontier
  'kie:claude-opus-4-7':       { provider: 'kie', label: 'Claude Opus 4.7 (Kie.ai)',     key_field: 'kieai_key' },
  'kie:claude-sonnet-4-6':     { provider: 'kie', label: 'Claude Sonnet 4.6 (Kie.ai)',   key_field: 'kieai_key' },
  'kie:gemini-3.1-pro':        { provider: 'kie', label: 'Gemini 3.1 Pro (Kie.ai)',      key_field: 'kieai_key' },
  'kie:gemini-3-pro':          { provider: 'kie', label: 'Gemini 3 Pro (Kie.ai)',        key_field: 'kieai_key' },
  // Kie.ai legacy
  'kie:gpt-5-2':              { provider: 'kie', label: 'GPT-5.2 (Kie.ai)',              key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':    { provider: 'kie', label: 'Claude Sonnet 4.5 (Kie.ai)',    key_field: 'kieai_key' },
  'kie:claude-opus-4-5':      { provider: 'kie', label: 'Claude Opus 4.5 (Kie.ai)',      key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':       { provider: 'kie', label: 'Gemini 2.5 Pro (Kie.ai)',       key_field: 'kieai_key' },
};

// NOTE: 'original' is intentionally not in any SIZE_MAP. When user selects "Tamaño Original",
// it means "use the template's aspect ratio" — the missing entry triggers the auto-detection
// branch in the size resolution logic. Without a template, falls back to the '|| 1024x1024' default.
const SIZE_MAP = {
  fb_linkedin: '1792x1024',
  ig_square:   '1024x1024',
  ig_stories:  '1024x1792',
  yt_hd:       '1792x1024',
  banner:      '1024x1024',
  leaderboard: '1792x1024',
  skyscraper:  '1024x1792',
  fb_square:   '1024x1024',
  tiktok:      '1024x1792',
};

// GPT Image 2 (gpt-image-1) — only supports 3 sizes + auto
const GPT_IMAGE_SIZE_MAP = {
  fb_linkedin: '1536x1024',
  ig_square:   '1024x1024',
  ig_stories:  '1024x1536',
  yt_hd:       '1536x1024',
  banner:      '1024x1024',
  leaderboard: '1536x1024',
  skyscraper:  '1024x1536',
  fb_square:   '1024x1024',
  tiktok:      '1024x1536',
};

// Nano Banana family (Gemini image generation)
// Banana 2 = fast, Banana Pro = studio quality + precise text rendering
const NANO_BANANA_MODELS = {
  nano_banana_2:   'gemini-3.1-flash-image-preview',
  nano_banana_pro: 'gemini-3-pro-image-preview',
};
const isNanoBanana = (m) => m === 'nano_banana_2' || m === 'nano_banana_pro';

const GEMINI_ASPECT_MAP = {
  fb_linkedin: '16:9',
  ig_square:   '1:1',
  ig_stories:  '9:16',
  yt_hd:       '16:9',
  banner:      '4:3',
  leaderboard: '16:9',
  skyscraper:  '9:16',
  fb_square:   '1:1',
  tiktok:      '9:16',
};

// ── GET /api/ads — products with ad counts ───────────────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    ad_count: product_landings.forProduct(p.id).length,
  }));
  res.json({ products: list });
});

// ── GET /api/landings/categories ──────────────────────────────────────
router.get('/categories', (_req, res) => {
  res.json({ categories: LANDING_CATEGORIES });
});

// ── GET /api/landings/authority-images — gallery for the "Prueba de autoridad" element ──
// Returns globals (admin-uploaded "AS SEEN ON" strips, etc.) + the user's own uploads.
router.get('/authority-images', (req, res) => {
  const list = ad_templates.visibleByKind(req.user.id, 'authority').map(t => ({
    id:        t.id,
    name:      t.name || '',
    image_url: `/ad-templates/${t.image_path}`,
    is_mine:   t.owner_id != null && t.owner_id == req.user.id,
  }));
  res.json({ templates: list });
});

// ── GET /api/landings/templates — landing templates for gallery ───────
// `?source=ecom` → only globals; `?source=mine` → only user's own; otherwise all visible.
router.get('/templates', (req, res) => {
  const { category, source } = req.query;
  let list;
  if (source === 'mine') {
    list = ad_templates.forUserByKind(req.user.id, 'landing');
  } else if (source === 'ecom') {
    list = ad_templates.globalByKind('landing');
  } else {
    list = ad_templates.visibleByKind(req.user.id, 'landing');
  }
  if (category && LANDING_CATEGORIES.includes(category)) {
    list = list.filter(t => t.category === category);
  }
  const templates = list.map(t => ({
    ...t,
    image_url: `/ad-templates/${t.image_path}`,
    is_mine: t.owner_id != null && t.owner_id == req.user.id,
  }));
  res.json({ templates, categories: LANDING_CATEGORIES });
});

// ── GET /api/landings/:id — product + ads + research + angles ─────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ads = product_landings.forProduct(p.id).map(a => {
    let template_image_url = null;
    if (a.template) {
      const tpl = ad_templates.one(a.template);
      if (tpl?.image_path) template_image_url = `/ad-templates/${tpl.image_path}`;
    }
    return {
      ...a,
      image_url: `/landings/${a.image_path}`,
      prompt_used: a.prompt,
      template_image_url,
    };
  });
  res.json({
    product:  p,
    ads,
    research: product_research.forProduct(p.id),
    angles:   product_angles.forProduct(p.id),
  });
});

// ── POST /api/landings/:id/autofill — AI text autofill ────────────────
router.post('/:id/autofill', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const settings = user_settings.get(req.user.id);
  let apiKey, provider, modelId;
  if (settings?.openai_key) {
    apiKey = settings.openai_key; provider = 'openai'; modelId = 'gpt-4o-mini';
  } else if (settings?.claude_key) {
    apiKey = settings.claude_key; provider = 'anthropic'; modelId = 'claude-haiku-4-5-20251001';
  } else if (settings?.kieai_key) {
    apiKey = settings.kieai_key; provider = 'kie'; modelId = 'gpt-5-2';
  } else {
    return res.status(402).json({ error: 'Configura tu API key de OpenAI, Anthropic o Kie.ai en Ajustes → APIs' });
  }
  const { angle_content } = req.body;
  const angleCtx = angle_content ? `\n\nÁngulo de venta:\n${angle_content.slice(0, 800)}` : '';
  const prompt = `Eres un copywriter experto en e-commerce. Genera textos para un anuncio del producto "${p.name}".${angleCtx}

Devuelve SOLO JSON válido:
{"headline":"titular (máx 8 palabras)","subheadline":"subtítulo (máx 15 palabras)","cta":"CTA (máx 4 palabras)","price":"precio sugerido","offer":"oferta/descuento","tagline":"slogan (máx 8 palabras)"}`;
  try {
    let content;
    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({model:modelId,messages:[{role:'user',content:prompt}],max_tokens:300,temperature:.7}) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error?.message); content = d.choices[0].message.content;
    } else if (provider === 'kie') {
      content = await callKie({ apiKey, modelId, userPrompt: prompt, maxTokens: 300, temperature: 0.7 });
    } else {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Type':'application/json'}, body:JSON.stringify({model:modelId,max_tokens:300,messages:[{role:'user',content:prompt}]}) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error?.message); content = d.content[0].text;
    }
    res.json(JSON.parse(content.replace(/```json\n?|\n?```/g,'').trim()));
  } catch (err) {
    res.status(502).json({ error: `Error al auto-completar: ${err.message}` });
  }
});

// ── POST /api/landings/:id/generate ───────────────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  const {
    image_model = 'gpt_image_2',
    template_id, template_url, photos, size, language, model_id, bg_color,
    nationality, gender, age_range,
    include_person = true,          // when false, render only the product (no character) — overrides template
    product_details, angle_description, specific_problem, avatar, solution,
    additional_instructions,
  } = req.body;
  const includePerson = include_person !== false;

  // Validate bg_color format if provided
  const safeBgColor = (typeof bg_color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(bg_color))
    ? bg_color.toUpperCase()
    : null;

  // Validate required key for the selected image engine
  if (isNanoBanana(image_model)) {
    if (!geminiKey)
      return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana. Configúrala en Ajustes → APIs' });
  } else {
    if (!openaiKey)
      return res.status(402).json({ error: 'Se requiere API key de OpenAI para GPT Image 2. Configúrala en Ajustes → APIs' });
  }

  let imgSize    = SIZE_MAP[size]           || '1024x1024';
  let imgSizeGpt = GPT_IMAGE_SIZE_MAP[size] || '1024x1024';
  let imgAspect  = GEMINI_ASPECT_MAP[size]  || '1:1';

  // Permission check: if a template is selected, the user must own it (or it must be global).
  if (template_id && template_id !== 'custom') {
    const tplCheck = ad_templates.one(template_id);
    if (!ad_templates.isUsableBy(tplCheck, req.user.id)) {
      return res.status(403).json({ error: 'No puedes usar esta plantilla' });
    }
  }

  // Analyze product photos with GPT-4o Vision (only if OpenAI key available)
  let photoDesc = null;
  if (photos?.length > 0 && openaiKey) {
    try { photoDesc = await analyzePhotos(photos, p.name, openaiKey); } catch (_) {}
  }

  // Analyze template style with GPT-4o Vision (only if OpenAI key available)
  let templateDesc = null;
  if (openaiKey) {
    if (template_id && template_id !== 'custom') {
      const tpl = ad_templates.one(template_id);
      if (tpl) {
        const file = path.join(TEMPLATES_DIR, tpl.image_path);
        if (fs.existsSync(file)) {
          try {
            const ext = tpl.image_path.split('.').pop() || 'png';
            const b64 = fs.readFileSync(file).toString('base64');
            templateDesc = await analyzeTemplateStyle(`data:image/${ext};base64,${b64}`, openaiKey);
          } catch (_) {}
        }
      }
    } else if (template_url?.startsWith('data:')) {
      try { templateDesc = await analyzeTemplateStyle(template_url, openaiKey); } catch (_) {}
    }
  }

  // Reference images — order matters: BANNER MODEL FIRST, then product photos.
  // The prompt tells the image model "the first reference is the layout to clone".
  const refImages = [];
  let hasTemplateRef = false;
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
          hasTemplateRef = true;
        } catch (_) {}
      }
    }
  } else if (typeof template_url === 'string' && template_url.startsWith('data:')) {
    refImages.push(template_url);
    hasTemplateRef = true;
    const m = template_url.match(/^data:image\/\w+;base64,(.+)$/);
    if (m) templateBuffer = Buffer.from(m[1], 'base64');
  }

  // User-selected size always wins. Fall back to template aspect only when the user
  // didn't explicitly pick a size (smart default for "auto" behavior).
  const userPickedSize = typeof size === 'string' && size.length > 0 && SIZE_MAP[size];
  if (templateBuffer && !userPickedSize) {
    const dims = getImageDimensions(templateBuffer);
    if (dims) {
      imgSize    = pickSizeForAspect(dims.width, dims.height, 'dall-e-3');
      imgSizeGpt = pickSizeForAspect(dims.width, dims.height, 'gpt_image_2');
      imgAspect  = pickSizeForAspect(dims.width, dims.height, 'nano_banana_2');
      console.log(`[generate] No size selected → using template aspect: ${dims.width}x${dims.height} → DALL-E ${imgSize} | GPT-Image ${imgSizeGpt} | Gemini ${imgAspect}`);
    }
  } else {
    console.log(`[generate] User-selected size ${size}: DALL-E ${imgSize} | GPT-Image ${imgSizeGpt} | Gemini ${imgAspect}`);
  }
  let hasProductPhotos = false;
  if (Array.isArray(photos)) {
    photos.forEach(ph => {
      if (typeof ph === 'string' && ph.startsWith('data:')) { refImages.push(ph); hasProductPhotos = true; }
    });
  }

  // Pre-pass: look at the template (to identify text zones) + product photos (for palette),
  // then generate exact copy for each zone of the template adapted to the new product.
  // Makes the image model a renderer of fixed text + colors instead of inventing them.
  let bannerAssets = null;
  if (openaiKey) {
    const templateDataUrl = refImages[0] && refImages[0].startsWith('data:') ? refImages[0] : null;
    bannerAssets = await generateLandingAssets({
      templateDataUrl,
      photos,
      productName: p.name,
      angle: angle_description,
      problem: specific_problem,
      avatar,
      solution,
      language,
      additionalInstructions: additional_instructions,
      apiKey: openaiKey,
    });
    if (bannerAssets) console.log('[generate] Landing assets pre-generated:', JSON.stringify(bannerAssets).slice(0, 800));
  }

  // If user supplied a fixed bg color, force it as the palette primary (overrides extracted palette)
  if (safeBgColor && bannerAssets?.palette) {
    bannerAssets.palette.primary = safeBgColor;
  } else if (safeBgColor && !bannerAssets) {
    bannerAssets = { palette: { primary: safeBgColor, secondary: '#FFFFFF', accent: '#000000', text_on_primary: '#FFFFFF', description: 'user-specified background color' }, copy_guidance: null };
  }

  // Build image prompt deterministically from user inputs.
  const inputs = {
    productName: p.name, photoDesc, templateDesc, language, nationality, gender, age_range,
    product_details, angle_description, specific_problem, avatar, solution, additional_instructions,
    hasProductPhotos, hasTemplateRef, bannerAssets, bgColor: safeBgColor, includePerson,
  };
  const imagePrompt = buildImagePrompt(inputs);
  console.log('[generate] Image prompt sent to', image_model, ':\n', imagePrompt);
  console.log('[generate] Reference images attached:', refImages.length);

  // Generate image with selected engine. GPT Image 2 and Nano Banana 2 accept reference images;
  // DALL-E 3 is text-only.
  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(imagePrompt, imgAspect, geminiKey, refImages, image_model);
      filename  = `ad_${req.user.id}_${Date.now()}.jpg`;
    } else if (image_model === 'gpt_image_2') {
      imgBuffer = await generateWithGptImage2(imagePrompt, imgSizeGpt, openaiKey, refImages);
      filename  = `ad_${req.user.id}_${Date.now()}.png`;
    } else {
      imgBuffer = await generateWithDallE(imagePrompt, imgSize, openaiKey);
      filename  = `ad_${req.user.id}_${Date.now()}.png`;
    }
  } catch (err) {
    console.error('[generate] image generation failed:', err.message);
    return res.status(502).json({ error: `Error generando anuncio: ${err.message}` });
  }

  fs.writeFileSync(path.join(LANDINGS_DIR, filename), imgBuffer);

  // Pull category + image url from the chosen template
  let landingCategory   = null;
  let templateImageUrl  = null;
  if (template_id && template_id !== 'custom') {
    const tplRec = ad_templates.one(template_id);
    if (tplRec) {
      if (tplRec.kind === 'landing') landingCategory = tplRec.category || null;
      if (tplRec.image_path) templateImageUrl = `/ad-templates/${tplRec.image_path}`;
    }
  }

  const ad = product_landings.insert({
    product_id: p.id, user_id: req.user.id, image_path: filename,
    prompt: imagePrompt, size: imgSize, template: template_id || null,
    category: landingCategory,
    headline: angle_description?.slice(0, 100) || null,
  });

  res.json({ id: ad.id, image_url: `/landings/${filename}`, prompt_used: imagePrompt, category: landingCategory, template: template_id || null, template_image_url: templateImageUrl });
});

// ── POST /api/landings/:id/landings/:adId/edit — re-generate with edit instruction ──
router.post('/:id/landings/:adId/edit', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ad = product_landings.one({ id: Number(req.params.adId), user_id: req.user.id });
  if (!ad) return res.status(404).json({ error: 'Anuncio no encontrado' });

  const { instruction, reference_image, image_model = 'gpt_image_2' } = req.body;
  if (!instruction || !instruction.trim())
    return res.status(400).json({ error: 'Falta la instrucción de edición' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  if (isNanoBanana(image_model) && !geminiKey)
    return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana' });
  if (!isNanoBanana(image_model) && !openaiKey)
    return res.status(402).json({ error: 'Se requiere API key de OpenAI' });

  // Load the existing ad image as a reference
  const existingFile = path.join(LANDINGS_DIR, ad.image_path);
  if (!fs.existsSync(existingFile))
    return res.status(404).json({ error: 'Archivo del anuncio original no encontrado' });
  const existingExt  = (path.extname(ad.image_path).slice(1) || 'png').toLowerCase();
  const existingMime = existingExt === 'jpg' ? 'jpeg' : existingExt;
  const existingDataUrl = `data:image/${existingMime};base64,${fs.readFileSync(existingFile).toString('base64')}`;

  // Reference images: original ad first, then optional user-uploaded reference
  const refImages = [existingDataUrl];
  if (typeof reference_image === 'string' && reference_image.startsWith('data:')) {
    refImages.push(reference_image);
  }

  // Pull product context for the AI: latest research + latest angle
  const research = product_research.forProduct(p.id);
  const angles   = product_angles.forProduct(p.id);
  const editPrompt = buildEditPrompt({
    productName:      p.name,
    instruction:      sanitizeImagePrompt(instruction.slice(0, 1000)),
    research:         research[0]?.content || '',
    angles:           angles[0]?.content   || '',
    originalPrompt:   ad.prompt || '',
    hasUserReference: refImages.length > 1,
  });

  console.log('[edit] Edit prompt:\n', editPrompt);

  // Determine output size: keep the original ad's aspect ratio
  const dims = getImageDimensions(fs.readFileSync(existingFile)) || { width: 1024, height: 1024 };
  const outSizeGpt = pickSizeForAspect(dims.width, dims.height, 'gpt_image_2');
  const outAspect  = pickSizeForAspect(dims.width, dims.height, 'nano_banana_2');

  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(editPrompt, outAspect, geminiKey, refImages, image_model);
      filename  = `ad_${req.user.id}_${Date.now()}.jpg`;
    } else {
      imgBuffer = await generateWithGptImage2(editPrompt, outSizeGpt, openaiKey, refImages);
      filename  = `ad_${req.user.id}_${Date.now()}.png`;
    }
  } catch (err) {
    console.error('[edit] image generation failed:', err.message);
    return res.status(502).json({ error: `Error editando anuncio: ${err.message}` });
  }

  fs.writeFileSync(path.join(LANDINGS_DIR, filename), imgBuffer);

  const newAd = product_landings.insert({
    product_id: p.id,
    user_id:    req.user.id,
    image_path: filename,
    prompt:     editPrompt,
    size:       `${dims.width}x${dims.height}`,
    template:   ad.template,
    category:   ad.category || null,
    headline:   `[Editado] ${(instruction || '').slice(0, 80)}`,
  });

  let editTemplateImageUrl = null;
  if (ad.template) {
    const tplRec = ad_templates.one(ad.template);
    if (tplRec?.image_path) editTemplateImageUrl = `/ad-templates/${tplRec.image_path}`;
  }
  res.json({ id: newAd.id, image_url: `/landings/${filename}`, prompt_used: editPrompt, category: ad.category || null, template: ad.template || null, template_image_url: editTemplateImageUrl });
});

// ── POST /api/landings/:id/landings/:adId/resize — recreate at new aspect ratio ────
const ASPECT_DEFS = {
  '1:1':  { gpt: '1024x1024', gemini: '1:1',  label: 'Cuadrado'                 },
  '9:16': { gpt: '1024x1536', gemini: '9:16', label: 'Instagram Story / TikTok' },
  '16:9': { gpt: '1536x1024', gemini: '16:9', label: 'YouTube / Widescreen'     },
  '3:4':  { gpt: '1024x1536', gemini: '3:4',  label: 'Pinterest Vertical'       },
  '4:3':  { gpt: '1536x1024', gemini: '4:3',  label: 'Presentaciones Estándar'  },
  '3:2':  { gpt: '1536x1024', gemini: '16:9', label: 'Fotografía DSLR Horizontal' },
  '5:4':  { gpt: '1536x1024', gemini: '4:3',  label: 'Clásico Horizontal'       },
  '4:5':  { gpt: '1024x1536', gemini: '3:4',  label: 'Instagram Feed Portrait'  },
};

router.post('/:id/landings/:adId/resize', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ad = product_landings.one({ id: Number(req.params.adId), user_id: req.user.id });
  if (!ad) return res.status(404).json({ error: 'Anuncio no encontrado' });

  const { aspect_ratio, image_model = 'gpt_image_2' } = req.body;
  const def = ASPECT_DEFS[aspect_ratio];
  if (!def) return res.status(400).json({ error: 'Aspect ratio inválido' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  if (isNanoBanana(image_model) && !geminiKey)
    return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana' });
  if (!isNanoBanana(image_model) && !openaiKey)
    return res.status(402).json({ error: 'Se requiere API key de OpenAI' });

  // Load original ad as reference
  const existingFile = path.join(LANDINGS_DIR, ad.image_path);
  if (!fs.existsSync(existingFile))
    return res.status(404).json({ error: 'Archivo del anuncio original no encontrado' });
  const existingExt  = (path.extname(ad.image_path).slice(1) || 'png').toLowerCase();
  const existingMime = existingExt === 'jpg' ? 'jpeg' : existingExt;
  const existingDataUrl = `data:image/${existingMime};base64,${fs.readFileSync(existingFile).toString('base64')}`;

  // Pull product context
  const research = product_research.forProduct(p.id);
  const angles   = product_angles.forProduct(p.id);

  const resizePrompt = buildResizePrompt({
    productName:    p.name,
    aspectRatio:    aspect_ratio,
    aspectLabel:    def.label,
    research:       research[0]?.content || '',
    angles:         angles[0]?.content   || '',
    originalPrompt: ad.prompt || '',
  });

  console.log('[resize] Resize prompt for', aspect_ratio, ':\n', resizePrompt);

  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(resizePrompt, def.gemini, geminiKey, [existingDataUrl], image_model);
      filename  = `ad_${req.user.id}_${Date.now()}.jpg`;
    } else {
      imgBuffer = await generateWithGptImage2(resizePrompt, def.gpt, openaiKey, [existingDataUrl]);
      filename  = `ad_${req.user.id}_${Date.now()}.png`;
    }
  } catch (err) {
    console.error('[resize] image generation failed:', err.message);
    return res.status(502).json({ error: `Error redimensionando anuncio: ${err.message}` });
  }

  fs.writeFileSync(path.join(LANDINGS_DIR, filename), imgBuffer);

  const newAd = product_landings.insert({
    product_id: p.id,
    user_id:    req.user.id,
    image_path: filename,
    prompt:     resizePrompt,
    size:       def.gpt,
    template:   ad.template,
    category:   ad.category || null,
    headline:   `[Resize ${aspect_ratio}] ${(ad.headline || '').slice(0, 60)}`,
  });

  let rszTemplateImageUrl = null;
  if (ad.template) {
    const tplRec = ad_templates.one(ad.template);
    if (tplRec?.image_path) rszTemplateImageUrl = `/ad-templates/${tplRec.image_path}`;
  }
  res.json({ id: newAd.id, image_url: `/landings/${filename}`, prompt_used: resizePrompt, aspect_ratio, category: ad.category || null, template: ad.template || null, template_image_url: rszTemplateImageUrl });
});

// ── DELETE /api/landings/:id/landings/:adId ────────────────────────────────
router.delete('/:id/landings/:adId', (req, res) => {
  const ad = product_landings.one({ id: Number(req.params.adId), user_id: req.user.id });
  if (ad) {
    const file = path.join(LANDINGS_DIR, ad.image_path);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }
  const ok = product_landings.delete(req.params.adId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Anuncio no encontrado' });
  res.json({ message: 'Anuncio eliminado' });
});

// ── AI Helpers ────────────────────────────────────────────────────
async function analyzePhotos(photos, productName, apiKey) {
  const imageContent = photos.slice(0, 3).map(photo => ({
    type: 'image_url', image_url: { url: photo, detail: 'low' },
  }));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: `Describe visually this product "${productName}" for ad image generation: colors, shape, key visual features, packaging. Max 80 words.` }] }],
      max_tokens: 150,
    }),
  });
  const d = await r.json();
  if (!r.ok) return null;
  return d.choices[0].message.content;
}

// Pre-pass for Landings: in ONE multimodal call, look at BOTH the template (to identify
// every text zone and its role/length) and the product images (to extract palette). Then
// generate exact, well-spelled copy for each text zone of the template — adapted to the
// new product, sales angle and avatar.
//
// The image model becomes a renderer of fixed strings and fixed colors instead of having
// to invent text on its own (which is where typos/mangled words happen).
async function generateLandingAssets({ templateDataUrl, photos, productName, angle, problem, avatar, solution, language, additionalInstructions, apiKey }) {
  const lang = (language || 'Spanish').trim();

  // Vision content: template first (for structure) + up to 2 product photos (for palette)
  const imgContent = [];
  if (templateDataUrl) {
    imgContent.push({ type: 'image_url', image_url: { url: templateDataUrl, detail: 'high' } });
  }
  (Array.isArray(photos) ? photos : [])
    .filter(p => typeof p === 'string' && p.startsWith('data:image/'))
    .slice(0, 2)
    .forEach(p => imgContent.push({ type: 'image_url', image_url: { url: p, detail: 'low' } }));

  const userText = `Eres un director de arte. Vas a adaptar una sección de landing page existente (REFERENCIA 1: el template) para un nuevo producto.

Tu tarea:
1. IDENTIFICAR TODAS las zonas de texto visibles en el template y, en ORDEN VISUAL (arriba→abajo, izquierda→derecha), describir su rol y longitud aproximada (titular, subtitular, párrafo, bullet, badge, CTA, precio, columna de tabla, pregunta de FAQ, respuesta, footer, etc.).
2. Extraer la PALETA DOMINANTE DEL PRODUCTO (REFERENCIAS 2+ si existen). Si no hay foto de producto, deduce paleta apropiada.
3. Generar el COPY adaptado al nuevo producto, ángulo y avatar — EN ${lang.toUpperCase()} — con UNA línea por zona del template.

Devuelve este JSON exacto:

{
  "palette": {
    "primary":   "#XXXXXX",
    "secondary": "#XXXXXX",
    "accent":    "#XXXXXX",
    "text_on_primary": "#FFFFFF or #000000",
    "description": "8-15 palabras describiendo el mood"
  },
  "copy_guidance": "Texto multilínea. Una línea por cada zona de texto del template, en el ORDEN VISUAL en que aparecen. Formato de cada línea: '[ROL — posición aproximada]: \"texto exacto a renderizar\"'. Ejemplo:\n[Titular — superior centro]: \"Texto exacto del titular en ${lang}\"\n[Subtitular — bajo titular]: \"Subtitular exacto en ${lang}\"\n[Bullet 1 — lista izquierda]: \"...\"\n[Bullet 2 — lista izquierda]: \"...\"\n[CTA — botón inferior]: \"Texto del botón en ${lang}\""
}

REGLAS:
- La paleta DEBE extraerse del producto cuando hay foto. No inventes colores ajenos al producto.
- El número de zonas de texto del copy_guidance DEBE coincidir con las que tiene el template — no agregues zonas, no quites zonas.
- La longitud de cada texto debe coincidir con la del template (titular = corto, párrafo = largo).
- Respeta el rol de cada zona (un CTA es un verbo de acción corto, un bullet es una afirmación corta, un titular es una frase impacto, un párrafo es una explicación).
- NO inventes información del producto que no esté en el contexto provisto.
- Cada palabra correctamente escrita en ${lang}, sin abreviaciones extrañas.

CONTEXTO DEL PRODUCTO:
- Nombre: ${productName || ''}
- Ángulo de venta: ${angle || ''}
- Problema que resuelve: ${problem || ''}
- Avatar / cliente ideal: ${avatar || ''}
- Solución / transformación: ${solution || ''}
${additionalInstructions ? `- Instrucciones adicionales del usuario: ${additionalInstructions}` : ''}

Devuelve SOLO el JSON, nada más.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [...imgContent, { type: 'text', text: userText }] }],
        max_tokens: 1500,
        temperature: 0.4,
      }),
    });
    const d = await r.json();
    if (!r.ok) return null;
    let txt = (d.choices?.[0]?.message?.content || '').replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(txt);
    if (!json.palette) return null;
    return json;
  } catch (err) {
    console.warn('[generate] generateLandingAssets failed:', err.message);
    return null;
  }
}

async function analyzeTemplateStyle(imageDataUrl, apiKey) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
        { type: 'text', text: `Forensic analysis of this advertising banner — be very specific and structural. Output as labelled bullet points:

LAYOUT: aspect ratio (vertical/square/horizontal), how is the canvas divided?
PRODUCT POSITION: where is the product placed (left/center/right, top/middle/bottom), what's its rough size and orientation?
TEXT BLOCKS: where are headline / subhead / CTA button / price / disclaimer placed? (use cardinal positions)
BACKGROUND: solid color / gradient / scenic / abstract? Exact colors?
LIGHTING: direction, intensity, hard or soft, dramatic or even?
COLOR PALETTE: 3-5 hex-equivalent dominant colors
TYPOGRAPHY STYLE: serif/sans-serif, bold/light, large hero text or small?
VISUAL VIBE: minimalist / aggressive / luxury / urgent / playful / clinical?
NEGATIVE SPACE: where is empty space deliberately preserved?

Be precise — this analysis will be used to replicate the structure with a different product.` },
      ]}],
      max_tokens: 500,
    }),
  });
  const d = await r.json();
  if (!r.ok) return null;
  return d.choices[0].message.content;
}

// Strip only content-moderation triggers that cause models to silently rewrite the prompt.
// We deliberately KEEP design words like "banner", "layout", "advertising" — those are needed
// for the banner-replication mode, and modern models (GPT Image 2, Nano Banana 2) don't
// have the same auto-rewrite problem DALL-E 3 had.
function sanitizeImagePrompt(prompt) {
  return (prompt || '')
    .replace(/\b(pheromone|pheromones|feromona|feromonas|seduction|seductive|seduce|sexual attraction|sex appeal|sensual|erotic|libido|aphrodisiac|arousal|orgasm)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const NATIONALITY_ADJ = {
  ar:'Argentine', bo:'Bolivian', br:'Brazilian', cl:'Chilean', co:'Colombian',
  cr:'Costa Rican', cu:'Cuban', do:'Dominican', ec:'Ecuadorian', sv:'Salvadoran',
  gt:'Guatemalan', hn:'Honduran', mx:'Mexican', ni:'Nicaraguan', pa:'Panamanian',
  py:'Paraguayan', pe:'Peruvian', pr:'Puerto Rican', uy:'Uruguayan', ve:'Venezuelan',
};

// Deterministic prompt builder.
// Two modes:
//   1. TEMPLATE REPLICATION (template selected): faithfully reproduce the template
//      structure for the new product — swapping product, persona, copy and palette.
//   2. NO-TEMPLATE FALLBACK: simple lifestyle composition.
function buildImagePrompt(inputs) {
  const { productName, photoDesc, templateDesc, language, nationality, gender, age_range,
    product_details, angle_description, specific_problem, avatar, solution, additional_instructions,
    hasProductPhotos, hasTemplateRef, bannerAssets, bgColor, includePerson = true } = inputs;
  const lang = (language || 'Spanish').trim();

  const sAngle    = angle_description ? sanitizeImagePrompt(angle_description) : '';
  const sProblem  = specific_problem  ? sanitizeImagePrompt(specific_problem)  : '';
  const sAvatar   = avatar            ? sanitizeImagePrompt(avatar)            : '';
  const sSolution = solution          ? sanitizeImagePrompt(solution)          : '';
  const sDetails  = product_details   ? sanitizeImagePrompt(product_details)   : '';
  const sExtra    = additional_instructions ? sanitizeImagePrompt(additional_instructions) : '';
  const sProduct  = sanitizeImagePrompt(productName || '');

  // ───────────── MODE 1: TEMPLATE REPLICATION ─────────────
  if (hasTemplateRef) {
    const dissection = templateDesc
      ? `\n═══ ANÁLISIS FORENSE DEL TEMPLATE (referencia estructural) ═══\n${sanitizeImagePrompt(templateDesc)}\n`
      : '';

    // ── PRODUCT block ──
    const productBlock = hasProductPhotos
      ? `Las imágenes del NUEVO producto están adjuntas DESPUÉS del template.
Reproduce el producto FIELMENTE: forma, color, label completo, todo el texto impreso (marca, dosis, peso, advertencias) — preserva cada palabra de manera idéntica y legible.
NO inventes ni alteres el producto.
${sDetails ? `Contexto del producto: ${sDetails.slice(0, 280)}` : ''}`
      : `Producto: ${sProduct}.
${photoDesc ? `Apariencia: ${sanitizeImagePrompt(photoDesc)}` : ''}
${sDetails  ? `Contexto: ${sDetails.slice(0, 280)}` : ''}`;

    // ── PERSON block ──
    const nat = NATIONALITY_ADJ[nationality] || nationality || '';
    const AGE_TRAITS = {
      '18-25': '18-25 años — apariencia juvenil, piel tersa, rasgos firmes',
      '25-35': '25-35 años — adulto joven, rasgos definidos',
      '35-45': '35-45 años — adulto maduro, ligeras líneas de expresión',
      '45-55': '45-55 años — mediana edad, líneas marcadas, posibles canas',
      '55-65': '55-65 años — adulto mayor, canas claras, rasgos maduros',
      '65+'  : '65 o más — apariencia senior con cabello canoso/blanco, rasgos claramente envejecidos',
    };
    const ageTraits = age_range ? (AGE_TRAITS[age_range] || `~${age_range} años`) : '';

    let demographic = '';
    if (gender === 'male')        demographic = `${nat} hombre`.trim();
    else if (gender === 'female') demographic = `${nat} mujer`.trim();
    else if (gender === 'both')   demographic = `${nat} pareja (hombre y mujer)`.trim();
    else if (nationality || age_range || sAvatar) demographic = `${nat} persona`.trim();
    demographic = demographic.replace(/\s{2,}/g, ' ').trim();

    const hasPersonSpec = !!(demographic || ageTraits || sAvatar);
    const contextLine = sProblem
      ? ` • CONTEXTO DEL PROBLEMA: el producto resuelve "${sProblem.slice(0, 240)}". Esto define POR COMPLETO la situación, lugar, vestimenta, actividad y actitud del personaje (ver reglas abajo).`
      : '';

    const personBlock = !includePerson
      ? `INSTRUCCIÓN CRÍTICA — SIN PERSONAS:
La imagen final NO DEBE contener NINGUNA persona, figura humana, rostro, cuerpo, parte del cuerpo (manos, dedos, brazos, hombros, cabello), silueta, ni elemento de apariencia humana — INCLUSO SI EL TEMPLATE DE REFERENCIA MUESTRA UNA O MÁS PERSONAS. Las zonas del template que muestran personas DEBEN SER REEMPLAZADAS por una de estas opciones (elige la que mejor preserve el layout):
 • PRODUCTO HERO: agranda el producto, agrégalo en una segunda vista/ángulo, o muestra variantes/ingredientes a su alrededor.
 • OBJETO LIFESTYLE: un objeto relacionado con el uso del producto (taza, libro, planta, vaso de agua, utensilios) — NUNCA mostrando manos ni interacción humana.
 • ESPACIO LIMPIO: gradiente suave o color sólido coherente con la paleta, con formas abstractas sutiles.

Prohibido absoluto: personas, rostros, manos, dedos, brazos, cabello, silhuetas, sugerencias de presencia humana (brazos entrando desde fuera del canvas, hombros parciales, vista POV de una mano sosteniendo el producto). El producto es el héroe visual indiscutido. Calidad fotorrealista de estudio.`
      : hasPersonSpec
      ? `Si el template muestra una o más personas, reemplázalas por la siguiente especificación:
${demographic ? ` • Quién: ${demographic}` : ''}
${ageTraits   ? ` • Edad / rasgos: ${ageTraits}` : ''}
${sAvatar     ? ` • Avatar / cliente ideal: ${sAvatar.slice(0, 280)}` : ''}
${contextLine}

REGLAS OBLIGATORIAS DE COHERENCIA CON EL PROBLEMA QUE RESUELVE EL PRODUCTO:
 • SITUACIÓN / ACTIVIDAD: el personaje debe estar haciendo algo COHERENTE con el momento de uso o el contexto del problema (ej: producto para dolor de espalda → persona en escritorio o levantando una caja; producto para insomnio → persona en dormitorio nocturno; producto deportivo → persona entrenando; producto culinario → persona cocinando; producto de skincare → persona frente al espejo del baño; suplemento digestivo → persona en su cocina/comedor con comida).
 • LUGAR / ESCENARIO: el fondo debe ser un entorno realista donde APARECE ese problema o donde se USA el producto (ej: oficina, gimnasio, dormitorio, cocina, baño, parque, sala, terraza, consultorio). NO uses fondos genéricos de estudio si el template no es un bodegón puro.
 • VESTIMENTA: ropa apropiada al lugar y a la actividad (ej: ropa deportiva en gimnasio, pijama o casual de noche en dormitorio, ropa casual en casa, formal en oficina, delantal en cocina). NUNCA uses vestimenta neutra de estudio si el escenario sugiere otra cosa.
 • UTILERÍA / OBJETOS DE APOYO: incluye objetos del entorno coherentes con la actividad (laptop en oficina, mancuernas en gimnasio, sartén en cocina, almohada en dormitorio, etc.) — sin opacar al producto.
 • ACTITUD / EXPRESIÓN: emoción acorde al estado que el producto produce o al momento del problema (ej: alivio tras tomar el producto, concentración mientras lo usa, satisfacción tras el resultado). NO uses sonrisas plásticas genéricas de catálogo.
 • LUZ / HORA DEL DÍA: coherente con el escenario (luz cálida de tarde en sala, luz fría matinal en baño, luz tenue nocturna en dormitorio, luz brillante de gimnasio).
${sSolution ? ` • TRANSFORMACIÓN A MOSTRAR: ${sSolution.slice(0, 200)} — refleja este estado en la actitud y entorno del personaje.` : ''}
${sAngle    ? ` • ÁNGULO DE COMUNICACIÓN: ${sAngle.slice(0, 200)} — el personaje y la escena deben comunicar visualmente este ángulo.` : ''}

CONSERVA del template: composición de la persona (encuadre, ángulo de cámara, tamaño relativo dentro del canvas), pose general y posición. CAMBIA: rasgos físicos, vestimenta, escenario, actividad, utilería y actitud para alinearlos con el problema/contexto descrito arriba.

Si el template no incluye personas, NO agregues ninguna.`
      : `Si el template muestra personas, conserva su género/edad/etnia tal como aparecen en el template, PERO ajusta su SITUACIÓN, LUGAR, VESTIMENTA y ACTITUD al contexto del problema que resuelve el producto${sProblem ? ` ("${sProblem.slice(0, 200)}")` : ''}. La escena debe sentirse como el momento real donde aparece el problema o donde se usa el producto, no un escenario neutro de catálogo. Si no incluye personas, no agregues ninguna.`;

    // ── PALETTE block ──
    let paletteBlock;
    if (bgColor) {
      paletteBlock = `Color predominante del fondo (especificado por el usuario): ${bgColor}.
Construye la paleta alrededor de este color como base. Mantén el contraste y la legibilidad del template.
${bannerAssets?.palette ? `Paleta complementaria sugerida (extraída del producto):
   • Secundario: ${bannerAssets.palette.secondary}
   • Acento:     ${bannerAssets.palette.accent}
   • Texto sobre fondo: ${bannerAssets.palette.text_on_primary}` : ''}`;
    } else if (bannerAssets?.palette) {
      paletteBlock = `Paleta extraída del nuevo producto (úsala para reemplazar la paleta del template):
   • Dominante:  ${bannerAssets.palette.primary}
   • Secundario: ${bannerAssets.palette.secondary}
   • Acento:     ${bannerAssets.palette.accent}
   • Texto sobre dominante: ${bannerAssets.palette.text_on_primary}
   Mood: ${bannerAssets.palette.description || 'alineado al producto'}
Adapta los colores del template a esta paleta MANTENIENDO la jerarquía visual (qué zona usa qué color).`;
    } else {
      paletteBlock = `Deriva la paleta del nuevo producto y úsala para reemplazar la del template, manteniendo la jerarquía visual.`;
    }

    // ── COPY block ──
    const copyBlock = bannerAssets?.copy_guidance
      ? `Cada zona de texto del template debe contener EXACTAMENTE lo siguiente, en ${lang}:

${bannerAssets.copy_guidance}

Respeta la cantidad y posición de las zonas: si el template tiene 1 titular + 3 bullets + 1 CTA, el resultado debe tener 1 titular + 3 bullets + 1 CTA. No agregues zonas inexistentes ni elimines zonas existentes. Cada palabra correctamente escrita en ${lang}, sin letras incompletas, sin palabras inventadas.`
      : `Adapta el contenido textual del template al nuevo producto y al ángulo de venta:
${[sAngle && `• Ángulo de venta: ${sAngle.slice(0, 280)}`,
   sProblem && `• Problema que resuelve: ${sProblem.slice(0, 200)}`,
   sSolution && `• Solución / transformación: ${sSolution.slice(0, 200)}`].filter(Boolean).join('\n')}

Mantén la MISMA cantidad de zonas de texto del template (titular, subtitular, bullets, CTA, badges, columnas, etc.) — no agregues ni quites zonas. Cada zona debe tener una longitud similar a la del template. Cada palabra correctamente escrita en ${lang}.`;

    return sanitizeImagePrompt(
`ROL
Eres un director de arte senior. Tu tarea es producir una RÉPLICA FIEL del template adjunto (REFERENCIA 1) para el nuevo producto. NO estás creando un anuncio nuevo: estás reusando la sección de landing del template, sustituyendo producto, personajes (si los hay), copy y paleta — manteniendo intactos la estructura, layout, tipografía, jerarquía visual y elementos decorativos.

═══ A. ESTRUCTURA (replicar exactamente del template) ═══
Clona del template:
 • Aspect ratio, márgenes y divisiones del canvas.
 • Posición, tamaño y proporción de cada elemento (producto, personas, zonas de texto, formas decorativas, iconos, badges, separadores, columnas de tabla, viñetas).
 • Tipografía: familia, peso, tamaño relativo, jerarquía.
 • Estilo visual general (fotográfico, ilustrado, flat, gradientes, sombras, formas).
 • Cantidad y distribución de zonas — no agregues elementos inexistentes, no elimines elementos existentes.

═══ B. PRODUCTO ═══
${productBlock}
Coloca el nuevo producto en la misma posición, escala y orientación que el producto del template. Si el template no muestra producto explícito, no fuerces uno.

═══ C. PERSONAJES ═══
${personBlock}

═══ D. PALETA ═══
${paletteBlock}

═══ E. COPY (texto a renderizar en el canvas) ═══
${copyBlock}

═══ F. ELEMENTOS A CONSERVAR DEL TEMPLATE ═══
 • CTAs / botones: si el template tiene botones, mantenlos en la misma forma, color y posición; solo adapta el texto al nuevo producto/ángulo.
 • Iconos, badges, sellos, formas decorativas, separadores, líneas, gradientes, ondas.
 • Estilo fotográfico/ilustrativo, mood lumínico, sombras, profundidad.
 • Numeración / orden de viñetas, jerarquía de columnas, headers de tabla.

═══ G. IDIOMA ═══
Todo el texto del canvas debe estar en ${lang}, ortografía perfecta, cada letra completa, sin caracteres extraños ni palabras fusionadas.

═══ H. CALIDAD ═══
 • Calidad fotorrealista o vectorial según el estilo del template.
 • Tipografía nítida, sin letras incompletas, fusionadas, duplicadas o ilegibles.
 • Iluminación coherente con un único punto de luz consistente.
 • Acabado profesional, listo para producción de landing page.

${sExtra ? `\n═══ I. INSTRUCCIONES ADICIONALES DEL USUARIO ═══\n${sExtra}\n` : ''}
${dissection}`
    );
  }

  // ───────────── MODE 2: LIFESTYLE PHOTO (no template) ─────────────

  // MODE 2 — NO PERSON variant: product hero still-life, no character.
  if (!includePerson) {
    const productLineNP = hasProductPhotos
      ? `Reference image(s) of the EXACT product are attached. You MUST faithfully reproduce the product: keep its exact shape, color, label graphics, ALL printed text on the label (every word legible and identical), cap and proportions. Do NOT invent or alter the product.`
      : photoDesc
        ? `The product appearance: ${sanitizeImagePrompt(photoDesc)}.`
        : `A premium, sleek bottle / container of the product.`;
    const noTextRuleNP = hasProductPhotos
      ? `NO additional text, signs, banners, captions, watermarks or graphic-design overlays anywhere in the image — EXCEPT the product's own original label, which must be reproduced exactly as in the reference (every word on the label legible and identical). Pure photograph, not a poster.`
      : `Absolutely no text, no letters, no words, no labels, no typography anywhere — pure photograph, not a design layout.`;
    const partsNP = [
      `A cinematic, magazine-grade product photograph. The product is the unmistakable hero of the image.`,
      productLineNP,
      `Composition: the product centered or slightly off-center using rule-of-thirds, hero scale, shot from a flattering low-to-eye-level angle.`,
      `Staging: complementary still-life elements may appear around the product (ingredients, leaves, water droplets, a soft fabric, related objects) ONLY if they reinforce the product story. NO PEOPLE, NO HANDS, NO FINGERS, NO BODY PARTS, NO SILHOUETTES, NO HUMAN-SHAPED ELEMENTS of any kind anywhere in the frame.`,
      sDetails  ? `Product context: ${sDetails.slice(0, 200)}.` : '',
      sSolution ? `Mood the product conveys: ${sSolution.slice(0, 180)}.` : '',
      bgColor   ? `Background dominant color: ${bgColor}. Use it as the surface / backdrop tone.` : '',
      `Camera: shot on Sony A7R V, 90mm macro f/2.8, ISO 200. Hyper-realistic textures, perfect focus on the product, softly blurred background.`,
      `Lighting: studio softbox with a single coherent light source — natural shadows and highlights, premium magazine quality. Surface: clean tabletop, marble, polished wood, or textured neutral background — matching the product palette.`,
      `Quality: photorealistic, magazine-grade, scroll-stopping. Premium, trustworthy, conversion-focused.`,
      noTextRuleNP,
      sExtra ? sExtra : '',
    ].filter(Boolean);
    return sanitizeImagePrompt(partsNP.join(' '));
  }

  const nat    = NATIONALITY_ADJ[nationality] || (nationality || 'Latin American');
  const ageStr = age_range ? `${age_range}-year-old` : '30-year-old';

  let character;
  if (gender === 'male') {
    character = `${ageStr} ${nat} man with strong masculine features, well-groomed dark hair, defined jawline, intense confident eyes and clear healthy skin, wearing tasteful modern clothing`;
  } else if (gender === 'female') {
    character = `${ageStr} ${nat} woman with striking beautiful features, luminous radiant skin, captivating expressive eyes, glossy hair and elegant styling, wearing tasteful modern clothing`;
  } else if (gender === 'both') {
    character = `attractive ${nat} couple in their ${age_range || '30s'} — a confident man and a beautiful woman together, both stylishly dressed`;
  } else {
    character = `${ageStr} ${nat} person with charismatic confident features, well-groomed appearance and clear healthy skin, wearing tasteful modern clothing`;
  }

  const emotion = sAngle
    ? `Their facial expression, posture and body language physically embody this feeling: "${sAngle.slice(0, 280)}". They look genuinely confident, fulfilled and self-assured`
    : `They radiate quiet confidence, charisma and inner power — relaxed posture, subtle knowing smile, eyes alive and present`;

  const productLine = hasProductPhotos
    ? `Reference image(s) of the EXACT product are attached. You MUST faithfully reproduce this product in the scene: keep its exact bottle shape, color, label graphics, ALL printed text on the label (preserve every word legibly), cap and proportions. Do NOT invent or alter the product. The person holds it naturally in one hand at chest height — clearly visible but secondary to the person.`
    : photoDesc
      ? `The person holds a small premium bottle at chest height — appearance: ${sanitizeImagePrompt(photoDesc)}.`
      : `The person holds a small sleek premium bottle naturally in their hand at chest height.`;

  const noTextRule = hasProductPhotos
    ? `NO additional text, signs, banners, captions, watermarks or graphic-design overlays anywhere in the image — EXCEPT the product's own original label, which must be reproduced exactly as in the reference (every word on the label must be legible and identical to the reference). Pure photograph, not a poster.`
    : `Absolutely no text, no letters, no words, no labels, no typography anywhere — pure photograph, not a design layout.${lang ? ` (Note: any unavoidable signage in scene should appear in ${lang}.)` : ''}`;

  const parts = [
    `A cinematic editorial lifestyle photograph of a ${character}.`,
    sAvatar   ? `About this person: ${sAvatar.slice(0, 220)}.` : '',
    `${emotion}.`,
    sProblem  ? `Scene conveys the AFTER-state: ${sProblem.slice(0, 220)}.` : '',
    sSolution ? `The character embodies this transformation: ${sSolution.slice(0, 180)}.` : '',
    productLine,
    sDetails  ? `Additional product context: ${sDetails.slice(0, 200)}.` : '',
    `Composition: three-quarter framing of the person, slightly low camera angle. Subject pin-sharp, softly blurred background with creamy bokeh.`,
    `Camera: shot on Sony A7R V, 85mm f/1.4, ISO 400. Hyper-realistic skin texture, catch lights in eyes. 8K RAW, magazine editorial quality.`,
    `Atmosphere: dark luxury — deep charcoal and obsidian tones with warm highlights, premium editorial mood.`,
    `Quality: photorealistic, magazine-grade. All shadows and highlights consistent with a single coherent light source. Premium, trustworthy, conversion-focused.`,
    noTextRule,
    sExtra ? sExtra : '',
  ].filter(Boolean);

  return sanitizeImagePrompt(parts.join(' '));
}

async function generateWithDallE(prompt, size, apiKey) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, quality: 'hd', response_format: 'url' }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
  const imgResp = await fetch(d.data[0].url);
  if (!imgResp.ok) throw new Error('No se pudo descargar la imagen generada');
  return Buffer.from(await imgResp.arrayBuffer());
}

// Read width/height from a PNG or JPEG buffer header (no dependencies)
function getImageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with w/h at byte 16/20
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: FF D8, walk segments to find SOF0-SOF3 marker
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xFF) return null;
      const marker = buffer[i + 1];
      if (marker >= 0xC0 && marker <= 0xC3) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      const segLen = buffer.readUInt16BE(i + 2);
      i += 2 + segLen;
    }
  }
  // WebP: RIFF....WEBP — VP8 / VP8L / VP8X
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buffer.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  return null;
}

// Pick the best output size for the template's aspect ratio
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
  // dall-e-3
  if (r > 1.25) return '1792x1024';
  if (r < 0.8)  return '1024x1792';
  return '1024x1024';
}

// Parse a data URL like "data:image/png;base64,XXXX" → { mime, ext, buffer, b64 }
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  const subtype = m[1].toLowerCase();
  const mime    = `image/${subtype === 'jpg' ? 'jpeg' : subtype}`;
  const ext     = subtype === 'jpeg' ? 'jpg' : subtype;
  return { mime, ext, b64: m[2], buffer: Buffer.from(m[2], 'base64') };
}

async function generateWithGptImage2(prompt, size, apiKey, referenceImages = []) {
  const refs = (referenceImages || []).map(parseDataUrl).filter(Boolean).slice(0, 4);

  // No reference images → pure text-to-image
  if (refs.length === 0) {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
    const b64 = d.data[0].b64_json;
    if (!b64) throw new Error('No se recibieron datos de imagen de GPT Image 2');
    return Buffer.from(b64, 'base64');
  }

  // Reference images present → use /v1/images/edits multipart endpoint
  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', prompt);
  formData.append('n', '1');
  formData.append('size', size);
  formData.append('quality', 'high');
  refs.forEach((ref, i) => {
    formData.append('image[]', new Blob([ref.buffer], { type: ref.mime }), `ref_${i}.${ref.ext}`);
  });

  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `GPT Image 2 edits error ${r.status}`);
  const b64 = d.data[0].b64_json;
  if (!b64) throw new Error('No se recibieron datos de imagen del endpoint de edición');
  return Buffer.from(b64, 'base64');
}

async function generateWithNanoBanana(prompt, aspectRatio, apiKey, referenceImages = [], imageModel = 'nano_banana_2') {
  const refs = (referenceImages || []).map(parseDataUrl).filter(Boolean).slice(0, 4);
  const geminiModelId = NANO_BANANA_MODELS[imageModel] || NANO_BANANA_MODELS.nano_banana_2;

  // Build parts: text first, then any reference images as inlineData
  const parts = [{ text: prompt }];
  refs.forEach(ref => {
    parts.push({ inlineData: { mimeType: ref.mime, data: ref.b64 } });
  });

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['image', 'text'], imageConfig: { aspectRatio } },
      }),
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `Gemini error ${r.status}`);
  const part = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part?.inlineData?.data) throw new Error('No se recibieron datos de imagen de Gemini');
  return Buffer.from(part.inlineData.data, 'base64');
}

// ── Prompt builders for edit / resize ────────────────────────────
function buildEditPrompt({ productName, instruction, research, angles, originalPrompt, hasUserReference }) {
  const sName     = sanitizeImagePrompt(productName || '');
  const sResearch = research ? sanitizeImagePrompt(research.slice(0, 3500)) : '';
  const sAngles   = angles   ? sanitizeImagePrompt(angles.slice(0, 2000))   : '';
  const sOrig     = originalPrompt ? sanitizeImagePrompt(originalPrompt.slice(0, 1500)) : '';

  const refLine = hasUserReference
    ? `The SECOND attached image is an additional visual reference uploaded by the user — use it to guide the requested change (e.g. style, color, element to add).`
    : '';

  return `ROLE: You are a senior art director editing an existing advertising banner.

TASK: Take the FIRST attached image (the current banner) and apply ONLY the change requested below. Preserve EVERYTHING ELSE — same layout, same product, same person/people, same typography, same colors, same composition, same mood. Only the requested change should be visible in the result.

═══ EDIT INSTRUCTION (apply this and only this) ═══
${instruction}

${refLine}

═══ PRODUCT CONTEXT (use as fact source — do NOT contradict the product's actual properties) ═══
Product: ${sName}

${sResearch ? `📊 INVESTIGATION:\n${sResearch}\n` : ''}
${sAngles   ? `🎯 SALES ANGLES:\n${sAngles}\n`   : ''}
${sOrig     ? `📝 ORIGINAL BANNER PROMPT (for reference — for things you should preserve):\n${sOrig}\n` : ''}

═══ STRICT RULES ═══
1. Output the EDITED banner — same aspect ratio as the original.
2. Preserve all elements not affected by the instruction. Don't redesign the whole banner.
3. The product label and printed text MUST remain identical.
4. The people in the scene (face, ethnicity, age, pose) must remain identical unless the instruction explicitly changes them.
5. Photographic studio quality, native banner style — never a generic lifestyle photo.`;
}

function buildResizePrompt({ productName, aspectRatio, aspectLabel, research, angles, originalPrompt }) {
  const sName     = sanitizeImagePrompt(productName || '');
  const sResearch = research ? sanitizeImagePrompt(research.slice(0, 3500)) : '';
  const sAngles   = angles   ? sanitizeImagePrompt(angles.slice(0, 1500))   : '';
  const sOrig     = originalPrompt ? sanitizeImagePrompt(originalPrompt.slice(0, 1500)) : '';

  return `ROLE: You are a senior art director adapting an existing advertising banner to a new aspect ratio.

TASK: Recreate the FIRST attached image (the current banner) at the new aspect ratio: ${aspectRatio} (${aspectLabel}). Adapt the composition naturally to fill the new aspect ratio while preserving the design's identity.

═══ ADAPTATION RULES ═══
1. PRESERVE: the product (exact bottle/box, label, printed text, colors, proportions), the people in the scene (face, ethnicity, age, pose, expression), the headline/subhead/CTA wording, the typography style, the color palette, the lighting style and the overall visual mood.
2. RECOMPOSE: rearrange the elements to fit the new ${aspectRatio} canvas naturally — extend the background where needed, reposition text blocks, scale the product appropriately. Do NOT crop or stretch the original. Treat this as a "responsive redesign" of the same banner.
3. If the new ratio is wider than the original (e.g. going to 16:9), distribute elements horizontally — product on one side, person and copy on the other.
4. If the new ratio is taller than the original (e.g. going to 9:16), stack elements vertically — copy on top, product+person below or vice versa.
5. Keep the same brand identity, typography weights, and design vibe. Don't redesign — re-arrange.

═══ PRODUCT CONTEXT (fact source — preserve) ═══
Product: ${sName}

${sResearch ? `📊 INVESTIGATION:\n${sResearch}\n` : ''}
${sAngles   ? `🎯 SALES ANGLES:\n${sAngles}\n`   : ''}
${sOrig     ? `📝 ORIGINAL BANNER PROMPT (preserve everything mentioned here):\n${sOrig}\n` : ''}

═══ OUTPUT ═══
A high-quality advertising banner in ${aspectRatio} aspect ratio, native premium look, photo-realistic studio quality. Same banner, new shape.`;
}

// ═══════════════════════════════════════════════════════════════
//  Assembled Landings — compositions made from selected landings
// ═══════════════════════════════════════════════════════════════

// Hydrate sections with image_url + headline from the referenced ad.
// Prefers the WebP-optimized version when it exists on disk (auto-generated at assemble time).
function hydrateSections(sections) {
  return (sections || []).map(s => {
    const ad = product_landings.one({ id: Number(s.source_ad_id) });
    let url = null;
    if (ad) {
      // Same base name with .webp extension is the optimized cache; fall back to the original.
      const webpName = ad.image_path.replace(/\.[^.]+$/, '.webp');
      const webpAbs  = path.join(LANDINGS_DIR, webpName);
      if (fs.existsSync(webpAbs)) url = `/landings/${webpName}`;
      else                        url = `/landings/${ad.image_path}`;
    }
    return {
      id:            s.id,
      source_ad_id:  s.source_ad_id,
      image_url:     url,
      headline:      ad?.headline || null,
      category:      ad?.category || null,
      missing:       !ad,
    };
  });
}

// GET /api/landings/:id/assembled — list all assembled landings for product
router.get('/:id/assembled', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const rows = product_assembled_landings.forProduct(p.id);
  const items = rows.map(r => ({
    ...r,
    hydrated_sections: hydrateSections(r.sections),
  }));
  res.json({ items });
});

// POST /api/landings/:id/assembled — body: { section_ids: [<adId>, ...] }
// Generates a WebP-optimized version of each source image (cached on disk).
router.post('/:id/assembled', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ids = Array.isArray(req.body?.section_ids) ? req.body.section_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'Debes seleccionar al menos una landing' });
  // Validate every id belongs to a landing of this product
  const sections = [];
  const sourcePaths = [];
  for (const adId of ids) {
    const ad = product_landings.one({ id: Number(adId), product_id: p.id });
    if (!ad) return res.status(400).json({ error: `Landing ${adId} no pertenece a este producto` });
    sections.push({ id: uid(), source_ad_id: ad.id });
    sourcePaths.push(path.join(LANDINGS_DIR, ad.image_path));
  }

  // Generate WebP optimized copies in parallel — landing files are independent.
  // Each call is idempotent (cached on disk after first run).
  await Promise.all(sourcePaths.map(p => ensureWebP(p).catch(err => {
    console.warn('[landings/assemble] WebP gen failed:', err.message);
    return null;
  })));

  const row = product_assembled_landings.insert({
    user_id:    req.user.id,
    product_id: p.id,
    sections,
    elements:   [],
  });
  res.status(201).json({ ...row, hydrated_sections: hydrateSections(row.sections) });
});

// PUT /api/landings/:id/assembled/:aid — body: { sections?, elements? }
router.put('/:id/assembled/:aid', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const changes = {};
  if (Array.isArray(req.body?.sections)) {
    const sections = [];
    for (const s of req.body.sections) {
      const ad = product_landings.one({ id: Number(s.source_ad_id), product_id: p.id });
      if (!ad) return res.status(400).json({ error: `Landing ${s.source_ad_id} no pertenece a este producto` });
      sections.push({ id: s.id || uid(), source_ad_id: ad.id });
    }
    changes.sections = sections;
  }
  if (Array.isArray(req.body?.elements)) {
    changes.elements = req.body.elements;
  }
  const updated = product_assembled_landings.update(req.params.aid, req.user.id, changes);
  if (!updated) return res.status(404).json({ error: 'Landing ensamblada no encontrada' });
  res.json({ ...updated, hydrated_sections: hydrateSections(updated.sections) });
});

// DELETE /api/landings/:id/assembled/:aid
router.delete('/:id/assembled/:aid', (req, res) => {
  const ok = product_assembled_landings.delete(req.params.aid, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Landing ensamblada no encontrada' });
  res.json({ message: 'Landing ensamblada eliminada' });
});

module.exports = router;
