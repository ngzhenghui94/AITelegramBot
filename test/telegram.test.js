import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelegramHandler,
  sendMessageInChunks,
} from '../lib/telegram.js';
import { resetInMemoryRateLimits } from '../lib/rateLimit.js';

const ADMIN_ID = '424242';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function adminMessage(text, messageId = 1, extra = {}) {
  return {
    message_id: messageId,
    chat: { id: Number(ADMIN_ID), type: 'private' },
    from: { id: Number(ADMIN_ID) },
    text,
    ...extra,
  };
}

function fakeAgent() {
  let busy = false;
  let gate = null;
  const state = {
    runCount: 0,
    prompts: [],
    answers: [],
    abortCount: 0,
    modelChanges: [],
  };

  return {
    state,
    isBusy: () => busy,
    async run(chatId, prompt, operationCallbacks) {
      busy = true;
      state.runCount += 1;
      state.prompts.push(prompt);
      gate = deferred();
      await operationCallbacks.onDialog({
        id: `dialog-${state.runCount}`,
        method: 'select',
        title: 'Allow tool: shell command /tmp/full-details',
        message: 'Full command details must remain visible.',
        optionDetails: ['single approval', 'single approval', 'session grant', 'deny'],
        options: ['Approve', 'Approve Once', 'Approve for this session', 'Deny'],
      });
      const result = await gate.promise;
      busy = false;
      if (result?.status === 'aborted') return result;
      await operationCallbacks.onText('Done.');
      await operationCallbacks.onDialogClosed(`dialog-${state.runCount}`);
      return { status: 'completed' };
    },
    answer(chatId, dialogId, response) {
      state.answers.push({ chatId, dialogId, response });
      gate?.resolve({ status: 'completed' });
      return true;
    },
    async abort() {
      state.abortCount += 1;
      busy = false;
      gate?.resolve({ status: 'aborted' });
      return true;
    },
    async reset() {},
    async compact() {},
    async models() {
      return {
        current: { provider: 'openai', id: 'gpt-current' },
        models: [
          { provider: 'openai', id: 'gpt-current', name: 'Current' },
          { provider: 'openai', id: 'gpt-next', name: 'Next' },
        ],
      };
    },
    async setModel(chatId, provider, modelId) {
      state.modelChanges.push({ chatId, provider, modelId });
      return { provider, id: modelId };
    },
    async close() {},
  };
}

function inputAgent() {
  let busy = false;
  let gate;
  const state = { answers: [], runCount: 0 };
  return {
    state,
    isBusy: () => busy,
    async run(chatId, prompt, operationCallbacks) {
      busy = true;
      state.runCount += 1;
      gate = deferred();
      await operationCallbacks.onDialog({
        id: 'input-dialog',
        method: 'input',
        title: 'Clarification',
        message: 'What should the tool focus on?',
      });
      await gate.promise;
      busy = false;
      await operationCallbacks.onText('Clarified.');
      await operationCallbacks.onDialogClosed('input-dialog');
      return { status: 'completed' };
    },
    answer(chatId, dialogId, response) {
      state.answers.push({ chatId, dialogId, response });
      gate.resolve();
      return true;
    },
    async abort() {
      busy = false;
      gate?.resolve();
      return true;
    },
    async close() {},
  };
}

function telegramHarness(t, agent = fakeAgent()) {
  const originalFetch = global.fetch;
  const originalEnv = Object.fromEntries(
    ['TELEGRAM_BOT_API_KEY', 'ADMINID', 'OPENAI_API_KEY', 'RATE_LIMIT_PER_CHAT_PER_HOUR'].map((key) => [key, process.env[key]])
  );
  process.env.TELEGRAM_BOT_API_KEY = 'telegram-test-token';
  process.env.ADMINID = ADMIN_ID;
  process.env.OPENAI_API_KEY = 'openai-test-key';
  delete process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
  resetInMemoryRateLimits();

  const requests = [];
  let nextMessageId = 100;
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('https://api.openai.com/')) {
      return new Response(JSON.stringify({ text: 'voice text' }), { status: 200 });
    }
    if (url.includes('/file/bot')) {
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    const body = options.body ? JSON.parse(options.body) : {};
    const method = url.split('/').pop();
    requests.push({ method, body });
    if (method === 'sendMessage') {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: nextMessageId++ } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };

  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetInMemoryRateLimits();
  });

  return { agent, requests, handler: createTelegramHandler({ agent }) };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for Telegram task state');
}

