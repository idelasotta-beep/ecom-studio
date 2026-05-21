// Kie.ai unified caller. Handles 3 different model architectures:
//  - Claude family   → /claude/v1/messages (Anthropic-native format)
//  - GPT-5 family    → /{model}/v1/chat/completions (OpenAI, max_completion_tokens, developer role)
//  - Gemini/other    → /{model}/v1/chat/completions (standard OpenAI)
// All responses may be wrapped as { code, msg, data } envelope.

function detectFamily(model) {
  if (/^claude-/i.test(model)) return 'claude';
  if (/^gpt-5/i.test(model))   return 'gpt5';
  return 'openai-generic';   // gemini and others
}

function buildRequest(family, model, sysMsg, userPrompt, maxTokens, temperature) {
  if (family === 'claude') {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (sysMsg) body.system = sysMsg;
    return { url: 'https://api.kie.ai/claude/v1/messages', body };
  }
  if (family === 'gpt5') {
    const messages = [];
    if (sysMsg) messages.push({ role: 'developer', content: sysMsg });
    messages.push({ role: 'user', content: userPrompt });
    return {
      url: `https://api.kie.ai/${model}/v1/chat/completions`,
      body: { model, messages, max_completion_tokens: maxTokens },
    };
  }
  // openai-generic (Gemini, etc.)
  const messages = [];
  if (sysMsg) messages.push({ role: 'system', content: sysMsg });
  messages.push({ role: 'user', content: userPrompt });
  return {
    url: `https://api.kie.ai/${model}/v1/chat/completions`,
    body: { model, messages, max_tokens: maxTokens, temperature },
  };
}

function extractContent(d, model, httpStatus, family) {
  // Wrapped error envelope
  if (d?.code && d.code >= 400) {
    throw new Error(`Kie.ai (${model}) ${d.code}: ${d.msg || 'sin mensaje'}`);
  }
  // Unwrap if wrapped success
  const p = (d?.code === 200 && d?.data) ? d.data : d;

  // Anthropic-style: content array with text blocks
  if (family === 'claude' || p?.content?.[0]?.text) {
    if (p?.content?.[0]?.text) return p.content[0].text;
    if (Array.isArray(p?.content)) {
      const joined = p.content.map(c => c?.text || '').filter(Boolean).join('\n');
      if (joined) return joined;
    }
  }
  // OpenAI shape
  if (p?.choices?.[0]?.message?.content) return p.choices[0].message.content;
  // Plain fields
  if (typeof p?.output_text === 'string') return p.output_text;
  if (typeof p?.text === 'string') return p.text;
  if (p?.error) {
    throw new Error(`Kie.ai (${model}) error: ${p.error.message || JSON.stringify(p.error)}`);
  }
  if (httpStatus >= 400) {
    throw new Error(`Kie.ai (${model}) HTTP ${httpStatus}: ${JSON.stringify(d).slice(0, 300)}`);
  }
  throw new Error(`Kie.ai (${model}) formato inesperado: ${JSON.stringify(d).slice(0, 400)}`);
}

// Main entrypoint. Strips the "kie:" prefix if present, dispatches by family,
// and returns the assistant's text content.
async function callKie({ apiKey, modelId, sysMsg, userPrompt, maxTokens = 4000, temperature = 0.7 }) {
  const model = modelId.startsWith('kie:') ? modelId.slice(4) : modelId;
  const family = detectFamily(model);
  const { url, body } = buildRequest(family, model, sysMsg, userPrompt, maxTokens, temperature);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  return extractContent(d, model, r.status, family);
}

module.exports = { callKie };
