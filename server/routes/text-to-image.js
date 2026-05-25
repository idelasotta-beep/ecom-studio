const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { text_to_image_outputs, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const OUTPUT_DIR = mediaDir('text-to-image');

// Nano Banana family
const NANO_BANANA_MODELS = {
  nano_banana_2:   'gemini-3.1-flash-image-preview',
  nano_banana_pro: 'gemini-3-pro-image-preview',
};
const isNanoBanana = (m) => m === 'nano_banana_2' || m === 'nano_banana_pro';

const longRunningAgent = new UndiciAgent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout:    15 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

// ── GET /api/text-to-image — list user's outputs ─────────────────
router.get('/', (req, res) => {
  res.json({ outputs: text_to_image_outputs.forUser(req.user.id) });
});

// ── POST /api/text-to-image/generate ─────────────────────────────
router.post('/generate', async (req, res) => {
  const { prompt, photos, image_model = 'gpt_image_2', size } = req.body;

  const trimmedPrompt = (prompt || '').trim();
  if (!trimmedPrompt) return res.status(400).json({ error: 'Falta la instrucción / prompt' });

  const settings  = user_settings.get(req.user.id);
  const openaiKey = settings?.openai_key;
  const geminiKey = settings?.gemini_key;

  if (isNanoBanana(image_model)) {
    if (!geminiKey) return res.status(402).json({ error: 'Se requiere API key de Google (Gemini) para Nano Banana. Configúrala en Ajustes → APIs' });
  } else {
    if (!openaiKey) return res.status(402).json({ error: 'Se requiere API key de OpenAI para GPT Image 2. Configúrala en Ajustes → APIs' });
  }

  // Filter and limit reference images (max 3)
  const refImages = Array.isArray(photos)
    ? photos.filter(p => typeof p === 'string' && p.startsWith('data:')).slice(0, 3)
    : [];

  // Determine output size — defaults to square if not specified
  const SIZE_MAP = {
    square:     { gpt: '1024x1024', gemini: '1:1'  },
    horizontal: { gpt: '1536x1024', gemini: '16:9' },
    vertical:   { gpt: '1024x1536', gemini: '9:16' },
  };
  const sizeKey = SIZE_MAP[size] ? size : 'square';
  const imgSizeGpt = SIZE_MAP[sizeKey].gpt;
  const imgAspect  = SIZE_MAP[sizeKey].gemini;

  console.log(`[text-to-image] generate | model=${image_model} size=${sizeKey} refs=${refImages.length} prompt="${trimmedPrompt.slice(0, 120)}..."`);

  let imgBuffer, filename;
  try {
    if (isNanoBanana(image_model)) {
      imgBuffer = await generateWithNanoBanana(trimmedPrompt, imgAspect, geminiKey, refImages, image_model);
    } else {
      imgBuffer = await generateWithGptImage2(trimmedPrompt, imgSizeGpt, openaiKey, refImages);
    }
    filename = `t2i_${req.user.id}_${Date.now()}.png`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), imgBuffer);
  } catch (err) {
    console.error('[text-to-image] generation failed:', err.message);
    if (err.cause) console.error('  cause:', err.cause.code || err.cause.message);
    return res.status(502).json({ error: `Error al generar imagen: ${err.message}` });
  }

  const saved = text_to_image_outputs.insert({
    user_id:      req.user.id,
    image_path:   filename,
    prompt:       trimmedPrompt,
    model:        image_model,
    photos_count: refImages.length,
  });

  res.json({
    id:        saved.id,
    image_url: `/text-to-image/${filename}`,
    prompt:    trimmedPrompt,
    model:     image_model,
  });
});

// ── DELETE /api/text-to-image/:id ────────────────────────────────
router.delete('/:id', (req, res) => {
  const ok = text_to_image_outputs.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Imagen no encontrada' });
  res.json({ message: 'Imagen eliminada' });
});

// ─────────────────────────────────────────────────────────────────
// Image generation engines (mirror of mockups/logos)
// ─────────────────────────────────────────────────────────────────

async function generateWithGptImage2(prompt, size, apiKey, referenceImages = []) {
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

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', 'high');
  referenceImages.forEach((dataUrl, idx) => {
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
  const refs = (referenceImages || []).map(parseDataUrl).filter(Boolean).slice(0, 3);
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

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  const subtype = m[1].toLowerCase();
  const mime    = `image/${subtype === 'jpg' ? 'jpeg' : subtype}`;
  const ext     = subtype === 'jpeg' ? 'jpg' : subtype;
  return { mime, ext, b64: m[2], buffer: Buffer.from(m[2], 'base64') };
}

module.exports = router;
