import test from 'node:test';
import assert from 'node:assert/strict';

import { getChatCompletion, generateFollowUpQuestions, transcribeAudio } from '../lib/openai.js';

function mockResponse(t, body, status = 200) {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));
}

test('Responses extracts message text after reasoning and across content blocks', async (t) => {
  mockResponse(t, {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private reasoning' }] },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'The answer ' },
          { type: 'output_text', text: 'is 42.' },
        ],
      },
    ],
  });

  assert.equal(await getChatCompletion([{ role: 'user', content: 'What is the answer?' }]), 'The answer is 42.');
});

test('Responses preserves a refusal instead of sending an empty Telegram reply', async (t) => {
  mockResponse(t, {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
  });

  assert.equal(await getChatCompletion([]), 'I cannot help with that.');
});

test('Responses rejects incomplete output rather than saving a partial answer', async (t) => {
  mockResponse(t, {
    status: 'incomplete',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'A partial answer' }] }],
  });

  await assert.rejects(getChatCompletion([]), /did not complete/);
});

test('Responses rejects completed output without user-visible text', async (t) => {
  mockResponse(t, { status: 'completed', output: [{ type: 'reasoning', summary: [] }] });

  await assert.rejects(getChatCompletion([]), /contained no text/);
});

test('HTTP errors expose status without leaking the provider error body', async (t) => {
  mockResponse(t, { error: { message: 'Private request details', code: 'invalid_api_key' } }, 401);

  await assert.rejects(getChatCompletion([]), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /Private request details|test-key/);
    return true;
  });
});

test('follow-up generation falls back when a question exceeds the UTF-8 byte limit', async (t) => {
  mockResponse(t, {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: JSON.stringify({ questions: ['Explain 語語語語語語語語語', 'Give an example?', 'What next?'] }),
      }],
    }],
  });

  assert.deepEqual(await generateFollowUpQuestions('Explain this', 'An explanation'), []);
});

test('follow-up API failures keep the existing fallback buttons available', async (t) => {
  mockResponse(t, { error: { message: 'Rate limited' } }, 429);

  assert.deepEqual(await generateFollowUpQuestions('Explain this', 'An explanation'), []);
});

test('transcription rejects invalid or empty text instead of silently dropping a voice message', async (t) => {
  for (const text of [undefined, '', '   ', 42]) {
    await t.test(`text ${JSON.stringify(text)}`, async (t) => {
      mockResponse(t, { text });
      await assert.rejects(transcribeAudio(Buffer.from('audio')), /transcription contained no text/);
    });
  }
});

test('follow-up generation normalizes model formatting into usable buttons', async (t) => {
  mockResponse(t, {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: '```json\n' + JSON.stringify({
          questions: [' "Explain   further?" ', 'Give an example?', 'What next?'],
        }) + '\n```',
      }],
    }],
  });

  assert.deepEqual(
    await generateFollowUpQuestions('Explain this', 'An explanation'),
    ['Explain further?', 'Give an example?', 'What next?']
  );
});
