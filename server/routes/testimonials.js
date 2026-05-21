const express = require('express');
const { products, product_research, product_testimonials, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callKie } = require('../lib/kie');

const router = express.Router();
router.use(requireAuth);

// ── Model registry (same as other AI routes) ────────────────────
const MODELS = {
  'gpt-4.1':                   { provider: 'openai',    label: 'GPT-4.1',           key_field: 'openai_key' },
  'gpt-4.1-mini':              { provider: 'openai',    label: 'GPT-4.1 mini',      key_field: 'openai_key' },
  'gpt-4o':                    { provider: 'openai',    label: 'GPT-4o',            key_field: 'openai_key' },
  'gpt-4o-mini':               { provider: 'openai',    label: 'GPT-4o mini',       key_field: 'openai_key' },
  'claude-opus-4-7':           { provider: 'anthropic', label: 'Claude Opus 4.7',     key_field: 'claude_key' },
  'claude-sonnet-4-6':         { provider: 'anthropic', label: 'Claude Sonnet 4.6', key_field: 'claude_key' },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5',  key_field: 'claude_key' },
  'gemini-3.1-pro-preview':    { provider: 'google',    label: 'Gemini 3.1 Pro (preview)', key_field: 'gemini_key' },
  'gemini-3-flash-preview':    { provider: 'google',    label: 'Gemini 3 Flash (preview)', key_field: 'gemini_key' },
  'gemini-3.1-flash-lite':     { provider: 'google',    label: 'Gemini 3.1 Flash Lite',    key_field: 'gemini_key' },
  'gemini-2.5-pro':            { provider: 'google',    label: 'Gemini 2.5 Pro',           key_field: 'gemini_key' },
  'gemini-2.5-flash':          { provider: 'google',    label: 'Gemini 2.5 Flash',         key_field: 'gemini_key' },
  'kie:gpt-5-2':               { provider: 'kie',       label: 'GPT-5.2 (Kie.ai)',           key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':     { provider: 'kie',       label: 'Claude Sonnet 4.5 (Kie.ai)', key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':        { provider: 'kie',       label: 'Gemini 2.5 Pro (Kie.ai)',    key_field: 'kieai_key' },
};

const TONES = {
  casual:      'Tono casual y cercano, como un amigo. Usa abreviaciones naturales (xq, q, tb), algunos emojis sutiles.',
  enthusiastic:'Tono entusiasta y agradecido, el cliente está MUY feliz. Más emojis (😍🙌✨), exclamaciones.',
  formal:      'Tono más formal pero amable. Sin abreviaciones excesivas, pocos o ningún emoji.',
};

const LANGUAGES = {
  es: { name: 'Español neutro de Latinoamérica', sample: 'Hola, me llegó el pedido' },
  pt: { name: 'Português do Brasil',              sample: 'Oi, recebi meu pedido' },
  en: { name: 'English',                          sample: 'Hi, got my order' },
};

// ── GET /api/testimonials — products with testimonial counts ────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    testimonial_count: (product_testimonials.forProduct(p.id) || []).length,
    research_count:    products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/testimonials/:id — product + testimonials ──────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:      p,
    testimonials: product_testimonials.forProduct(p.id),
    research:     product_research.forProduct(p.id),
  });
});

// ── POST /api/testimonials/:id/generate ─────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const {
    model_id,
    contact_name,            // support contact name shown in the header (e.g. "Soporte EcomMagic")
    customer_name,           // optional, otherwise AI picks one
    tone     = 'casual',
    language = 'es',
    msg_count = 6,           // target number of messages (3 short / 6 medium / 9 long)
    extra_context = '',
    date,                    // YYYY-MM-DD, used by frontend day-divider
  } = req.body;

  const safeDate = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : null;

  if (!TONES[tone])           return res.status(400).json({ error: 'Tono inválido' });
  if (!LANGUAGES[language])   return res.status(400).json({ error: 'Idioma inválido' });

  const modelDef = MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });
  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  // Use latest research as context if available
  const research = product_research.forProduct(p.id)[0];
  const safeMsgCount = Math.max(4, Math.min(14, Number(msg_count) || 8));

  const prompt = buildPrompt({
    productName:   p.name,
    research:      research?.content || '',
    contactName:   contact_name || 'Soporte de la Tienda',
    customerName:  customer_name || '',
    tone,
    language,
    msgCount:      safeMsgCount,
    extraContext:  extra_context,
  });

  let raw;
  try {
    if (modelDef.provider === 'kie') {
      raw = await callKie({ apiKey, modelId: model_id, sysMsg: SYS, userPrompt: prompt, maxTokens: 1200, temperature: 0.85 });
    } else {
      raw = await callAI(modelDef.provider, model_id, apiKey, prompt);
    }
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  // Parse JSON
  let parsed;
  try {
    const clean = String(raw).replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    return res.status(502).json({ error: 'La IA devolvió un formato inválido. Reintenta.' });
  }

  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return res.status(502).json({ error: 'La IA no devolvió mensajes válidos. Reintenta.' });
  }

  // Sanitize each message
  const messages = parsed.messages
    .filter(m => m && (m.role === 'customer' || m.role === 'support') && typeof m.text === 'string')
    .map(m => ({
      role: m.role,
      text: String(m.text).slice(0, 600),
      time: typeof m.time === 'string' && /^\d{1,2}:\d{2}$/.test(m.time) ? m.time : null,
    }));

  if (messages.length === 0) return res.status(502).json({ error: 'No se pudieron extraer mensajes válidos.' });

  // Auto-fill times if missing (10:00, 10:01, 10:03, ...)
  let baseH = 10, baseM = 0;
  messages.forEach((m, i) => {
    if (!m.time) {
      const offset = i * (1 + Math.floor(Math.random() * 2));
      const total = baseM + offset;
      const hh = String(baseH + Math.floor(total / 60)).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      m.time = `${hh}:${mm}`;
    }
  });

  const finalContact  = parsed.contact_name  || contact_name  || 'Soporte de la Tienda';
  const finalCustomer = parsed.customer_name || customer_name || '';

  const saved = product_testimonials.insert({
    product_id:    p.id,
    user_id:       req.user.id,
    contact_name:  finalContact,
    customer_name: finalCustomer,
    tone,
    language,
    messages,
    model:         modelDef.label,
    provider:      modelDef.provider,
    date:          safeDate,
  });

  res.json({
    id:            saved.id,
    contact_name:  finalContact,
    customer_name: finalCustomer,
    tone,
    language,
    messages,
    model:         modelDef.label,
    date:          safeDate,
  });
});

