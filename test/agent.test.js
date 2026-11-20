import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentBridge } from '../lib/agent.js';
import { configuredClaudeModel } from '../lib/agentRuntime.js';

const TELEGRAM_TASK_PREFIX = 'Telegram user request:\n\n';

class FakeInput extends EventEmitter {
  constructor(onFrame) {
    super();
    this.onFrame = onFrame;
    this.frames = [];
    this.ended = false;
  }

  write(value) {
    const frame = JSON.parse(String(value));
    this.frames.push(frame);
    this.onFrame(frame);
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(onFrame) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.terminated = false;
    this.terminateCalls = 0;
    this.stdin = new FakeInput(onFrame);
  }

  terminate() {
    this.terminateCalls += 1;
    this.terminated = true;
    queueMicrotask(() => this.emit('close', 0, null));
    return Promise.resolve();
  }

  emitLine(frame, split = false) {
    const line = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (!split) {
      this.stdout.emit('data', line);
      return;
    }
    const middle = Math.max(1, Math.floor(line.length / 2));
    this.stdout.emit('data', line.subarray(0, middle));
    this.stdout.emit('data', line.subarray(middle));
  }

  emitLogical(frame, split = true) {
    const bytes = Buffer.from(JSON.stringify(frame));
    const chunkSize = Math.max(1, Math.ceil(bytes.length / 3));
    const count = Math.ceil(bytes.length / chunkSize);
    for (let index = 0; index < count; index += 1) {
      const part = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
      this.emitLine({
        type: 'rpc_chunk',
        chunkId: 'logical-1',
        index,
        count,
        byteLength: bytes.length,
        data: part.toString('base64'),
      }, split);
    }
  }
}

async function withStateDir(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'omp-agent-test-'));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function makeHarness({ onCommand, onSetModel, pointers = new Map(), models = new Map(), setModelError = false } = {}) {
  const children = [];
  const launches = [];
  const durableSessions = new Set(pointers.values());
  let sessionNumber = 0;
  const launch = ({ chatId, sessionFile, modelId }) => {
    launches.push({ chatId, sessionFile, modelId });
    if (!pointers.has(chatId)) {
      pointers.set(chatId, `/home/agent/sessions/chat-${chatId}.json`);
    }
    if (!models.has(chatId)) {
      models.set(chatId, { provider: 'anthropic', id: configuredClaudeModel() });
    }

    let child;
    child = new FakeChild((frame) => {
      const emit = (payload, split = false) => child.emitLine(payload, split);
      const state = () => ({
        type: 'response',
        id: frame.id,
        command: frame.type,
        success: true,
        data: {
          sessionFile: pointers.get(chatId),
          model: models.get(chatId),
          isSettled: true,
        },
      });

      if (frame.type === 'negotiate_protocol') {
        emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: { protocolVersion: 2 } });
      } else if (frame.type === 'get_state') {
        emit(state());
      } else if (frame.type === 'get_available_models') {
        emit({
          type: 'response',
          id: frame.id,
          command: frame.type,
          success: true,
          data: {
            models: [
              { provider: 'anthropic', id: configuredClaudeModel(), name: 'Default Claude' },
              { provider: 'anthropic', id: 'claude-test', name: 'Claude test' },
            ],
          },
        });
      } else if (frame.type === 'set_model') {
        if (typeof onSetModel === 'function') {
          onSetModel({ frame, child, emit, state, pointers, models });
          return;
        }
        if (setModelError) {
          emit({
            type: 'response',
            id: frame.id,
            command: frame.type,
            success: false,
            error: 'Model not found: requested/model',
          });
        } else {
          models.set(chatId, { provider: frame.provider, id: frame.modelId });
          emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: models.get(chatId) });
        }
      } else if (frame.type === 'new_session') {
        pointers.set(chatId, `/home/agent/sessions/chat-${chatId}-${++sessionNumber}.json`);
        durableSessions.add(pointers.get(chatId));
        emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} });
      } else if (frame.type === 'abort') {
        // The bridge intentionally does not wait for an abort acknowledgement.
      } else if (typeof onCommand === 'function') {
        onCommand({ frame, child, emit, state, pointers, models });
      }
    });
    children.push(child);
    queueMicrotask(() => {
      if (sessionFile && !durableSessions.has(sessionFile)) {
        child.emit('close', 1, null);
        return;
      }
      child.emitLine({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      }, true);
    });
    return child;
  };
  return { launch, children, launches, pointers, models };
}

