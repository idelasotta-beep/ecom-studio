const express = require('express');
const { products, product_research, product_audios, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callKie } = require('../lib/kie');

const router = express.Router();
router.use(requireAuth);

// ── Model registry ───────────────────────────────────────────────
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
  // Kie.ai — sólo modelos en formato Chat Completions / Messages.
  'kie:gpt-5-2':              { provider: 'kie', label: 'GPT-5.2 (Kie.ai)',              key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':    { provider: 'kie', label: 'Claude Sonnet 4.5 (Kie.ai)',    key_field: 'kieai_key' },
  'kie:claude-opus-4-5':      { provider: 'kie', label: 'Claude Opus 4.5 (Kie.ai)',      key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':       { provider: 'kie', label: 'Gemini 2.5 Pro (Kie.ai)',       key_field: 'kieai_key' },
};

const VOICE_TYPES = ['sensual', 'profesional', 'testimonial'];
const CATEGORIES  = ['salud', 'belleza', 'fitness', 'bienestar_intimo'];
const COUNTRIES   = {
  cl: 'Chile',
  mx: 'México',
  ar: 'Argentina',
  co: 'Colombia',
  pe: 'Perú',
  es: 'España',
  nu: 'Neutral',
};

// ── GET /api/audios — products with audio counts ─────────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    audio_count:    products.audioCount(p.id),
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── GET /api/audios/:id — product + audios + research ────────────
router.get('/:id', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:  p,
    audios:   product_audios.forProduct(p.id),
    research: product_research.forProduct(p.id),
  });
});

// ── POST /api/audios/:id/generate ────────────────────────────────
router.post('/:id/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, voice_type, category, country = 'cl', extra_info, research_id } = req.body;

  if (!VOICE_TYPES.includes(voice_type))
    return res.status(400).json({ error: 'Tipo de voz inválido. Usa: sensual, profesional o testimonial.' });
  if (!CATEGORIES.includes(category))
    return res.status(400).json({ error: 'Categoría inválida. Usa: salud, belleza, fitness o bienestar_intimo.' });

  const modelDef = MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  // Pick the research entry to use as context: explicit research_id wins,
  // otherwise fall back to the latest (most recent) research for this product.
  const allResearch = product_research.forProduct(p.id);
  let chosen = null;
  if (research_id) {
    chosen = allResearch.find(r => String(r.id) === String(research_id)) || null;
  }
  if (!chosen) chosen = allResearch[0] || null;

  const prompt = buildPrompt({
    productName:    p.name,
    research:       chosen?.content || '',
    researchTitle:  chosen?.title   || '',
    voiceType:      voice_type,
    category,
    country,
    extraInfo:      extra_info || '',
  });

  let raw;
  try {
    raw = await callAI(modelDef.provider, model_id, apiKey, prompt);
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  // The output is the script itself (just the audio text). Trim whitespace.
  const script = (raw || '').trim();

  const r = product_audios.insert({
    product_id: p.id,
    user_id:    req.user.id,
    script,
    voice_type,
    category,
    country,
    model:      modelDef.label,
    provider:   modelDef.provider,
  });

  res.json({
    id:         r.id,
    script,
    voice_type,
    category,
    country,
    model:      modelDef.label,
  });
});

