const express = require('express');
const { products, product_research, product_descriptions, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callKie } = require('../lib/kie');

const router = express.Router();
router.use(requireAuth);

// ── Model registry (same as products.js) ─────────────────────────
const MODELS = {
  'gpt-4.1':                  { provider: 'openai',    label: 'GPT-4.1',          key_field: 'openai_key' },
  'gpt-4.1-mini':             { provider: 'openai',    label: 'GPT-4.1 mini',     key_field: 'openai_key' },
  'gpt-4.1-nano':             { provider: 'openai',    label: 'GPT-4.1 nano',     key_field: 'openai_key' },
  'gpt-4o':                   { provider: 'openai',    label: 'GPT-4o',           key_field: 'openai_key' },
  'gpt-4o-mini':              { provider: 'openai',    label: 'GPT-4o mini',      key_field: 'openai_key' },
  'o3':                       { provider: 'openai',    label: 'o3',               key_field: 'openai_key' },
  'o4-mini':                  { provider: 'openai',    label: 'o4-mini',          key_field: 'openai_key' },
  'claude-opus-4-7':          { provider: 'anthropic', label: 'Claude Opus 4.7',    key_field: 'claude_key' },
  'claude-sonnet-4-6':        { provider: 'anthropic', label: 'Claude Sonnet 4.6',key_field: 'claude_key' },
  'claude-haiku-4-5-20251001':{ provider: 'anthropic', label: 'Claude Haiku 4.5', key_field: 'claude_key' },
  'gemini-3.1-pro-preview':   { provider: 'google',    label: 'Gemini 3.1 Pro (preview)', key_field: 'gemini_key' },
  'gemini-3-flash-preview':   { provider: 'google',    label: 'Gemini 3 Flash (preview)', key_field: 'gemini_key' },
  'gemini-3.1-flash-lite':    { provider: 'google',    label: 'Gemini 3.1 Flash Lite',    key_field: 'gemini_key' },
  'gemini-2.5-pro':           { provider: 'google',    label: 'Gemini 2.5 Pro',           key_field: 'gemini_key' },
  'gemini-2.5-flash':         { provider: 'google',    label: 'Gemini 2.5 Flash',         key_field: 'gemini_key' },
  'gemini-2.0-flash':         { provider: 'google',    label: 'Gemini 2.0 Flash',         key_field: 'gemini_key' },
  // Kie.ai 2026 frontier
  'kie:claude-opus-4-7':       { provider: 'kie', label: 'Claude Opus 4.7 (Kie.ai)',     key_field: 'kieai_key' },
  'kie:claude-sonnet-4-6':     { provider: 'kie', label: 'Claude Sonnet 4.6 (Kie.ai)',   key_field: 'kieai_key' },
  'kie:gpt-5-5':               { provider: 'kie', label: 'GPT-5.5 (Kie.ai)',             key_field: 'kieai_key' },
  'kie:gemini-3.1-pro-preview':{ provider: 'kie', label: 'Gemini 3.1 Pro (Kie.ai)',      key_field: 'kieai_key' },
  'kie:gemini-3-flash-preview':{ provider: 'kie', label: 'Gemini 3 Flash (Kie.ai)',      key_field: 'kieai_key' },
  // Kie.ai legacy
  'kie:gpt-5-2':              { provider: 'kie', label: 'GPT-5.2 (Kie.ai)',              key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':    { provider: 'kie', label: 'Claude Sonnet 4.5 (Kie.ai)',    key_field: 'kieai_key' },
  'kie:claude-opus-4-5':      { provider: 'kie', label: 'Claude Opus 4.5 (Kie.ai)',      key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':       { provider: 'kie', label: 'Gemini 2.5 Pro (Kie.ai)',       key_field: 'kieai_key' },
};

// ── GET /api/descriptions — products with description counts ────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    description_count: products.descriptionCount(p.id),
    research_count:    products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/descriptions/:id — product + descriptions + research
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:      p,
    descriptions: product_descriptions.forProduct(p.id),
    research:     product_research.forProduct(p.id),
  });
});

// ── POST /api/descriptions/:id/generate ──────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, extra_info } = req.body;

  const modelDef = MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  // Use the latest research as the input context
  const research = product_research.forProduct(p.id);
  const latestResearch = research[0];
  if (!latestResearch && !extra_info) {
    return res.status(400).json({ error: 'Este producto no tiene una investigación previa. Genera una investigación primero, o envía información extra.' });
  }

  const prompt = buildPrompt(p.name, latestResearch?.content || '', extra_info || '');

  let raw;
  try {
    raw = await callAI(modelDef.provider, model_id, apiKey, prompt);
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  // Parse the 4 sections out of the response
  const sections = parseSections(raw);

  const r = product_descriptions.insert({
    product_id:         p.id,
    user_id:            req.user.id,
    description:        sections.description,
    usage:              sections.usage,
    technical_features: sections.technical_features,
    package_contents:   sections.package_contents,
    model:              modelDef.label,
    provider:           modelDef.provider,
  });

  res.json({
    id:       r.id,
    sections,
    model:    modelDef.label,
    raw,
  });
});

