import test from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdate, sendMessageInChunks } from '../lib/telegram.js';

test('sendMessageInChunks retries without HTML parse mode when Telegram rejects entities', async (t) => {
  const originalFetch = global.fetch;
  const originalTelegramToken = process.env.TELEGRAM_BOT_API_KEY;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_API_KEY;
    } else {
      process.env.TELEGRAM_BOT_API_KEY = originalTelegramToken;
    }
  });

  process.env.TELEGRAM_BOT_API_KEY = 'test-token';
  const requests = [];

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });

    if (requests.length === 1) {
      return {
        json: async () => ({
          ok: false,
          description: "Bad Request: can't parse entities: Unmatched end tag",
        }),
      };
    }

    return {
      json: async () => ({
        ok: true,
        result: { message_id: 123 },
      }),
    };
  };

  await sendMessageInChunks('12345', 'broken <b>html</i>', {
    reply_markup: { inline_keyboard: [] },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.parse_mode, 'HTML');
  assert.equal(requests[1].body.parse_mode, undefined);
  assert.deepEqual(requests[1].body.reply_markup, { inline_keyboard: [] });
});

test('handleUpdate does not throw when Telegram cannot send the fallback error reply', async (t) => {
  const originalFetch = global.fetch;
  const originalTelegramToken = process.env.TELEGRAM_BOT_API_KEY;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_API_KEY;
    } else {
      process.env.TELEGRAM_BOT_API_KEY = originalTelegramToken;
    }
  });

  process.env.TELEGRAM_BOT_API_KEY = 'test-token';
  const methods = [];

  global.fetch = async (url, options) => {
    const method = url.split('/').pop();
    methods.push(method);

    return {
      json: async () => ({
        ok: false,
        description: 'Bad Request: chat not found',
      }),
    };
  };

  await assert.doesNotReject(() =>
    handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 1, type: 'private' },
        text: 'hello',
      },
    })
  );

  assert.deepEqual(methods, ['sendChatAction', 'sendMessage']);
});
