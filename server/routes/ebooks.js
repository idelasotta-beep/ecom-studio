/**
 * Ebook generation — Phase 1 (MVP).
 *
 * Endpoints:
 *   POST   /api/ebooks/products/:pid/ideas        → generate 5 ebook idea candidates
 *   POST   /api/ebooks/products/:pid/generate     → kick off async full generation
 *   GET    /api/ebooks/:id                        → poll status + content
 *   POST   /api/ebooks/:id/export-pdf             → render the final PDF (idempotent)
 *   GET    /api/ebooks/by-product/:pid            → list ebooks for a product
 *   DELETE /api/ebooks/:id                        → remove ebook + media files
 *
 * The /generate endpoint returns immediately with the new ebook_id and runs
 * the heavy lifting in the background (fire-and-forget). The frontend polls
 * /api/ebooks/:id every few seconds to render progress.
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { products, product_angles, product_ebooks, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');
const { buildEbookHTML } = require('../lib/ebook-template');
const { renderEbookPDF } = require('../lib/ebook-pdf');
const { callKie } = require('../lib/kie');

const router = express.Router();
router.use(requireAuth);

const EBOOK_PDF_DIR = mediaDir('ebooks');
const EBOOK_IMG_DIR = mediaDir('ebook-images');

// ── Text model registry (mirror of copys.js) ─────────────────────
const TEXT_MODELS = {
  'gpt-4.1':                   { provider: 'openai',    label: 'GPT-4.1',                  key_field: 'openai_key' },
  'gpt-4.1-mini':              { provider: 'openai',    label: 'GPT-4.1 mini',             key_field: 'openai_key' },
  'gpt-4o':                    { provider: 'openai',    label: 'GPT-4o',                   key_field: 'openai_key' },
  'gpt-4o-mini':               { provider: 'openai',    label: 'GPT-4o mini',              key_field: 'openai_key' },
  'claude-opus-4-7':           { provider: 'anthropic', label: 'Claude Opus 4.7',          key_field: 'claude_key' },
  'claude-sonnet-4-6':         { provider: 'anthropic', label: 'Claude Sonnet 4.6',        key_field: 'claude_key' },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5',         key_field: 'claude_key' },
  'gemini-2.5-pro':            { provider: 'google',    label: 'Gemini 2.5 Pro',           key_field: 'gemini_key' },
  'gemini-2.5-flash':          { provider: 'google',    label: 'Gemini 2.5 Flash',         key_field: 'gemini_key' },
  // Kie.ai 2026 frontier
  'kie:claude-opus-4-7':        { provider: 'kie',      label: 'Claude Opus 4.7 (Kie.ai)',    key_field: 'kieai_key' },
  'kie:claude-sonnet-4-6':      { provider: 'kie',      label: 'Claude Sonnet 4.6 (Kie.ai)',  key_field: 'kieai_key' },
  'kie:gemini-3.1-pro':         { provider: 'kie',      label: 'Gemini 3.1 Pro (Kie.ai)',     key_field: 'kieai_key' },
  'kie:gemini-3-pro':           { provider: 'kie',      label: 'Gemini 3 Pro (Kie.ai)',       key_field: 'kieai_key' },
  // Kie.ai legacy
  'kie:claude-sonnet-4-5':     { provider: 'kie',       label: 'Claude Sonnet 4.5 (Kie.ai)', key_field: 'kieai_key' },
  'kie:gpt-5-2':               { provider: 'kie',       label: 'GPT-5.2 (Kie.ai)',           key_field: 'kieai_key' },
};

const IMAGE_MODELS = {
  gpt_image_2:     { engine: 'openai',  label: 'GPT Image 2',          key_field: 'openai_key' },
  nano_banana_2:   { engine: 'gemini',  label: 'Nano Banana 2',        key_field: 'gemini_key', model: 'gemini-3.1-flash-image-preview' },
  nano_banana_pro: { engine: 'gemini',  label: 'Nano Banana Pro',      key_field: 'gemini_key', model: 'gemini-3-pro-image-preview' },
};

// 20→5, 40→10, 60→15, 80→20, 100→25 (≈ 4 pages per chapter incl. image).
function chaptersFromPages(pages) {
  return Math.max(3, Math.round(Number(pages) / 4));
}

// Helper to fetch the user's API key for a given model/image engine
function keyFor(userId, model, isImage = false) {
  const settings = user_settings.get(userId) || {};
  const def = isImage ? IMAGE_MODELS[model] : TEXT_MODELS[model];
  if (!def) return null;
  return settings[def.key_field] || null;
}

// ─────────────────────────────────────────────────────────────────
// Angle parser — same shape used by copys.js
// ─────────────────────────────────────────────────────────────────
function parseAngles(content) {
  if (!content) return [];
  const blocks = content.split(/^## ÁNGULO \d+:/m);
  return blocks.slice(1).map((block, i) => {
    const lines = block.trim().split('\n');
    const title = (lines[0] || '').trim();
    const body  = lines.slice(1).join('\n').trim();
    const subs  = {};
    body.split(/^### /m).slice(1).forEach(s => {
      const nl = s.indexOf('\n');
      if (nl === -1) return;
      subs[s.slice(0, nl).trim()] = s.slice(nl + 1).trim();
    });
    return {
      num:         String(i + 1).padStart(2, '0'),
      title,
      description: subs['Descripción del Ángulo'] || '',
      avatar:      subs['Avatar o Público Objetivo'] || '',
      problem:     subs['Problema Específico que Aborda el Ángulo de Venta'] || '',
      solution:    subs['Cómo el Producto se Vuelve la Solución Ideal'] || '',
    };
  });
}

function flatAngles(productId) {
  const recs = product_angles.forProduct(productId);
  const out = [];
  recs.forEach(rec => {
    parseAngles(rec.content).forEach((angle, idx) => {
      out.push({
        uid:         `${rec.id}-${idx}`,
        record_id:   rec.id,
        index:       idx,
        num:         angle.num,
        title:       angle.title,
        description: angle.description,
        avatar:      angle.avatar,
        problem:     angle.problem,
        solution:    angle.solution,
        record_date: rec.created_at,
      });
    });
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Text generation — unified across providers
// ─────────────────────────────────────────────────────────────────
async function generateText({ modelId, apiKey, system, user, maxTokens = 4000, temperature = 0.75 }) {
  const def = TEXT_MODELS[modelId];
  if (!def) throw new Error('Modelo de texto desconocido');

  if (def.provider === 'kie') {
    return callKie({ apiKey, modelId, sysMsg: system, userPrompt: user, maxTokens, temperature });
  }

  if (def.provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
    return d.choices[0].message.content;
  }

  if (def.provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic error ${r.status}`);
    return d.content[0].text;
  }

  if (def.provider === 'google') {
    const isThinking25 = /^gemini-(2\.5|3)/.test(modelId);
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
          generationConfig: { maxOutputTokens: isThinking25 ? Math.max(maxTokens, 8192) : maxTokens, temperature },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Google error ${r.status}`);
    const cand = d.candidates && d.candidates[0];
    const text = cand?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`Google devolvió respuesta vacía (finishReason: ${cand?.finishReason || 'desconocido'})`);
    return text;
  }

  throw new Error(`Proveedor ${def.provider} no soportado`);
}

// ─────────────────────────────────────────────────────────────────
// Image generation — minimal client for GPT-Image-1 and Nano Banana
// ─────────────────────────────────────────────────────────────────
const longRunningAgent = new UndiciAgent({
  headersTimeout: 5 * 60 * 1000,
  bodyTimeout:    5 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

async function generateImage({ engine, prompt, apiKey, aspect = '4:3', modelId }) {
  if (engine === 'openai') {
    const sizeMap = { '4:3': '1536x1024', '16:9': '1536x1024', '1:1': '1024x1024', '9:16': '1024x1536' };
    const size = sizeMap[aspect] || '1536x1024';
    const r = await undiciFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'medium' }),
      dispatcher: longRunningAgent,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI image error ${r.status}`);
    return Buffer.from(d.data[0].b64_json, 'base64');
  }

  if (engine === 'gemini') {
    const r = await undiciFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } },
        }),
        dispatcher: longRunningAgent,
      }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Gemini image error ${r.status}`);
    const parts = d.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error('Gemini no devolvió imagen');
    return Buffer.from(imgPart.inlineData.data, 'base64');
  }

  throw new Error(`Engine ${engine} no soportado`);
}

// ─────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────
const SYS_IDEAS = `Eres un copywriter senior experto en lead magnets y embudos de venta para e-commerce y dropshipping. Generas IDEAS de ebooks que: (1) están temáticamente conectadas al producto, (2) abordan el dolor del avatar SIN nombrar el producto explícitamente, (3) ofrecen valor educativo real, y (4) preparan al lector para querer comprar. Respondes SIEMPRE en formato JSON válido sin texto adicional ni markdown alrededor. Escribes en español neutro de Latinoamérica usando conjugaciones estándar (tú/tu). PROHIBIDO usar voseo rioplatense (vos/configurá/elegí/tenés/etc.).`;

function buildIdeasPrompt({ productName, angle, chapters }) {
  return `Genera 5 IDEAS distintas de ebooks para usar como lead magnet asociado al siguiente producto.

PRODUCTO: ${productName}

ÁNGULO DE VENTA (esto guía el enfoque del ebook):
- Título del ángulo: ${angle.title}
- Descripción: ${angle.description || '(no especificada)'}
- Avatar / cliente ideal: ${angle.avatar || '(no especificado)'}
- Problema que aborda: ${angle.problem || '(no especificado)'}
- Cómo el producto soluciona: ${angle.solution || '(no especificado)'}

CADA IDEA debe tener exactamente ${chapters} capítulos (capítulos cortos y digeribles).

DEVUELVE JSON con esta forma exacta (sin markdown, sin comillas de bloque, solo el objeto):
{
  "ideas": [
    {
      "title": "Título del ebook en mayúsculas (8-12 palabras impactantes)",
      "subtitle": "Subtítulo de 1 línea que clarifica la promesa (~12-18 palabras)",
      "synopsis": "Párrafo de 2-3 oraciones que describe qué aprenderá el lector y por qué le importa",
      "chapter_titles": ["Título cap 1 (frase atractiva con dos puntos)", "Título cap 2", ...]
    },
    ... (5 ideas totales)
  ]
}

REGLAS:
- Las 5 ideas deben ser CLARAMENTE distintas en enfoque (no variaciones del mismo título).
- El estilo de los títulos debe ser tipo "El Laberinto del Hambre: Por Qué Tu Cuerpo Pide Dulce" — con dos puntos, descriptivo + provocativo.
- Cada idea debe SERVIR al producto sin nombrarlo: educa al lector en el problema y lo prepara para ver el producto como solución natural.
- En español neutro de Latinoamérica.
- NO uses markdown, NO uses bloques de código alrededor del JSON, NO agregues texto antes o después. Solo el objeto JSON.`;
}

const SYS_CHAPTER = `Eres un escritor profesional de ebooks de marketing y bienestar. Escribes capítulos de lead-magnet PDF: ~600-800 palabras, tono cercano y profesional, prosa fluida en párrafos largos (sin viñetas, sin listas numeradas, sin markdown). Tu objetivo es educar al lector sobre el problema y posicionar SUTILMENTE el producto como aliado natural en la solución. NUNCA recomiendas médicamente, NUNCA prometes resultados absolutos, USAS verbos suaves como "apoya", "favorece", "contribuye a". Mencionas el producto integrado en el flujo natural del texto, 1-2 veces por capítulo. Cierras SIEMPRE el capítulo con un "consejo profesional" práctico, accionable y breve (3-5 líneas). Devuelves SOLO el texto del capítulo, sin título encabezado, sin markdown. IDIOMA: español neutro de Latinoamérica con conjugaciones estándar (tú/tu/tienes/configura/elige). PROHIBIDO el voseo rioplatense (vos/configurá/tenés/elegí/etc.).`;

function buildChapterPrompt({ productName, ebookTitle, chapterNum, totalChapters, chapterTitle, chapterTitlesAll, angle, previousSummary }) {
  return `Escribe el contenido completo del capítulo ${chapterNum} de ${totalChapters} de un ebook tipo lead magnet.

EBOOK: "${ebookTitle}"
PRODUCTO ASOCIADO (mencionar 1-2 veces integrado al texto, como aliado natural): ${productName}

CAPÍTULO ACTUAL: "${chapterTitle}"

TODOS LOS CAPÍTULOS DEL EBOOK (para que mantengas coherencia y no repitas):
${chapterTitlesAll.map((t, i) => `${i + 1}. ${t}`).join('\n')}

ÁNGULO DE VENTA SUBYACENTE:
- Avatar: ${angle.avatar || '(generalista)'}
- Problema: ${angle.problem || '(no especificado)'}
- Cómo el producto ayuda: ${angle.solution || '(no especificado)'}

${previousSummary ? `RESUMEN BREVE DE CAPÍTULOS ANTERIORES (no repitas ideas ya cubiertas):\n${previousSummary}\n` : ''}

REGLAS DE ESCRITURA:
- Extensión: 600-800 palabras de prosa fluida.
- Estructura: 3-4 párrafos densos + cierre con "consejo profesional" en su propio párrafo.
- Estilo: español neutro LATAM, profesional pero cercano. Cero modismos regionales.
- Mención del producto: 1-2 veces, integrado naturalmente en el texto (ej: "productos como ${productName} actúan como aliados estratégicos al ayudar a...").
- NO uses títulos ni encabezados (el título lo agrega el sistema arriba).
- NO uses markdown (sin **, sin #, sin viñetas, sin numeración).
- NO prometas curas, resultados garantizados, ni "X kilos en N días".
- USA verbos suaves: "apoya", "favorece", "contribuye a", "promueve".
- El "consejo profesional" del cierre debe ser concreto, accionable, ejecutable hoy mismo por el lector.

IDIOMA: español neutro estándar (tú/tu/tienes/configura/elige). PROHIBIDO el voseo argentino (vos/tenés/configurá).

Devuelve únicamente el texto del capítulo, sin nada más alrededor.`;
}

function buildImagePrompt({ chapterTitle, chapterExcerpt, productCategory }) {
  return `Editorial photography for an ebook chapter illustration. Subject: "${chapterTitle}". Context from the chapter: ${String(chapterExcerpt).slice(0, 400)}.
Style: clean, modern editorial photography, natural lighting, soft shadows, professional color grading, calm and aspirational mood. Shallow depth of field. Composition with breathing room — works as a horizontal banner. ${productCategory ? `Related to: ${productCategory}.` : ''}
ABSOLUTE PROHIBITIONS: no text overlay, no logos, no watermarks, no UI elements, no captions, no labels, no charts or infographics. Just a clean photographic scene.`;
}

function buildCoverImagePrompt({ ebookTitle, productCategory }) {
  return `Background image for the cover of a professional ebook titled "${ebookTitle}". Style: clean editorial photography, soft natural light, calm aspirational mood, professional color palette. Composition: empty negative space at the top half where the title will overlay; main subject in the lower portion. ${productCategory ? `Theme: ${productCategory}.` : ''}
NO TEXT, NO LOGOS, NO WATERMARKS, NO UI. Just a calm photographic background.`;
}

// ─────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────

// GET /api/ebooks — products with ebook counts (grid landing view)
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => {
    const ebooksForProduct = product_ebooks.forProduct(p.id) || [];
    const ready = ebooksForProduct.filter(e => e.status === 'ready').length;
    const angleCount = (product_angles.forProduct(p.id) || []).reduce((sum, rec) => sum + parseAngles(rec.content).length, 0);
    return {
      ...p,
      ebook_count: ebooksForProduct.length,
      ebook_ready_count: ready,
      angle_count: angleCount,
    };
  });
  res.json({ products: list });
});

// POST /api/ebooks/products/:pid/ideas → 5 idea candidates
router.post('/products/:pid/ideas', async (req, res) => {
  const p = products.one({ id: Number(req.params.pid), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { angle_uid, text_model_id, pages } = req.body;
  if (!angle_uid || !text_model_id || !pages) return res.status(400).json({ error: 'Faltan angle_uid, text_model_id o pages' });

  const def = TEXT_MODELS[text_model_id];
  if (!def) return res.status(400).json({ error: 'Modelo de texto no válido' });
  const apiKey = keyFor(req.user.id, text_model_id);
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${def.provider} en Ajustes → APIs` });

  // Locate the angle
  const angle = flatAngles(p.id).find(a => a.uid === angle_uid);
  if (!angle) return res.status(404).json({ error: 'El ángulo seleccionado ya no existe' });

  const totalChapters = chaptersFromPages(pages);
  const prompt = buildIdeasPrompt({ productName: p.name, angle, chapters: totalChapters });

  let raw;
  try {
    raw = await generateText({ modelId: text_model_id, apiKey, system: SYS_IDEAS, user: prompt, maxTokens: 3000, temperature: 0.85 });
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  // Strip code fences if the model added them despite instructions
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (err) {
    return res.status(502).json({ error: 'La IA no devolvió JSON válido', raw: cleaned.slice(0, 500) });
  }

  if (!Array.isArray(parsed.ideas) || parsed.ideas.length === 0) {
    return res.status(502).json({ error: 'Respuesta inválida (sin ideas[])', raw: cleaned.slice(0, 500) });
  }

  res.json({ ideas: parsed.ideas, chapters: totalChapters, pages: Number(pages), angle });
});

// POST /api/ebooks/products/:pid/generate → kick off async generation
router.post('/products/:pid/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.pid), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { angle_uid, text_model_id, image_model_id, pages, idea } = req.body;
  if (!angle_uid || !text_model_id || !image_model_id || !pages || !idea) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const textDef = TEXT_MODELS[text_model_id];
  const imgDef  = IMAGE_MODELS[image_model_id];
  if (!textDef) return res.status(400).json({ error: 'Modelo de texto no válido' });
  if (!imgDef)  return res.status(400).json({ error: 'Modelo de imagen no válido' });

  const textKey = keyFor(req.user.id, text_model_id);
  const imgKey  = keyFor(req.user.id, image_model_id, true);
  if (!textKey) return res.status(402).json({ error: `Configura tu API key de ${textDef.provider} en Ajustes → APIs` });
  if (!imgKey)  return res.status(402).json({ error: `Configura tu API key de ${imgDef.engine === 'openai' ? 'OpenAI' : 'Google'} en Ajustes → APIs` });

  const angle = flatAngles(p.id).find(a => a.uid === angle_uid);
  if (!angle) return res.status(404).json({ error: 'El ángulo seleccionado ya no existe' });

  const totalChapters = chaptersFromPages(pages);
  const chapterTitles = Array.isArray(idea.chapter_titles) ? idea.chapter_titles.slice(0, totalChapters) : [];

  // Create draft row — guardamos también ids y snapshots porque resume los necesita
  const draft = product_ebooks.insert({
    user_id:        req.user.id,
    product_id:     p.id,
    status:         'generating',
    title:          idea.title || `Ebook de ${p.name}`,
    subtitle:       idea.subtitle || '',
    angle_ref:      angle.title,
    angle_content:  `## ÁNGULO ${angle.num}: ${angle.title}`,
    pages_target:   Number(pages),
    text_model:     textDef.label,
    text_provider:  textDef.provider,
    image_model:    imgDef.label,
    text_model_id,
    image_model_id,
    angle_data:     angle,
    idea_data:      idea,
    chapters:       chapterTitles.map((t, i) => ({ id: i + 1, num: i + 1, title: t, content: '', image_path: null })),
    progress:       { step: 'starting', current: 0, total: totalChapters + 2, message: 'Preparando…' },
  });

  // Fire and forget — the heavy work runs in the background
  generateEbookAsync(draft.id, {
    product:        p,
    angle,
    idea,
    totalChapters,
    text_model_id,
    image_model_id,
    textKey,
    imgKey,
    imgDef,
  }).catch(err => {
    console.error(`[ebooks] generation ${draft.id} failed:`, err);
    product_ebooks.updateById(draft.id, { status: 'failed', error: err.message });
  });

  res.status(202).json({ id: draft.id, status: 'generating', total_steps: totalChapters + 2 });
});

// GET /api/ebooks/:id → poll status
// GET /api/ebooks/by-product/:pid → list (declared before /:id so the literal
// prefix wins over the numeric param matcher)
router.get('/by-product/:pid', (req, res) => {
  const p = products.one({ id: Number(req.params.pid), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const list = product_ebooks.forProduct(p.id).map(e => ({
    id:           e.id,
    title:        e.title,
    subtitle:     e.subtitle,
    status:       e.status,
    error:        e.error || null,
    pages_target: e.pages_target,
    progress:     e.progress,
    pdf_url:      e.pdf_path ? `/ebooks/${e.pdf_path}` : null,
    cover_image_url: e.cover_image_path ? `/ebook-images/${e.cover_image_path}` : null,
    created_at:   e.created_at,
    // can_resume: solo si está fallido y tiene los snapshots que el orquestador necesita
    can_resume:   e.status === 'failed' && !!e.text_model_id && !!e.image_model_id && !!e.angle_data && !!e.idea_data,
  }));
  res.json({ ebooks: list });
});

router.get('/:id', (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });

  const safe = { ...e };
  if (safe.cover_image_path)      safe.cover_image_url      = `/ebook-images/${safe.cover_image_path}`;
  if (safe.back_cover_image_path) safe.back_cover_image_url = `/ebook-images/${safe.back_cover_image_path}`;
  if (safe.pdf_path)              safe.pdf_url              = `/ebooks/${safe.pdf_path}`;
  safe.chapters = (safe.chapters || []).map(c => ({
    ...c,
    image_url: c.image_path ? `/ebook-images/${c.image_path}` : null,
  }));
  res.json({ ebook: safe });
});

// PUT /api/ebooks/:id → edita metadatos del ebook (título, subtítulo, intro, conclusión).
// Body: { title?, subtitle?, intro_content?, conclusion_content? }. Invalida pdf_path.
router.put('/:id', (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });
  if (e.status === 'generating') return res.status(409).json({ error: 'No puedes editar mientras el ebook se está generando' });

  const allowed = ['title', 'subtitle', 'intro_content', 'conclusion_content'];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      if (typeof req.body[k] !== 'string') return res.status(400).json({ error: `${k} debe ser string` });
      patch[k] = req.body[k].trim();
    }
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  // Limpieza del PDF viejo
  const oldPdf = e.pdf_path;
  patch.pdf_path = null;
  product_ebooks.updateById(e.id, patch);
  if (oldPdf) { try { fs.unlinkSync(path.join(EBOOK_PDF_DIR, oldPdf)); } catch (_) {} }

  res.json({ ebook: product_ebooks.one({ id: e.id }), pdf_invalidated: true });
});

// PUT /api/ebooks/:id/chapter/:cid → edita texto o título de un capítulo
// Body: { content?, title? }. Invalida pdf_path para forzar re-exportar.
router.put('/:id/chapter/:cid', (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });
  if (e.status === 'generating') return res.status(409).json({ error: 'No puedes editar mientras el ebook se está generando' });

  const cid = Number(req.params.cid);
  const idx = (e.chapters || []).findIndex(c => c.id === cid);
  if (idx === -1) return res.status(404).json({ error: 'Capítulo no encontrado' });

  const { content, title } = req.body;
  if (content === undefined && title === undefined) {
    return res.status(400).json({ error: 'Nada que actualizar (envía content o title)' });
  }
  if (content !== undefined && typeof content !== 'string') return res.status(400).json({ error: 'content debe ser string' });
  if (title   !== undefined && typeof title   !== 'string') return res.status(400).json({ error: 'title debe ser string' });

  const patch = {};
  if (content !== undefined) patch.content = content.trim();
  if (title   !== undefined) patch.title   = title.trim();

  const updatedChapters = e.chapters.map((c, i) => i === idx ? { ...c, ...patch } : c);
  const oldPdf = e.pdf_path;
  product_ebooks.updateById(e.id, { chapters: updatedChapters, pdf_path: null });
  if (oldPdf) { try { fs.unlinkSync(path.join(EBOOK_PDF_DIR, oldPdf)); } catch (_) {} }

  res.json({ chapter: updatedChapters[idx], pdf_invalidated: true });
});

// POST /api/ebooks/:id/regenerate-chapter → re-genera texto + imagen de UN capítulo
// Body: { chapter_id }. Devuelve el chapter actualizado. Invalida el pdf_path actual
// (el usuario tiene que volver a exportar).
router.post('/:id/regenerate-chapter', async (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });
  if (e.status === 'generating') return res.status(409).json({ error: 'No puedes regenerar mientras el ebook se está generando' });

  const { chapter_id } = req.body;
  const idx = (e.chapters || []).findIndex(c => c.id == chapter_id);
  if (idx === -1) return res.status(404).json({ error: 'Capítulo no encontrado' });

  if (!e.text_model_id || !e.image_model_id || !e.angle_data || !e.idea_data) {
    return res.status(409).json({ error: 'Este ebook no tiene los snapshots necesarios para regenerar (fue creado antes de fase 2)' });
  }

  const textDef = TEXT_MODELS[e.text_model_id];
  const imgDef  = IMAGE_MODELS[e.image_model_id];
  if (!textDef || !imgDef) return res.status(400).json({ error: 'Los modelos usados ya no están disponibles' });

  const textKey = keyFor(req.user.id, e.text_model_id);
  const imgKey  = keyFor(req.user.id, e.image_model_id, true);
  if (!textKey) return res.status(402).json({ error: `Configura tu API key de ${textDef.provider} en Ajustes → APIs` });
  if (!imgKey)  return res.status(402).json({ error: `Configura tu API key de ${imgDef.engine === 'openai' ? 'OpenAI' : 'Google'} en Ajustes → APIs` });

  const product = products.one({ id: e.product_id, user_id: req.user.id });
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  const chapter = e.chapters[idx];
  const chapterTitles = e.chapters.map(c => c.title);
  const totalChapters = e.chapters.length;
  const productCategory = product.description ? product.description.slice(0, 120) : product.name;

  // Limpiar imagen anterior para no dejar huérfanos en el volumen
  if (chapter.image_path) {
    try { fs.unlinkSync(path.join(EBOOK_IMG_DIR, chapter.image_path)); } catch (_) {}
  }

  // Construir el prompt usando el resumen de capítulos previos (no sucesivos —
  // para evitar feedback loop con su propio output viejo)
  const previousSummary = e.chapters.slice(0, idx)
    .filter(c => c.content)
    .map((c, k) => `Cap ${k + 1}: ${c.content.slice(0, 140)}`)
    .join('\n');

  const chapterPrompt = buildChapterPrompt({
    productName:      product.name,
    ebookTitle:       e.title,
    chapterNum:       idx + 1,
    totalChapters,
    chapterTitle:     chapter.title,
    chapterTitlesAll: chapterTitles,
    angle:            e.angle_data,
    previousSummary,
  });

  let newText;
  try {
    newText = await generateText({
      modelId:     e.text_model_id,
      apiKey:      textKey,
      system:      SYS_CHAPTER,
      user:        chapterPrompt,
      maxTokens:   2500,
      temperature: 0.85,  // un poco más alto que el inicial para que dé variación real
    });
    newText = String(newText || '').trim();
  } catch (err) {
    return res.status(502).json({ error: `Error al regenerar texto: ${err.message}` });
  }

  let newImgFile = null;
  try {
    const imgPrompt = buildImagePrompt({ chapterTitle: chapter.title, chapterExcerpt: newText, productCategory });
    const imgBuf = await generateImage({ engine: imgDef.engine, prompt: imgPrompt, apiKey: imgKey, aspect: '4:3', modelId: imgDef.model });
    newImgFile = `ch${idx + 1}_${e.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.png`;
    fs.writeFileSync(path.join(EBOOK_IMG_DIR, newImgFile), imgBuf);
  } catch (err) {
    console.warn(`[ebooks] regenerate image failed: ${err.message}`);
  }

  // Persistir el nuevo capítulo y limpiar el pdf_path (queda desactualizado)
  const updatedChapters = e.chapters.map((c, i) => i === idx ? { ...c, content: newText, image_path: newImgFile } : c);
  const old = e.pdf_path;
  product_ebooks.updateById(e.id, { chapters: updatedChapters, pdf_path: null });
  if (old) { try { fs.unlinkSync(path.join(EBOOK_PDF_DIR, old)); } catch (_) {} }

  const updated = product_ebooks.one({ id: e.id });
  const chap = updated.chapters[idx];
  res.json({
    chapter: {
      ...chap,
      image_url: chap.image_path ? `/ebook-images/${chap.image_path}` : null,
    },
    pdf_invalidated: true,
  });
});

// POST /api/ebooks/:id/resume → reanuda un ebook fallido/incompleto
router.post('/:id/resume', async (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });
  if (e.status === 'generating') return res.status(409).json({ error: 'El ebook ya está generándose' });

  // Necesitamos los snapshots que el generate guardó. Si vienen de un ebook
  // viejo (anterior a la fase 2) sin estos campos, no podemos reanudar.
  if (!e.text_model_id || !e.image_model_id || !e.angle_data || !e.idea_data) {
    return res.status(409).json({
      error: 'Este ebook no se puede reanudar (fue creado antes de la función reanudar). Genera uno nuevo.',
    });
  }

  const textDef = TEXT_MODELS[e.text_model_id];
  const imgDef  = IMAGE_MODELS[e.image_model_id];
  if (!textDef || !imgDef) return res.status(400).json({ error: 'Los modelos usados ya no están disponibles' });

  const textKey = keyFor(req.user.id, e.text_model_id);
  const imgKey  = keyFor(req.user.id, e.image_model_id, true);
  if (!textKey) return res.status(402).json({ error: `Configura tu API key de ${textDef.provider} en Ajustes → APIs` });
  if (!imgKey)  return res.status(402).json({ error: `Configura tu API key de ${imgDef.engine === 'openai' ? 'OpenAI' : 'Google'} en Ajustes → APIs` });

  const product = products.one({ id: e.product_id, user_id: req.user.id });
  if (!product) return res.status(404).json({ error: 'El producto del ebook ya no existe' });

  const totalChapters = (e.chapters || []).length || chaptersFromPages(e.pages_target);

  // Marcar generating + limpiar error previo y disparar el orquestador
  product_ebooks.updateById(e.id, {
    status:   'generating',
    error:    null,
    progress: { step: 'resuming', current: 0, total: totalChapters + 2, message: 'Reanudando…' },
  });

  generateEbookAsync(e.id, {
    product,
    angle:          e.angle_data,
    idea:           e.idea_data,
    totalChapters,
    text_model_id:  e.text_model_id,
    image_model_id: e.image_model_id,
    textKey,
    imgKey,
    imgDef,
  }).catch(err => {
    console.error(`[ebooks] resume ${e.id} failed:`, err);
    product_ebooks.updateById(e.id, { status: 'failed', error: err.message });
  });

  res.status(202).json({ id: e.id, status: 'generating', total_steps: totalChapters + 2 });
});

// POST /api/ebooks/:id/export-pdf → render PDF on demand
router.post('/:id/export-pdf', async (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });
  if (e.status !== 'ready') return res.status(409).json({ error: `El ebook no está listo (status: ${e.status})` });

  try {
    const pdfFilename = await buildPDF(e);
    product_ebooks.updateById(e.id, { pdf_path: pdfFilename });
    res.json({ pdf_url: `/ebooks/${pdfFilename}` });
  } catch (err) {
    console.error('[ebooks] PDF export failed:', err);
    res.status(500).json({ error: `Error al generar PDF: ${err.message}` });
  }
});

// DELETE /api/ebooks/:id
router.delete('/:id', (req, res) => {
  const e = product_ebooks.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!e) return res.status(404).json({ error: 'Ebook no encontrado' });

  // Best-effort cleanup of files
  const tryUnlink = (p) => { try { fs.unlinkSync(p); } catch (_) {} };
  if (e.pdf_path)              tryUnlink(path.join(EBOOK_PDF_DIR, e.pdf_path));
  if (e.cover_image_path)      tryUnlink(path.join(EBOOK_IMG_DIR, e.cover_image_path));
  if (e.back_cover_image_path) tryUnlink(path.join(EBOOK_IMG_DIR, e.back_cover_image_path));
  (e.chapters || []).forEach(c => { if (c.image_path) tryUnlink(path.join(EBOOK_IMG_DIR, c.image_path)); });

  product_ebooks.delete(e.id, req.user.id);
  res.json({ message: 'Ebook eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Async generation orchestrator
//
// Idempotente: skipea cualquier paso cuya salida ya esté guardada en la DB
// (portada, contraportada, texto del capítulo, imagen del capítulo, intro,
// conclusión). Esto permite reanudar un ebook fallido sin regenerar lo que
// ya costó tokens.
// ─────────────────────────────────────────────────────────────────
async function generateEbookAsync(ebookId, ctx) {
  const { product, angle, idea, totalChapters, text_model_id, textKey, imgKey, imgDef } = ctx;
  const chapterTitles = (idea.chapter_titles || []).slice(0, totalChapters);

  const updateProgress = (step, current, total, message) => {
    product_ebooks.updateById(ebookId, { progress: { step, current, total, message } });
  };

  // Foto del estado actual: qué hay que generar y qué se puede saltar.
  const initial = product_ebooks.one({ id: ebookId }) || {};
  const productCategory = product.description ? product.description.slice(0, 120) : product.name;
  const coverPrompt = buildCoverImagePrompt({ ebookTitle: idea.title, productCategory });

  const saveImg = (buf, basename) => {
    const filename = `${basename}_${ebookId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.png`;
    fs.writeFileSync(path.join(EBOOK_IMG_DIR, filename), buf);
    return filename;
  };

  // ─── Step 1: cover + back cover (genera solo las que falten) ───
  updateProgress('cover', 0, totalChapters + 2, 'Generando portada…');
  const needCover = !initial.cover_image_path || !fs.existsSync(path.join(EBOOK_IMG_DIR, initial.cover_image_path));
  const needBack  = !initial.back_cover_image_path || !fs.existsSync(path.join(EBOOK_IMG_DIR, initial.back_cover_image_path));
  if (needCover || needBack) {
    try {
      const jobs = [];
      if (needCover) jobs.push(generateImage({ engine: imgDef.engine, prompt: coverPrompt, apiKey: imgKey, aspect: '4:3', modelId: imgDef.model }));
      if (needBack)  jobs.push(generateImage({ engine: imgDef.engine, prompt: coverPrompt + ' Alternative composition, equally clean.', apiKey: imgKey, aspect: '4:3', modelId: imgDef.model }));
      const results = await Promise.all(jobs);
      const patch = {};
      let idx = 0;
      if (needCover) { patch.cover_image_path      = saveImg(results[idx++], 'cover'); }
      if (needBack)  { patch.back_cover_image_path = saveImg(results[idx++], 'back'); }
      product_ebooks.updateById(ebookId, patch);
    } catch (err) {
      throw new Error(`Falló la generación de portada: ${err.message}`);
    }
  }

  // ─── Step 2: cada capítulo (texto → imagen) — skip lo que ya está hecho ───
  const previousSummaries = [];
  for (let i = 0; i < chapterTitles.length; i++) {
    const chapterNum   = i + 1;
    const chapterTitle = chapterTitles[i];
    const currentState = product_ebooks.one({ id: ebookId });
    const existing     = currentState?.chapters?.[i] || {};

    // ── Texto del capítulo ──
    let chapterText = existing.content || '';
    if (chapterText) {
      previousSummaries.push(chapterText.slice(0, 200));
      updateProgress('chapter_text', chapterNum, totalChapters + 2, `Cap ${chapterNum}/${totalChapters} ya escrito — saltando`);
    } else {
      updateProgress('chapter_text', chapterNum, totalChapters + 2, `Escribiendo capítulo ${chapterNum}/${totalChapters}…`);
      const previousSummary = previousSummaries.length
        ? previousSummaries.map((s, k) => `Cap ${k + 1}: ${s.slice(0, 140)}`).join('\n')
        : '';
      const chapterPrompt = buildChapterPrompt({
        productName:      product.name,
        ebookTitle:       idea.title,
        chapterNum,
        totalChapters,
        chapterTitle,
        chapterTitlesAll: chapterTitles,
        angle,
        previousSummary,
      });
      try {
        chapterText = await generateText({
          modelId:     text_model_id,
          apiKey:      textKey,
          system:      SYS_CHAPTER,
          user:        chapterPrompt,
          maxTokens:   2500,
          temperature: 0.78,
        });
      } catch (err) {
        throw new Error(`Capítulo ${chapterNum}: ${err.message}`);
      }
      chapterText = String(chapterText || '').trim();
      previousSummaries.push(chapterText.slice(0, 200));
      // Persistir el texto inmediatamente para que el polling lo vea
      const eb = product_ebooks.one({ id: ebookId });
      const next = eb.chapters.map((c, idx) => idx === i ? { ...c, content: chapterText } : c);
      product_ebooks.updateById(ebookId, { chapters: next });
    }

    // ── Imagen del capítulo ──
    const hasImg = existing.image_path && fs.existsSync(path.join(EBOOK_IMG_DIR, existing.image_path));
    if (!hasImg) {
      updateProgress('chapter_image', chapterNum, totalChapters + 2, `Generando imagen capítulo ${chapterNum}/${totalChapters}…`);
      try {
        const imgPrompt = buildImagePrompt({
          chapterTitle,
          chapterExcerpt: chapterText,
          productCategory,
        });
        const imgBuf = await generateImage({ engine: imgDef.engine, prompt: imgPrompt, apiKey: imgKey, aspect: '4:3', modelId: imgDef.model });
        const imgFile = saveImg(imgBuf, `ch${chapterNum}`);
        const eb2 = product_ebooks.one({ id: ebookId });
        const withImg = eb2.chapters.map((c, idx) => idx === i ? { ...c, image_path: imgFile } : c);
        product_ebooks.updateById(ebookId, { chapters: withImg });
      } catch (err) {
        // No fatal: si la imagen falla, el PDF se renderiza sin ella.
        console.warn(`[ebooks] image for chapter ${chapterNum} failed: ${err.message}`);
      }
    }
  }

  // ─── Step 3: intro & conclusion (skip si ya existen) ───
  updateProgress('intro_conclusion', totalChapters + 1, totalChapters + 2, 'Escribiendo introducción y conclusión…');

  const introPrompt = `Escribe la INTRODUCCIÓN de un ebook tipo lead magnet titulado "${idea.title}", subtítulo "${idea.subtitle}".
El ebook acompaña al producto: ${product.name}.
Avatar: ${angle.avatar || '(generalista)'}.
Problema central: ${angle.problem || idea.synopsis}.

Extensión: 150-220 palabras. Tono cercano, profesional. Sin títulos. Sin markdown. 2 párrafos.
Menciona el producto UNA SOLA VEZ, de pasada, como "el complemento ideal" o similar.
Cierra con una frase que invite al lector a embarcarse en la lectura.
IDIOMA: español neutro estándar (tú/tu). PROHIBIDO el voseo argentino.`;

  const conclusionPrompt = `Escribe la CONCLUSIÓN de un ebook tipo lead magnet titulado "${idea.title}".
Producto asociado: ${product.name}.
Capítulos cubiertos: ${chapterTitles.join('; ')}.

Extensión: 130-180 palabras. Tono motivacional pero sobrio. 2 párrafos. Sin markdown. Sin títulos.
Refuerza la idea de que la consistencia es lo importante.
Anima al lector a poner en práctica lo aprendido y menciona el producto UNA vez como "herramienta de apoyo".
IDIOMA: español neutro estándar (tú/tu). PROHIBIDO el voseo argentino.`;

  const ebState = product_ebooks.one({ id: ebookId }) || {};
  const introPatch = {};
  const introNeed      = !ebState.intro_content;
  const conclusionNeed = !ebState.conclusion_content;
  if (introNeed || conclusionNeed) {
    try {
      const jobs = [];
      if (introNeed)      jobs.push(generateText({ modelId: text_model_id, apiKey: textKey, system: SYS_CHAPTER, user: introPrompt,      maxTokens: 800, temperature: 0.75 }));
      if (conclusionNeed) jobs.push(generateText({ modelId: text_model_id, apiKey: textKey, system: SYS_CHAPTER, user: conclusionPrompt, maxTokens: 800, temperature: 0.75 }));
      const results = await Promise.all(jobs);
      let idx = 0;
      if (introNeed)      introPatch.intro_content      = String(results[idx++] || '').trim();
      if (conclusionNeed) introPatch.conclusion_content = String(results[idx++] || '').trim();
      if (Object.keys(introPatch).length > 0) product_ebooks.updateById(ebookId, introPatch);
    } catch (err) {
      console.warn('[ebooks] intro/conclusion failed:', err.message);
    }
  }

  // ─── Step 4: render PDF ───
  updateProgress('pdf', totalChapters + 2, totalChapters + 2, 'Renderizando PDF…');
  const finalEbook = product_ebooks.one({ id: ebookId });
  try {
    const pdfFilename = await buildPDF(finalEbook);
    product_ebooks.updateById(ebookId, {
      pdf_path: pdfFilename,
      status:   'ready',
      error:    null,
      progress: { step: 'done', current: totalChapters + 2, total: totalChapters + 2, message: 'Listo' },
    });
  } catch (err) {
    // Mark as ready-without-pdf so the user can still preview chapters
    product_ebooks.updateById(ebookId, {
      status:   'ready',
      error:    `PDF falló: ${err.message}. Los capítulos están listos — puedes re-exportar.`,
      progress: { step: 'pdf_failed', current: totalChapters + 1, total: totalChapters + 2, message: 'Capítulos listos. PDF falló — intenta re-exportar.' },
    });
  }
}

// Build the PDF from an ebook row. Inlines images as data URIs so Puppeteer
// doesn't need to fetch them over HTTP.
async function buildPDF(ebook) {
  const inline = (filename) => {
    if (!filename) return null;
    const full = path.join(EBOOK_IMG_DIR, filename);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    const ext = (filename.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  };

  const enriched = {
    ...ebook,
    cover_image_data_url:      inline(ebook.cover_image_path),
    back_cover_image_data_url: inline(ebook.back_cover_image_path),
    chapters: (ebook.chapters || []).map(c => ({
      ...c,
      image_data_url: inline(c.image_path),
    })),
  };

  const html = buildEbookHTML(enriched);
  const filename = `ebook_${ebook.id}_${Date.now()}.pdf`;
  const outPath = path.join(EBOOK_PDF_DIR, filename);
  await renderEbookPDF(html, outPath);
  return filename;
}

module.exports = router;