// ── DELETE /api/descriptions/:id/:descId ─────────────────────────
router.delete('/:id/:descId', (req, res) => {
  const ok = product_descriptions.delete(req.params.descId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Descripción no encontrada' });
  res.json({ message: 'Descripción eliminada' });
});

// ── Prompt builder ───────────────────────────────────────────────
function buildPrompt(productName, researchContent, extraInfo) {
  const ctx = researchContent
    ? `INVESTIGACIÓN COMPLETA DEL PRODUCTO (úsala como fuente principal de información — extrae características técnicas, componentes, beneficios, modo de uso y todo dato relevante para construir la descripción comercial):\n\n${researchContent}`
    : '';

  const extra = extraInfo
    ? `\n\nINFORMACIÓN ADICIONAL APORTADA POR EL USUARIO:\n${extraInfo}`
    : '';

  return `Eres un copywriter experto en descripciones de productos para marketplaces y tiendas online (estilo MercadoLibre, Amazon, tiendas de dropshipping). Generas descripciones comerciales claras, atractivas y orientadas a la conversión.

PRODUCTO: ${productName}

${ctx}${extra}

---

Tu tarea es generar la DESCRIPCIÓN COMERCIAL DEL PRODUCTO con EXACTAMENTE las 4 secciones siguientes, en español neutro hispanohablante, usando los encabezados literales mostrados. Cada sección debe ser concreta, específica y útil para un comprador.

## 1. Descripción
Escribe una descripción comercial atractiva y persuasiva del producto (4-7 párrafos). Resalta el valor principal, los beneficios clave y por qué este producto vale la pena. Usa lenguaje emocional pero claro. Captura la atención desde la primera línea. Incluye un cierre que motive a la compra.

## 2. Modo de Uso
Describe el modo de uso paso a paso, de forma clara y práctica. Incluye:
- Cómo se utiliza el producto (pasos numerados o lista)
- Frecuencia recomendada de uso
- Tips para sacar el mejor provecho
- Cuidados / mantenimiento si aplica

## 3. Características Técnicas
Lista detallada, en formato bullet points, de TODAS las especificaciones técnicas relevantes. Por ejemplo:
- Tamaño / dimensiones
- Peso
- Materiales / composición / ingredientes
- Potencia / capacidad / cantidad
- Certificaciones (si aplica)
- Vida útil / garantía
- Origen / fabricación
- Cualquier especificación numérica o medible
Si la investigación no menciona un dato específico, infiere lo razonable o indica "Consultar empaque" — pero NO inventes datos numéricos que no estén implícitos.

## 4. Contenido del Paquete
Lista clara de TODO lo que viene incluido en el paquete que recibe el cliente. Por ejemplo:
- 1 x Producto principal
- 1 x Manual de instrucciones
- 1 x Accesorio X
- Empaque protector
Si la investigación es ambigua, infiere lo más razonable basado en el tipo de producto.

---

INSTRUCCIONES IMPORTANTES:
- Usa EXACTAMENTE los 4 encabezados con la numeración (## 1. Descripción, ## 2. Modo de Uso, ## 3. Características Técnicas, ## 4. Contenido del Paquete)
- Empieza el contenido directamente debajo de cada encabezado
- NO añadas secciones extra
- Lenguaje en español neutro hispanohablante
- Tono profesional pero cercano y comercial
- Listas con guiones (-) o números cuando sea apropiado`;
}

// ── Parse the 4 sections from the AI response ────────────────────
function parseSections(raw) {
  const result = { description: '', usage: '', technical_features: '', package_contents: '' };
  if (!raw) return result;

  // Split by ## N. headers
  const parts = raw.split(/^##\s*\d+\.\s*/m).map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const firstNewline = part.indexOf('\n');
    const header = (firstNewline === -1 ? part : part.slice(0, firstNewline)).toLowerCase();
    const body   = firstNewline === -1 ? '' : part.slice(firstNewline + 1).trim();

    if (header.includes('descripción') || header.includes('descripcion')) {
      result.description = body;
    } else if (header.includes('modo de uso') || header.includes('uso')) {
      result.usage = body;
    } else if (header.includes('técnic') || header.includes('tecnic') || header.includes('caracterí') || header.includes('caracteri')) {
      result.technical_features = body;
    } else if (header.includes('paquete') || header.includes('contenido')) {
      result.package_contents = body;
    }
  }

  return result;
}

// ── AI call (same shape as products.js) ──────────────────────────
const SYS = 'Eres un copywriter experto en descripciones comerciales de productos para tiendas online y marketplaces hispanohablantes. Generas siempre contenido en español neutro, claro, persuasivo y orientado a la conversión.';

async function callAI(provider, modelId, apiKey, prompt) {
  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 4000,
        temperature: 0.7,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
    return d.choices[0].message.content;
  }
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 4000, system: SYS, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic error ${r.status}`);
    return d.content[0].text;
  }
  if (provider === 'google') {
    const isThinking25 = /^gemini-(2\.5|3)/.test(modelId);
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYS}\n\n${prompt}` }] }],
          generationConfig: { maxOutputTokens: isThinking25 ? 16384 : 4096 },
        }),
      }
    );
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Google error ${r.status}`);
    const cand = d.candidates && d.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
    if (!text) {
      const reason = cand?.finishReason || 'sin candidatos';
      const blockReason = d.promptFeedback?.blockReason;
      throw new Error(`Google devolvió respuesta vacía (finishReason: ${reason}${blockReason ? `, bloqueo: ${blockReason}` : ''})`);
    }
    return text;
  }
  if (provider === 'kie') {
    return callKie({ apiKey, modelId, sysMsg: SYS, userPrompt: prompt, maxTokens: 4000, temperature: 0.7 });
  }
  throw new Error('Proveedor no soportado');
}

module.exports = router;
