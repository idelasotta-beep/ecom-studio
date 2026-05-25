/**
 * Audios reales generados con ElevenLabs.
 *
 * Endpoints:
 *   GET  /api/voiceovers                          → productos con count de audios
 *   GET  /api/voiceovers/:pid                     → producto + sus voiceovers + scripts disponibles
 *   POST /api/voiceovers/:pid/generate            → genera mp3 con ElevenLabs
 *   DELETE /api/voiceovers/:pid/:vid              → elimina audio (DB + archivo)
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { Agent: UndiciAgent, fetch: undiciFetch } = require('undici');

const { products, product_voiceovers, product_audios, user_settings } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mediaDir } = require('../lib/paths');

const router = express.Router();
router.use(requireAuth);

const AUDIO_DIR = mediaDir('voiceovers');

// ─────────────────────────────────────────────────────────────────
// Voice catalog — voces "premade" oficiales de ElevenLabs que rinden
// bien en español LATAM con el modelo eleven_multilingual_v2.
// Más voces se pueden agregar acá sin tocar el frontend (solo el catálogo).
// ─────────────────────────────────────────────────────────────────
const VOICE_CATALOG = {
  male_young:       { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni',    description: 'Hombre joven, voz cálida y cercana' },
  male_adult:       { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',      description: 'Hombre adulto, narrador profundo' },
  male_authority:   { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh',      description: 'Hombre maduro, autoridad y confianza' },
  female_young:     { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',     description: 'Mujer joven, dulce y enérgica' },
  female_adult:     { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',    description: 'Mujer adulta, conversacional y profesional' },
  female_authority: { voice_id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte', description: 'Mujer madura, sofisticada y serena' },
};

const ALLOWED_MODELS = {
  'eleven_multilingual_v2': { label: 'Multilingual v2 — calidad alta (recomendado)', max_chars: 5000 },
  'eleven_flash_v2_5':      { label: 'Flash v2.5 — más rápido, menos costo',         max_chars: 5000 },
};

// 10 min, ElevenLabs puede tardar varios segundos en textos largos
const longRunningAgent = new UndiciAgent({
  headersTimeout: 10 * 60 * 1000,
  bodyTimeout:    10 * 60 * 1000,
  connectTimeout: 30 * 1000,
});

// ─────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────

// GET /api/voiceovers — products con count
router.get('/', (req, res) => {
  const list = products.allForUser(req.user.id).map(p => ({
    ...p,
    voiceover_count: (product_voiceovers.forProduct(p.id) || []).length,
    script_count:    (product_audios.forProduct(p.id) || []).length,
  }));
  res.json({
    products: list,
    voices:   VOICE_CATALOG,
    models:   ALLOWED_MODELS,
  });
});

// GET /api/voiceovers/:pid → producto + voiceovers + scripts existentes
router.get('/:pid', (req, res) => {
  const p = products.one({ id: Number(req.params.pid), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const voiceovers = product_voiceovers.forProduct(p.id).map(v => ({
    ...v,
    audio_url: `/voiceovers/${v.audio_path}`,
  }));
  const scripts = product_audios.forProduct(p.id);
  res.json({
    product: p,
    voiceovers,
    scripts,
    voices: VOICE_CATALOG,
    models: ALLOWED_MODELS,
  });
});

// POST /api/voiceovers/:pid/generate
//   body: { text?, script_id?, voice_type, model_id }
router.post('/:pid/generate', async (req, res) => {
  const p = products.one({ id: Number(req.params.pid), user_id: req.user.id });
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });

  const settings = user_settings.get(req.user.id) || {};
  const apiKey = settings.elevenlabs_key;
  if (!apiKey) return res.status(402).json({ error: 'Configura tu API key de ElevenLabs en Ajustes → APIs' });

  const { text, script_id, voice_type, model_id } = req.body;

  // Validar modelo
  const modelDef = ALLOWED_MODELS[model_id];
  if (!modelDef) return res.status(400).json({ error: 'Modelo de voz no válido' });

  // Validar voz
  const voiceDef = VOICE_CATALOG[voice_type];
  if (!voiceDef) return res.status(400).json({ error: 'Tipo de voz no válido' });

  // Resolver el texto (script_id tiene prioridad si vino)
  let finalText = '';
  let sourceScriptId = null;
  if (script_id) {
    const script = product_audios.one({ id: Number(script_id), user_id: req.user.id });
    if (!script) return res.status(404).json({ error: 'Script no encontrado' });
    if (script.product_id != p.id) return res.status(403).json({ error: 'El script no pertenece a este producto' });
    finalText = String(script.script || '').trim();
    sourceScriptId = script.id;
  } else if (text) {
    finalText = String(text).trim();
  } else {
    return res.status(400).json({ error: 'Falta text o script_id' });
  }

  if (!finalText) return res.status(400).json({ error: 'El texto está vacío' });
  if (finalText.length > modelDef.max_chars) {
    return res.status(400).json({ error: `Texto demasiado largo (máx ${modelDef.max_chars} chars)` });
  }

  // Llamar ElevenLabs
  let audioBuffer;
  try {
    audioBuffer = await synthesizeAudio({
      apiKey,
      text:     finalText,
      voiceId:  voiceDef.voice_id,
      modelId:  model_id,
    });
  } catch (err) {
    return res.status(502).json({ error: `Error al sintetizar audio: ${err.message}` });
  }

  // Guardar archivo .mp3
  const filename = `vo_${p.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  try {
    fs.writeFileSync(filePath, audioBuffer);
  } catch (err) {
    return res.status(500).json({ error: `No se pudo guardar el archivo: ${err.message}` });
  }

  // Persistir
  const saved = product_voiceovers.insert({
    user_id:          req.user.id,
    product_id:       p.id,
    source_script_id: sourceScriptId,
    text:             finalText,
    voice_type,
    voice_id:         voiceDef.voice_id,
    voice_name:       voiceDef.name,
    model_id,
    audio_path:       filename,
    char_count:       finalText.length,
    file_size_bytes:  audioBuffer.length,
  });

  res.json({
    id:         saved.id,
    audio_url:  `/voiceovers/${filename}`,
    char_count: finalText.length,
    file_size_bytes: audioBuffer.length,
    voice_name: voiceDef.name,
    model_id,
  });
});

// DELETE /api/voiceovers/:pid/:vid
router.delete('/:pid/:vid', (req, res) => {
  const v = product_voiceovers.one({ id: Number(req.params.vid), user_id: req.user.id });
  if (!v) return res.status(404).json({ error: 'Audio no encontrado' });
  if (v.product_id != Number(req.params.pid)) return res.status(403).json({ error: 'Audio no pertenece a este producto' });

  // Borrar archivo del disco (best effort)
  if (v.audio_path) {
    try { fs.unlinkSync(path.join(AUDIO_DIR, v.audio_path)); } catch (_) {}
  }
  product_voiceovers.delete(v.id, req.user.id);
  res.json({ message: 'Audio eliminado' });
});

// ─────────────────────────────────────────────────────────────────
// Cliente ElevenLabs (text-to-speech)
// ─────────────────────────────────────────────────────────────────
async function synthesizeAudio({ apiKey, text, voiceId, modelId }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const r = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
        style:            0.0,
        use_speaker_boost: true,
      },
    }),
    dispatcher: longRunningAgent,
  });
  if (!r.ok) {
    let errMsg = `ElevenLabs HTTP ${r.status}`;
    try {
      const errBody = await r.json();
      errMsg = errBody.detail?.message || errBody.detail || errBody.message || JSON.stringify(errBody).slice(0, 200);
    } catch (_) {
      try { errMsg = (await r.text()).slice(0, 200); } catch (_) {}
    }
    throw new Error(errMsg);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('ElevenLabs devolvió un archivo vacío');
  return buf;
}

module.exports = router;
