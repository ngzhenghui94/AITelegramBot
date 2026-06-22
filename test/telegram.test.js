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

test('/reset clears the session without sending a typing action', async (t) => {
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
    requests.push({
      method: url.split('/').pop(),
      body: JSON.parse(options.body),
    });

    return {
      json: async () => ({
        ok: true,
        result: { message_id: 456 },
      }),
    };
  };

  await handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      chat: { id: 151894779, type: 'private' },
      text: '/reset',
    },
  });

  assert.deepEqual(requests.map((request) => request.method), ['sendMessage']);
  assert.equal(requests[0].body.text, 'Conversation history cleared.');
});

test('/compact with no stored session replies without calling typing', async (t) => {
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
    requests.push({
      method: url.split('/').pop(),
      body: JSON.parse(options.body),
    });

    return {
      json: async () => ({
        ok: true,
        result: { message_id: 789 },
      }),
    };
  };

  await handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      chat: { id: 151894779, type: 'private' },
      text: '/compact',
    },
  });

  assert.deepEqual(requests.map((request) => request.method), ['sendMessage']);
  assert.match(requests[0].body.text, /No conversation history/i);
});

test('successful bot replies are mirrored to the admin log chat', async (t) => {
  const originalFetch = global.fetch;
  const originalTelegramToken = process.env.TELEGRAM_BOT_API_KEY;
  const originalAdminId = process.env.ADMINID;
  const originalLogApiKey = process.env.LOGAPIKEY;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalTelegramToken === undefined) {
      delete process.env.TELEGRAM_BOT_API_KEY;
    } else {
      process.env.TELEGRAM_BOT_API_KEY = originalTelegramToken;
    }
    if (originalAdminId === undefined) {
      delete process.env.ADMINID;
    } else {
      process.env.ADMINID = originalAdminId;
    }
    if (originalLogApiKey === undefined) {
      delete process.env.LOGAPIKEY;
    } else {
      process.env.LOGAPIKEY = originalLogApiKey;
    }
  });

  process.env.TELEGRAM_BOT_API_KEY = 'test-token';
  process.env.ADMINID = 'admin-chat';
  process.env.LOGAPIKEY = 'log-token';
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({
      url,
      method: url.split('/').pop(),
      body: JSON.parse(options.body),
    });

    return {
      json: async () => ({
        ok: true,
        result: { message_id: 999 },
      }),
    };
  };

  await handleUpdate({
    update_id: 4,
    message: {
      message_id: 4,
      chat: { id: 151894779, type: 'private' },
      text: '/reset',
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(requests[0].body.text, 'Conversation history cleared.');
  assert.equal(requests[1].url, 'https://api.telegram.org/botlog-token/sendMessage');
  assert.equal(requests[1].body.chat_id, 'admin-chat');
  assert.equal(
    requests[1].body.text,
    '[reply] {"chat_id":"151894779","text":"Conversation history cleared."}'
  );
});