test('sendMessageInChunks keeps HTML fallback and puts markup on the final chunk', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.TELEGRAM_BOT_API_KEY;
  process.env.TELEGRAM_BOT_API_KEY = 'telegram-test-token';
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return { ok: true, json: async () => ({ ok: false, description: "can't parse entities" }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_API_KEY;
    else process.env.TELEGRAM_BOT_API_KEY = originalToken;
  });

  await sendMessageInChunks('424242', 'bad <b>html</i>', {
    reply_markup: { inline_keyboard: [] },
  });
  assert.equal(requests[0].parse_mode, 'HTML');
  assert.equal(requests[1].parse_mode, undefined);
  assert.deepEqual(requests[1].reply_markup, { inline_keyboard: [] });
});

test('unauthorized or disabled access silently ignores messages and callbacks before network or agent work', async (t) => {
  const { agent, requests, handler } = telegramHarness(t);
  const blocked = [
    { chat: { id: Number(ADMIN_ID), type: 'group' } },
    { chat: { id: 99, type: 'private' } },
    { from: { id: 99 } },
    { from: undefined },
  ];
  for (const fields of blocked) {
    const message = adminMessage('/start', 1, fields);
    await handler.handleUpdate({ message });
    await handler.handleUpdate({ message: { ...message, text: undefined, voice: { file_id: 'private-audio' } } });
    await handler.handleUpdate({
      callback_query: { id: 'blocked', data: 'omp-dialog:blocked', from: message.from, message },
    });
  }
  for (const adminId of [undefined, '', '-100123']) {
    if (adminId === undefined) delete process.env.ADMINID;
    else process.env.ADMINID = adminId;
    const message = adminMessage('/start', 2);
    await handler.handleUpdate({ message });
    await handler.handleUpdate({
      callback_query: { id: 'disabled', data: 'omp-dialog:disabled', from: message.from, message },
    });
  }
  assert.equal(agent.state.runCount, 0);
  assert.deepEqual(requests, []);
});

test('pending OMP approval remains live while task is admitted, and replay/forged callbacks are rejected', async (t) => {
  const { agent, requests, handler } = telegramHarness(t);
  await handler.handleUpdate({ message: adminMessage('run a tool', 10) });
  await waitFor(() => requests.some((request) => request.method === 'sendMessage' && request.body.reply_markup));

  const approvalRequest = requests.find((request) => request.body.reply_markup);
  const buttons = approvalRequest.body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => !/always|session/i.test(button.text)));
  assert.match(approvalRequest.body.text, /full-details/);
  const callbackData = buttons[0].callback_data;
  assert.ok(callbackData);

  await handler.handleUpdate({
    callback_query: {
      id: 'forged',
      data: callbackData,
      from: { id: 99 },
      message: { message_id: 100, chat: { id: Number(ADMIN_ID), type: 'private' } },
    },
  });
  assert.equal(agent.state.answers.length, 0);

  const botMessageId = approvalRequest.body.message_id || 100;
  await handler.handleUpdate({
    callback_query: {
      id: 'approval',
      data: callbackData,
      from: { id: Number(ADMIN_ID) },
      message: { message_id: botMessageId, chat: { id: Number(ADMIN_ID), type: 'private' } },
    },
  });
  await waitFor(() => agent.state.answers.length === 1);
  assert.equal(agent.state.answers[0].response.value, 'Approve');

  await handler.handleUpdate({
    callback_query: {
      id: 'replay',
      data: callbackData,
      from: { id: Number(ADMIN_ID) },
      message: { message_id: botMessageId, chat: { id: Number(ADMIN_ID), type: 'private' } },
    },
  });
  assert.equal(agent.state.answers.length, 1);
  await handler.shutdownTelegram();
});

