const groqKeys = [...new Set(
  [1, 2, 3, 4].map(i => process.env['GROQ_API_KEY_' + i])
    .concat((process.env.GROQ_API_KEYS || '').split(','))
    .map(key => key && key.trim()).filter(Boolean)
)];
const GOOGLE_KEY = process.env.GOOGLE_API_KEY?.trim();
const QWEN_VISION_MODEL = process.env.QWEN_VISION_MODEL || process.env.QWEN_MODEL || 'qwen/qwen3.8-27b';
const GROQ_REASONING_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const configuredGoogleVisionModel = process.env.GOOGLE_VISION_MODEL?.trim();
const GOOGLE_VISION_MODEL = !configuredGoogleVisionModel || /^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(configuredGoogleVisionModel) ? 'gemini-3.6-flash' : configuredGoogleVisionModel;
const VISION_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 1_000_000;
const MAX_TOTAL_IMAGE_BYTES = 2_450_000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function safeError(text) {
  return String(text || 'Unknown provider error').replace(/\s+/g, ' ').slice(0, 600);
}

export function validateImages(images) {
  if (!Array.isArray(images) || images.length > 3) throw new Error('Upload no more than three images.');
  let total = 0;
  return images.map((image, index) => {
    const mimeType = String(image?.mimeType || '');
    const data = String(image?.data || '').replace(/^data:[^,]+,/, '');
    if (!ALLOWED_MIME.has(mimeType)) throw new Error(`Image ${index + 1} must be PNG, JPEG or WebP.`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length < 16) throw new Error(`Image ${index + 1} is not valid base64 data.`);
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`Image ${index + 1} is larger than 1 MB. Compress it and try again.`);
    total += bytes;
    return { mimeType, data, name: String(image?.name || `reference-${index + 1}`).slice(0, 120) };
  }).filter(image => {
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error('Combined image size exceeds 2.45 MB.');
    return true;
  });
}

async function callGroq(prompt, images) {
  if (!groqKeys.length) throw new Error('No Groq API key is configured.');
  let lastError = 'Groq request failed.';
  for (let i = 0; i < groqKeys.length; i++) {
    const key = groqKeys[i];
    const started = Date.now();
    try {
      const content = [{ type: 'text', text: prompt }, ...images.map(image => ({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      }))];
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: QWEN_VISION_MODEL,
          messages: [{ role: 'user', content }],
          temperature: 0.2,
          max_completion_tokens: 1800,
          stream: false,
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = safeError(await response.text());
        lastError = `Groq key ${i + 1}: HTTP ${response.status} — ${detail}`;
        if ([400, 401, 403, 404, 413, 422].includes(response.status)) {
          if ([400, 413, 422].includes(response.status)) break;
          continue;
        }
        continue;
      }
      const json = await response.json();
      return {
        label: 'Coder', model: QWEN_VISION_MODEL,
        text: json.choices?.[0]?.message?.content || '(The model returned no text.)',
        usage: json.usage || null, ms: Date.now() - started,
      };
    } catch (error) {
      lastError = `Groq key ${i + 1}: ${safeError(error.message)}`;
    }
  }
  throw new Error(lastError);
}


