const express = require('express');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');
const { products, product_research, product_angles, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callKie } = require('../lib/kie');
const { ICON_KEYS } = require('../lib/shopify-section-builder');

const router = express.Router();
router.use(requireAuth);

// Node's default fetch (undici) aborts after 5 min waiting for response headers.
// Long, non-streaming AI calls (Claude Opus 4.7, Sonnet 4.6 on 30-section research)
// can take 7-10 min before the first byte arrives. This agent extends the limit to 15 min.
const longRunningAgent = new UndiciAgent({
  headersTimeout: 15 * 60 * 1000, // 15 min waiting for response headers
  bodyTimeout:    15 * 60 * 1000, // 15 min waiting for body to finish
  connectTimeout: 30 * 1000,      // 30s to establish connection
});

// ── Model registry ───────────────────────────────────────────────
const MODELS = {
  // OpenAI
  'gpt-4.1':                  { provider: 'openai',    label: 'GPT-4.1',                     key_field: 'openai_key' },
  'gpt-4.1-mini':             { provider: 'openai',    label: 'GPT-4.1 mini',                 key_field: 'openai_key' },
  'gpt-4.1-nano':             { provider: 'openai',    label: 'GPT-4.1 nano',                 key_field: 'openai_key' },
  'gpt-4o':                   { provider: 'openai',    label: 'GPT-4o',                       key_field: 'openai_key' },
  'gpt-4o-mini':              { provider: 'openai',    label: 'GPT-4o mini',                  key_field: 'openai_key' },
  'o3':                       { provider: 'openai',    label: 'o3',                           key_field: 'openai_key' },
  'o4-mini':                  { provider: 'openai',    label: 'o4-mini',                      key_field: 'openai_key' },
  // Anthropic
  'claude-opus-4-7':           { provider: 'anthropic', label: 'Claude Opus 4.7',             key_field: 'claude_key' },
  'claude-sonnet-4-6':         { provider: 'anthropic', label: 'Claude Sonnet 4.6',           key_field: 'claude_key' },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5',            key_field: 'claude_key' },
  // Google
  'gemini-3.1-pro-preview':    { provider: 'google',    label: 'Gemini 3.1 Pro (preview)',    key_field: 'gemini_key' },
  'gemini-3-flash-preview':    { provider: 'google',    label: 'Gemini 3 Flash (preview)',    key_field: 'gemini_key' },
  'gemini-3.1-flash-lite':     { provider: 'google',    label: 'Gemini 3.1 Flash Lite',       key_field: 'gemini_key' },
  'gemini-2.5-pro':            { provider: 'google',    label: 'Gemini 2.5 Pro',              key_field: 'gemini_key' },
  'gemini-2.5-flash':          { provider: 'google',    label: 'Gemini 2.5 Flash',            key_field: 'gemini_key' },
  'gemini-2.0-flash':          { provider: 'google',    label: 'Gemini 2.0 Flash',            key_field: 'gemini_key' },
  // Kie.ai — sólo modelos en formato Chat Completions / Messages.
  // (gpt-5-4 y gpt-5-5 usan Responses API, otra arquitectura — no soportados aquí.)
  // Kie.ai 2026 frontier
  'kie:claude-opus-4-7':        { provider: 'kie', label: 'Claude Opus 4.7 (Kie.ai)',          key_field: 'kieai_key' },
  'kie:claude-sonnet-4-6':      { provider: 'kie', label: 'Claude Sonnet 4.6 (Kie.ai)',        key_field: 'kieai_key' },
  'kie:gemini-3.1-pro':         { provider: 'kie', label: 'Gemini 3.1 Pro (Kie.ai)',           key_field: 'kieai_key' },
  'kie:gemini-3-pro':           { provider: 'kie', label: 'Gemini 3 Pro (Kie.ai)',             key_field: 'kieai_key' },
  // Kie.ai legacy
  'kie:gpt-5-2':               { provider: 'kie', label: 'GPT-5.2 (Kie.ai)',                  key_field: 'kieai_key' },
  'kie:claude-sonnet-4-5':     { provider: 'kie', label: 'Claude Sonnet 4.5 (Kie.ai)',        key_field: 'kieai_key' },
  'kie:claude-opus-4-5':       { provider: 'kie', label: 'Claude Opus 4.5 (Kie.ai)',          key_field: 'kieai_key' },
  'kie:gemini-2.5-pro':        { provider: 'kie', label: 'Gemini 2.5 Pro (Kie.ai)',           key_field: 'kieai_key' },
};

// ── GET /api/products ────────────────────────────────────────────
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    research_count: products.researchCount(p.id),
  }));
  res.json({ products: list });
});

// ── POST /api/products ───────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, description, image } = req.body;
  if (!name || !name.trim())
    return res.status(400).json({ error: 'El nombre del producto es requerido' });
  const result = products.insert({ user_id: req.user.id, name: name.trim(), description, image: image || null });
  const p = products.one({ id: result.id });
  res.status(201).json({ product: { ...p, research_count: 0 } });
});

// ── PUT /api/products/:id ────────────────────────────────────────
router.put('/:id', (req, res) => {
  const { name, description, image } = req.body;
  const changes = { name, description };
  if (image !== undefined) changes.image = image || null;
  const ok = products.update(req.params.id, req.user.id, changes);
  if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ message: 'Producto actualizado' });
});

// ── DELETE /api/products/:id ─────────────────────────────────────
router.delete('/:id', (req, res) => {
  const ok = products.delete(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ message: 'Producto eliminado' });
});

// ── GET /api/products/:id/research ──────────────────────────────
router.get('/:id/research', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ product: p, research: product_research.forProduct(p.id) });
});

