/**
 * Verifica que cada modelo Kie.ai recién agregado responde a un prompt corto.
 * Sirve para confirmar — antes de exponerlo en la UI — que el slug es el
 * correcto y que tu key tiene acceso al modelo.
 *
 * Uso (PowerShell):
 *   $env:KIE_API_KEY = "kie-..."
 *   node scripts/test-kie-models.js
 *
 * Opcional:
 *   $env:KIE_MODELS = "kie:claude-opus-4-7,kie:gpt-5-5"   (default: todos los 2026)
 */
const path = require('path');

const KIE_API_KEY = process.env.KIE_API_KEY;
if (!KIE_API_KEY) {
  console.error('Falta KIE_API_KEY en el entorno.');
  process.exit(1);
}

const DEFAULT_MODELS = [
  'kie:claude-opus-4-7',
  'kie:claude-sonnet-4-6',
  'kie:gpt-5-5',
  'kie:gemini-3.1-pro-preview',
  'kie:gemini-3-flash-preview',
];

const MODELS = (process.env.KIE_MODELS || DEFAULT_MODELS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const { callKie } = require(path.join(__dirname, '..', 'server', 'lib', 'kie.js'));

const SYS = 'Eres un asistente conciso. Responde en una sola línea.';
const PROMPT = 'Di "OK" seguido del nombre del modelo que eres en una palabra.';

(async () => {
  console.log(`→ Testing ${MODELS.length} modelos contra Kie.ai...\n`);
  const results = [];
  for (const modelId of MODELS) {
    const t0 = Date.now();
    try {
      const out = await callKie({
        apiKey:     KIE_API_KEY,
        modelId,
        sysMsg:     SYS,
        userPrompt: PROMPT,
        maxTokens:  60,
        temperature: 0.3,
      });
      const dt = Date.now() - t0;
      const trimmed = String(out || '').trim().slice(0, 120);
      console.log(`✅ ${modelId.padEnd(32)} ${dt}ms  ${trimmed}`);
      results.push({ modelId, ok: true, ms: dt });
    } catch (err) {
      const dt = Date.now() - t0;
      console.log(`❌ ${modelId.padEnd(32)} ${dt}ms  ERROR: ${err.message}`);
      results.push({ modelId, ok: false, error: err.message });
    }
  }

  console.log('\n=== Resumen ===');
  const ok = results.filter(r => r.ok).length;
  console.log(`${ok}/${results.length} modelos respondieron correctamente.`);
  process.exit(ok === results.length ? 0 : 1);
})();
