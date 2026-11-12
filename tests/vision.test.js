import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Stub provider credentials before importing the route: no real API calls are made.
process.env.GROQ_API_KEY_1 = 'test-groq-key';
process.env.GOOGLE_API_KEY = 'test-google-key';
// Simulate an old deployment setting: the route must redirect this to the current model.
process.env.GOOGLE_VISION_MODEL = 'gemini-2.5-pro';

const realFetch = globalThis.fetch;
process.env.AUTH_SECRET = 'test-auth-secret';
const { signSession } = await import('../api/_auth.js');
const COOKIE = 'kd_session=' + signSession({ uid: 'u1', sid: 'sid-1', username: 'tester' });
const { default: handler, analyzeImages, validateImages } = await import('../api/vision.js?vision-tests');
after(() => { globalThis.fetch = realFetch; });

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

const image = {
  mimeType: 'image/jpeg',
  data: Buffer.from('fake-image-for-route-test').toString('base64'),
};

test('GET reports configured vision model providers without revealing keys', async () => {
  const response = mockResponse();
  await handler({ method: 'GET' }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.qwen.available, true);
  assert.equal(response.payload.gemini.available, true);
  assert.equal(response.payload.gemini.model, 'gemini-3.6-flash');
  assert.equal(JSON.stringify(response.payload).includes('test-groq-key'), false);
});

test('compare mode sends the same prompt and image to Groq and Gemini', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    if (String(url).includes('api.groq.com')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Groq vision result' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini vision result' }] } }] }), { status: 200 });
  };

  const response = mockResponse();
  await handler({ method: 'POST', headers: { cookie: COOKIE }, body: { model: 'both', prompt: 'Describe this image.', images: [image] } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.results.length, 2);
  assert.deepEqual(new Set(response.payload.results.map(item => item.text)), new Set(['Groq vision result', 'Gemini vision result']));
  assert.equal(calls.length, 2);
  assert.equal(calls.find(call => call.url.includes('api.groq.com')).body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'), true);
  assert.equal(calls.find(call => call.url.includes('generativelanguage.googleapis.com')).body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
});

test('rejects unsupported image MIME types', async () => {
  const response = mockResponse();
  await handler({ method: 'POST', headers: { cookie: COOKIE }, body: { model: 'qwen', prompt: 'Test', images: [{ mimeType: 'image/svg+xml', data: 'c3Zn' }] } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /PNG, JPEG or WebP/);
});

test('rejects more than three images', async () => {
  const response = mockResponse();
  await handler({ method: 'POST', headers: { cookie: COOKIE }, body: { model: 'qwen', prompt: 'Test', images: [image, image, image, image] } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.payload.error, /three images/i);
});


test('all mode runs available multimodal models for image input and excludes text-only reasoning', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('api.groq.com')) return new Response(JSON.stringify({ choices: [{ message: { content: 'Qwen result' } }] }), { status: 200 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini result' }] } }] }), { status: 200 });
  };
  const response = mockResponse();
  await handler({ method: 'POST', headers: { cookie: COOKIE }, body: { model: 'all', prompt: 'Inspect.', images: [image] } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.results.length, 2);
  assert.equal(calls.some(url => url.includes('generativelanguage.googleapis.com')), true);
  assert.equal(calls.length, 2);
});

test('all mode includes the text-only reasoning model when no image is attached', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('api.groq.com')) {
      const model = JSON.parse(options.body).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: model } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini text result' }] } }] }), { status: 200 });
  };
  const response = mockResponse();
  await handler({ method: 'POST', headers: { cookie: COOKIE }, body: { model: 'all', prompt: 'Explain recursion.', images: [] } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.results.length, 3);
  assert.equal(response.payload.results.some(item => item.label === 'Thinker'), true);
});


test('normal agent vision analysis calls a multimodal model with the attached image', async () => {
  let captured;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A settings page with a left sidebar and blue save button.' } }] }), { status: 200 });
  };
  const result = await analyzeImages('Inspect this UI reference for implementation.', [image]);
  assert.match(result.text, /left sidebar/);
  assert.equal(captured.body.model, process.env.QWEN_VISION_MODEL || process.env.QWEN_MODEL || 'qwen/qwen3.8-27b');
  assert.equal(captured.body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'), true);
});

test('normal agent automatically falls back to Gemini when Groq vision fails', async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('api.groq.com')) return new Response('temporary provider failure', { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini inspected the screenshot.' }] } }] }), { status: 200 });
  };
  const result = await analyzeImages('Inspect this screenshot.', [image]);
  assert.match(result.text, /Gemini inspected/);
  assert.equal(result.label, 'Genius');
  assert.equal(calls.length, 2);
});

test('visual analysis rejects a missing image list', async () => {
  await assert.rejects(analyzeImages('Inspect this.', []), /At least one image/);
});