// ── POST /api/products/:id/research/generate ─────────────────────
router.post('/:id/research/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, product_info } = req.body;
  if (!product_info || !product_info.trim())
    return res.status(400).json({ error: 'La información del producto es requerida' });

  const modelDef = MODELS[model_id];
  if (!modelDef)
    return res.status(400).json({ error: 'Modelo de IA no válido' });

  // Get user API key
  const settings = user_settings.get(req.user.id);
  const apiKey = settings && settings[modelDef.key_field];
  if (!apiKey)
    return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  const prompt = buildPrompt(p.name, product_info.trim());

  let content;
  try {
    content = await callAI(modelDef.provider, model_id, apiKey, prompt);
  } catch (err) {
    // Log the full error to server console so we can see the real cause (err.cause is hidden by undici)
    console.error(`[products/research] AI call failed | model=${model_id} provider=${modelDef.provider}`);
    console.error('  err.message:', err.message);
    if (err.cause) {
      console.error('  err.cause:', err.cause.code || err.cause.message || err.cause);
    }
    if (err.stack) console.error('  stack:', err.stack.split('\n').slice(0, 5).join('\n'));
    const causeStr = err.cause ? ` (${err.cause.code || err.cause.message || 'sin detalles'})` : '';
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}${causeStr}` });
  }

  // Save research
  const r = product_research.insert({
    product_id: p.id,
    user_id:    req.user.id,
    title:      `Investigación de producto profesional`,
    content,
    model:      modelDef.label,
    provider:   modelDef.provider,
  });

  res.json({ id: r.id, content, model: modelDef.label });
});

// ── POST /api/products/:id/research (manual save) ────────────────
router.post('/:id/research', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const { title, content } = req.body;
  if (!title || !content)
    return res.status(400).json({ error: 'title y content son requeridos' });
  const r = product_research.insert({ product_id: p.id, user_id: req.user.id, title, content });
  res.status(201).json({ id: r.id, message: 'Investigación guardada' });
});

// ── DELETE /api/products/:id/research/:rid ───────────────────────
router.delete('/:id/research/:rid', (req, res) => {
  const ok = product_research.delete(req.params.rid, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Investigación no encontrada' });
  res.json({ message: 'Investigación eliminada' });
});

// ── GET /api/products/:id/angles ─────────────────────────────────
router.get('/:id/angles', (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({
    product:  p,
    research: product_research.forProduct(p.id),
    angles:   product_angles.forProduct(p.id),
  });
});

// ── POST /api/products/:id/angles/generate ───────────────────────
router.post('/:id/angles/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, research_id } = req.body;
  const modelDef = MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey)
    return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  if (research_id) {
    const list = product_research.forProduct(p.id);
    const r    = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  }

  const prompt = buildAnglesPrompt(p.name, researchContent);

  let content;
  try {
    content = await callAI(modelDef.provider, model_id, apiKey, prompt, SYS_ANGLES);
  } catch (err) {
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  const a = product_angles.insert({
    product_id: p.id,
    user_id:    req.user.id,
    content,
    model:      modelDef.label,
    provider:   modelDef.provider,
  });

  res.json({ id: a.id, content, model: modelDef.label, provider: modelDef.provider });
});

// ── DELETE /api/products/:id/angles/:angId ───────────────────────
router.delete('/:id/angles/:angId', (req, res) => {
  const ok = product_angles.delete(req.params.angId, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Ángulos no encontrados' });
  res.json({ message: 'Ángulos eliminados' });
});

// ── POST /api/products/:id/generate-faqs ─────────────────────────
// Generates an array of FAQs `[{q, a}, ...]` for the product using the
// research already saved for it (latest one) as context. Used by the
// FAQ element in the landing builder.
// Body: { model_id?, count?, research_id? }
router.post('/:id/generate-faqs', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id } = req.body || {};
  const safeCount = Math.min(12, Math.max(3, Number(count) || 5));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';   // fast + cheap default
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  // Pick research content: explicit research_id > latest research > empty
  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const prompt = buildFaqsPrompt(p.name, researchContent, safeCount);

  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_FAQS);
  } catch (err) {
    console.error(`[products/generate-faqs] AI call failed:`, err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }

  const questions = parseFaqsJson(raw);
  if (!questions || !questions.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido de FAQs.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({ questions, model: modelDef.label, provider: modelDef.provider });
});

// ── AI helpers ───────────────────────────────────────────────────
function buildPrompt(productName, info) {
  return `Eres un experto estratega de marketing digital, psicología del consumidor y copywriting con más de 15 años de experiencia en mercados hispanohablantes (México, Colombia, Argentina, España, Chile, Perú). Tu especialidad es crear investigaciones de producto profundas que revelan los mecanismos psicológicos detrás de la decisión de compra.

Genera una INVESTIGACIÓN DE PRODUCTO PROFESIONAL COMPLETA Y EXHAUSTIVA para el siguiente producto:

NOMBRE DEL PRODUCTO: ${productName}

INFORMACIÓN DEL PRODUCTO (puede estar en cualquier idioma y formato — extrae todo lo relevante):
${info}

---

INSTRUCCIONES CRÍTICAS DE FORMATO:
- Usa EXACTAMENTE los 30 encabezados numerados que se indican abajo (## 01. Título, ## 02. Título, etc.)
- Cada sección debe comenzar con el encabezado en formato ## NN. Título
- Inmediatamente debajo del encabezado escribe el subtítulo de la sección en cursiva (entre asteriscos simples: *subtítulo*)
- Cada sección debe tener contenido DENSO, ESPECÍFICO y EXHAUSTIVO — mínimo 200 palabras por sección
- Usa lenguaje coloquial hispanohablante natural y profesional
- Incluye ejemplos concretos, frases textuales listas para usar en anuncios, bullets detallados
- Enfócate en los mercados: México, Colombia, Argentina, España y Chile principalmente

INSTRUCCIONES CRÍTICAS DE COMPLETITUD — LEE ESTO ANTES DE EMPEZAR:
- Debes generar las 30 secciones COMPLETAS. No te detengas en la sección 9, 15, 20, ni en ninguna otra.
- ANTES de terminar tu respuesta, CUENTA mentalmente los encabezados ## que escribiste. Si no llegaste a "## 30. Públicos Objetivos", VUELVE Y COMPLETA las secciones que faltan.
- La sección 30 ("## 30. Públicos Objetivos") DEBE ser la última que escribas. Esa es tu señal de finalización.
- Si necesitas ser más conciso para llegar a las 30 secciones, hazlo: prefiere 100 palabras en TODAS las secciones que 200 palabras en solo la mitad.
- NUNCA omitas secciones, NUNCA terminés antes de la sección 30, NUNCA escribas "(continuaré después)" o frases similares.

## 01. Nombre y Descripción del Producto
*Nombre comercial del producto, tipo de producto y descripción general de sus características principales.*
Proporciona el nombre comercial exacto o recomendado para mercados hispanohablantes. Describe de forma completa qué es el producto: su naturaleza, composición o tecnología principal, cómo funciona, en qué categoría se clasifica, para qué situaciones fue creado y cuál es su función primaria. Incluye formato, presentación, variantes disponibles y cualquier característica física relevante.

## 02. Promesa Central del Producto
*La transformación o resultado principal que el producto promete al usuario de forma realista.*
Identifica y articula la promesa más poderosa y creíble que puede hacer este producto. Define la transformación concreta: qué cambia en la vida del usuario, en cuánto tiempo, con qué nivel de certeza. Redacta 3 versiones de la promesa central: una larga (párrafo completo), una media (2-3 oraciones) y una corta (slogan de 10-15 palabras). Explica por qué esta promesa es creíble y realista basándote en el mecanismo del producto.

## 03. Beneficios Específicos
*Listado completo de todos los beneficios: físicos, estéticos, funcionales y emocionales. Sin límite de cantidad.*
Lista todos los beneficios concretos que el producto entrega. Organízalos en categorías: **Beneficios funcionales** (qué hace el producto de forma práctica), **Beneficios físicos o estéticos** (cambios observables en el cuerpo o apariencia), **Beneficios emocionales** (cómo hace sentir al usuario), **Beneficios sociales** (cómo mejora la percepción de los demás). Para cada beneficio, describe la transformación específica y un ejemplo de cómo se manifiesta en la vida real del cliente. Mínimo 10-12 beneficios detallados.

## 04. Características Clave del Producto
*Todos los datos técnicos, ingredientes, materiales, tamaños, funciones, componentes, formatos, etc.*
Detalla todas las características técnicas del producto: ingredientes activos o componentes principales, materiales, dimensiones, peso, presentación, concentraciones, tecnologías utilizadas, certificaciones o avales, instrucciones básicas de uso, condiciones de almacenamiento, origen o fabricación. Si hay múltiples versiones o SKUs, describe cada uno. Incluye todo dato técnico relevante que un comprador informado querría saber antes de tomar una decisión.

## 05. Tipo de Solución
*Qué tipo de solución representa: preventiva, correctiva, de mantenimiento, alivio inmediato, optimización u otra.*
Clasifica y explica el tipo de solución que ofrece el producto. Determina si es: preventiva (evita que ocurra un problema), correctiva (arregla un problema existente), de mantenimiento (sostiene un estado deseado), de alivio inmediato (calma síntomas rápidamente), de optimización (mejora algo que ya funciona), transformacional (cambia radicalmente una situación) o una combinación. Explica las implicaciones de este tipo de solución para el marketing: qué tipo de urgencia genera, cómo se debe comunicar, qué expectativas establece en el consumidor.

## 06. Mecanismo Diferencial Funcional
*Cómo funciona el producto y qué lo hace diferente o más eficaz frente a otras opciones.*
Explica el mecanismo de acción del producto paso a paso: qué ocurre desde el momento en que se usa hasta que se obtiene el resultado. Identifica el mecanismo único o diferencial que hace a este producto superior o distinto a otras soluciones del mercado. Describe qué ingredientes, tecnologías o métodos son responsables del resultado. Compara brevemente con las alternativas más comunes y explica por qué este producto es más eficaz, conveniente o adecuado.

## 07. Problemas que Resuelve
*Todos los problemas, frustraciones o dificultades que el producto ayuda a resolver.*
Lista de forma exhaustiva todos los problemas que este producto resuelve directa e indirectamente. Para cada problema: describe el problema con detalle y especificidad, explica cómo impacta la vida diaria del usuario (tiempo perdido, dinero gastado, malestar físico o emocional, impacto social), qué soluciones ha intentado antes sin éxito y por qué fallaron. Incluye frases textuales que el cliente usaría para describir cada problema — estas son las palabras exactas para los anuncios.

## 08. Anhelos o Deseos del Consumidor
*Deseos profundos y aspiraciones del usuario: cómo quiere verse, sentirse o ser percibido.*
Identifica los deseos más profundos y aspiraciones del consumidor ideal de este producto. Va más allá del beneficio funcional: qué quiere lograr en términos de identidad, estatus social, autoconfianza, relaciones o calidad de vida. Para cada deseo: describe qué quiere específicamente, cómo imagina su vida una vez que lo logre, qué le diría a sus amigos o familia, qué emoción positiva busca experimentar. Incluye frases textuales en primera persona que el cliente pensaría o diría — estas son las palabras para los anuncios de aspiración.

## 09. Dolores Profundos del Consumidor
*Frustraciones y dificultades profundas que experimenta el usuario y que el producto soluciona.*
Profundiza en los dolores emocionales y psicológicos más intensos del consumidor, más allá del problema funcional superficial. Identifica: la frustración acumulada de no haber encontrado solución, el impacto en su autoestima o confianza, cómo este dolor afecta sus relaciones o vida social, la vergüenza o incomodidad que genera en situaciones cotidianas, el cansancio de haber probado muchas soluciones sin resultado. Para cada dolor: describe su intensidad, frecuencia y consecuencias emocionales. Incluye las frases internas que el consumidor se dice a sí mismo.

## 10. Miedos Ocultos del Consumidor
*Preocupaciones internas que el consumidor no expresa pero influyen en su decisión de compra.*
Identifica los miedos no expresados que influyen en la decisión de compra. Estos son los pensamientos que el consumidor raramente dice en voz alta pero que frenan la acción. Ejemplos típicos: miedo a que no funcione para mí específicamente, miedo a ser juzgado por necesitar este producto, miedo al fraude o producto de baja calidad, miedo a la dependencia o efectos secundarios, miedo a gastar dinero sin resultados, miedo al cambio o a la incomodidad del proceso. Para cada miedo: cómo se manifiesta en el comportamiento de compra y cómo neutralizarlo en el mensaje de marketing.

## 11. Resultado Principal Deseado
*El resultado final más importante que el usuario realmente quiere lograr con el producto.*
Define con precisión el resultado final más deseado — no el beneficio superficial sino el resultado de vida profundo que el consumidor busca. Distingue entre: el resultado funcional inmediato (lo que el producto hace), el resultado experiencial (cómo se siente el usuario durante el uso), el resultado de transformación (el cambio sostenido en el tiempo) y el resultado de identidad (en quién se convierte el usuario). Describe cómo este resultado impacta en las áreas más importantes de su vida: relaciones, trabajo, salud, autoestima, vida social.

## 12. Tipo de Transformación
*Qué tipo de transformación ofrece: física, estética, funcional, emocional o combinación.*
Clasifica y describe en profundidad el tipo de transformación que ofrece el producto. Determina el nivel de transformación en cada dimensión: **Física** (cambios observables en el cuerpo o salud), **Estética** (mejora en apariencia o imagen), **Funcional** (capacidades o desempeño mejorado), **Emocional** (estados internos y bienestar psicológico), **Social** (cómo impacta en las relaciones e imagen ante los demás), **Identitaria** (cómo cambia la percepción de uno mismo). Explica qué tan profunda y duradera es esta transformación, y qué evidencias la demuestran.

## 13. Transformación de Antes y Después
*Cómo está o se siente el usuario ANTES de usar el producto y cómo estaría o se sentiría DESPUÉS.*
Describe de forma vívida y específica el contraste entre la situación antes y después del producto. El ANTES: estado físico, emocional y situacional del usuario, sus limitaciones diarias, cómo se siente al despertar cada mañana, situaciones en que sufre o se incomoda por el problema, cómo este problema lo limita en sus relaciones, trabajo o actividades. El DESPUÉS: cómo luce o se siente físicamente, qué situaciones ahora disfruta que antes evitaba, qué comentarios recibe de su entorno, cómo ha cambiado su confianza y autoestima, qué nuevas posibilidades se abren en su vida. Escribe este contraste en primera persona para usarlo directamente en anuncios.

## 14. Naturaleza del Valor
*Tipo de valor que entrega: ahorro de tiempo, dinero, comodidad, mejora estética o bienestar.*
Analiza en profundidad la naturaleza del valor que entrega el producto. Cuantifica cuando sea posible: cuánto tiempo ahorra, cuánto dinero economiza o genera, qué nivel de comodidad proporciona, qué mejoras estéticas produce, qué impacto en bienestar físico o mental genera. Identifica el tipo de valor más resonante para el consumidor de este producto (no siempre es el mismo para todos). Explica cómo comunicar este valor de forma tangible y creíble en los mensajes de marketing.

## 15. Modo de Uso
*Cómo se utiliza o aplica el producto, frecuencia y cómo se integra en la rutina diaria.*
Describe el protocolo de uso completo: paso a paso de cómo usar el producto, frecuencia de uso (diario, semanal, por situación), cantidad o dosis recomendada, momento óptimo del día o situación para usarlo, cómo integrarlo en la rutina existente del usuario, cuándo se empiezan a notar los primeros resultados, cuándo se alcanzan resultados óptimos, cómo mantener los resultados a largo plazo. Incluye tips de uso que maximicen la efectividad y que puedan usarse como contenido de valor.

## 16. Errores de Uso
*Errores comunes al usar este tipo de producto que podrían impedir buenos resultados.*
Identifica los errores más frecuentes que cometen los usuarios de este tipo de producto y que impiden obtener los resultados esperados. Para cada error: describe qué hace el usuario incorrectamente, por qué ocurre ese error (por falta de información, malos hábitos, expectativas incorrectas), qué consecuencias tiene en los resultados, y cómo corregirlo. Este contenido es valioso para educar al comprador antes de la venta (aumenta la confianza) y después de la venta (mejora satisfacción y reduce devoluciones).

## 17. Restricciones y Advertencias
*Advertencias éticas, regulatorias o limitaciones importantes del producto.*
Detalla todas las restricciones, contraindicaciones y advertencias relevantes del producto: para quién NO es recomendable, condiciones médicas o situaciones en que no debe usarse, interacciones con otros productos o medicamentos, advertencias de seguridad, limitaciones de resultados (no funciona en todos los casos o situaciones), requisitos previos para su uso, regulaciones vigentes en los principales mercados hispanohablantes. Explicar estas restricciones honestamente genera confianza y reduce reclamaciones.

## 18. Categoría Mental del Producto
*Cómo clasifica el consumidor este producto en su mente: solución, herramienta, dispositivo, tratamiento, accesorio, etc.*
Analiza cómo el consumidor categoriza mentalmente este producto y las implicaciones para el marketing. Determina: qué categoría mental ocupa (lujo accesible, necesidad básica, capricho justificable, inversión en uno mismo, herramienta de trabajo, ritual de cuidado, etc.), qué expectativas de precio lleva implícita esa categoría, con qué otros productos o marcas lo compara intuitivamente, cómo esta categorización afecta la disposición a pagar, qué palabras activan o desactivan esa categoría mental. Recomienda cómo posicionar el producto para ocupar la categoría mental más favorable.

## 19. Criterios de Decisión del Comprador
*Los criterios más importantes que el comprador considera para decidir si compra o no.*
Identifica y jerarquiza todos los criterios que el comprador evalúa antes de tomar la decisión de compra. Organízalos por orden de importancia para este producto específico. Para cada criterio: qué información busca el comprador, dónde la busca, cómo evalúa las opciones, qué señales le indican que este producto cumple el criterio. Incluye criterios racionales (precio, efectividad, ingredientes) y emocionales (marca, reseñas, recomendación personal, confianza). Indica cómo cada criterio debe abordarse en el proceso de venta.

## 20. Disparadores de Compra
*Situaciones, momentos o eventos que activan la necesidad de buscar o comprar el producto.*
Identifica todos los disparadores (triggers) específicos que llevan a un consumidor a buscar activamente este producto. Puede ser: un evento puntual (boda, reunión, verano), un momento de vida (cambio de trabajo, nuevo año), una experiencia incómoda, una comparación social, un contenido visto en redes, una recomendación de alguien, un período de desesperación acumulada. Para cada disparador: describe el momento específico, el estado emocional del consumidor en ese momento, qué acción toma, cómo llegaría a encontrar este producto. Estos disparadores son la base para segmentación y targeting en campañas.

## 21. Objeciones Comunes del Consumidor
*Dudas, miedos o creencias que frenan la compra: económicas, emocionales o psicológicas.*
Lista exhaustiva de todas las objeciones que frenan la compra. Para cada objeción: escribe la objeción exactamente como la diría el cliente, clasifícala (económica, de desconfianza, de efectividad, de conveniencia, de tiempo, psicológica), explica la creencia subyacente que la genera, proporciona una respuesta persuasiva lista para usar en landing page, anuncios o conversación de ventas, e indica qué tipo de prueba social la neutraliza mejor.

## 22. Barrera Principal de Acción
*La razón principal por la que el consumidor podría posponer la compra o no tomar acción.*
Identifica la barrera número uno — no las objeciones múltiples sino el obstáculo fundamental que impide que el consumidor actúe ahora mismo. Puede ser: precio percibido como alto, falta de urgencia real, desconfianza en que funcione para su caso específico, necesidad de aprobación de otra persona, falta de información suficiente, o simplemente el hábito de procrastinar. Describe cómo se manifiesta esta barrera en el comportamiento del consumidor, por qué es tan difícil de superar, y 3-5 estrategias específicas para eliminarla o rodearla en el proceso de venta.

## 23. Nivel de Explicación Necesario
*Qué tan fácil o difícil es entender el producto para comprarlo y usarlo. Qué necesita entender primero.*
Evalúa la complejidad de comprensión que requiere este producto para ser comprado con confianza. Determina: si el consumidor necesita educarme primero sobre el problema antes de presentar la solución, cuánta explicación técnica es necesaria vs. contraproducente, qué conceptos o mecanismos deben explicarse para generar confianza, cuáles son las preguntas que siempre hace un prospecto antes de comprar, qué orden de información maximiza la conversión. Recomienda la estructura ideal de un mensaje de ventas para este producto (del problema al mecanismo a la solución).

## 24. Señales de Credibilidad
*Qué necesita ver el consumidor para confiar y creer que este producto vale la pena.*
Identifica todas las señales de credibilidad específicas que este consumidor busca para sentirse seguro comprando. Categoriza por tipo: **Credibilidad de efectividad** (resultados demostrados, estudios, antes/después), **Credibilidad de marca** (historia, valores, trayectoria), **Credibilidad social** (testimonios, número de clientes, reseñas, influencers), **Credibilidad técnica** (ingredientes certificados, patentes, avales profesionales), **Credibilidad comercial** (garantías, política de devolución, seguridad de pago). Para cada tipo indica qué elementos concretos generar o mostrar.

## 25. Evidencias o Pruebas
*Estudios, testimonios o argumentos que respaldan la efectividad del producto.*
Lista todas las formas de evidencia disponibles o generables que respaldan los beneficios del producto: estudios científicos o clínicos sobre ingredientes activos, estadísticas de efectividad, antes y después visuales, testimonios de usuarios reales, endorsements de profesionales o especialistas, premios o reconocimientos, certificaciones de calidad, resultados de encuestas a clientes. Para cada tipo de evidencia: cómo obtenerla o generarla, cómo presentarla de forma más convincente, dónde usarla en el funnel de ventas (anuncio, landing page, checkout, email).

## 26. Factor de Gratificación
*Si el producto se percibe como de gratificación inmediata, progresiva o mixta.*
Analiza el perfil de gratificación del producto y sus implicaciones para el marketing. Determina si la gratificación es: **Inmediata** (resultados en minutos u horas — alta emoción en el punto de compra), **Progresiva** (resultados en días o semanas — requiere compromiso y paciencia), **Mixta** (algo inmediato + resultados profundos a largo plazo), o **Diferida** (resultados claros solo semanas o meses después). Para cada tipo: cómo influye en la expectativa del comprador, cómo comunicarlo honestamente sin desmotivar, cómo manejar la ansiedad post-compra, y qué estrategias de retención y satisfacción aplicar.

## 27. Oportunidades Estratégicas
*Oportunidades prácticas para marketing y comunicación basadas en toda la información del análisis.*
Identifica las oportunidades estratégicas más valiosas para escalar la venta de este producto. Incluye: nichos de mercado subestimados con alta probabilidad de conversión, ángulos publicitarios sin explotar que la competencia no usa, tendencias culturales o sociales que potencian la demanda, canales de distribución o promoción sin saturar, alianzas estratégicas con influencers o profesionales del sector, formatos de contenido que generarían alta viralidad, momentos del año para aprovechar con campañas especiales. Para cada oportunidad: describe el potencial, los recursos necesarios y los primeros pasos concretos.

## 28. Insights Psicológicos Clave
*Los insights psicológicos más importantes que explican por qué una persona compraría este producto.*
Revela los insights psicológicos más profundos que explican la decisión de compra de este producto. Estos son los "por qué reales" detrás de la compra — no los racionales sino los emocionales e inconscientes. Puede incluir: el deseo de aprobación o pertenencia, el miedo a perderse algo (FOMO), la búsqueda de identidad a través del consumo, la compensación emocional, el deseo de control o certeza, la comparación social, la búsqueda de la versión ideal de uno mismo. Para cada insight: cómo se aplica a este producto, qué mensaje publicitario activa ese insight, y un ejemplo de copy listo para usar.

## 29. Resumen
*Síntesis completa del producto: qué es, cómo funciona, a quién ayuda y su propuesta de valor.*
Síntesis ejecutiva del análisis completo. Redacta un resumen de 3-5 párrafos que capture: la esencia del producto y su mecanismo diferencial, el perfil del cliente ideal y su motivación más profunda, la propuesta de valor única y por qué gana frente a alternativas, los factores críticos de éxito para venderlo, y una evaluación del potencial de mercado y rentabilidad. Este resumen debe ser suficientemente completo para que alguien que lo lea sin ver el resto del documento tenga una comprensión profunda del producto y su oportunidad comercial.

## 30. Públicos Objetivos
*Todos los perfiles de usuarios que podrían beneficiarse. Identificar cada público de la forma más específica posible.*
Identifica y describe todos los segmentos de público objetivo con el máximo nivel de especificidad. Para cada segmento: nombre descriptivo del perfil, rango de edad y género, situación de vida específica, motivación principal para comprar, nivel de urgencia o necesidad, poder adquisitivo, canales donde se encuentra (qué redes usa, qué busca en Google, qué ve en YouTube), tipo de mensaje que resuena más con ese segmento, y estimación de tamaño de mercado relativo. Incluye también públicos secundarios o de nicho que podrían ser altamente rentables aunque sean más pequeños.

---

IMPORTANTE: Genera las 30 secciones COMPLETAS Y EXHAUSTIVAS. No omitas ninguna sección. Cada sección debe ser densa, específica y con contenido accionable listo para ejecutar. El resultado debe ser una guía profesional de investigación de mercado de nivel agencia, no una lista de consejos genéricos. Total esperado: mínimo 8000 palabras.`;
}

const SYS_RESEARCH = 'Eres un experto en marketing y copywriting. DEBES generar la respuesta usando EXACTAMENTE los encabezados de sección en el formato "## NN. Título" tal como se especifican en el mensaje del usuario. No renombres, no combines, no omitas ninguna sección. Genera las 30 secciones completas en el orden indicado.';

const SYS_ANGLES = 'Eres un experto en copywriting estratégico y marketing de respuesta directa para mercados hispanohablantes. Tu tarea es generar EXACTAMENTE 5 ángulos de venta usando el formato ## ÁNGULO 01:, ## ÁNGULO 02:, etc., cada uno con sus 4 subsecciones ### exactas: "Descripción del Ángulo", "Avatar o Público Objetivo", "Problema Específico que Aborda el Ángulo de Venta" y "Cómo el Producto se Vuelve la Solución Ideal". Si se proporciona una investigación base del producto, DEBES usarla como fuente principal para crear ángulos específicos, precisos y relevantes para ese producto en particular — no generes ángulos genéricos. Cada subsección debe tener mínimo 100 palabras.';

async function callAI(provider, modelId, apiKey, prompt, systemMessage) {
  const sysMsg = systemMessage || SYS_RESEARCH;

  if (provider === 'openai') {
    const r = await undiciFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: prompt },
        ],
        max_tokens: 16000,
        temperature: 0.7,
      }),
      dispatcher: longRunningAgent,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `OpenAI error ${r.status}`);
    const finishReason = d.choices[0].finish_reason;
    const text = d.choices[0].message.content;
    console.log(`[products] OpenAI ${modelId} finish_reason=${finishReason} chars=${text?.length || 0}`);
    return text;
  }

  if (provider === 'anthropic') {
    // 30 sections × 200 words in Spanish needs ~22-25K output tokens. Bump to 32K with margin.
    // The longRunningAgent (15 min headersTimeout) handles the longer wait without aborting.
    // Limits: Haiku 4.5 supports 64K, Sonnet 4.6 supports 64K, Opus 4.7 supports 128K — all OK.
    const maxTokens = 32000;
    // 9-minute timeout (server has 10-minute setTimeout — leave 1min margin)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('Timeout: la API de Anthropic no respondió en 9 minutos'), 9 * 60 * 1000);
    let r;
    try {
      r = await undiciFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          system: sysMsg,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
        dispatcher: longRunningAgent,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `Anthropic error ${r.status}`);
    const text = d.content[0].text;
    console.log(`[products] Anthropic ${modelId} stop_reason=${d.stop_reason} usage=${JSON.stringify(d.usage)} chars=${text?.length || 0}`);
    if (d.stop_reason === 'max_tokens') {
      console.warn(`[products] ⚠️ Anthropic ${modelId} hit max_tokens limit — output truncated`);
    }
    return text;
  }

  if (provider === 'google') {
    const isThinkingModel = /^gemini-(2\.5|3)/.test(modelId);
    const r = await undiciFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${sysMsg}\n\n${prompt}` }] }],
          generationConfig: { maxOutputTokens: isThinkingModel ? 32768 : 16384 },
        }),
        dispatcher: longRunningAgent,
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
    return callKie({ apiKey, modelId, sysMsg, userPrompt: prompt, maxTokens: 16000, temperature: 0.7 });
  }

  throw new Error('Proveedor no soportado');
}