function promptFrames(emit, id, text = 'Answer') {
  emit({
    type: 'response',
    id,
    command: 'prompt',
    success: true,
    data: { agentInvoked: true },
  });
  emit({
    type: 'message_end',
    messageId: `message-${id}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
  emit({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
  emit({ type: 'session_settled' });
}

test('run waits for session settlement and emits only one public assistant text', async (t) => {
  const stateDir = await withStateDir(t);
  const events = new EventEmitter();
  let delayedSettle;
  const harness = makeHarness({
    onCommand: ({ frame, child, emit }) => {
      if (frame.type !== 'prompt') {
        return;
      }
      emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
      emit({
        type: 'message_end',
        messageId: 'message-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'visible answer' }] },
      });
      emit({ type: 'agent_end', messages: [], isTerminal: false, yielded: true, awaitingAsyncWork: true });
      emit({ type: 'prompt_result', id: frame.id, agentInvoked: true, status: 'completed', sessionSettled: false });
      delayedSettle = () => emit({ type: 'session_settled' });
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500, approvalTimeoutMs: 100 });
  t.after(() => bridge.close());

  const texts = [];
  const textReady = once(events, 'text');
  const pending = bridge.run(100, 'hello', {
    onText: async (text) => { texts.push(text); events.emit('text'); },
  });
  await textReady;
  assert.deepEqual(texts, ['visible answer']);
  assert.equal(delayedSettle instanceof Function, true);
  delayedSettle();
  assert.deepEqual(await pending, { status: 'completed' });

  const metadata = JSON.parse(await readFile(path.join(stateDir, '100.json'), 'utf8'));
  assert.equal(metadata.sessionFile, harness.pointers.get('100'));
});

test('slash-prefixed user text is submitted as literal task content', async (t) => {
  const stateDir = await withStateDir(t);
  let submitted;
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type !== 'prompt') {
        return;
      }
      submitted = frame.message;
      promptFrames(emit, frame.id, 'literal slash answer');
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  await bridge.run(108, '/config reveal secrets');
  assert.equal(submitted, `${TELEGRAM_TASK_PREFIX}/config reveal secrets`);
});

test('failed prompt results reject without pretending to complete', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type !== 'prompt') {
        return;
      }
      emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
      emit({
        type: 'prompt_result',
        id: frame.id,
        agentInvoked: true,
        status: 'error',
        error: { message: 'provider failed', retryable: false },
        sessionSettled: true,
      });
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  await assert.rejects(bridge.run(101, 'fail me'), /provider failed/);
});

test('a chat can restart before its first prompt without resuming a nonexistent file', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness();
  const first = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  const initial = await first.start(113);
  await first.close();

  const second = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => second.close());
  const resumed = await second.start(113);
  assert.equal(resumed.sessionFile, initial.sessionFile);
});

test('reset persists exact new pointer and the next bridge resumes it', async (t) => {
  const stateDir = await withStateDir(t);
  const first = makeHarness();
  const bridge = new AgentBridge({ launch: first.launch, stateDir, timeoutMs: 500 });
  await bridge.models(102);
  await bridge.reset(102);
  await bridge.close();

  const sessionFile = first.pointers.get('102');
  const second = makeHarness({ pointers: new Map([['102', sessionFile]]) });
  const restored = new AgentBridge({ launch: second.launch, stateDir, timeoutMs: 500 });
  t.after(() => restored.close());
  await restored.start(102);
  assert.equal(second.launches[0].sessionFile, sessionFile);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, '102.json'), 'utf8')).sessionFile, sessionFile);
});

test('resumed legacy or missing models migrate before work without replacing history or resending context', async (t) => {
  for (const [name, model] of [
    ['legacy provider', { provider: 'openai', id: 'gpt-old' }],
    ['missing model', undefined],
    ['worker substituted a different Claude model', { provider: 'anthropic', id: 'claude-auto-default' }],
  ]) {
    for (const kind of ['run', 'compact']) {
      await t.test(`${name}: ${kind}`, async (t) => {
        const stateDir = await withStateDir(t);
        const sessionFile = '/home/agent/sessions/retained-history.json';
        const selected = { provider: 'anthropic', id: configuredClaudeModel() };
        await writeFile(path.join(stateDir, '120.json'), JSON.stringify({ sessionFile }));
        const harness = makeHarness({
          pointers: new Map([['120', sessionFile]]),
          models: new Map([['120', model]]),
          onCommand: ({ frame, emit, models, pointers }) => {
            assert.deepEqual(models.get('120'), selected);
            assert.equal(pointers.get('120'), sessionFile);
            if (frame.type === 'prompt') {
              promptFrames(emit, frame.id, 'continued history');
            } else if (frame.type === 'compact') {
              emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} });
            }
          },
        });
        const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
        t.after(() => bridge.close());
        const texts = [];
        const starting = bridge.start(120);
        const operation = kind === 'run'
          ? bridge.run(120, 'continue once', { onText: async (text) => texts.push(text) })
          : bridge.compact(120);
        await Promise.all([starting, operation]);

        assert.deepEqual(harness.launches, [{ chatId: '120', sessionFile, modelId: selected.id }]);
        const frames = harness.children[0].stdin.frames;
        assert.deepEqual(frames.map(({ type }) => type), [
          'negotiate_protocol',
          'get_state',
          'set_model',
          'get_state',
          kind === 'run' ? 'prompt' : 'compact',
          'get_state',
        ]);
        const selection = frames.find(({ type }) => type === 'set_model');
        assert.equal(selection.provider, selected.provider);
        assert.equal(selection.modelId, selected.id);
        if (kind === 'run') {
          assert.equal(frames.find(({ type }) => type === 'prompt').message,
            `${TELEGRAM_TASK_PREFIX}continue once`);
          assert.deepEqual(texts, ['continued history']);
        }
        assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, '120.json'), 'utf8')), {
          sessionFile, claudeModel: selected.id,
        });
        assert.deepEqual((await bridge.models(120)).current, selected);
        assert.equal(frames.filter(({ type }) => type === 'set_model').length, 1);
      });
    }
  }
});

test('resuming preserves a previously selected Anthropic model', async (t) => {
  const stateDir = await withStateDir(t);
  const sessionFile = '/home/agent/sessions/selected-claude-history.json';
  const selected = { provider: 'anthropic', id: 'claude-previously-selected', name: 'Previously selected' };
  await writeFile(path.join(stateDir, '121.json'), JSON.stringify({ sessionFile, claudeModel: selected.id }));
  const harness = makeHarness({
    pointers: new Map([['121', sessionFile]]),
    models: new Map([['121', selected]]),
    onCommand: ({ frame, emit }) => {
      if (frame.type === 'prompt') promptFrames(emit, frame.id);
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  await bridge.run(121, 'keep my model and history');
  assert.deepEqual((await bridge.models(121)).current, selected);
  assert.deepEqual(harness.launches, [{ chatId: '121', sessionFile, modelId: selected.id }]);
  assert.equal(harness.children[0].stdin.frames.some(
    ({ type }) => type === 'set_model' || type === 'new_session'
  ), false);
});

test('resume migration fails closed on rejection, unverified selection, or changed history', async (t) => {
  for (const [name, onSetModel, expectedError] of [
    ['rejected selection', ({ frame, emit }) => {
      emit({ type: 'response', id: frame.id, command: frame.type, success: false, error: 'Model unavailable' });
    }, /Model unavailable/],
    ['acknowledged without changing provider', ({ frame, emit }) => {
      emit({
        type: 'response', id: frame.id, command: frame.type, success: true,
        data: { provider: 'anthropic', id: frame.modelId },
      });
    }, /did not select the configured Anthropic model/],
    ['wrong Anthropic model', ({ frame, emit, models }) => {
      models.set('122', { provider: 'anthropic', id: 'claude-unrequested' });
      emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} });
    }, /did not select the configured Anthropic model/],
    ['changed session', ({ frame, emit, models, pointers }) => {
      models.set('122', { provider: 'anthropic', id: frame.modelId });
      pointers.set('122', '/home/agent/sessions/unexpected-new-history.json');
      emit({ type: 'response', id: frame.id, command: frame.type, success: true, data: {} });
    }, /session path changed unexpectedly/],
  ]) {
    await t.test(name, async (t) => {
      const stateDir = await withStateDir(t);
      const sessionFile = '/home/agent/sessions/must-retain-history.json';
      await writeFile(path.join(stateDir, '122.json'), JSON.stringify({ sessionFile }));
      const harness = makeHarness({
        pointers: new Map([['122', sessionFile]]),
        models: new Map([['122', { provider: 'openai', id: 'gpt-old' }]]),
        onSetModel,
      });
      const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
      t.after(() => bridge.close());
      const texts = [];

      await assert.rejects(bridge.run(122, 'must not send', {
        onText: async (text) => texts.push(text),
      }), expectedError);
      assert.deepEqual(texts, []);
      assert.equal(harness.children[0].terminateCalls, 1);
      const frames = harness.children[0].stdin.frames;
      assert.equal(frames.some(({ type }) => ['prompt', 'compact', 'new_session'].includes(type)), false);
      assert.equal(frames.filter(({ type }) => type === 'set_model').length, 1);
      assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, '122.json'), 'utf8')), { sessionFile });
    });
  }
});

test('new Anthropic workers do not receive a redundant startup model change', async (t) => {
  const stateDir = await withStateDir(t);
  const selected = { provider: 'anthropic', id: configuredClaudeModel() };
  const harness = makeHarness({ models: new Map([['123', selected]]) });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  await bridge.start(123);
  assert.deepEqual(harness.launches, [{ chatId: '123', sessionFile: undefined, modelId: selected.id }]);
  assert.deepEqual(harness.children[0].stdin.frames.map(({ type }) => type), [
    'negotiate_protocol', 'new_session', 'get_state',
  ]);
});

test('models expose the live catalog and setModel never falls back providers', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness();
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  const available = await bridge.models(103);
  assert.deepEqual(available.current, { provider: 'anthropic', id: configuredClaudeModel() });
  assert.deepEqual(available.models.map(({ provider, id }) => `${provider}/${id}`), [
    `anthropic/${configuredClaudeModel()}`,
    'anthropic/claude-test',
  ]);
  assert.deepEqual(await bridge.setModel(103, 'anthropic', 'claude-test'), {
    provider: 'anthropic',
    id: 'claude-test',
  });
  assert.deepEqual((await bridge.models(103)).current, { provider: 'anthropic', id: 'claude-test' });
  const rejectingHarness = makeHarness({ setModelError: true });
  const rejectingBridge = new AgentBridge({ launch: rejectingHarness.launch, stateDir, timeoutMs: 500 });
  t.after(() => rejectingBridge.close());
  await assert.rejects(rejectingBridge.setModel(110, 'anthropic', 'missing'), /Model not found/);
  assert.deepEqual((await rejectingBridge.models(110)).current, available.current);
});

test('approval answers are schema-checked, single-use, chat-bound, and expire', async (t) => {
  const stateDir = await withStateDir(t);
  const events = new EventEmitter();
  let dialogId;
  let dialogSeen;
  let promptFrame;
  let dialogCount = 0;
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type === 'prompt') {
        promptFrame = frame;
        dialogCount += 1;
        dialogId = `approval-${dialogCount}`;
        emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
        emit({
          type: 'extension_ui_request',
          id: dialogId,
          method: 'select',
          title: 'Approve',
          message: 'Run tool?',
          options: ['Approve once', 'Deny'],
        });
        return;
      }
      if (frame.type === 'extension_ui_response' && frame.id === dialogId) {
        promptFrames(emit, promptFrame.id, 'approved answer');
      }
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500, approvalTimeoutMs: 30 });
  t.after(() => bridge.close());

  const firstDialog = once(events, 'dialog');
  const firstRun = bridge.run(104, 'run tool', {
    onDialog: async (dialog) => { dialogSeen = dialog; events.emit('dialog'); },
    onDialogClosed: async () => {},
  });
  await firstDialog;
  assert.equal(dialogSeen.options[0], 'Approve once');
  assert.equal(bridge.answer(105, dialogId, { value: 'Approve once' }), false);
  assert.equal(bridge.answer(104, dialogId, { value: 'Always' }), false);
  assert.equal(bridge.answer(104, dialogId, { value: 'Approve once' }), true);
  assert.equal(bridge.answer(104, dialogId, { value: 'Approve once' }), false);
  assert.deepEqual(await firstRun, { status: 'completed' });

  const secondDialog = once(events, 'dialog');
  const secondRun = bridge.run(104, 'run another tool', {
    onDialog: async (dialog) => { dialogSeen = dialog; events.emit('dialog'); },
  });
  await secondDialog;
  const expiredDialogId = dialogId;
  assert.equal(expiredDialogId, 'approval-2');
  assert.deepEqual(await secondRun, { status: 'completed' });
  assert.equal(bridge.answer(104, expiredDialogId, { value: 'Approve once' }), false);
});

test('busy reservation rejects a concurrent run before asynchronous startup', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type === 'prompt') {
        emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
      }
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  const first = bridge.run(109, 'first');
  await assert.rejects(bridge.run(109, 'second'), /busy/);
  await bridge.abort(109);
  assert.deepEqual(await first, { status: 'aborted' });
});

test('abort forcibly terminates a worker and settles the run as aborted', async (t) => {
  const stateDir = await withStateDir(t);
  const events = new EventEmitter();
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type === 'prompt') {
        emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
        events.emit('prompt');
      }
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  const admitted = once(events, 'prompt');
  const run = bridge.run(106, 'long task');
  await admitted;
  assert.equal(bridge.isBusy(106), true);
  assert.equal(await bridge.abort(106), true);
  assert.deepEqual(await run, { status: 'aborted' });
  assert.equal(harness.children[0].terminateCalls, 1);
  assert.equal(bridge.isBusy(106), false);
});

test('concurrent startup requests share one worker and one session', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness();
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());
  const [first, second] = await Promise.all([bridge.start(110), bridge.start(110)]);
  assert.equal(harness.children.length, 1);
  assert.equal(first, second);
});

test('failed container removal blocks replacement even after the Docker client exits', async (t) => {
  const stateDir = await withStateDir(t);
  const events = new EventEmitter();
  const harness = makeHarness({
    onCommand: ({ frame, emit }) => {
      if (frame.type === 'prompt') {
        emit({ type: 'response', id: frame.id, command: 'prompt', success: true });
        events.emit('prompt');
      }
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => Promise.allSettled([bridge.close()]));
  await bridge.start(111);
  harness.children[0].terminate = async () => {
    harness.children[0].emit('close', null, 'SIGKILL');
    throw new Error('Container removal failed');
  };
  const admitted = once(events, 'prompt');
  const run = bridge.run(111, 'run a task');
  await admitted;
  await assert.rejects(bridge.abort(111), /Container removal failed/);
  assert.deepEqual(await run, { status: 'aborted' });
  assert.equal(bridge.isBusy(111), true);
  await assert.rejects(bridge.start(111), /Container removal failed/);
  assert.equal(harness.children.length, 1);
});

test('corrupt or oversized RPC frames fail the task and terminate its worker', async (t) => {
  for (const [name, data] of [
    ['invalid JSON', Buffer.from('not-json\n')],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['oversized frame', Buffer.alloc(1024 * 1024 + 1, 0x61)],
  ]) {
    await t.test(name, async (t) => {
      const stateDir = await withStateDir(t);
      const harness = makeHarness({
        onCommand: ({ frame, child }) => {
          if (frame.type === 'prompt') child.stdout.emit('data', data);
        },
      });
      const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
      t.after(() => bridge.close());
      await assert.rejects(bridge.run(112, 'read a file'), /Invalid|frame limit/);
      await bridge.close();
      assert.equal(harness.children[0].terminateCalls, 1);
    });
  }
});

test('v2 chunk frames reassemble across physical stdout splits', async (t) => {
  const stateDir = await withStateDir(t);
  const harness = makeHarness({
    onCommand: ({ frame, child, emit }) => {
      if (frame.type !== 'prompt') {
        return;
      }
      emit({ type: 'response', id: frame.id, command: 'prompt', success: true, data: { agentInvoked: true } });
      child.emitLogical({
        type: 'message_end',
        messageId: 'chunked-message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'chunked answer' }] },
      });
      child.emitLogical({ type: 'prompt_result', id: frame.id, agentInvoked: true, status: 'completed', sessionSettled: true });
      child.emitLogical({ type: 'session_settled' });
    },
  });
  const bridge = new AgentBridge({ launch: harness.launch, stateDir, timeoutMs: 500 });
  t.after(() => bridge.close());

  const texts = [];
  assert.deepEqual(await bridge.run(107, 'chunk', { onText: async (text) => texts.push(text) }), {
    status: 'completed',
  });
  assert.deepEqual(texts, ['chunked answer']);
});