// ── DELETE /api/testimonials/:id/items/:tid ─────────────────────
router.delete('/:id/items/:tid', (req, res) => {
  const ok = product_testimonials.delete(req.params.tid, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Testimonio no encontrado' });
  res.json({ message: 'Testimonio eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────
const SYS = 'Eres un copywriter senior especializado en social proof y testimonios para e-commerce. Tu trabajo es generar conversaciones realistas de WhatsApp entre clientes satisfechos y el soporte de una tienda. Devuelves SIEMPRE un objeto JSON válido sin markdown, sin comentarios, sin texto adicional.';

function buildPrompt({ productName, research, contactName, customerName, tone, language, msgCount, extraContext }) {
  const langDef  = LANGUAGES[language];
  const toneDef  = TONES[tone];
  const researchCtx = research
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (úsala para que los comentarios del cliente suenen reales y específicos — extrae beneficios concretos, problemas que resuelve, y detalles del producto):\n\n${research.slice(0, 4000)}\n`
    : '';
  const customerLine = customerName
    ? `Nombre del cliente (úsalo si es natural): ${customerName}`
    : `Inventa un nombre realista para el cliente (en ${langDef.name}). Mujer u hombre, 25-55 años.`;
  const extraLine = extraContext ? `\nCONTEXTO EXTRA: ${extraContext}` : '';

  return `Genera una conversación de WhatsApp REALISTA entre un cliente satisfecho y el soporte de la tienda. El cliente acaba de recibir el producto (o lo lleva usando unos días) y deja comentarios positivos.

PRODUCTO: ${productName}
${researchCtx}
${customerLine}
NOMBRE DEL SOPORTE EN EL HEADER DEL CHAT: ${contactName}
IDIOMA: ${langDef.name}
TONO: ${toneDef}
CANTIDAD DE MENSAJES: ${msgCount} (entre cliente y soporte, alternados de forma natural)${extraLine}

LA CONVERSACIÓN DEBE CUBRIR (orgánicamente, NO como checklist):
1. La logística (rapidez de entrega, empaque, llegada en buen estado).
2. La calidad del producto (cómo se ve, se siente, materiales, presentación).
3. Cómo está resolviendo SU problema específico (beneficio concreto que el cliente experimentó).

REGLAS DE FORMATO DE LA CONVERSACIÓN:
- Mensajes CORTOS y NATURALES, como se escribe en WhatsApp real. Promedio 8-20 palabras por mensaje. Algunos pueden ser de 2-4 palabras.
- Mezcla mensajes del cliente y del soporte de forma orgánica. NO siempre alternar 1-1. A veces el cliente envía 2 mensajes seguidos.
- Empieza con el cliente saludando o comentando que llegó el pedido.
- Termina con un cierre cálido (cliente agradeciendo + soporte deseando lo mejor, o similar).
- El soporte responde con tono profesional pero cálido, agradece, pregunta cómo le está yendo.
- Usa errores tipográficos sutiles ocasionales (1-2 max en toda la conversación) — hace que se vea más real. Ej: "jaja" sin tilde, "porfa", "graciaa".
- Emojis: úsalos según el tono. Casual: 1-3 emojis total. Entusiasta: 3-6. Formal: 0-1.
- NUNCA uses claims médicos absolutos ("me curó", "100% efectivo"). El cliente describe su experiencia POSITIVA pero realista.
- Horarios (campo "time"): formato HH:MM 24h. Distribuye los mensajes en un rango de 5-15 minutos (ej. 10:23 → 10:34). NO todos al mismo segundo.

FORMATO DE SALIDA — devuelve EXACTAMENTE este JSON sin nada más:

{
  "contact_name": "${contactName}",
  "customer_name": "<nombre del cliente que inventaste o usé arriba>",
  "messages": [
    { "role": "customer", "text": "...", "time": "10:23" },
    { "role": "support",  "text": "...", "time": "10:24" },
    ...
  ]
}

- "role" debe ser exactamente "customer" o "support" (en inglés, en minúsculas).
- "text" debe estar en ${langDef.name}.
- El primer mensaje debe ser del cliente.
- Total: ${msgCount} mensajes.

Devuelve SOLO el JSON, nada más.`;
}

// ── AI call dispatch ─────────────────────────────────────────────
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
        max_tokens: 1200,
        temperature: 0.85,
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
      body: JSON.stringify({ model: modelId, max_tokens: 1200, system: SYS, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic error ${r.status}`);
    return d.content[0].text;
  }
  if (provider === 'google') {
    // Gemini 2.5 models use thinking tokens that consume the output budget.
    // 2.5 Pro needs a generous limit or it returns empty parts with finishReason=MAX_TOKENS.
    const isThinking25 = /^gemini-(2\.5|3)/.test(modelId);
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYS}\n\n${prompt}` }] }],
          generationConfig: { maxOutputTokens: isThinking25 ? 8192 : 1200, responseMimeType: 'application/json' },
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
