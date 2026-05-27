const express = require('express');
const { callKie } = require('../lib/kie');
const fs      = require('fs');
const path    = require('path');
const { products, product_research, product_angles, product_ads, ad_templates, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const ADS_DIR       = mediaDir('ads');
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
    ad_count: product_ads.forProduct(p.id).length,
  }));
  res.json({ products: list });
});

// ── GET /api/ads/templates — ad templates for gallery ────────────
// `?source=ecom` → only globals; `?source=mine` → only user's own; otherwise all visible.
router.get('/templates', (req, res) => {
  const { source } = req.query;
  let list;
  if (source === 'mine') {
    list = ad_templates.forUserByKind(req.user.id, 'ad');
  } else if (source === 'ecom') {
    list = ad_templates.globalByKind('ad');
  } else {
    list = ad_templates.visibleByKind(req.user.id, 'ad');
  }
  const templates = list.map(t => ({
    ...t,
    image_url: `/ad-templates/${t.image_path}`,
    is_mine: t.owner_id != null && t.owner_id == req.user.id,
  }));
  res.json({ templates });
});

// ── GET /api/ads/:id — product + ads + research + angles ─────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ads = product_ads.forProduct(p.id).map(a => {
    let template_image_url = null;
    if (a.template) {
      const tpl = ad_templates.one(a.template);
      if (tpl?.image_path) template_image_url = `/ad-templates/${tpl.image_path}`;
    }
    return {
      ...a,
      image_url: `/ads/${a.image_path}`,
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

// ── POST /api/ads/:id/autofill — AI text autofill ────────────────
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

// ── POST /api/ads/:id/generate ───────────────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  const {
    image_model = 'gpt_image_2',
    headline_style,                 // 'statement' | 'question'
    template_id, template_url, photos, size, language, model_id,
    nationality, gender, age_range,
    include_person = true,          // when false, render only the product (no character) — overrides template
    product_details, angle_description, specific_problem, avatar, solution,
    additional_instructions,
  } = req.body;
  const safeHeadlineStyle = headline_style === 'question' ? 'question' : 'statement';
  const includePerson = include_person !== false;

  // Validate required key for the selected image engine
  if (isNanoBanana(image_model)) {
    if (!geminiKey)
      return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana 2. Configúrala en Ajustes → APIs' });
  } else {
    if (!openaiKey)
      return res.status(402).json({ error: 'Se requiere API key de OpenAI para DALL-E 3 / GPT Image 2. Configúrala en Ajustes → APIs' });
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

  // Pre-pass: extract palette from product photos + generate exact banner copy.
  // Makes GPT Image 2 a renderer of fixed text+colors instead of inventing them.
  let bannerAssets = null;
  if (openaiKey) {
    bannerAssets = await generateBannerAssets({
      photos, productName: p.name, angle: angle_description, problem: specific_problem,
      avatar, solution, language, headlineStyle: safeHeadlineStyle, apiKey: openaiKey,
    });
    if (bannerAssets) console.log('[generate] Banner assets pre-generated:', JSON.stringify(bannerAssets));
  }

  // Build image prompt deterministically from user inputs.
  const inputs = {
    productName: p.name, photoDesc, templateDesc, language, nationality, gender, age_range,
    product_details, angle_description, specific_problem, avatar, solution, additional_instructions,
    hasProductPhotos, hasTemplateRef, bannerAssets, includePerson,
    headlineStyle: safeHeadlineStyle,
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

  fs.writeFileSync(path.join(ADS_DIR, filename), imgBuffer);

  const ad = product_ads.insert({
    product_id: p.id, user_id: req.user.id, image_path: filename,
    prompt: imagePrompt, size: imgSize, template: template_id || null,
    headline: angle_description?.slice(0, 100) || null,
  });

  let templateImageUrl = null;
  if (template_id && template_id !== 'custom') {
    const tplRec = ad_templates.one(template_id);
    if (tplRec?.image_path) templateImageUrl = `/ad-templates/${tplRec.image_path}`;
  }
  res.json({ id: ad.id, image_url: `/ads/${filename}`, prompt_used: imagePrompt, template: template_id || null, template_image_url: templateImageUrl });
});

// ── POST /api/ads/:id/ads/:adId/edit — re-generate with edit instruction ──
router.post('/:id/ads/:adId/edit', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ad = product_ads.one({ id: Number(req.params.adId), user_id: req.user.id });
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
  const existingFile = path.join(ADS_DIR, ad.image_path);
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

  fs.writeFileSync(path.join(ADS_DIR, filename), imgBuffer);

  const newAd = product_ads.insert({
    product_id: p.id,
    user_id:    req.user.id,
    image_path: filename,
    prompt:     editPrompt,
    size:       `${dims.width}x${dims.height}`,
    template:   ad.template,
    headline:   `[Editado] ${(instruction || '').slice(0, 80)}`,
  });

  let editTemplateImageUrl = null;
  if (ad.template) {
    const tplRec = ad_templates.one(ad.template);
    if (tplRec?.image_path) editTemplateImageUrl = `/ad-templates/${tplRec.image_path}`;
  }
  res.json({ id: newAd.id, image_url: `/ads/${filename}`, prompt_used: editPrompt, template: ad.template || null, template_image_url: editTemplateImageUrl });
});