async function callGroqReasoning(prompt) {
  if (!groqKeys.length) throw new Error('No Groq API key is configured.');
  let lastError = 'Groq request failed.';
  for (let i = 0; i < groqKeys.length; i++) {
    const started = Date.now();
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKeys[i]}` },
        body: JSON.stringify({
          model: GROQ_REASONING_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_completion_tokens: 1800,
          stream: false,
        }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastError = `Groq key ${i + 1}: HTTP ${response.status} — ${safeError(await response.text())}`;
        continue;
      }
      const json = await response.json();
      return {
        label: 'Thinker', model: GROQ_REASONING_MODEL,
        text: json.choices?.[0]?.message?.content || '(The model returned no text.)',
        usage: json.usage || null, ms: Date.now() - started,
      };
    } catch (error) {
      lastError = `Groq key ${i + 1}: ${safeError(error.message)}`;
    }
  }
  throw new Error(lastError);
}


// Shared multimodal entry point used by both Model Lab and normal agent chats.
// The main agent stores only this text analysis in its checkpoint, never raw image bytes.
export async function analyzeImages(prompt, images) {
  const valid = validateImages(images);
  if (!valid.length) throw new Error('At least one image is required for visual analysis.');
  const cleanPrompt = String(prompt || '').trim().slice(0, 6_000) ||
    'Inspect the attached reference images carefully. Describe the visible content, layout, text, objects, colors, dimensions when inferable, and relevant details. Separate observations from assumptions.';
  const errors = [];
  if (groqKeys.length) {
    try { return await callGroq(cleanPrompt, valid); }
    catch (error) { errors.push(error.message); }
  }
  if (GOOGLE_KEY) {
    try { return await callGemini(cleanPrompt, valid); }
    catch (error) { errors.push(error.message); }
  }
  throw new Error(errors.join(' | ') || 'No vision provider is configured. Add GROQ_API_KEY_1 or GOOGLE_API_KEY in Vercel.');
}

async function callGemini(prompt, images) {
  if (!GOOGLE_KEY) throw new Error('GOOGLE_API_KEY is not configured.');
  const started = Date.now();
  const parts = [{ text: prompt }, ...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GOOGLE_VISION_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GOOGLE_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1800 },
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Gemini: HTTP ${response.status} — ${safeError(await response.text())}`);
  const json = await response.json();
  const text = (json.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
  return {
    label: 'Genius', model: GOOGLE_VISION_MODEL,
    text: text || '(The model returned no text.)',
    usage: json.usageMetadata ? { total_tokens: json.usageMetadata.totalTokenCount } : null,
    ms: Date.now() - started,
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      qwen: { available: groqKeys.length > 0, model: QWEN_VISION_MODEL, provider: 'Groq', keyCount: groqKeys.length },
      reasoning: { available: groqKeys.length > 0, model: GROQ_REASONING_MODEL, provider: 'Groq', keyCount: groqKeys.length },
      gemini: { available: Boolean(GOOGLE_KEY), model: GOOGLE_VISION_MODEL, provider: 'Google' },
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim().slice(0, 6_000);
    if (!prompt) return res.status(400).json({ error: 'Enter a test prompt.' });
    const images = validateImages(body.images || []);
    const requested = body.model === 'all'
      ? [...(groqKeys.length ? ['qwen'] : []), ...(GOOGLE_KEY ? ['gemini'] : []), ...(!images.length && groqKeys.length ? ['reasoning'] : [])]
      : body.model === 'both' ? ['qwen', 'gemini']
      : [body.model === 'gemini' ? 'gemini' : body.model === 'reasoning' ? 'reasoning' : 'qwen'];
    if (images.length && requested.includes('reasoning')) return res.status(400).json({ error: 'Thinker is text-only. Remove the image(s) or select Coder or Genius for image input.' });
    if (!requested.length) return res.status(400).json({ error: 'No AI provider is configured. Add a Groq or Google API key in Vercel.' });
    const results = await Promise.all(requested.map(async id => {
      try {
        const result = id === 'gemini' ? await callGemini(prompt, images) : id === 'reasoning' ? await callGroqReasoning(prompt) : await callGroq(prompt, images);
        return result;
      } catch (error) {
        return { label: id === 'gemini' ? 'Genius' : id === 'reasoning' ? 'Thinker' : 'Coder', model: id === 'gemini' ? GOOGLE_VISION_MODEL : id === 'reasoning' ? GROQ_REASONING_MODEL : QWEN_VISION_MODEL, error: error.message };
      }
    }));
    return res.status(200).json({ results });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid vision test request.' });
  }
}