// ── DELETE /api/audios/:id/:audioId ──────────────────────────────
router.delete('/:id/:audioId', (req, res) => {
  const ok = product_audios.delete(req.params.audioId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Audio no encontrado' });
  res.json({ message: 'Audio eliminado' });
});

// ── Prompt builder ───────────────────────────────────────────────
const VOICE_GUIDE = {
  sensual:     `🔥 VOZ SENSUAL\n- Voz femenina cálida y suave.\n- Sensualidad natural y elegante.\n- Tono cercano, confidencial, como en secreto.\n- Ritmo pausado, con respiraciones sutiles (insinuadas con comas y puntos).`,
  profesional: `🎓 VOZ PROFESIONAL\n- Voz clara, tranquila y segura.\n- Tono de asesoría honesta.\n- Lenguaje respetuoso y cercano, sin tecnicismos rebuscados.`,
  testimonial: `💬 VOZ TESTIMONIAL\n- Voz espontánea y humana.\n- Lenguaje cotidiano del país elegido.\n- Sensación de experiencia real, como amiga contando algo.`,
};

const CATEGORY_GUIDE = {
  salud: `🩺 SALUD\n- Lenguaje responsable y cuidadoso.\n- Usa expresiones como "me ha tocado ver", "en el día a día".\n- NUNCA prometer curas ni resultados médicos.`,
  belleza: `✨ BELLEZA\n- Lenguaje positivo y delicado.\n- Expresiones suaves: "se nota harto", "queda la piel súper rica".`,
  fitness: `💪 FITNESS\n- Tono motivador, sin presión.\n- Expresiones: "de a poco", "sin volverse loco".`,
  bienestar_intimo: `🌸 BIENESTAR ÍNTIMO\n- Lenguaje respetuoso, privado y empático.\n- Normaliza con frases como "a muchas nos pasa", "es más común de lo que uno cree".`,
};

const COUNTRY_GUIDE = {
  cl: `País: CHILE.\n- Usa modismos chilenos naturales: "te cuento al tiro", "harto", "súper", "po", "fíjate", "ojito".\n- Evita lenguaje neutro latino — debe sonar como una chilena hablando.`,
  mx: `País: MÉXICO.\n- Usa modismos mexicanos naturales: "fíjate que", "neta", "mira", "ándale", "te platico".\n- Tono mexicano cálido, sin lenguaje neutro.`,
  ar: `País: ARGENTINA.\n- Usa voseo y modismos argentinos: "mirá", "te cuento", "che", "re bueno", "una banda".\n- Tono porteño cálido, sin lenguaje neutro.`,
  co: `País: COLOMBIA.\n- Usa modismos colombianos naturales: "parce", "vea pues", "súper bacano", "le cuento".\n- Tono cálido colombiano, sin lenguaje neutro.`,
  pe: `País: PERÚ.\n- Usa modismos peruanos naturales: "oye", "fíjate", "está bacán", "chévere".\n- Tono cálido peruano, sin lenguaje neutro.`,
  es: `País: ESPAÑA.\n- Usa expresiones españolas: "mira", "vamos", "te cuento", "fíjate", "vale".\n- Tono español cálido, sin lenguaje neutro latino.`,
  nu: `País: NEUTRAL (castellano internacional).
- NO uses modismos ni regionalismos de ningún país específico.
- Evita expresiones marcadamente locales como "po", "che", "vale", "parce", "ándale", "neta", "bacán", "guay", "tío/tía", voseo argentino, vosotros español, etc.
- Usa palabras comunes y universalmente comprensibles del castellano: "mira", "te cuento", "fíjate", "imagina", "te explico".
- Conjuga en segunda persona singular usando "tú" (no "usted" ni "vos" ni "vosotros").
- Tono cálido y cercano pero sin acento ni cultura regional identificable.
- El audio debe sonar natural a oídos de un hispanohablante de cualquier país.`,
};

function buildPrompt({ productName, research, researchTitle, voiceType, category, country, extraInfo }) {
  const ctx = research
    ? `🔬 INVESTIGACIÓN BASE DEL PRODUCTO ${researchTitle ? `(${researchTitle})` : ''}
Úsala como fuente de verdad sobre el producto: extrae beneficios concretos, dolores reales del cliente, mecanismo de acción, modo de uso, avatar, objeciones y testimonios sugeridos. NO copies texto literal — destila la esencia y aplícala al estilo de nota de voz. Cualquier dato específico (ingredientes, modo de uso, beneficios, dolores) que menciones en el audio debe salir de aquí, no inventarse.

${research.slice(0, 9000)}

`
    : '';
  const extra = extraInfo
    ? `\n\n📝 INFORMACIÓN EXTRA APORTADA POR EL OPERADOR (úsala como contexto puntual de la conversación, ej. la duda específica del cliente):\n${extraInfo}\n`
    : '';

  return `🎧 PROMPT MAESTRO – AUDIO WHATSAPP (ELEVENLABS READY)

🧠 ROL
Eres un especialista en atención al cliente conversacional, neuromarketing y persuasión humana, con experiencia en ventas 1 a 1 por WhatsApp. Creas audios breves, naturales y creíbles, como notas de voz reales grabadas en el momento por una asesora real. El audio NO suena a publicidad, NO vende, NO presiona. Acompaña, aclara y genera confianza.

🟢 CONTEXTO OBLIGATORIO
- El cliente ya recibió imágenes y textos del producto por WhatsApp.
- El audio es una respuesta dentro de una conversación real.
- El cliente está interesado pero aún tiene dudas normales.
- Hablas como persona real, no como marca.

🟢 PRODUCTO
${productName}

${ctx}${extra}

🎙️ CONFIGURACIÓN DE VOZ (APLICA ESTRICTO)
${VOICE_GUIDE[voiceType]}

🧠 ADAPTACIÓN POR CATEGORÍA
${CATEGORY_GUIDE[category]}

🌎 ADAPTACIÓN POR PAÍS
${COUNTRY_GUIDE[country] || COUNTRY_GUIDE.cl}

🧠 ESTRUCTURA DEL GUION (escribe como nota de voz real, en este orden, sin enumerarlas)
1. Entrada natural — "Mira, te cuento al tiro…", "A propósito de lo que viste recién…", "Te explico cortito…".
2. Empatía real — valida la duda con expresiones del país: "es normal tener dudas", "a varias personas les pasa".
3. Refuerzo de beneficios — sin repetir lo que ya vio en imágenes; explica "en simple".
4. Testimonio indirecto — "harta gente me ha comentado que…", "varias clientas me dijeron que…".
5. Tranquilidad y confianza — "la idea es que te sientas tranquila", "no es algo complicado".
6. Cierre abierto — "cualquier cosa me dices", "yo feliz te ayudo".

⏱️ DURACIÓN Y FORMATO ELEVENLABS
- MÁXIMO 1 minuto de audio (aprox. 130-160 palabras).
- Texto continuo, sin títulos, sin numeración, sin viñetas.
- Frases cortas y habladas. Pausas implícitas con comas y puntos.
- Listo para copiar y pegar en ElevenLabs.
- NO agregar emojis, paréntesis ni aclaraciones.

🚫 PROHIBICIONES ABSOLUTAS
El guion NO debe:
- Vender explícitamente.
- Cerrar la venta.
- Sonar a anuncio.
- Mencionar: ofertas, descuentos, envíos, pagos, urgencia comercial.
- Usar lenguaje neutro latino — debe sonar 100% del país elegido.

🎯 SALIDA
Devuelve ÚNICAMENTE el guion del audio — texto continuo, listo para pegar en ElevenLabs. Nada más. Sin encabezados, sin comillas, sin notas, sin "Aquí tienes:" ni similares. Solo el guion.`;
}

// ── AI call ──────────────────────────────────────────────────────
const SYS = 'Eres un copywriter conversacional experto en notas de voz para WhatsApp en mercados hispanohablantes. Devuelves siempre el guion final como texto continuo, listo para usar en ElevenLabs, sin meta-comentarios.';

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
        max_tokens: 1500,
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
      body: JSON.stringify({ model: modelId, max_tokens: 1500, system: SYS, messages: [{ role: 'user', content: prompt }] }),
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
          generationConfig: { maxOutputTokens: isThinking25 ? 8192 : 1500 },
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
    return callKie({ apiKey, modelId, sysMsg: SYS, userPrompt: prompt, maxTokens: 1500, temperature: 0.85 });
  }
  throw new Error('Proveedor no soportado');
}

module.exports = router;