// ── POST /api/ads/:id/ads/:adId/resize — recreate at new aspect ratio ────
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

router.post('/:id/ads/:adId/resize', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const ad = product_ads.one({ id: Number(req.params.adId), user_id: req.user.id });
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
  const existingFile = path.join(ADS_DIR, ad.image_path);
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

  fs.writeFileSync(path.join(ADS_DIR, filename), imgBuffer);

  const newAd = product_ads.insert({
    product_id: p.id,
    user_id:    req.user.id,
    image_path: filename,
    prompt:     resizePrompt,
    size:       def.gpt,
    template:   ad.template,
    headline:   `[Resize ${aspect_ratio}] ${(ad.headline || '').slice(0, 60)}`,
  });

  let rszTemplateImageUrl = null;
  if (ad.template) {
    const tplRec = ad_templates.one(ad.template);
    if (tplRec?.image_path) rszTemplateImageUrl = `/ad-templates/${tplRec.image_path}`;
  }
  res.json({ id: newAd.id, image_url: `/ads/${filename}`, prompt_used: resizePrompt, aspect_ratio, template: ad.template || null, template_image_url: rszTemplateImageUrl });
});

// ── DELETE /api/ads/:id/ads/:adId ────────────────────────────────
router.delete('/:id/ads/:adId', (req, res) => {
  const ad = product_ads.one({ id: Number(req.params.adId), user_id: req.user.id });
  if (ad) {
    const file = path.join(ADS_DIR, ad.image_path);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }
  const ok = product_ads.delete(req.params.adId, req.user.id);
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

// Pre-pass: in ONE multimodal call, extract a hex palette FROM THE PRODUCT IMAGE
// and generate exact, short, well-spelled banner copy. This makes the image model
// behave like a renderer that copies fixed text and fixed colors, instead of having
// to invent + spell + colorize on its own (which is where mangling happens).
async function generateBannerAssets({ photos, productName, angle, problem, avatar, solution, language, headlineStyle, apiKey }) {
  const lang = (language || 'Spanish').trim();
  const style = headlineStyle === 'question' ? 'question' : 'statement';
  const imgContent = (Array.isArray(photos) ? photos : [])
    .filter(p => typeof p === 'string' && p.startsWith('data:image/'))
    .slice(0, 2)
    .map(p => ({ type: 'image_url', image_url: { url: p, detail: 'low' } }));

  // Headline rules vary by user-selected style. Statement = magazine label (Meta-safer).
  // Question = direct question to identify the viewer with the problem (higher CTR but
  // higher Meta-rejection risk — chosen explicitly by the user).
  const headlineRules = style === 'question'
    ? `- "headline": Una PREGUNTA DIRECTA dirigida al viewer para que se identifique con el problema que resuelve el producto.
  Reglas:
    - Entre 3 y 8 palabras. Empezar con signo "¿" y terminar con "?" (en español).
    - Tono empático, no agresivo. Apela al problema o deseo del avatar.
    - Puede incluir pronombres personales ("tú", "tu", "te").
    - En mayúsculas para alto impacto visual O en formato sentencia (capitalización normal) — depende de qué luzca mejor; por defecto MAYÚSCULAS.
  EJEMPLOS PERMITIDOS:
    ✓ "¿SUFRES DE HINCHAZÓN?"
    ✓ "¿Te duelen las rodillas?"
    ✓ "¿Cansada de las arrugas?"
    ✓ "¿QUIERES DORMIR MEJOR?"
    ✓ "¿Tu piel se ve apagada?"
    ✓ "¿Te falta energía cada día?"
  Nota: este formato puede tener mayor riesgo de rechazo en Meta Ads — fue elegido explícitamente por el usuario.`
    : `- "headline": 1-3 PALABRAS, en MAYÚSCULAS, estilo ETIQUETA / TÍTULO DE REVISTA. Solo declara el problema/tema/beneficio que el producto aborda, SIN preguntar al viewer ni asumir que él lo tiene.
  PROHIBIDO (Meta lo rechaza por asumir atributo personal):
    ✗ "¿SUFRES DE HINCHAZÓN?" (pregunta personal)
    ✗ "¿TE DUELE LA ESPALDA?" (pregunta personal)
    ✗ "¿CANSADA DE LAS ARRUGAS?" (pregunta personal con género asumido)
    ✗ "TÚ TIENES HINCHAZÓN" (afirmación personal)
  PERMITIDO (declarar tema o beneficio sin dirigirse al viewer):
    ✓ "HINCHAZÓN" (etiqueta directa del tema — sin pregunta)
    ✓ "INFLAMACIÓN ABDOMINAL" (etiqueta del tema)
    ✓ "DOLOR DE RODILLAS" (etiqueta del tema)
    ✓ "ARRUGAS" (etiqueta del tema)
    ✓ "CAÍDA DEL CABELLO" (etiqueta del tema)
    ✓ "PIEL JOVEN" (etiqueta del beneficio)
    ✓ "DIGESTIÓN SANA" (etiqueta del beneficio)
    ✓ "ADIÓS HINCHAZÓN" (frase impacto sin pregunta — opcional)
  Reglas:
    - 1-3 palabras MÁXIMO. NO usar más.
    - Sin signo de pregunta "?". Sin "¿Sufres", "¿Tienes", "¿Te duele".
    - Sin pronombres personales ("tu", "te", "tú").
    - El headline declara el TEMA/PROBLEMA o el BENEFICIO como una etiqueta, igual que la portada de una revista (ej: "ESTRÉS", "FATIGA", "SUEÑO REPARADOR").
    - Va en mayúsculas, alto impacto visual, listo para titular grande.`;

  // Subhead rules also slightly relax for "question" style — it's the user's choice.
  const metaPolicySection = style === 'question'
    ? `═══ POLÍTICAS DE META — RECOMENDACIONES ═══
1. Evita afirmaciones absolutas ("cura", "elimina", "garantiza") y plazos específicos en días/semanas.
2. Evita body-shaming: la pregunta debe apuntar al problema, no a un defecto físico del viewer.
3. Mantén el tono empático y respetuoso.`
    : `═══ POLÍTICAS DE META — REGLAS OBLIGATORIAS ═══
1. PROHIBIDO ASUMIR ATRIBUTOS PERSONALES del usuario. NO uses preguntas que asuman que el viewer tiene un problema/condición/atributo personal:
   - PROHIBIDO: "¿Sufres de hinchazón?", "¿Tienes acné?", "¿Te duele la espalda?", "¿Eres obeso?", "¿Tienes problemas de calvicie?"
   - PERMITIDO: "Conoce esta solución natural", "Descubre el poder de [producto]", "Una alternativa para tu bienestar"
2. PROHIBIDO BODY-SHAMING o crear inseguridad. Nada que sugiera que la persona tiene defectos que necesita corregir.
3. PROHIBIDOS HEALTH CLAIMS específicos con plazos. NO uses "Cura X en N días", "Elimina X en N semanas", "Resultados garantizados".
   - PROHIBIDO: "Elimina la celulitis en 7 días", "Cura la inflamación en 5 días", "Pierde 10 kilos en 30 días"
   - PERMITIDO: "Apoya tu bienestar", "Contribuye a una digestión saludable", "Una ayuda natural para tu rutina"
4. PROHIBIDAS PROMESAS GARANTIZADAS. NO uses "Garantizado", "100% efectivo", "Funciona o tu dinero de vuelta" como gancho.
5. PROHIBIDO BEFORE/AFTER framing. No insinuar transformación dramática.`;

  const userText = `Eres un director creativo de agencia publicitaria especializada en CTR (click-through rate) para Meta Ads (Facebook + Instagram).

ESTILO DEL TITULAR ELEGIDO POR EL USUARIO: ${style.toUpperCase()}
${style === 'question'
    ? '→ El headline DEBE ser una pregunta directa al viewer.'
    : '→ El headline DEBE ser una afirmación / etiqueta corta tipo portada de revista (sin pregunta).'}

${metaPolicySection}

Devuelve este JSON exacto:

{
  "palette": {
    "primary":   "#XXXXXX",
    "secondary": "#XXXXXX",
    "accent":    "#XXXXXX",
    "text_on_primary": "#FFFFFF or #000000",
    "description": "8-15 palabras describiendo el mood de la paleta"
  },
  "copy": {
    "headline": "...",
    "subhead":  "...",
    "benefits": ["...", "...", "..."]
  }
}

REGLAS PARA LA PALETA:
- Si hay imagen(es) del producto adjuntas, los colores DEBEN extraerse directamente de ellas (del envase, label y fotos del producto). NO inventes colores ajenos.
- "primary" = color dominante del producto. "secondary" = segundo color del producto. "accent" = color de alto contraste para acentos.
- Si no hay imágenes, usa colores apropiados a la categoría sugerida por el nombre/contexto.

REGLAS PARA EL COPY (en ${lang}):

${headlineRules}

- "subhead": 8-12 palabras MÁXIMO. Debe MENCIONAR EL NOMBRE DEL PRODUCTO y describir su propósito en términos GENERALES y SUAVES — sin promesas medicas específicas con plazos.
  PROHIBIDO (Meta lo rechaza):
    ✗ "Cura la inflamación en 7 días" (claim médico con plazo)
    ✗ "Elimina las arrugas en 5 días" (claim absoluto)
    ✗ "Garantiza pérdida de 10kg" (promesa garantizada)
    ✗ "Solución 100% efectiva contra X"
  PERMITIDO (Meta-compliant — usa verbos suaves: "apoya", "contribuye", "ayuda", "favorece"):
    ✓ "Papaya Cleanse apoya tu sistema digestivo de forma natural." (9)
    ✓ "Renova Skin ayuda a mantener tu piel joven y radiante." (10)
    ✓ "HairBoost contribuye a la fuerza y vitalidad de tu cabello." (10)
    ✓ "JointFlex favorece la flexibilidad articular en tu rutina diaria." (9)
  El subhead debe afirmar QUE EL PRODUCTO HACE algo positivo, sin usar verbos absolutos como "cura", "elimina", "garantiza", "remueve completamente", ni plazos específicos en días/semanas.

- "benefits": array de EXACTAMENTE 3 beneficios cortos del producto, derivados del ÁNGULO DE VENTA seleccionado por el usuario. Estos serán renderizados como una pequeña lista de bullets en el banner.
  Reglas:
    - Cada beneficio: 2-5 palabras MÁXIMO. Frases muy cortas, escaneables de un golpe.
    - Cada uno destaca un atributo/resultado/ventaja distinta del producto que refuerce el ángulo de venta.
    - NO repetir el contenido del headline ni del subhead.
    - Mismo idioma (${lang}) y registro que el resto del copy.
    - Capitalización: primera letra mayúscula, resto minúscula (estilo bullet, no MAYÚSCULAS).
    - Sin verbos absolutos ("cura", "elimina"), sin plazos en días/semanas, sin "garantizado".
  EJEMPLOS PERMITIDOS (3 beneficios distintos por producto):
    ✓ ["Fórmula 100% natural", "Acción rápida", "Sin efectos secundarios"]
    ✓ ["Hidratación profunda", "Antioxidantes naturales", "Apto piel sensible"]
    ✓ ["Resultados visibles", "Uso diario fácil", "Recomendado por dermatólogos"]
    ✓ ["Aporta energía", "Apoya digestión", "Equilibra el organismo"]
  Los 3 beneficios DEBEN reflejar el ángulo de venta provisto en CONTEXTO DEL PRODUCTO — no inventes beneficios genéricos si el ángulo apunta a otra cosa.

- IMPORTANTE: NO generes campo "cta". Este anuncio NO incluye botón.
- Usa palabras simples y comunes — evita términos raros o con muchas tildes.
- Cada palabra debe estar correctamente escrita en ${lang}.

CONTEXTO DEL PRODUCTO:
- Nombre: ${productName || ''}
- Ángulo de venta: ${angle || ''}
- Problema que resuelve: ${problem || ''}
- Avatar / cliente ideal: ${avatar || ''}
- Solución / transformación: ${solution || ''}

Devuelve SOLO el JSON, nada más.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: [...imgContent, { type: 'text', text: userText }] }],
        max_tokens: 800,
        temperature: 0.4,
      }),
    });
    const d = await r.json();
    if (!r.ok) return null;
    let txt = (d.choices?.[0]?.message?.content || '').replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(txt);
    if (!json.palette || !json.copy) return null;
    return json;
  } catch (err) {
    console.warn('[generate] generateBannerAssets failed:', err.message);
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
//   1. BANNER REPLICATION (template + product photos provided): clone the template's
//      structure/layout/style and swap in the new product. Inspired by the user's
//      master prompt for cloning ad creatives.
//   2. LIFESTYLE (no template): generate a person holding the product.
function buildImagePrompt(inputs) {
  const { productName, photoDesc, templateDesc, language, nationality, gender, age_range,
    product_details, angle_description, specific_problem, avatar, solution, additional_instructions,
    hasProductPhotos, hasTemplateRef, bannerAssets, headlineStyle, includePerson = true } = inputs;
  const lang  = (language || 'Spanish').trim();
  const style = headlineStyle === 'question' ? 'question' : 'statement';

  const sAngle    = angle_description ? sanitizeImagePrompt(angle_description) : '';
  const sProblem  = specific_problem  ? sanitizeImagePrompt(specific_problem)  : '';
  const sAvatar   = avatar            ? sanitizeImagePrompt(avatar)            : '';
  const sSolution = solution          ? sanitizeImagePrompt(solution)          : '';
  const sDetails  = product_details   ? sanitizeImagePrompt(product_details)   : '';
  const sExtra    = additional_instructions ? sanitizeImagePrompt(additional_instructions) : '';
  const sProduct  = sanitizeImagePrompt(productName || '');

  // ───────────── MODE 1: BANNER REPLICATION ─────────────
  if (hasTemplateRef) {
    const dissection = templateDesc
      ? `\n═══ MODEL BANNER FORENSIC ANALYSIS ═══\n${sanitizeImagePrompt(templateDesc)}\n`
      : '';

    const productBlock = hasProductPhotos
      ? `═══ NEW PRODUCT (provided in references after the model banner) ═══
- Reference image(s) of the new product are attached AFTER the model banner.
- You MUST faithfully reproduce this NEW product, keeping its exact bottle/box shape, color, label graphics, ALL printed text on the label (brand name, dosage, weight, etc. — preserve every word legibly and identically), cap, and proportions.
- Do NOT invent or alter the new product.
${sDetails ? `- Product context: ${sDetails.slice(0, 250)}` : ''}`
      : `═══ NEW PRODUCT ═══
- Product name: ${sProduct}
${photoDesc ? `- Product appearance: ${sanitizeImagePrompt(photoDesc)}` : ''}
${sDetails  ? `- Product context: ${sDetails.slice(0, 250)}` : ''}`;

    // Character block — replaces whoever appears in the model banner with the user's specified persona
    const nat    = NATIONALITY_ADJ[nationality] || nationality || '';

    // Translate the age bucket into concrete visible physical traits.
    // The image model otherwise drifts toward whatever age the model banner shows.
    const AGE_TRAITS = {
      '18-25': 'youthful — early-twenties appearance, smooth fresh skin, no wrinkles, full firm features, vibrant energy',
      '25-35': 'young adult — late twenties to early thirties, mature but smooth skin, fully developed features, sharp confident look',
      '35-45': 'mature adult — mid-thirties to mid-forties, slight expression lines around eyes, defined facial features, established adult look',
      '45-55': 'middle-aged — mid-forties to mid-fifties, visible expression lines, possible early greys at temples, distinguished mature look',
      '55-65': 'older adult — mid-fifties to mid-sixties, clearly visible facial lines and forehead wrinkles, salt-and-pepper or grey hair, mature dignified look',
      '65+'  : 'senior / elderly — clearly 65 years or older, visibly aged face with deep wrinkles around eyes and mouth, grey or silver-white hair (or balding), mature skin texture, dignified elderly appearance — the person MUST look unmistakably elderly, NOT young or middle-aged',
    };
    const ageTraits = age_range ? (AGE_TRAITS[age_range] || `approximately ${age_range} years old`) : '';

    const hasCharacterSpec = gender || nationality || age_range || sAvatar;
    let demographic = '';
    if (gender === 'male')        demographic = `${nat} man`.trim();
    else if (gender === 'female') demographic = `${nat} woman`.trim();
    else if (gender === 'both')   demographic = `${nat} couple — a man and a woman`.trim();
    else if (hasCharacterSpec)    demographic = `${nat} person`.trim();
    demographic = demographic.replace(/\s{2,}/g, ' ').trim();

    // Demographics-only block. The contextual situation/wardrobe rules live in Section B
    // of the main prompt to avoid duplication.
    const characterBlock = hasCharacterSpec
      ? `${demographic ? `WHO: ${demographic}` : ''}
${ageTraits  ? `AGE & PHYSICAL TRAITS: ${ageTraits}` : ''}
${sAvatar    ? `PERSONA / CUSTOMER DESCRIPTION: ${sAvatar.slice(0, 280)}` : ''}`.trim()
      : '';

    const copyBlock = [
      sAngle    && `- Sales angle to communicate: ${sAngle.slice(0, 280)}`,
      sProblem  && `- Pain point being solved: ${sProblem.slice(0, 200)}`,
      sSolution && `- Solution / transformation: ${sSolution.slice(0, 200)}`,
    ].filter(Boolean).join('\n');

    // ───────── Build allowlist of allowed text strings ─────────
    const allowedHead = bannerAssets?.copy?.headline || '';
    const allowedSub  = bannerAssets?.copy?.subhead  || '';
    const allowedBenefits = Array.isArray(bannerAssets?.copy?.benefits)
      ? bannerAssets.copy.benefits.filter(b => typeof b === 'string' && b.trim()).slice(0, 3)
      : [];

    // ───────── Color palette block ─────────
    const paletteBlock = bannerAssets?.palette
      ? `Use ONLY these 4 colors (extracted from the new product):
   • Background dominant: ${bannerAssets.palette.primary}
   • Secondary zones:     ${bannerAssets.palette.secondary}
   • Accent / highlights: ${bannerAssets.palette.accent}
   • Text on primary:     ${bannerAssets.palette.text_on_primary}
   Mood: ${bannerAssets.palette.description || 'product-aligned'}`
      : `Derive the palette FROM THE NEW PRODUCT's reference image. Use only the product's own brand colors. Maximum 3 dominant colors.`;

    // ───────── Text allowlist block (varies by user-selected headline style) ─────────
    const fallbackHeadlineRules = style === 'question'
      ? `STRING 1 (headline): A DIRECT QUESTION (3-8 words, starts with "¿" and ends with "?" in Spanish). Aimed at the viewer to identify with the problem. Examples: "¿SUFRES DE HINCHAZÓN?", "¿Te duelen las rodillas?", "¿Cansada de las arrugas?", "¿QUIERES DORMIR MEJOR?". May use personal pronouns ("tú", "te", "tu").`
      : `STRING 1 (headline): 1-3 WORD label of the problem/topic/benefit. Uppercase. NO question mark. NO "¿Sufres...?", NO "¿Tienes...?". Examples: "HINCHAZÓN", "INFLAMACIÓN ABDOMINAL", "DOLOR DE RODILLAS", "ARRUGAS", "CAÍDA DEL CABELLO", "PIEL JOVEN", "DIGESTIÓN SANA", "ADIÓS HINCHAZÓN". Like a magazine cover topic.`;
    const benefitsLines = allowedBenefits.length === 3
      ? `   STRING 3 (benefit 1, bullet): "${allowedBenefits[0]}"
   STRING 4 (benefit 2, bullet): "${allowedBenefits[1]}"
   STRING 5 (benefit 3, bullet): "${allowedBenefits[2]}"`
      : `   STRINGS 3-5 (benefits, bullets): 3 short product benefits (2-5 words each, sentence case) derived from the SALES ANGLE. Each on its own line as a bullet item. Examples: "Fórmula 100% natural", "Acción rápida", "Sin efectos secundarios". NEVER "cura", "elimina", "garantiza", no timeframes.`;
    const textBlock = (allowedHead && allowedSub)
      ? `The banner contains EXACTLY 5 text strings — nothing more, nothing less. Render each ONCE, character-by-character identical (every letter, every accent):

   STRING 1 (the headline — biggest, most prominent text zone): "${allowedHead}"
   STRING 2 (the subhead  — second text zone, smaller font):    "${allowedSub}"
${benefitsLines}`
      : `The banner contains EXACTLY 5 text strings. Headline style chosen by user: ${style.toUpperCase()}.
   ${fallbackHeadlineRules}
   STRING 2 (subhead):  8-12 word soft affirmation naming the product. Use verbs like "apoya", "ayuda a", "contribuye a" — NEVER "cura", "elimina", "garantiza", and NO timeframes like "en 7 días". Example: "${sProduct} apoya tu sistema digestivo de forma natural."
${benefitsLines}`;

    return sanitizeImagePrompt(
`ROLE
You are a senior art director designing a CTR-optimized advertising banner. The goal is for a viewer who HAS the problem to STOP and CLICK — not to buy from this banner. The banner is a hook; the landing page sells.

PRIORITIES (apply in this order, each rule overrides the rules below it)
 1. ${includePerson ? 'Apply the CHARACTER + SITUATION specification — overrides whatever the model banner shows.' : 'NO PERSON / NO HUMAN FIGURE in the output — overrides whatever the model banner shows. Even if the model banner displays a person, the output MUST have zero human elements.'}
 2. Render the 5 allowed text strings — each EXACTLY ONCE, no duplicates, no mirroring across left/right or top/bottom. The 3 benefit bullets form ONE single list in ONE zone. Overrides any text or duplicate layout in the model banner.
 3. Use ONLY the product palette — overrides the model banner's colors.
 4. Replicate the model banner's structural layout (zone positions and proportions) — only when not in conflict with rules 1-3. If the model banner has the same text twice (e.g. left+right columns), COLLAPSE it to a single occurrence in the output.

${copyBlock ? `═══ STRATEGIC CONTEXT (informs every visual + copy decision; do NOT render as text on the banner) ═══
${copyBlock}
` : ''}
═══ A. STRUCTURAL BLUEPRINT (from the model banner) ═══
Clone from the FIRST attached image:
 • Aspect ratio, canvas dimensions, framing.
 • Position of the product zone, person zone, headline zone, subhead zone.
 • Proportions between visual area and text area.
 • Typography style (bold sans-serif by default), weight, hierarchy.
DO NOT clone from the model banner: its colors, its specific text content, its person's mood/wardrobe, or any CTA button.

${includePerson
  ? `═══ B. PERSON (META-COMPLIANT — must NOT body-shame or imply personal flaws) ═══
${characterBlock || `WHO: ${NATIONALITY_ADJ[nationality] || nationality || 'Latin American'} ${gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person'}, age ${age_range || '30-45'}.`}

ATTITUDE — CRITICAL (Meta-compliant):
 • Expression: NEUTRAL, calm, content, or subtly confident. Soft natural smile is OK. NEVER triumphant/celebratory (no fitness-victory pose, no arms raised), NEVER showing distress or pain (no clutching body parts, no grimacing).
 • Pose: relaxed and natural, doing something everyday (sitting, standing, holding the product). They MAY hold the product naturally in one hand. Do NOT have them point at body parts in a "before-state" way.
 • Setting: an aspirational but everyday environment (sunlit living room, modern kitchen, terrace, park bench, well-lit office). The setting should feel like a moment in a normal life, not staged.
 • Wardrobe: tasteful casual or smart-casual everyday clothing appropriate to the persona's age and setting. NOT clinical (no doctor coats), NOT activewear/sportswear/gym clothing (unless the product is genuinely fitness-related), NOT pajamas (avoids "before-state" framing).
${sProblem ? ` • Context (do NOT depict this visibly): the product addresses "${sProblem.slice(0, 200)}". Show the person in a calm, post-solved or solution-oriented state — never in distress.` : ''}

DO NOT do (Meta would reject the ad):
 ✗ Person clutching their belly / head / back / hair in distress
 ✗ Close-up on body parts (skin flaws, fat rolls, hair loss, wrinkles)
 ✗ Before/after side-by-side or implied transformation
 ✗ Sad/depressed/pained expression
 ✗ Pointing at a body "problem area"`
  : `═══ B. NO PERSON — PRODUCT-ONLY COMPOSITION (CRITICAL — overrides the model banner) ═══
The output banner MUST NOT contain ANY person, human figure, character, face, body part, hand, finger, arm, shoulder, hair, silhouette, or human-shaped element — EVEN IF THE MODEL BANNER REFERENCE SHOWS ONE. The reference's person zone is IGNORED.

Replace the person zone with one of these (pick the one that fits the layout best):
 • PRODUCT HERO: enlarge the product to dominate that area, optionally show it from a second angle, or add subtle product variants/ingredient close-ups around it.
 • LIFESTYLE OBJECT: a still-life element related to the product's use (e.g. a cup of tea, an open book, a plant, a glass of water, kitchen items) — NEVER showing hands or a person interacting with it.
 • CLEAN NEGATIVE SPACE: a soft gradient or solid color matching the palette, with subtle abstract shapes — leaves an airy, premium feel.

Strict rules:
 ✗ NO people, NO faces, NO hands, NO hair, NO body parts of any kind, NO silhouettes.
 ✗ NO suggestion of a person via partial framing (no arm reaching in from off-canvas, no shoulder visible, no "POV" of a hand holding the product).
 ✓ The product becomes the unmistakable visual hero of the entire composition.
 ✓ Studio-quality photo realism with proper lighting and natural shadows.`}

═══ C. PRODUCT ═══
${productBlock}
Place the new product in the same screen position, scale and orientation as the original product in the model banner. Reproduce its real label faithfully — every word on the label must be legible and identical to the reference. Integrate with proper studio lighting and natural shadows. Never paste it on flat.

═══ D. COLOR PALETTE ═══
DISCARD the model banner's color palette completely. Do NOT keep its background hue.
${paletteBlock}

═══ E. TEXT — STRICT ALLOWLIST ═══
${textBlock}

Placement:
 • STRING 1 (headline) → the most prominent text zone of the model banner (largest font, top or hero position). Appears EXACTLY ONCE.
 • STRING 2 (subhead)  → the second-most-prominent text zone (medium font, just below the headline). Appears EXACTLY ONCE.
 • STRINGS 3-5 (the 3 benefits) → render as ONE SINGLE bullet list with EXACTLY 3 items, in ONE position on the canvas (either below the subhead, beside the product, or in one lateral column — pick the one zone that fits the model banner's layout). The list appears ONCE only — NEVER duplicated across quadrants, NEVER repeated on left and right sides.
 • EVERY OTHER text zone in the model banner → leave EMPTY (background color, gradient, or abstract shapes). Do NOT fill with invented words.

Visual style for the benefit bullets:
 • Bullet marker: use a clean attractive check mark (✓) or a small filled circular icon — NOT plain "·" dots. Each bullet line starts with the same marker, consistent color (use the accent or text-on-primary color).
 • Font size: notably larger than typical body text — roughly 60-70% of the subhead size, big enough to read at thumb-scroll speed.
 • Weight: medium to semi-bold. The bullets must feel scannable and bold, not whispery.
 • Alignment: left-aligned, equal indentation, equal vertical spacing between lines.
 • The 3 bullets form a single visual block — one column, one location.

PRODUCT NAME HIGHLIGHTING (CRITICAL):
 • Whenever the product name "${sProduct}" appears in any rendered string (typically in the subhead), render JUST those words in a DIFFERENT, MORE EYE-CATCHING COLOR than the surrounding text — to make the brand name pop.
 • Use the ACCENT color from the palette (${bannerAssets?.palette?.accent || 'the brightest contrasting color in the palette'}) for the product name. The rest of the subhead/text uses the normal text color.
 • Optionally make the product name slightly bolder (e.g. extra-bold while the rest is medium). Same font family, same size — only color and weight change.
 • The product name MUST be perfectly spelled — character-by-character identical to "${sProduct}".
 • This highlighting applies to the SUBHEAD and any other string that contains the product name. It does NOT apply to the bottle's own label (that stays as-is on the product).

═══ F. ABSOLUTE PROHIBITIONS (banner must NOT contain) ═══
Layout & text:
 • Any text beyond the 5 allowed strings above (no extra slogans, no taglines, no "with [product]" overlay).
 • More or fewer than 3 benefit bullets (must be exactly 3, no more, no less).
 • THE BULLET LIST DUPLICATED. The 3 bullets MUST appear exactly ONCE total — never twice (left and right), never four times (one per quadrant), never repeated symmetrically. ONE bullet column. ONE list. THREE items total on the entire canvas.
 • A repetition of any of the 5 strings anywhere on the canvas — each string appears exactly ONCE.
 • A CTA button or any imperative purchase language: "Comprar", "Compra ya", "Lo quiero", "Quiero", "Buy", "Shop", "Order", "Click", "Pide ya", "Adquirir", "Probar gratis".
 • Phone numbers, "Contáctanos", WhatsApp icon + number, email, web URL, social handles — NONE of these.
 • Standalone product-name text overlay (the bottle's own label already has the brand).
 • Made-up or mangled words like "RECUPFORMA", "DESINFLAMACOR", fake Latin filler, lorem ipsum.
 • Letters partially formed, duplicated within a word, fused together, or otherwise illegible.
 • Colors not in the palette above (no purple/pink/blue if the product is green/orange — DISCARD the model's hue).

Meta Ads policy compliance:
${style === 'question'
  ? ` • The headline IS a direct question to the viewer (chosen explicitly by the user). Keep the rest of the banner Meta-compliant.
 • NO body-shaming, no negative self-perception triggers, no insecurity creation in the IMAGE.
 • NO before/after visual framing, no transformation imagery, no "antes y después".
 • NO close-ups of body parts that could be interpreted as flaw-focus (skin pores, fat rolls, hair loss patches, wrinkles, cellulite).
 • NO health/medical claims with specific timeframes ("in 7 days", "en 7 días", "in 24 hours") rendered as visible text.
 • NO "guaranteed" / "100% effective" / "works or money back" badges or text.
 • NO drug-style imagery suggesting the product replaces medical treatment.
 • NO showing the person in obvious distress or pain related to the product's target problem.`
  : ` • NO assertions or implied assumptions about the viewer's personal attributes (medical condition, body shape, weight, age, mental state, financial status). Reject any "¿Sufres de X?", "¿Tienes X?", "¿Eres X?", "¿Te duele X?" framing.
 • NO body-shaming, no negative self-perception triggers, no insecurity creation.
 • NO before/after visual framing, no transformation imagery, no "antes y después".
 • NO close-ups of body parts that could be interpreted as flaw-focus (skin pores, fat rolls, hair loss patches, wrinkles, cellulite).
 • NO health/medical claims with specific timeframes ("in 7 days", "en 7 días", "in 24 hours") rendered as visible text.
 • NO "guaranteed" / "100% effective" / "works or money back" badges or text.
 • NO drug-style imagery suggesting the product replaces medical treatment.
 • NO showing the person in obvious distress or pain related to the product's target problem.`}

═══ G. QUALITY ═══
 • Photorealistic, magazine-grade. Major-brand campaign quality (Nike, L'Oréal, Apple).
 • Single coherent light source — all shadows and highlights consistent.
 • Crisp typography, every letter perfectly formed in ${lang}.
 • Premium, trustworthy, scroll-stopping feel.

═══ H. OUTPUT ═══
A premium META-COMPLIANT banner: same structural skeleton as the model, NEW product front-and-centered, NEW persona in calm/aspirational lifestyle moment (NOT distressed), NEW palette (from product), EXACTLY 5 strings of text (headline + subhead + 3 benefit bullets — no more, no fewer), NO CTA, NO contact info, NO body-shaming, NO health claims with timeframes. The viewer reads the headline (hooks), scans the 3 bullets (validates value), and clicks to learn more.

${dissection}
${sExtra ? `EXTRA NOTES: ${sExtra}` : ''}`
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

module.exports = router;