function buildAnglesPrompt(productName, researchContent) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN BASE DEL PRODUCTO (úsala COMPLETAMENTE como contexto profundo para crear ángulos precisos, específicos y altamente relevantes para este producto en particular):\n\n${researchContent}`
    : '';

  return `Eres un experto en copywriting estratégico, psicología persuasiva y marketing de respuesta directa con más de 15 años de experiencia generando campañas exitosas en mercados hispanohablantes (México, Colombia, Argentina, España, Chile, Perú).

Tu tarea es identificar y desarrollar los 5 MEJORES ÁNGULOS DE VENTA para el siguiente producto. Cada ángulo debe ser una perspectiva única y poderosa que conecte profundamente con un segmento específico del mercado hispanohablante.

PRODUCTO: ${productName}${ctx}

---

INSTRUCCIONES CRÍTICAS DE FORMATO:
Genera EXACTAMENTE 5 ángulos de venta. Usa EXACTAMENTE esta estructura para CADA ángulo:

## ÁNGULO 01: [Nombre descriptivo y memorable del ángulo]

### Descripción del Ángulo
[Explica qué perspectiva o narrativa utiliza este ángulo, cómo posiciona el producto, cuál es el mecanismo emocional o racional que activa, y por qué es persuasivo. Incluye un hook de apertura listo para usar en un anuncio. Mínimo 100 palabras.]

