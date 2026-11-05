import test from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdate, sendMessageInChunks } from '../lib/telegram.js';
import { DEFAULT_MODEL } from '../lib/openai.js';
import { checkRateLimit, resetInMemoryRateLimits } from '../lib/rateLimit.js';

function authorizeChat(t, chatId) {
  const previousAdminId = process.env.ADMINID;
  process.env.ADMINID = chatId;
  t.after(() => {
    if (previousAdminId === undefined) delete process.env.ADMINID;
    else process.env.ADMINID = previousAdminId;
  });
}

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
  authorizeChat(t, '1');
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
  authorizeChat(t, '151894779');
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
  authorizeChat(t, '151894779');
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
  process.env.ADMINID = '151894779';
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
  assert.equal(requests[1].url, 'https://api.telegram.org/botlog-token/sendMessage');
  assert.equal(requests[0].body.chat_id, '151894779');
  assert.equal(requests[1].body.chat_id, '151894779');
  assert.deepEqual(JSON.parse(requests[1].body.text.slice('[reply] '.length)), requests[0].body);
});

function captureTelegramRequests(t, adminId) {
  const originalFetch = global.fetch;
  const originalEnv = Object.fromEntries(
    ['TELEGRAM_BOT_API_KEY', 'ADMINID', 'LOGAPIKEY'].map((key) => [key, process.env[key]])
  );
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  process.env.TELEGRAM_BOT_API_KEY = 'test-token';
  process.env.ADMINID = adminId;
  delete process.env.LOGAPIKEY;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ method: url.split('/').pop(), body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return requests;
}

test('/model lets the admin select Astra and marks the current model', async (t) => {
  const requests = captureTelegramRequests(t, '2002');
  await handleUpdate({
    update_id: 10,
    message: { message_id: 10, chat: { id: 2002, type: 'private' }, text: '/model' },
  });
  const buttons = requests.at(-1).body.reply_markup.inline_keyboard.map(([button]) => button);
  assert.ok(buttons.some((button) => button.callback_data === 'model:gpt-6-astra'));
  assert.deepEqual(
    buttons.filter((button) => button.text.startsWith('✓')).map((button) => button.callback_data),
    [`model:${DEFAULT_MODEL}`]
  );
});

test('forged model callbacks cannot select models outside the allowlist', async (t) => {
  const requests = captureTelegramRequests(t, '2002');
  await handleUpdate({
    update_id: 11,
    callback_query: {
      id: 'model-callback',
      data: 'model:not-a-model',
      message: { chat: { id: 2002, type: 'private' } },
    },
  });
  assert.deepEqual(requests.map((request) => request.method), ['answerCallbackQuery']);
  assert.match(requests[0].body.text, /not available/i);
});

test('a model choice is not confirmed when it cannot be saved', async (t) => {
  const requests = captureTelegramRequests(t, '2002');

  await handleUpdate({
    update_id: 12,
    callback_query: {
      id: 'model-callback',
      data: 'model:gpt-6.1-terra',
      message: { chat: { id: 2002, type: 'private' } },
    },
  });

  assert.deepEqual(requests.map((request) => request.method), ['answerCallbackQuery']);
  assert.match(requests[0].body.text, /Could not save/);
});

test('a voice message from a rate-limited chat is not downloaded or transcribed', async (t) => {
  const requests = captureTelegramRequests(t, '3003');
  const originalLimit = process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
  t.after(() => {
    if (originalLimit === undefined) delete process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
    else process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = originalLimit;
    resetInMemoryRateLimits();
  });
  process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = '1';
  await checkRateLimit('3003'); // uses the chat's only request this hour

  await handleUpdate({
    update_id: 13,
    message: { message_id: 13, chat: { id: 3003, type: 'private' }, voice: { file_id: 'voice-file' } },
  });

  assert.deepEqual(requests.map((request) => request.method), ['sendChatAction', 'sendMessage']);
  assert.match(requests[1].body.text, /Hourly limit reached/);
});

test('non-admin messages and callbacks are ignored before any network calls', async (t) => {
  const requests = captureTelegramRequests(t, '2002');
  const chat = { id: 1001, type: 'private' };
  const messages = [
    { text: 'hello' },
    { voice: { file_id: 'voice-file' } },
    ...['/start', '/clear', '/reset', '/compact', '/model'].map((text) => ({ text })),
    { photo: [{ file_id: 'photo-file' }] },
  ];
  for (const message of messages) {
    await handleUpdate({ message: { ...message, chat } });
  }
  for (const data of ['followup:Give an example?', 'model:gpt-6-astra', 'unknown']) {
    await handleUpdate({ callback_query: { id: 'blocked-callback', data, message: { chat } } });
  }
  assert.deepEqual(requests, []);
});

test('missing or empty ADMINID disables replies', async (t) => {
  const requests = captureTelegramRequests(t, '2002');
  for (const adminId of [undefined, '']) {
    if (adminId === undefined) delete process.env.ADMINID;
    else process.env.ADMINID = adminId;
    await handleUpdate({ message: { chat: { id: 2002, type: 'private' }, text: '/start' } });
    await handleUpdate({
      callback_query: {
        id: 'disabled-callback',
        data: 'model:gpt-6-astra',
        message: { chat: { id: 2002, type: 'private' } },
      },
    });
  }
  assert.deepEqual(requests, []);
});

test('a group cannot be authorized by setting ADMINID to its chat ID', async (t) => {
  const requests = captureTelegramRequests(t, '-1002002');
  await handleUpdate({
    message: { chat: { id: -1002002, type: 'supergroup' }, from: { id: 2002 }, text: '/start' },
  });
  assert.deepEqual(requests, []);
});