test('input dialogs require a reply to the originating ForceReply message', async (t) => {
  const { agent, requests, handler } = telegramHarness(t, inputAgent());
  await handler.handleUpdate({ message: adminMessage('ask tool', 50) });
  await waitFor(() => requests.some((request) => request.body.reply_markup?.force_reply));
  const promptMessageId = requests.find((request) => request.body.reply_markup?.force_reply).body.message_id || 100;

  await handler.handleUpdate({ message: adminMessage('unrelated text', 51) });
  await waitFor(() => requests.some((request) => /already in progress/.test(request.body.text || '')));
  assert.equal(agent.state.answers.length, 0);

  await handler.handleUpdate({
    message: adminMessage('focus on the config file', 52, {
      reply_to_message: { message_id: promptMessageId },
    }),
  });
  await waitFor(() => agent.state.answers.length === 1);
  assert.equal(agent.state.answers[0].response.value, 'focus on the config file');
  await handler.shutdownTelegram();
});

test('ordinary messages receive busy notice while a task is pending', async (t) => {
  const { agent, requests, handler } = telegramHarness(t);
  await handler.handleUpdate({ message: adminMessage('first', 20) });
  await waitFor(() => agent.state.runCount === 1);
  await handler.handleUpdate({ message: adminMessage('second', 21) });
  await waitFor(() => requests.some((request) => /already in progress/.test(request.body.text || '')));
  assert.equal(agent.state.runCount, 1);
  await handler.shutdownTelegram();
});

test('cancellation during voice transcription prevents a later OMP run', async (t) => {
  const { agent, requests, handler } = telegramHarness(t);
  const originalFetch = global.fetch;
  let transcriptionStarted = false;
  global.fetch = async (url, options = {}) => {
    if (url.startsWith('https://api.openai.com/')) {
      transcriptionStarted = true;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return originalFetch(url, options);
  };
  await handler.handleUpdate({
    message: adminMessage('', 30, { text: undefined, voice: { file_id: 'voice-file' } }),
  });
  await waitFor(() => transcriptionStarted);
  await handler.handleUpdate({ message: adminMessage('/cancel', 31) });
  await waitFor(() => agent.state.abortCount === 1);
  assert.equal(agent.state.runCount, 0);
  assert.ok(requests.some((request) => /Cancellation requested/.test(request.body.text || '')));
  await handler.shutdownTelegram();
});

test('/model uses exact catalog tokens and rejects forged callback data', async (t) => {
  const { agent, requests, handler } = telegramHarness(t);
  await handler.handleUpdate({ message: adminMessage('/model', 40) });
  await waitFor(() => requests.some((request) => request.body.reply_markup));
  const picker = requests.find((request) => request.body.reply_markup);
  const button = picker.body.reply_markup.inline_keyboard[1][0];
  await handler.handleUpdate({
    callback_query: {
      id: 'forged-model',
      data: 'omp-model:not-a-real-token',
      from: { id: Number(ADMIN_ID) },
      message: { message_id: 100, chat: { id: Number(ADMIN_ID), type: 'private' } },
    },
  });
  assert.equal(agent.state.modelChanges.length, 0);
  await handler.handleUpdate({
    callback_query: {
      id: 'model',
      data: button.callback_data,
      from: { id: Number(ADMIN_ID) },
      message: { message_id: 100, chat: { id: Number(ADMIN_ID), type: 'private' } },
    },
  });
  await waitFor(() => agent.state.modelChanges.length === 1);
  assert.deepEqual(agent.state.modelChanges[0], {
    chatId: ADMIN_ID,
    provider: 'openai',
    modelId: 'gpt-next',
  });
  await handler.shutdownTelegram();
});