### Avatar o Público Objetivo
[Perfil detallado del consumidor ideal para ESTE ángulo específico: rango de edad, género, situación de vida, valores, estilo de vida, motivaciones de compra. Escribe de forma específica y concreta, como si hablaras de una persona real. Mínimo 100 palabras.]

### Problema Específico que Aborda el Ángulo de Venta
[El dolor o frustración concreto que este ángulo resuelve. Descríbelo con detalle vívido: cómo se siente el consumidor, qué situaciones cotidianas lo generan, qué ha intentado antes sin éxito. Incluye frases textuales que el cliente usaría para describir su problema. Mínimo 100 palabras.]

### Cómo el Producto se Vuelve la Solución Ideal
[Explica cómo este producto, desde ESTE ángulo específico, es la solución perfecta al problema. Conecta el mecanismo del producto con el dolor. Incluye copy persuasivo listo para usar en un anuncio, landing page o guión de video. Mínimo 100 palabras.]

## ÁNGULO 02: [Nombre descriptivo y memorable]

### Descripción del Ángulo
[...]

### Avatar o Público Objetivo
[...]

### Problema Específico que Aborda el Ángulo de Venta
[...]

### Cómo el Producto se Vuelve la Solución Ideal
[...]

[Continúa con ÁNGULO 03, ÁNGULO 04, ÁNGULO 05 con la misma estructura]

