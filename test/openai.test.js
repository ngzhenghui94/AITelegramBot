import test from 'node:test';
import assert from 'node:assert/strict';

import { transcribeAudio } from '../lib/openai.js';

function mockFetch(t, body, status = 200) {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async () => new Response(JSON.stringify(body), { status });
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });
}

test('transcription rejects an empty or invalid provider result', async (t) => {
  for (const text of [undefined, '', '   ', 42]) {
    await t.test(String(text), async (t) => {
      mockFetch(t, { text });
      await assert.rejects(transcribeAudio(Buffer.from('audio')), /transcription contained no text/);
    });
  }
});

test('transcription errors expose status without provider body or API key', async (t) => {
  mockFetch(t, { error: { message: 'private provider details' } }, 401);
  await assert.rejects(transcribeAudio(Buffer.from('audio')), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /private provider details|test-key/);
    return true;
  });
});

test('transcription accepts cancellation while the request is pending', async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const controller = new AbortController();
  global.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const pending = transcribeAudio(Buffer.from('audio'), 'voice.ogg', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
