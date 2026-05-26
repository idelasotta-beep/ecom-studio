const express = require('express');
const { products, product_angles, product_copys, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callKie } = require('../lib/kie');

const router = express.Router();
router.use(requireAuth);

// ── Model registry (mirror of products.js / descriptions.js) ─────
const MODELS = {
  'gpt-4.1':                   { provider: 'openai',    label: 'GPT-4.1',           key_field: 'openai_key' },
  'gpt-4.1-mini':              { provider: 'openai',    label: 'GPT-4.1 mini',      key_field: 'openai_key' },
  'gpt-4.1-nano':              { provider: 'openai',    label: 'GPT-4.1 nano',      key_field: 'openai_key' },
  'gpt-4o':                    { provider: 'openai',    label: 'GPT-4o',            key_field: 'openai_key' },
  'gpt-4o-mini':               { provider: 'openai',    label: 'GPT-4o mini',       key_field: 'openai_key' },
  'o3':                        { provider: 'openai',    label: 'o3',                key_field: 'openai_key' },
  'o4-mini':                   { provider: 'openai',    label: 'o4-mini',           key_field: 'openai_key' },
  'claude-opus-4-7':           { provider: 'anthropic', label: 'Claude Opus 4.7',     key_field: 'claude_key' },
  'claude-sonnet-4-6':         { provider: 'anthropic', label: 'Claude Sonnet 4.6', key_field: 'claude_key' },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5',  key_field: 'claude_key' },
  'gemini-3.1-pro-preview':    { provider: 'google',    label: 'Gemini 3.1 Pro (preview)', key_field: 'gemini_key' },
  'gemini-3-flash-preview':    { provider: 'google',    label: 'Gemini 3 Flash (preview)', key_field: 'gemini_key' },
  'gemini-3.1-flash-lite':     { provider: 'google',    label: 'Gemini 3.1 Flash Lite',    key_field: 'gemini_key' },
  'gemini-2.5-pro':            { provider: 'google',    label: 'Gemini 2.5 Pro',           key_field: 'gemini_key' },
  'gemini-2.5-flash':          { provider: 'google',    label: 'Gemini 2.5 Flash',         key_field: 'gemini_key' },
  'gemini-2.0-flash':          { provider: 'google',    label: 'Gemini 2.0 Flash',         key_field: 'gemini_key' },
  // Kie.ai 2026 frontier (más recientes — recomendados)
  'kie:claude-opus-4-7':        { provider: 'kie',      label: 'Claude Opus 4.7 (Kie.ai)',    key_field: 'kieai_key' },
  'kie:claude-sonnet-4-6':      { provider: 'kie',      label: 'Claude Sonnet 4.6 (Kie.ai)',  key_field: 'kieai_key' },
  'kie:gpt-5-5':                { provider: 'kie',      label: 'GPT-5.5 (Kie.ai)',            key_field: 'kieai_key' },
  'kie:gemini-3.1-pro-preview': { provider: 'kie',      label: 'Gemini 3.1 Pro (Kie.ai)',     key_field: 'kieai_key' },
  'kie:gemini-3-flash-preview': { provider: 'kie',      label: 'Gemini 3 Flash (Kie.ai)',     key_field: 'kieai_key' },
  // Kie.ai legacy
  'kie:gpt-5-2':               { provider: 'kie',       label: 'GPT-5.2 (Kie.ai)',           key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':     { provider: 'kie',       label: 'Claude Sonnet 4.5 (Kie.ai)', key_field: 'kieai_key' },
  'kie:claude-opus-4-5':       { provider: 'kie',       label: 'Claude Opus 4.5 (Kie.ai)',   key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':        { provider: 'kie',       label: 'Gemini 2.5 Pro (Kie.ai)',    key_field: 'kieai_key' },
};

// Length presets — strict word ranges enforced via prompt
const LENGTHS = {
  short:  { label: 'Corto',  min: 8,  max: 12, description: 'gancho rápido, una sola idea fuerte' },
  medium: { label: 'Medio',  min: 25, max: 35, description: 'desarrolla el problema y presenta el producto' },
  long:   { label: 'Largo',  min: 80, max: 85, description: 'storytelling completo con problema, agitación y solución' },
};

// ── GET /api/copys — products with copy counts ───────────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    copy_count:     (product_copys.forProduct(p.id) || []).length,
    angle_count:    (product_angles.forProduct(p.id) || []).reduce((sum, rec) => sum + parseAngles(rec.content).length, 0),
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/copys/:id — product + saved copies + parsed angles ──
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  // Flatten all angles from all angle records into a single selectable list
  const angleRecords = product_angles.forProduct(p.id);
  const flatAngles = [];
  angleRecords.forEach(rec => {
    parseAngles(rec.content).forEach((angle, idx) => {
      flatAngles.push({
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

  res.json({
    product: p,
    copys:   product_copys.forProduct(p.id),
    angles:  flatAngles,
  });
});

// ── POST /api/copys/:id/generate ─────────────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, angle_uid, length = 'medium' } = req.body;

  // Validate length
  const lengthDef = LENGTHS[length];
  if (!lengthDef) return res.status(400).json({ error: 'Longitud inválida. Usa: short, medium o long.' });

  // Validate model + key
  const modelDef = MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });
  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  // Locate the selected angle
  if (!angle_uid) return res.status(400).json({ error: 'Falta el ángulo de venta seleccionado' });
  const [recordId, idxStr] = String(angle_uid).split('-');
  const angleRec = product_angles.forProduct(p.id).find(r => r.id == recordId);
  if (!angleRec) return res.status(404).json({ error: 'El ángulo seleccionado ya no existe' });
  const parsed = parseAngles(angleRec.content);
  const angle = parsed[Number(idxStr)];
  if (!angle) return res.status(404).json({ error: 'El ángulo seleccionado ya no existe' });

  // Build the prompt
  const prompt = buildCopyPrompt({ productName: p.name, angle, length: lengthDef });

  // Call AI
  let content;
  try {
    if (modelDef.provider === 'kie') {
      content = await callKie({ apiKey, modelId: model_id, sysMsg: SYS_COPY, userPrompt: prompt, maxTokens: 600, temperature: 0.8 });
    } else {
      content = await callAI(modelDef.provider, model_id, apiKey, prompt);
    }
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  // Clean common AI artifacts (surrounding quotes, leading/trailing whitespace)
  content = String(content || '').trim().replace(/^["“”']+|["“”']+$/g, '').trim();

  // Save
  const saved = product_copys.insert({
    product_id:    p.id,
    user_id:       req.user.id,
    angle_ref:     angle.title,
    angle_content: `## ÁNGULO ${angle.num}: ${angle.title}`,
    length,
    content,
    model:         modelDef.label,
    provider:      modelDef.provider,
  });

  res.json({
    id:       saved.id,
    content,
    length,
    angle:    { title: angle.title, num: angle.num },
    model:    modelDef.label,
    provider: modelDef.provider,
  });
});

// ── DELETE /api/copys/:id/copys/:copyId ──────────────────────────
router.delete('/:id/copys/:copyId', (req, res) => {
  const ok = product_copys.delete(req.params.copyId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Copy no encontrado' });
  res.json({ message: 'Copy eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

// Parse markdown angle blocks "## ÁNGULO 01: Title" with subsections
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

const SYS_COPY = 'Eres un copywriter senior especializado en publicidad de Facebook e Instagram (Meta Ads). Tu objetivo es escribir copies de anuncios que conviertan, respetando ESTRICTAMENTE las políticas de publicidad de Meta. Devuelves SIEMPRE el copy final como un único bloque de texto fluido, listo para pegar en el anuncio. NUNCA agregas comentarios, prefijos ("Copy:"), markdown, comillas alrededor del texto, ni explicaciones.';

function buildCopyPrompt({ productName, angle, length }) {
  return `Genera UN copy de anuncio para Meta Ads que convierta sin violar las políticas de Meta.

PRODUCTO: ${productName}

ÁNGULO DE VENTA A USAR:
- Título del ángulo: ${angle.title}
- Descripción: ${angle.description || '(no especificada)'}
- Avatar / cliente ideal: ${angle.avatar || '(no especificado)'}
- Problema que aborda: ${angle.problem || '(no especificado)'}
- Cómo el producto soluciona: ${angle.solution || '(no especificado)'}

EXTENSIÓN OBLIGATORIA: ${length.label} (entre ${length.min} y ${length.max} palabras EXACTAS). ${length.description}.

POLÍTICAS DE META — REGLAS QUE NO PUEDES VIOLAR:
1. PROHIBIDO ASUMIR ATRIBUTOS PERSONALES del lector. No uses preguntas/afirmaciones que asuman que el lector tiene una condición, problema, raza, género, edad, peso, condición médica, estado mental, etc.
   ✗ "¿Sufres de hinchazón?" / "Tú tienes acné" / "Personas como tú..."
   ✓ "Conoce esta solución natural" / "Una alternativa para el bienestar digestivo"
2. PROHIBIDO BODY-SHAMING o crear inseguridad. Nada de "antes/después", "personas con sobrepeso", insultos al cuerpo o autoestima.
3. PROHIBIDOS HEALTH CLAIMS específicos con plazos. No uses "Cura X en N días", "Elimina X garantizado", "Pierde X kilos en N semanas".
4. PROHIBIDAS PROMESAS ABSOLUTAS: nada de "100% efectivo", "Resultados garantizados", "Funciona o devolvemos tu dinero".
5. PROHIBIDO BEFORE/AFTER framing dramático.
6. PERMITIDO: verbos suaves ("apoya", "ayuda a", "contribuye a", "favorece"), beneficios generales, educación, curiosidad.

ESTRUCTURA RECOMENDADA (adaptada a la extensión):
- CORTO (8-12 palabras): un gancho fuerte que despierte curiosidad o nombre el beneficio. SIN preguntas personales.
- MEDIO (25-35 palabras): hook + 1 beneficio concreto + invitación suave a conocer más. Menciona el producto al menos una vez.
- LARGO (80-85 palabras): hook + contexto del problema (sin acusar al lector) + cómo el producto ayuda (verbos suaves) + diferenciador + invitación suave a hacer click para conocer más. Tono cercano, conversacional.

USO DE EMOJIS — OBLIGATORIO Y MODERADO:
- DEBES incluir emojis en el copy. No es opcional. Cantidad EXACTA según extensión:
  · CORTO: incluye 1 emoji (al inicio o al final, no ambos).
  · MEDIO: incluye 2 emojis distribuidos en distintas frases.
  · LARGO: incluye 3 emojis distribuidos en distintas partes del texto (uno cerca del hook, uno en la zona de beneficio, uno cerca del cierre).
- Deben ser RELEVANTES al producto, beneficio o emoción (ej: 🌿 para natural, ✨ para resultado, 💧 para hidratación, ☕ para café, 🌙 para descanso, 🐾 para mascotas, 💆 para bienestar).
- PROHIBIDO encadenar emojis seguidos (✨✨✨ o 🔥🔥). Cada emoji debe ir AISLADO.
- PROHIBIDO emojis genéricos de "vende-vende" tipo 💰💸🛒👉🚨🔴 que activan filtros de Meta como spam.
- Si el ángulo es serio/sensible (salud grave, dolor crónico, problemas familiares profundos), reduce a la mitad la cantidad indicada y elige emojis sobrios (🌿 ✨ 💚) en vez de festivos.

REGLAS DE FORMATO:
- En español neutro de Latinoamérica (sin modismos regionales).
- Sin hashtags.
- Sin signos de exclamación múltiples.
- Sin texto en MAYÚSCULAS (Meta penaliza shouting). Solo capitaliza el inicio de oraciones y nombres propios.
- Sin URLs ni teléfonos ni "Compra aquí".
- Sin asteriscos, sin markdown, sin viñetas.
- El copy es UN SOLO BLOQUE de texto fluido.
- NO añadas etiquetas como "Copy:", "Texto:", "Anuncio:" — solo el copy puro.

CUENTA LAS PALABRAS antes de responder y ajusta para caer EXACTO en el rango ${length.min}-${length.max} palabras.

Devuelve ÚNICAMENTE el copy final, sin nada más.`;
}

// ── AI call dispatch (mirror of descriptions.js pattern) ─────────
async function callAI(provider, modelId, apiKey, prompt) {
  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: SYS_COPY },
          { role: 'user',   content: prompt },
        ],
        max_tokens: 600,
        temperature: 0.8,
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
      body: JSON.stringify({ model: modelId, max_tokens: 600, system: SYS_COPY, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic error ${r.status}`);
    return d.content[0].text;
  }
  if (provider === 'google') {
    // Gemini 2.5 models use "thinking tokens" that consume the output budget.
    // 2.5 Pro needs a generous limit or it returns empty parts with finishReason=MAX_TOKENS.
    const isThinking25 = /^gemini-(2\.5|3)/.test(modelId);
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYS_COPY}\n\n${prompt}` }] }],
          generationConfig: { maxOutputTokens: isThinking25 ? 4096 : 600 },
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
  throw new Error('Proveedor no soportado');
}

module.exports = router;