---

REGLAS IMPORTANTES:
- Los 5 ángulos deben ser completamente DISTINTOS entre sí — diferentes perspectivas, diferentes avatares, diferentes narrativas
- Los nombres de los ángulos deben ser descriptivos y memorables (ej: "El Despertar de la Confianza", "La Solución que Ignorabas", "El Efecto Social Invisible")
- Cada ángulo debe ser accionable: listo para crear un anuncio, landing page o guión de video
- Usa lenguaje coloquial hispanohablante natural, persuasivo y sin tecnicismos innecesarios
- Genera los 5 ángulos COMPLETOS, no omitas ninguna de las 4 subsecciones de cada ángulo`;
}

// ── POST /api/products/:id/generate-stats ────────────────────────
// Generates an array of stats `[{number, label, desc}, ...]` for the product,
// in the "X% of users noted Y" style, anchored on the saved product research.
router.post('/:id/generate-stats', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id } = req.body || {};
  const safeCount = Math.min(6, Math.max(3, Number(count) || 3));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const prompt = buildStatsPrompt(p.name, researchContent, safeCount);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_STATS);
  } catch (err) {
    console.error('[products/generate-stats] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const items = parseStatsJson(raw);
  if (!items || !items.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido de estadísticas.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({ items, model: modelDef.label, provider: modelDef.provider });
});

// ── POST /api/products/:id/generate-comparison ───────────────────
// Generates 5-7 comparison criteria for a "us vs competitor" table,
// anchored on the saved product research.
router.post('/:id/generate-comparison', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id } = req.body || {};
  const safeCount = Math.min(8, Math.max(4, Number(count) || 5));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const prompt = buildComparisonPrompt(p.name, researchContent, safeCount);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_COMPARISON);
  } catch (err) {
    console.error('[products/generate-comparison] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const parsed = parseComparisonJson(raw);
  if (!parsed || !parsed.items || !parsed.items.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({
    title:       parsed.title || '',
    description: parsed.description || '',
    items:       parsed.items,
    model:       modelDef.label,
    provider:    modelDef.provider,
  });
});

// ── FAQ generation helpers ───────────────────────────────────────
const SYS_FAQS = 'Eres un experto en copywriting de respuesta directa y conversión de ecommerce para mercados hispanohablantes. Tu única tarea es responder con JSON estricto — un array de objetos { q, a } sin texto antes ni después, sin code fences, sin comentarios.';

function buildFaqsPrompt(productName, researchContent, count) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (usá esto para anclar respuestas concretas):\n${researchContent}`
    : '';
  return `Generá ${count} Preguntas Frecuentes (FAQ) para la página de venta del siguiente producto.

PRODUCTO: ${productName}${ctx}

REGLAS:
- Cada pregunta debe sonar natural, como la haría un cliente real ANTES de comprar (no marketing-speak).
- Cubrir mezcla diversa: uso/aplicación correcta, contraindicaciones, durabilidad, envío y tiempos, garantía/devoluciones, comparación con alternativas, casos en los que el producto NO es ideal.
- Las respuestas: 2-4 oraciones, persuasivas pero honestas, terminando con un toque de confianza o llamada a la acción suave.
- NUNCA inventar datos (precios exactos, dimensiones específicas, etc.) que no estén en la investigación.
- Lenguaje hispanohablante neutro / coloquial (no usar regionalismos extremos).

FORMATO DE SALIDA — JSON ESTRICTO, sin texto antes o después:
[
  { "q": "...", "a": "..." },
  { "q": "...", "a": "..." }
]`;
}

function parseFaqsJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) {
        return j.filter(it => it && typeof it.q === 'string' && typeof it.a === 'string')
                .map(it => ({ q: it.q.trim(), a: it.a.trim() }));
      }
    } catch (_) {}
    return null;
  };
  // 1) raw is direct JSON
  let r = tryParse(raw.trim()); if (r && r.length) return r;
  // 2) inside markdown code block
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParse(fence[1].trim()); if (r && r.length) return r; }
  // 3) just the first [...] block
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) { r = tryParse(arr[0]); if (r && r.length) return r; }
  return null;
}

// ── Comparison table generation helpers ──────────────────────────
const SYS_COMPARISON = 'Eres un experto en copywriting de respuesta directa y diferenciación competitiva para ecommerce hispanohablante. Tu única tarea es responder con JSON estricto — un objeto { title, description, items } sin texto antes ni después, sin code fences, sin comentarios.';

function buildComparisonPrompt(productName, researchContent, count) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (basate en los beneficios reales):\n${researchContent}`
    : '';
  return `Generá el contenido completo para una tabla comparativa "Nuestro producto vs Competencia".

PRODUCTO: ${productName}${ctx}

REGLAS DEL CONTENIDO:

1) "title": Un título atractivo que mencione el producto, máximo 6-8 palabras. Ej. "Lo que hace especial [Producto]" o "Por qué elegir [Producto]" o "[Producto] vs el resto". Usá el nombre del producto.

2) "description": 1-2 oraciones (máximo 35 palabras) explicando QUÉ hace al producto distinto de la competencia. Tono persuasivo, conciso, anclado a beneficios concretos. Ejemplo: "A diferencia de otros, combina X y Y en una sola herramienta. Resultados rápidos y uso cómodo para [perfil del cliente]."

3) "items": Array de ${count} criterios donde el producto SUPERA a alternativas típicas. Cada criterio: 1-3 palabras (ej. "Eficacia", "Durabilidad", "Comodidad", "Garantía", "Precio Accesible", "Tecnología avanzada", "Resultados rápidos", "Materiales premium"). Variá entre calidad, conveniencia, resultado, precio, garantía/soporte, tecnología según corresponda al producto.

FORMATO DE SALIDA — JSON ESTRICTO, sin texto antes o después:
{
  "title": "Lo que hace especial ...",
  "description": "A diferencia de otros, ...",
  "items": [
    { "label": "Eficacia" },
    { "label": "Durabilidad" }
  ]
}`;
}

function parseComparisonJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParseObject = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.items)) {
        const items = j.items
          .filter(it => it && typeof it.label === 'string' && it.label.trim())
          .map(it => ({ label: it.label.trim() }));
        if (!items.length) return null;
        return {
          title:       (typeof j.title       === 'string') ? j.title.trim()       : '',
          description: (typeof j.description === 'string') ? j.description.trim() : '',
          items,
        };
      }
      // Backwards-compat: legacy plain-array shape
      if (Array.isArray(j)) {
        const items = j.filter(it => it && typeof it.label === 'string' && it.label.trim())
                       .map(it => ({ label: it.label.trim() }));
        if (!items.length) return null;
        return { title: '', description: '', items };
      }
    } catch (_) {}
    return null;
  };
  let r = tryParseObject(raw.trim()); if (r) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParseObject(fence[1].trim()); if (r) return r; }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) { r = tryParseObject(obj[0]); if (r) return r; }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) { r = tryParseObject(arr[0]); if (r) return r; }
  return null;
}

// ── POST /api/products/:id/generate-features ────────────────────
router.post('/:id/generate-features', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id } = req.body || {};
  const safeCount = Math.min(8, Math.max(3, Number(count) || 6));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const prompt = buildFeaturesPrompt(p.name, researchContent, safeCount);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_FEATURES);
  } catch (err) {
    console.error('[products/generate-features] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const parsed = parseFeaturesJson(raw);
  if (!parsed || !parsed.items || !parsed.items.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({
    title:       parsed.title || '',
    description: parsed.description || '',
    items:       parsed.items,
    model:       modelDef.label,
    provider:    modelDef.provider,
  });
});

// ── Features generation helpers ──────────────────────────────────
const SYS_FEATURES = 'Eres un experto en copywriting de respuesta directa y conversión de ecommerce para mercados hispanohablantes. Tu única tarea es responder con JSON estricto — un objeto { title, description, items } sin texto antes ni después, sin code fences, sin comentarios.';

function buildFeaturesPrompt(productName, researchContent, count) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (anclá los features en beneficios reales):\n${researchContent}`
    : '';
  const iconList = ICON_KEYS.join(', ');
  return `Generá el contenido de una sección "¿Por qué elegirnos?" con ${count} features destacados del siguiente producto.

PRODUCTO: ${productName}${ctx}

REGLAS:

1) "title": Título de la sección, 3-7 palabras. Ej. "Beneficios que marcan la diferencia", "¿Por qué [Producto]?", "Lo que te llevás".

2) "description": 1-2 oraciones (máx. 30 palabras) introduciendo los features.

3) "items": Array de ${count} features. Cada uno con:
   - "icon": uno de estos identificadores (elegí el más apropiado para el feature): ${iconList}
   - "title": 2-5 palabras, claras y orientadas a beneficio (no a la característica). Ej. "Resultados visibles", "Envío rápido", "100% natural", "Garantía total", "Pago contra entrega".
   - "description": 1-2 oraciones (máx. 25 palabras) explicando el beneficio concreto al cliente.

Variá los íconos para que no se repitan. Cada feature debe ser distinto al anterior (cubrí mezcla de: resultado, conveniencia, seguridad/garantía, ingredientes/calidad, envío, soporte).

FORMATO DE SALIDA — JSON ESTRICTO:
{
  "title": "Beneficios que marcan la diferencia",
  "description": "Mirá por qué miles de clientes nos eligen.",
  "items": [
    { "icon": "zap", "title": "Resultados rápidos", "description": "Notá la diferencia desde la primera semana de uso." },
    { "icon": "shield", "title": "Garantía total", "description": "30 días para devolverlo sin preguntas." }
  ]
}`;
}

function parseFeaturesJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const validIcon = (v) => (typeof v === 'string' && ICON_KEYS.includes(v)) ? v : 'check';
  const tryParseObject = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.items)) {
        const items = j.items
          .filter(it => it && (typeof it.title === 'string' || typeof it.description === 'string'))
          .map(it => ({
            icon:        validIcon(it.icon),
            title:       String(it.title       || '').trim(),
            description: String(it.description || '').trim(),
          }))
          .filter(it => it.title || it.description);
        if (!items.length) return null;
        return {
          title:       (typeof j.title       === 'string') ? j.title.trim()       : '',
          description: (typeof j.description === 'string') ? j.description.trim() : '',
          items,
        };
      }
    } catch (_) {}
    return null;
  };
  let r = tryParseObject(raw.trim()); if (r) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParseObject(fence[1].trim()); if (r) return r; }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) { r = tryParseObject(obj[0]); if (r) return r; }
  return null;
}

// ── POST /api/products/:id/generate-testimonials ────────────────
router.post('/:id/generate-testimonials', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id, country } = req.body || {};
  const safeCount = Math.min(9, Math.max(3, Number(count) || 6));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const safeCountry = (typeof country === 'string' ? country.trim() : '').slice(0, 60);
  const prompt = buildTestimonialsPrompt(p.name, researchContent, safeCount, safeCountry);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_TESTIMONIALS);
  } catch (err) {
    console.error('[products/generate-testimonials] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const parsed = parseTestimonialsJson(raw);
  if (!parsed || !parsed.items || !parsed.items.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({
    title:       parsed.title || '',
    description: parsed.description || '',
    items:       parsed.items,
    model:       modelDef.label,
    provider:    modelDef.provider,
  });
});

// ── Testimonials generation helpers ──────────────────────────────
const SYS_TESTIMONIALS = 'Eres un experto en copywriting de prueba social y conversión para ecommerce hispanohablante. Tu única tarea es responder con JSON estricto — un objeto { title, description, items } sin texto antes ni después, sin code fences, sin comentarios.';

function buildTestimonialsPrompt(productName, researchContent, count, country) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (anclá los testimonios en beneficios reales y dolores del avatar):\n${researchContent}`
    : '';

  // Country-specific rule overrides the generic "variá entre países" rule
  const hasCountry = country && country.trim();
  const nameRule = hasCountry
    ? `"name": Nombre y apellido REALISTAS y típicos de **${country}** (ej. nombres y apellidos que suenen naturales en ese país, no genéricos). Variá la combinación entre testimonios pero todos deben ser claramente de ${country}.`
    : `"name": Nombre y apellido hispanos REALISTAS. Variá entre países (México, Colombia, Argentina, Perú, Chile, España, Ecuador, Venezuela). NO inventes nombres genéricos tipo "Juan Pérez" en todos — usá variedad real: "Carolina Restrepo", "Diego Ramírez", "María Fernanda Vásquez", "Andrés Castillo", "Camila Ortega", "Luis Mendoza", etc.`;
  const locationRule = hasCountry
    ? `"location": Formato "Ciudad, ${country}". TODAS las ciudades deben ser ciudades reales de **${country}**. Variá las ciudades entre testimonios (no repitas la misma ciudad).`
    : `"location": Ciudad + país, formato "Ciudad, País". Ej. "Medellín, Colombia", "Guadalajara, México". Variá las ciudades entre testimonios.`;
  const exampleLocations = hasCountry
    ? `Ciudad de ${country}` : '"Medellín, Colombia", "Guadalajara, México"';

  return `Generá ${count} testimonios realistas de clientes satisfechos para la landing de venta del siguiente producto.

PRODUCTO: ${productName}${ctx}${hasCountry ? `\n\nPAÍS OBJETIVO: ${country} — todos los testimonios deben ser de personas de este país.` : ''}

REGLAS:

1) "title": Título de la sección, 3-6 palabras. Ej. "Lo que dicen nuestros clientes", "Historias reales", "Clientes felices".

2) "description": 1 oración (máx. 20 palabras) introduciendo los testimonios. Puede mencionar la cantidad o el resultado promedio.

3) "items": Array de ${count} testimonios. Cada uno con:
   - ${nameRule}
   - ${locationRule}
   - "rating": número entero 4 o 5 (mayoría 5, alguno 4 para realismo).
   - "text": 2-4 oraciones del cliente, en PRIMERA PERSONA, en tono natural y conversacional (no marketing-speak)${hasCountry ? `, usando expresiones y vocabulario natural de ${country} cuando aplique (sin caer en estereotipos)` : ''}. Mencioná un dolor concreto antes de usar el producto y el resultado específico después. NO uses superlativos vacíos tipo "el mejor producto del mundo". Sí usá detalles concretos anclados a la investigación del producto. Variá la longitud y el estilo entre testimonios (algunos más cortos y emocionales, otros más técnicos/explicativos).

FORMATO DE SALIDA — JSON ESTRICTO:
{
  "title": "Lo que dicen nuestros clientes",
  "description": "Más de 10.000 personas ya lo probaron.",
  "items": [
    { "name": "Carolina Restrepo", "location": ${hasCountry ? `"Ciudad, ${country}"` : '"Medellín, Colombia"'}, "rating": 5, "text": "Llevaba meses sin poder dormir bien. A las dos semanas de usarlo ya me dormía en 10 minutos. Lo recomiendo." },
    { "name": "Diego Ramírez", "location": ${hasCountry ? `"Otra ciudad, ${country}"` : '"Guadalajara, México"'}, "rating": 5, "text": "Funciona tal como dice. Llegó en 3 días y el servicio de atención respondió rapidísimo cuando tuve una duda." }
  ]
}`;
}

function parseTestimonialsJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParseObject = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.items)) {
        const items = j.items
          .filter(it => it && (typeof it.name === 'string' || typeof it.text === 'string'))
          .map(it => {
            const rating = Math.min(5, Math.max(0, Math.round(Number(it.rating) || 5)));
            return {
              name:     String(it.name     || '').trim(),
              location: String(it.location || '').trim(),
              rating,
              text:     String(it.text     || '').trim(),
            };
          })
          .filter(it => it.name || it.text);
        if (!items.length) return null;
        return {
          title:       (typeof j.title       === 'string') ? j.title.trim()       : '',
          description: (typeof j.description === 'string') ? j.description.trim() : '',
          items,
        };
      }
    } catch (_) {}
    return null;
  };
  let r = tryParseObject(raw.trim()); if (r) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParseObject(fence[1].trim()); if (r) return r; }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) { r = tryParseObject(obj[0]); if (r) return r; }
  return null;
}

// ── POST /api/products/:id/generate-purchase-popup ──────────────
router.post('/:id/generate-purchase-popup', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, count, research_id, country } = req.body || {};
  const safeCount = Math.min(20, Math.max(3, Number(count) || 10));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const safeCountry = (typeof country === 'string' ? country.trim() : '').slice(0, 60);
  const prompt = buildPurchasePopupPrompt(p.name, researchContent, safeCount, safeCountry);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_PURCHASE_POPUP);
  } catch (err) {
    console.error('[products/generate-purchase-popup] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const parsed = parsePurchasePopupJson(raw);
  if (!parsed || !parsed.length) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({
    items:    parsed,
    model:    modelDef.label,
    provider: modelDef.provider,
  });
});

const SYS_PURCHASE_POPUP = 'Eres un experto en copywriting de prueba social para ecommerce hispanohablante. Tu única tarea es responder con JSON estricto — un array de objetos { name, city } sin texto antes ni después, sin code fences, sin comentarios.';

function buildPurchasePopupPrompt(productName, researchContent, count, country) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (para entender el avatar):\n${researchContent.slice(0, 2000)}`
    : '';
  const hasCountry = country && country.trim();
  const nameRule = hasCountry
    ? `Nombres y apellidos REALISTAS y típicos de **${country}**. Variá entre testimonios pero todos deben ser claramente de ${country}.`
    : `Nombres y apellidos hispanos REALISTAS. Variá entre países (México, Colombia, Argentina, Chile, Perú, España, Ecuador). NO uses nombres genéricos tipo "Juan Pérez".`;
  const cityRule = hasCountry
    ? `Ciudades reales de **${country}** (solo el nombre, sin país). Variá entre ítems — no repitas la misma ciudad.`
    : `Ciudades reales hispanas (solo el nombre, sin país). Ej. "Medellín", "Guadalajara", "Buenos Aires".`;
  return `Generá ${count} compradores ficticios para notificaciones flotantes de prueba social ("Carolina de Medellín compró Papaya Cleanse hace 5 minutos").

PRODUCTO: ${productName}${ctx}${hasCountry ? `\n\nPAÍS OBJETIVO: ${country} — todos los compradores deben ser de este país.` : ''}

REGLAS:
- "name": ${nameRule} Usá primer nombre + apellido (ej. "Carolina Restrepo", "Diego Ramírez").
- "city": ${cityRule}

FORMATO DE SALIDA — JSON ESTRICTO, sin texto antes o después:
[
  { "name": "Carolina Restrepo", "city": ${hasCountry ? `"Ciudad de ${country}"` : '"Medellín"'} },
  { "name": "Diego Ramírez",     "city": ${hasCountry ? `"Otra ciudad de ${country}"` : '"Guadalajara"'} }
]`;
}

function parsePurchasePopupJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) {
        const items = j
          .filter(it => it && typeof it.name === 'string' && it.name.trim())
          .map(it => ({
            name: String(it.name).trim(),
            city: String(it.city || '').trim(),
          }));
        return items.length ? items : null;
      }
    } catch (_) {}
    return null;
  };
  let r = tryParse(raw.trim()); if (r) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParse(fence[1].trim()); if (r) return r; }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) { r = tryParse(arr[0]); if (r) return r; }
  return null;
}

// ── POST /api/products/:id/generate-product-hero ────────────────
router.post('/:id/generate-product-hero', async (req, res) => {
  const p = products.one({ id: Number(req.params.id), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const { model_id, research_id, country, benefits_count } = req.body || {};
  const safeBenefitsCount = Math.min(8, Math.max(3, Number(benefits_count) || 4));
  const modelKey  = model_id || 'claude-haiku-4-5-20251001';
  const modelDef  = MODELS[modelKey];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de IA no válido' });

  const settings = user_settings.get(req.user.id);
  const apiKey   = settings && settings[modelDef.key_field];
  if (!apiKey) return res.status(402).json({ error: `Configura tu API key de ${modelDef.provider} en Ajustes → APIs` });

  let researchContent = '';
  const list = product_research.forProduct(p.id);
  if (research_id) {
    const r = list.find(x => x.id == research_id);
    if (r) researchContent = r.content;
  } else if (list.length) {
    researchContent = list[0].content;
  }

  const safeCountry = (typeof country === 'string' ? country.trim() : '').slice(0, 60);
  const prompt = buildProductHeroPrompt(p.name, researchContent, safeBenefitsCount, safeCountry);
  let raw;
  try {
    raw = await callAI(modelDef.provider, modelKey, apiKey, prompt, SYS_PRODUCT_HERO);
  } catch (err) {
    console.error('[products/generate-product-hero] AI call failed:', err.message);
    return res.status(502).json({ error: `Error al llamar la API de IA: ${err.message}` });
  }
  const parsed = parseProductHeroJson(raw);
  if (!parsed) {
    return res.status(502).json({ error: 'La IA no devolvió un JSON válido.', raw_preview: String(raw || '').slice(0, 300) });
  }
  res.json({
    subtitle:    parsed.subtitle || '',
    benefits:    parsed.benefits || [],
    testimonial: parsed.testimonial || null,
    model:       modelDef.label,
    provider:    modelDef.provider,
  });
});

const SYS_PRODUCT_HERO = 'Eres un experto en copywriting de respuesta directa para ecommerce hispanohablante. Tu única tarea es responder con JSON estricto — un objeto { subtitle, benefits, testimonial } sin texto antes ni después, sin code fences, sin comentarios.';

function buildProductHeroPrompt(productName, researchContent, benefitsCount, country) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (anclá el contenido en beneficios reales y dolores del avatar):\n${researchContent.slice(0, 3500)}`
    : '';
  const hasCountry = country && country.trim();
  const nameRule = hasCountry
    ? `name: nombre realista típico de **${country}** (ej. "Carlos M." o "Carolina R." — primer nombre + inicial del apellido).`
    : `name: nombre hispano realista (primer nombre + inicial del apellido, ej. "Luis Q.", "Carolina R.").`;

  return `Generá el contenido del hero de la landing del siguiente producto. Es la pieza ABOVE-THE-FOLD (lo primero que ve el visitante) — copy de alto impacto.

PRODUCTO: ${productName}${ctx}${hasCountry ? `\n\nPAÍS OBJETIVO: ${country}` : ''}

REGLAS:

1) "subtitle": 1 frase (10-18 palabras) — propuesta de valor central. Forma: "[Beneficio principal] [conector] [resultado secundario o contexto]". Ej. "Frescura interior diaria que eleva tu confianza y presencia social". NO uses signos de exclamación. NO uses palabras vacías como "increíble", "el mejor". Sí palabras concretas que reflejen un beneficio real anclado a la investigación.

2) "benefits": Array de ${benefitsCount} beneficios SUPER concretos y orientados a resultado. Cada uno empieza con un verbo de acción y termina con un detalle medible o contextual. Ej:
   - "Reduce olores visibles en 2-4 semanas diarios"
   - "Mejora aliento para conversaciones cercanas"
   - "Minimiza olor de pies tras jornadas largas"
   - "Aumenta seguridad social en eventos laborales"
   Cada beneficio: máx. 9 palabras. NUNCA empieces dos beneficios con el mismo verbo.

3) "testimonial": Un testimonio realista de un cliente satisfecho. Objeto con:
   - ${nameRule}
   - "rating": número entero (4 o 5, mayoría 5)
   - "text": 3-5 oraciones (50-90 palabras) en PRIMERA PERSONA. Estructura:
     a) "Antes" — mencioná el dolor concreto (de la investigación)
     b) "Después" — el resultado específico que obtuvo
     c) Cierre con uso cotidiano + recomendación implícita
     Tono natural, conversacional, NO marketing-speak. NO superlativos vacíos. Sí detalles concretos.

FORMATO DE SALIDA — JSON ESTRICTO:
{
  "subtitle": "...",
  "benefits": ["...", "...", "..."],
  "testimonial": {
    "name": "Luis Q.",
    "rating": 5,
    "text": "Me devolvió la confianza en reuniones..."
  }
}`;
}

function parseProductHeroJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const benefits = Array.isArray(j.benefits)
          ? j.benefits.filter(b => typeof b === 'string' && b.trim()).map(b => b.trim())
          : [];
        const t = j.testimonial && typeof j.testimonial === 'object' ? j.testimonial : null;
        return {
          subtitle: (typeof j.subtitle === 'string') ? j.subtitle.trim() : '',
          benefits,
          testimonial: t ? {
            name:   String(t.name   || '').trim(),
            rating: Math.min(5, Math.max(0, Math.round(Number(t.rating) || 5))),
            text:   String(t.text   || '').trim(),
          } : null,
        };
      }
    } catch (_) {}
    return null;
  };
  let r = tryParse(raw.trim()); if (r) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParse(fence[1].trim()); if (r) return r; }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) { r = tryParse(obj[0]); if (r) return r; }
  return null;
}

// ── Stats generation helpers ─────────────────────────────────────
const SYS_STATS = 'Eres un experto en copywriting de respuesta directa y prueba social para ecommerce hispanohablante. Tu única tarea es responder con JSON estricto — un array de objetos { number, label, desc } sin texto antes ni después, sin code fences, sin comentarios.';

function buildStatsPrompt(productName, researchContent, count) {
  const ctx = researchContent
    ? `\n\nINVESTIGACIÓN DEL PRODUCTO (anclá tus afirmaciones en beneficios reales mencionados acá):\n${researchContent}`
    : '';
  return `Generá ${count} estadísticas de satisfacción de clientes para la landing de venta del siguiente producto. Estilo "X% de los usuarios notó Y".

PRODUCTO: ${productName}${ctx}

REGLAS:
- "number": porcentaje en el rango 89-99% (incluí el símbolo "%"). Variá los números entre ítems para que no se vea repetitivo. NUNCA uses 100% (genera desconfianza).
- "label": la frase de observación, redactada como un dato post-encuesta. Empezá con verbo en pasado plural en TERCERA persona — "Notaron que…", "Reportaron…", "Experimentaron…", "Mencionaron…", "Confirmaron…", "Vieron resultados…", "Sintieron…". Sigue con un beneficio específico tomado de la investigación.
- "desc": dejá vacío salvo que necesites una segunda oración corta con contexto adicional. La mayoría de los casos deja desc = "".
- ANCLÁ las afirmaciones a beneficios concretos del producto — no inventes datos genéricos.
- Lenguaje hispanohablante neutro, persuasivo pero honesto. Evitá hipérboles.

FORMATO DE SALIDA — JSON ESTRICTO, sin texto antes o después:
[
  { "number": "98%", "label": "Notaron que ...", "desc": "" },
  { "number": "95%", "label": "Reportaron ...", "desc": "" }
]`;
}

function parseStatsJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tryParse = (s) => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) {
        return j.filter(it => it && (typeof it.number === 'string' || typeof it.label === 'string'))
                .map(it => ({
                  number: String(it.number || '').trim(),
                  label:  String(it.label  || '').trim(),
                  desc:   String(it.desc   || '').trim(),
                }));
      }
    } catch (_) {}
    return null;
  };
  let r = tryParse(raw.trim()); if (r && r.length) return r;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParse(fence[1].trim()); if (r && r.length) return r; }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) { r = tryParse(arr[0]); if (r && r.length) return r; }
  return null;
}

module.exports = router;
