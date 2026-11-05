import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchAgent, agentConfig } from './agentRuntime.js';

const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const SESSION_ROOT = '/home/agent/sessions';
const NOOP = () => {};

class AgentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AgentError';
    Object.assign(this, details);
  }
}

class RpcCommandError extends AgentError {
  constructor(frame) {
    const detail = typeof frame?.error === 'string' ? frame.error : 'OMP RPC command failed';
    super(detail, { frame, code: frame?.code });
    this.name = 'RpcCommandError';
  }
}

class OperationTimeoutError extends AgentError {
  constructor(kind) {
    super(`${kind} timed out`);
    this.name = 'OperationTimeoutError';
    this.code = 'timeout';
  }
}

function getRuntimeConfig() {
  return agentConfig();
}

function normalizeChatId(chatId) {
  if (typeof chatId === 'bigint') {
    if (chatId <= 0n) {
      throw new TypeError('chatId must be a positive numeric identifier');
    }
    return chatId.toString();
  }

  if (typeof chatId === 'number') {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      throw new TypeError('chatId must be a positive numeric identifier');
    }
    return String(chatId);
  }

  if (typeof chatId === 'string' && /^[0-9]+$/.test(chatId)) {
    let normalized;
    try {
      normalized = BigInt(chatId).toString();
    } catch {
      normalized = '';
    }
    if (normalized && normalized !== '0') {
      return normalized;
    }
  }

  throw new TypeError('chatId must be a positive numeric identifier');
}

function asError(error, fallback = 'OMP bridge error') {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new AgentError(error);
  }
  return new AgentError(fallback);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}


function extractText(message) {
  if (!isObject(message) || message.role !== 'assistant') {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const pieces = [];
  for (const block of message.content) {
    if (typeof block === 'string') {
      pieces.push(block);
      continue;
    }
    if (!isObject(block)) {
      continue;
    }
    if (block.type !== 'text' && block.type !== 'output_text') {
      continue;
    }
    if (typeof block.text === 'string') {
      pieces.push(block.text);
    }
  }
  return pieces.join('');
}

function modelShape(model) {
  if (!isObject(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') {
    return null;
  }
  const result = { provider: model.provider, id: model.id };
  if (typeof model.name === 'string') {
    result.name = model.name;
  }
  return result;
}

function validateSessionFile(sessionFile) {
  if (typeof sessionFile !== 'string' || !sessionFile || sessionFile.includes('\0')) {
    throw new AgentError('Invalid OMP session path');
  }

  // Runtime sessions are deliberately confined to the agent-owned Docker volume.
  // Do lexical validation here because the host cannot realpath a path in Docker.
  if (!sessionFile.startsWith(`${SESSION_ROOT}/`)) {
    throw new AgentError('Invalid OMP session path');
  }
  const normalized = path.posix.normalize(sessionFile);
  if (normalized !== sessionFile || normalized === SESSION_ROOT || normalized.endsWith('/')) {
    throw new AgentError('Invalid OMP session path');
  }
  return sessionFile;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(NOOP);
  return { promise, resolve, reject };
}

export class AgentBridge {
  constructor(options = {}) {
    const runtime = getRuntimeConfig();
    this.launch = options.launch || launchAgent;
    const stateDir = options.stateDir ?? runtime.stateDir;
    const timeoutMs = options.timeoutMs ?? runtime.timeoutMs;
    const approvalTimeoutMs = options.approvalTimeoutMs ?? runtime.approvalTimeoutMs;
    if (typeof stateDir !== 'string' || !stateDir) {
      throw new TypeError('OMP stateDir must be a non-empty string');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('OMP timeoutMs must be positive');
    }
    if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs <= 0) {
      throw new TypeError('OMP approvalTimeoutMs must be positive');
    }
    this.stateDir = path.resolve(stateDir);
    this.timeoutMs = timeoutMs;
    this.startupTimeoutMs = Math.min(timeoutMs, 30_000);
    this.commandTimeoutMs = Math.min(timeoutMs, 30_000);
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.records = new Map();
    this.closed = false;
    this.nextRequestId = 1;
  }

  _record(chatId) {
    let record = this.records.get(chatId);
    if (!record) {
      record = {
        chatId,
        busy: null,
        worker: null,
        starting: null,
        startCancelled: false,
        operationPromise: null,
      };
      this.records.set(chatId, record);
    }
    return record;
  }

  _metadataPath(chatId) {
    return path.join(this.stateDir, `${chatId}.json`);
  }

  _reserve(record, kind) {
    if (record.busy || record.worker?.terminating || record.worker?.terminationFailed) {
      throw new AgentError(`Chat ${record.chatId} is busy`);
    }
    const token = { kind, cancelled: false, timeout: false };
    record.busy = token;
    return token;
  }

  _release(record, token) {
    if (record.busy === token) {
      record.busy = null;
    }
  }

  async _readSessionPointer(chatId) {
    let text;
    try {
      text = await fs.readFile(this._metadataPath(chatId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }

    let metadata;
    try {
      metadata = JSON.parse(text);
    } catch {
      throw new AgentError('Invalid OMP session metadata');
    }

    const sessionFile = typeof metadata === 'string' ? metadata : metadata?.sessionFile;
    if (sessionFile === undefined || sessionFile === null) {
      throw new AgentError('Invalid OMP session metadata');
    }
    return validateSessionFile(sessionFile);
  }

  async _persistSessionPointer(chatId, sessionFile) {
    validateSessionFile(sessionFile);
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const metadataPath = this._metadataPath(chatId);
    const temporaryPath = path.join(
      this.stateDir,
      `.${chatId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    const content = `${JSON.stringify({ sessionFile })}\n`;
    try {
      await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporaryPath, metadataPath);
    } catch (error) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // Best effort cleanup of a failed atomic write.
      }
      throw error;
    }
  }

  _nextId(prefix = 'rpc') {
    const id = `${prefix}-${process.pid}-${this.nextRequestId}`;
    this.nextRequestId += 1;
    return id;
  }

  _attachChild(worker, child) {
    const onData = (chunk) => {
      this._consumeStdout(worker, chunk);
    };
    const onError = (error) => {
      if (worker.terminating || worker.closed) return;
      const failure = asError(error, 'OMP worker failed');
      this._workerFailure(worker, failure);
      void this._terminateWorker(worker, { rejectOperations: true });
    };
    const onExit = (code, signal) => {
      if (worker.terminating || worker.terminated || worker.closed || worker.terminationFailed) {
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
      this._workerFailure(worker, new AgentError(`OMP worker ${detail}`));
      void this._terminateWorker(worker, { rejectOperations: true });
    };

    if (child?.stdout?.on) {
      child.stdout.on('data', onData);
    }
    if (child?.stderr?.on) {
      // Never expose raw stderr: it may contain provider keys or command details.
      child.stderr.on('data', () => {});
    }
    if (child?.stdin?.on) {
      child.stdin.on('error', onError);
    }
    if (child?.on) {
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('close', onExit);
    }
  }

  _workerFailure(worker, error) {
    const failure = asError(error);
    if (!worker.failure) {
      worker.failure = failure;
    }
    this._invalidateDialogs(worker);
    worker.readyDeferred.reject(failure);
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    worker.pending.clear();

    const operation = worker.operation;
    if (operation && !operation.done && !operation.aborted) {
      operation.done = true;
      clearTimeout(operation.timer);
      if (operation.kind === 'run') {
        operation.deferred.reject(failure);
      } else if (operation.deferred) {
        operation.deferred.reject(failure);
      }
    }
  }

  _markWorkerClosed(worker) {
    if (worker.closed) {
      return;
    }
    this._invalidateDialogs(worker);
    worker.closed = true;
    worker.terminated = true;
    const record = this.records.get(worker.chatId);
    if (record?.worker === worker) {
      record.worker = null;
    }
    if (worker.operation?.kind === 'run' && !worker.operation.done && !worker.operation.aborted) {
      worker.operation.done = true;
      clearTimeout(worker.operation.timer);
      worker.operation.deferred.reject(worker.failure || new AgentError('OMP worker exited'));
    }
  }

  _consumeStdout(worker, chunk) {
    if (worker.closed || worker.terminating || worker.failure) {
      return;
    }
    let bytes;
    try {
      bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } catch (error) {
      this._protocolError(worker, 'Invalid OMP output');
      return;
    }
    if (bytes.length) {
      worker.inputBuffer = Buffer.concat([worker.inputBuffer, bytes]);
    }

    while (true) {
      const newline = worker.inputBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (worker.inputBuffer.length > worker.maxFrameBytes) {
          this._protocolError(worker, 'OMP output exceeded the physical frame limit');
        }
        return;
      }

      let line = worker.inputBuffer.subarray(0, newline);
      worker.inputBuffer = worker.inputBuffer.subarray(newline + 1);
      if (line.length + 1 > worker.maxFrameBytes) {
        this._protocolError(worker, 'OMP output exceeded the physical frame limit');
        return;
      }
      if (line.length && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (!line.length) {
        continue;
      }

      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      } catch {
        this._protocolError(worker, 'Invalid UTF-8 frame');
        return;
      }
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        this._protocolError(worker, 'Invalid JSON frame');
        return;
      }
      if (!isObject(frame)) {
        this._protocolError(worker, 'RPC frame must be an object');
        return;
      }

      const logical = this._decodeChunk(worker, frame);
      if (logical === null) {
        continue;
      }
      if (logical === false) {
        this._protocolError(worker, 'Invalid RPC chunk sequence');
        return;
      }
      this._queueFrame(worker, logical);
    }
  }

  _decodeChunk(worker, frame) {
    if (frame.type !== 'rpc_chunk') {
      if (worker.chunkState) {
        worker.chunkState = null;
        return false;
      }
      return frame;
    }

    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== 'string' || !chunkId ||
      !Number.isInteger(index) || index < 0 ||
      !Number.isInteger(count) || count <= 0 || count > 1_000_000 ||
      index >= count ||
      !Number.isInteger(byteLength) || byteLength < 0 || byteLength > worker.maxReassembledFrameBytes ||
      typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      worker.chunkState = null;
      return false;
    }

    let part;
    try {
      part = Buffer.from(data, 'base64');
    } catch {
      worker.chunkState = null;
      return false;
    }
    const canonical = part.toString('base64');
    if (canonical !== data) {
      worker.chunkState = null;
      return false;
    }

    let state = worker.chunkState;
    if (!state) {
      if (index !== 0) {
        return false;
      }
      state = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        total: 0,
        parts: [],
      };
      worker.chunkState = state;
    }

    if (
      state.chunkId !== chunkId || state.count !== count || state.byteLength !== byteLength ||
      state.nextIndex !== index || state.total + part.length > worker.maxReassembledFrameBytes
    ) {
      worker.chunkState = null;
      return false;
    }

    state.parts.push(part);
    state.total += part.length;
    state.nextIndex += 1;
    if (state.nextIndex !== state.count) {
      return null;
    }
    worker.chunkState = null;
    if (state.total !== state.byteLength) {
      return false;
    }

    const logicalBytes = Buffer.concat(state.parts, state.total);
    let logicalText;
    try {
      logicalText = new TextDecoder('utf-8', { fatal: true }).decode(logicalBytes);
    } catch {
      return false;
    }
    try {
      const logicalFrame = JSON.parse(logicalText);
      return isObject(logicalFrame) ? logicalFrame : false;
    } catch {
      return false;
    }
  }

  _protocolError(worker, message) {
    const error = new AgentError(message);
    this._workerFailure(worker, error);
    void this._terminateWorker(worker, { rejectOperations: true });
  }

  _queueFrame(worker, frame) {
    worker.frameQueue = worker.frameQueue
      .then(() => this._handleFrame(worker, frame))
      .catch((error) => {
        this._workerFailure(worker, error);
        void this._terminateWorker(worker, { rejectOperations: true });
      });
    worker.frameQueue.catch(NOOP);
  }

  async _handleFrame(worker, frame) {
    if (worker.closed || worker.terminating || worker.failure) {
      return;
    }
    if (frame.type === 'ready') {
      worker.readyFrame = frame;
      if (Array.isArray(frame.supportedProtocolVersions)) {
        worker.supportedProtocolVersions = frame.supportedProtocolVersions.filter((v) => Number.isInteger(v));
      }
      if (isFinitePositive(frame.maxFrameBytes)) {
        worker.maxFrameBytes = Math.min(MAX_PHYSICAL_FRAME_BYTES, Math.floor(frame.maxFrameBytes));
      }
      if (isFinitePositive(frame.maxReassembledFrameBytes)) {
        worker.maxReassembledFrameBytes = Math.min(
          MAX_REASSEMBLED_FRAME_BYTES,
          Math.floor(frame.maxReassembledFrameBytes)
        );
      }
      worker.readyDeferred.resolve(frame);
      return;
    }

    if (frame.type === 'response') {
      const id = frame.id === undefined ? undefined : String(frame.id);
      const pending = id === undefined ? undefined : worker.pending.get(id);
      if (!pending) {
        return;
      }
      worker.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.success === false) {
        pending.reject(new RpcCommandError(frame));
      } else {
        pending.resolve(frame);
      }
      return;
    }

    if (frame.type === 'extension_ui_request') {
      if (frame.method === 'cancel') {
        if (typeof frame.targetId === 'string') {
          this._closeDialog(worker, frame.targetId, { cancelled: true });
        }
        return;
      }
      this._handleDialogRequest(worker, frame);
      return;
    }

    if (frame.type === 'session_settled') {
      worker.sessionSettled = true;
      this._invalidateDialogs(worker);
      const operation = worker.operation;
      if (operation?.kind === 'run' && operation.waitingForSettled && !operation.done) {
        operation.done = true;
        clearTimeout(operation.timer);
        if (operation.error) {
          operation.deferred.reject(operation.error);
        } else {
          operation.deferred.resolve({ status: 'completed' });
        }
      }
      return;
    }

    if (frame.type === 'prompt_result') {
      this._handlePromptResult(worker, frame);
      return;
    }

    if (frame.type === 'message_end') {
      await this._emitAssistantMessage(worker, frame.message, frame.messageId);
      return;
    }


  }

  async _emitAssistantMessage(worker, message, messageId) {
    const operation = worker.operation;
    if (!operation || operation.done || typeof operation.callbacks?.onText !== 'function') {
      return;
    }
    const text = extractText(message);
    if (!text) {
      return;
    }
    if (typeof messageId === 'string' && messageId) {
      const id = `id:${messageId}`;
      if (operation.emittedTexts.has(id)) {
        return;
      }
      operation.emittedTexts.add(id);
    }
    await operation.callbacks.onText(text);
  }

  _handlePromptResult(worker, frame) {
    const operation = worker.operation;
    if (!operation || operation.kind !== 'run' || operation.done) {
      return;
    }
    if (frame.id !== undefined && operation.promptId !== String(frame.id)) {
      return;
    }
    if (frame.status === 'aborted') {
      this._invalidateDialogs(worker);
      operation.done = true;
      clearTimeout(operation.timer);
      operation.deferred.resolve({ status: 'aborted' });
      return;
    }
    if (frame.status === 'error') {
      this._invalidateDialogs(worker);
      const error = new AgentError(
        frame.error?.message || frame.error || 'OMP prompt failed',
        { promptResult: frame }
      );
      if (frame.sessionSettled === false) {
        operation.error = error;
        operation.waitingForSettled = true;
        worker.sessionSettled = false;
        return;
      }
      operation.done = true;
      clearTimeout(operation.timer);
      operation.deferred.reject(error);
      return;
    }
    if (frame.status && frame.status !== 'completed') {
      this._invalidateDialogs(worker);
      operation.done = true;
      clearTimeout(operation.timer);
      operation.deferred.reject(new AgentError(`Unknown OMP prompt status: ${frame.status}`));
      return;
    }

    if (frame.sessionSettled === false) {
      operation.waitingForSettled = true;
      worker.sessionSettled = false;
      return;
    }
    this._invalidateDialogs(worker);
    operation.done = true;
    clearTimeout(operation.timer);
    operation.deferred.resolve({ status: 'completed' });
  }

  _dialogTimeoutMs(frame) {
    if (Number.isFinite(frame.timeout) && frame.timeout >= 0) {
      return Math.min(this.approvalTimeoutMs, Math.max(0, frame.timeout));
    }
    return this.approvalTimeoutMs;
  }

  _handleDialogRequest(worker, frame) {
    const method = frame.method;
    if (
      method === 'notify' ||
      method === 'setStatus' ||
      method === 'setWidget' ||
      method === 'setTitle' ||
      method === 'set_editor_text' ||
      method === 'open_url'
    ) {
      return;
    }
    const operation = worker.operation;
    const supported = method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
    if (typeof frame.id !== 'string' || !frame.id || !supported || frame.secret === true) {
      if (typeof frame.id === 'string' && frame.id) {
        try {
          this._writeFrame(worker, { type: 'extension_ui_response', id: frame.id, cancelled: true });
        } catch {
          // The worker may already be stopping; no approval is sent.
        }
      }
      return;
    }

    if (worker.dialogs.has(frame.id)) {
      try {
        this._writeFrame(worker, { type: 'extension_ui_response', id: frame.id, cancelled: true });
      } catch {
        // The existing request remains invalidated.
      }
      return;
    }

    const dialog = {
      ...frame,
      id: frame.id,
      method,
      options: Array.isArray(frame.options) ? frame.options.slice() : frame.options,
      optionDetails: Array.isArray(frame.optionDetails) ? frame.optionDetails.slice() : frame.optionDetails,
    };
    const pending = {
      worker,
      dialog,
      operation,
      timer: null,
      closed: false,
    };
    const timeout = this._dialogTimeoutMs(frame);
    pending.timer = setTimeout(() => {
      this._closeDialog(worker, frame.id, { cancelled: true, timedOut: true });
    }, timeout);
    worker.dialogs.set(frame.id, pending);

    const callback = operation?.callbacks?.onDialog;
    if (typeof callback !== 'function') {
      this._closeDialog(worker, frame.id, { cancelled: true });
      return;
    }
    Promise.resolve()
      .then(() => callback(dialog))
      .catch((error) => {
        this._closeDialog(worker, frame.id, { cancelled: true });
        this._workerFailure(worker, asError(error, 'Dialog callback failed'));
        void this._terminateWorker(worker, { rejectOperations: true });
      })
      .catch(NOOP);
  }

  _closeDialog(worker, dialogId, response) {
    const pending = worker.dialogs.get(dialogId);
    if (!pending || pending.closed) {
      return false;
    }
    pending.closed = true;
    worker.dialogs.delete(dialogId);
    clearTimeout(pending.timer);
    try {
      this._writeFrame(worker, {
        type: 'extension_ui_response',
        id: dialogId,
        ...response,
      });
    } catch {
      // Closing a dialog is fail-safe when the worker is already gone.
    }
    const callback = pending.operation?.callbacks?.onDialogClosed;
    if (typeof callback === 'function') {
      Promise.resolve()
        .then(() => callback(dialogId))
        .catch((error) => {
          this._workerFailure(worker, asError(error, 'Dialog close callback failed'));
          void this._terminateWorker(worker, { rejectOperations: true });
        })
        .catch(NOOP);
    }
    return true;
  }

  _writeFrame(worker, frame) {
    if (
      worker.closed ||
      worker.terminated ||
      worker.terminating ||
      worker.terminationFailed ||
      !worker.child?.stdin?.write
    ) {
      throw new AgentError('OMP worker is not writable');
    }
    const line = `${JSON.stringify(frame)}\n`;
    try {
      worker.child.stdin.write(line);
    } catch (error) {
      this._workerFailure(worker, asError(error, 'OMP worker stdin failed'));
      throw error;
    }
  }

  _sendCommand(worker, type, payload = {}, timeoutMs = this.commandTimeoutMs) {
    if (worker.closed || worker.terminated || worker.terminating || worker.terminationFailed) {
      return Promise.reject(worker.failure || worker.terminationFailed || new AgentError('OMP worker is unavailable'));
    }
    const id = this._nextId(type);
    const frame = { id, type, ...payload };
    const deferred = createDeferred();
    const timer = setTimeout(() => {
      if (!worker.pending.has(id)) {
        return;
      }
      worker.pending.delete(id);
      deferred.reject(new OperationTimeoutError(type));
    }, Math.max(1, timeoutMs));
    worker.pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, timer, type });
    try {
      this._writeFrame(worker, frame);
    } catch (error) {
      clearTimeout(timer);
      worker.pending.delete(id);
      deferred.reject(asError(error));
    }
    return deferred.promise;
  }

  async _startWorker(record) {
    if (this.closed) {
      throw new AgentError('OMP bridge is closed');
    }
    const sessionFile = await this._readSessionPointer(record.chatId);
    if (this.closed || record.startCancelled || record.busy?.cancelled) {
      throw new AgentError('OMP worker startup cancelled');
    }

    let child;
    try {
      child = this.launch({ chatId: record.chatId, sessionFile });
    } catch (error) {
      throw asError(error, 'Unable to launch OMP worker');
    }
    if (!child) {
      throw new AgentError('OMP runtime did not return a child process');
    }

    const worker = {
      chatId: record.chatId,
      child,
      sessionFile,
      readyFrame: null,
      readyDeferred: createDeferred(),
      supportedProtocolVersions: [],
      protocolVersion: 1,
      maxFrameBytes: MAX_PHYSICAL_FRAME_BYTES,
      maxReassembledFrameBytes: MAX_REASSEMBLED_FRAME_BYTES,
      inputBuffer: Buffer.alloc(0),
      chunkState: null,
      pending: new Map(),
      dialogs: new Map(),
      frameQueue: Promise.resolve(),
      operation: null,
      closed: false,
      terminated: false,
      terminating: false,
      terminationFailed: null,
      terminationPromise: null,
      failure: null,
      sessionSettled: false,
    };
    record.worker = worker;
    this._attachChild(worker, child);

    const startupTimer = setTimeout(() => {
      worker.readyDeferred.reject(new OperationTimeoutError('OMP startup'));
      void this._terminateWorker(worker, { rejectOperations: true });
    }, this.startupTimeoutMs);
    try {
      const ready = await worker.readyDeferred.promise;
      clearTimeout(startupTimer);
      if (ready?.protocolVersion === 2 || worker.supportedProtocolVersions.includes(2)) {
        await this._sendCommand(worker, 'negotiate_protocol', { protocolVersion: 2 }, this.startupTimeoutMs);
        worker.protocolVersion = 2;
      }
      if (!sessionFile) {
        // Ordinary OMP startup is lazy; an explicit new session writes its header
        // before returning, so even a zero-turn chat can resume after a restart.
        const response = await this._sendCommand(worker, 'new_session', {}, this.startupTimeoutMs);
        if (response.data?.cancelled) throw new AgentError('OMP session creation was cancelled');
      }
      await this._refreshState(
        record,
        worker,
        { expectedSessionFile: sessionFile, timeoutMs: this.startupTimeoutMs }
      );
      return worker;
    } catch (error) {
      clearTimeout(startupTimer);
      await this._terminateWorker(worker, { rejectOperations: true });
      throw asError(error, 'OMP startup failed');
    }
  }

  async _ensureWorker(record) {
    if (this.closed) {
      throw new AgentError('OMP bridge is closed');
    }
    if (record.starting) {
      return record.starting;
    }
    if (record.worker?.terminationFailed) {
      throw record.worker.terminationFailed;
    }
    if (record.worker && !record.worker.closed && !record.worker.terminated) {
      if (record.worker.readyFrame) {
        return record.worker;
      }
      throw new AgentError('OMP worker handshake is incomplete');
    }
    record.startCancelled = false;
    const starting = this._startWorker(record);
    record.starting = starting;
    starting.then(NOOP, NOOP).finally(() => {
      if (record.starting === starting) {
        record.starting = null;
      }
    }).catch(NOOP);
    try {
      return await starting;
    } catch (error) {
      if (record.worker?.closed || record.worker?.terminated) {
        record.worker = null;
      }
      throw error;
    }
  }

  async start(chatId) {
    const normalized = normalizeChatId(chatId);
    return this._ensureWorker(this._record(normalized));
  }

  async _refreshState(
    record,
    worker,
    { requireNewSessionFile = false, expectedSessionFile, timeoutMs = this.commandTimeoutMs } = {}
  ) {
    const response = await this._sendCommand(worker, 'get_state', {}, timeoutMs);
    const state = isObject(response.data) ? response.data : {};
    if (Object.prototype.hasOwnProperty.call(state, 'sessionFile')) {
      if (typeof state.sessionFile !== 'string') {
        throw new AgentError('OMP returned an invalid session path');
      }
      if (expectedSessionFile !== undefined && state.sessionFile !== expectedSessionFile) {
        throw new AgentError('OMP session path changed unexpectedly');
      }
      worker.sessionFile = validateSessionFile(state.sessionFile);
    } else if (requireNewSessionFile || !worker.sessionFile) {
      throw new AgentError('OMP did not return a session path');
    }
    await this._persistSessionPointer(record.chatId, worker.sessionFile);
    return state;
  }

  _startOperationTimer(record, worker, operation, token) {
    operation.timer = setTimeout(() => {
      if (operation.done || operation.aborted) {
        return;
      }
      token.cancelled = true;
      token.timeout = true;
      if (operation.kind === 'run') {
        operation.aborted = true;
        operation.done = true;
        operation.deferred.resolve({ status: 'aborted' });
      } else {
        operation.done = true;
        operation.deferred.reject(new OperationTimeoutError(operation.kind));
      }
      void this._terminateWorker(worker, { rejectOperations: true });
    }, this.timeoutMs);
  }

  _operationCallbacks(callbacks) {
    if (!isObject(callbacks)) {
      return {};
    }
    return {
      onText: typeof callbacks.onText === 'function' ? callbacks.onText : undefined,
      onDialog: typeof callbacks.onDialog === 'function' ? callbacks.onDialog : undefined,
      onDialogClosed: typeof callbacks.onDialogClosed === 'function' ? callbacks.onDialogClosed : undefined,
    };
  }

  async run(chatId, text, callbacks = {}) {
    const normalized = normalizeChatId(chatId);
    if (typeof text !== 'string') {
      throw new TypeError('Prompt text must be a string');
    }
    const record = this._record(normalized);
    const token = this._reserve(record, 'run');
    const operationPromise = this._run(record, token, text, this._operationCallbacks(callbacks));
    record.operationPromise = operationPromise;
    try {
      return await operationPromise;
    } finally {
      if (record.operationPromise === operationPromise) {
        record.operationPromise = null;
      }
    }
  }

  async _run(record, token, text, callbacks) {
    let worker;
    let operation;
    let stateRefreshAttempted = false;
    try {
      worker = await this._ensureWorker(record);
      if (token.cancelled) {
        return { status: 'aborted' };
      }
      const deferred = createDeferred();
      operation = {
        kind: 'run',
        generation: this.nextRequestId,
        callbacks,
        deferred,
        timer: null,
        done: false,
        aborted: false,
        waitingForSettled: false,
        emittedTexts: new Set(),
        promptId: null,
        token,
      };
      worker.operation = operation;
      this._startOperationTimer(record, worker, operation, token);

      const responsePromise = this._sendCommand(worker, 'prompt', {
        message: `Telegram user request:\n\n${text}`,
      });
      // The generated command id is the newest pending prompt id. Capture it before awaiting
      // so a prompt_result that follows the acknowledgement can be correlated exactly.
      for (const [id, pending] of worker.pending) {
        if (pending.type === 'prompt') {
          operation.promptId = id;
        }
      }
      const response = await responsePromise;
      if (response.data?.agentInvoked === false) {
        operation.done = true;
        clearTimeout(operation.timer);
        operation.deferred.resolve({ status: 'completed' });
      }
      const result = await operation.deferred.promise;
      if (result.status === 'completed' && !token.cancelled) {
        stateRefreshAttempted = true;
        await this._refreshState(record, worker);
      }
      return result;
    } catch (error) {
      if (
        !stateRefreshAttempted &&
        !token.cancelled &&
        worker &&
        !worker.closed &&
        !worker.terminated &&
        !worker.terminating &&
        !worker.terminationFailed
      ) {
        stateRefreshAttempted = true;
        await this._refreshState(record, worker);
      }
      if (token.cancelled) {
        return { status: 'aborted' };
      }
      if (operation?.done && operation.aborted) {
        return { status: 'aborted' };
      }
      throw asError(error, 'OMP prompt failed');
    } finally {
      if (operation) {
        clearTimeout(operation.timer);
        if (worker?.operation === operation) {
          worker.operation = null;
        }
      }
      this._release(record, token);
    }
  }

  async compact(chatId, callbacks = {}) {
    const normalized = normalizeChatId(chatId);
    const record = this._record(normalized);
    const token = this._reserve(record, 'compact');
    const operationPromise = this._compact(record, token, this._operationCallbacks(callbacks));
    record.operationPromise = operationPromise;
    try {
      return await operationPromise;
    } finally {
      if (record.operationPromise === operationPromise) {
        record.operationPromise = null;
      }
    }
  }

  async _compact(record, token, callbacks) {
    let worker;
    let operation;
    try {
      worker = await this._ensureWorker(record);
      if (token.cancelled) {
        throw new OperationTimeoutError('compact');
      }
      operation = {
        kind: 'compact',
        generation: this.nextRequestId,
        callbacks,
        deferred: createDeferred(),
        timer: null,
        done: false,
        aborted: false,
        emittedTexts: new Set(),
        token,
      };
      worker.operation = operation;
      this._startOperationTimer(record, worker, operation, token);
      const response = await this._sendCommand(worker, 'compact', {}, this.timeoutMs);
      operation.done = true;
      clearTimeout(operation.timer);
      await this._refreshState(record, worker);
      return response.data;
    } catch (error) {
      if (token.cancelled && (token.timeout || worker?.terminated)) {
        throw new OperationTimeoutError('compact');
      }
      throw error;
    } finally {
      clearTimeout(operation?.timer);
      if (worker?.operation === operation) {
        worker.operation = null;
      }
      this._release(record, token);
    }
  }

  async reset(chatId) {
    const normalized = normalizeChatId(chatId);
    const record = this._record(normalized);
    const token = this._reserve(record, 'reset');
    const operationPromise = this._reset(record, token);
    record.operationPromise = operationPromise;
    try {
      return await operationPromise;
    } finally {
      if (record.operationPromise === operationPromise) {
        record.operationPromise = null;
      }
    }
  }

  async _reset(record, token) {
    let worker;
    let operation;
    try {
      worker = await this._ensureWorker(record);
      if (token.cancelled) {
        throw new OperationTimeoutError('reset');
      }
      operation = {
        kind: 'reset',
        generation: this.nextRequestId,
        callbacks: {},
        deferred: createDeferred(),
        timer: null,
        done: false,
        aborted: false,
        emittedTexts: new Set(),
        token,
      };
      worker.operation = operation;
      this._startOperationTimer(record, worker, operation, token);
      this._invalidateDialogs(worker);
      const response = await this._sendCommand(worker, 'new_session');
      if (response.data?.cancelled) {
        throw new AgentError('OMP session reset was cancelled');
      }
      operation.done = true;
      clearTimeout(operation.timer);
      if (isObject(response.data) && typeof response.data.sessionFile === 'string') {
        worker.sessionFile = validateSessionFile(response.data.sessionFile);
      } else {
        worker.sessionFile = undefined;
      }
      await this._refreshState(record, worker, { requireNewSessionFile: true });
      return { status: 'completed' };
    } catch (error) {
      if (token.cancelled && (token.timeout || worker?.terminated)) {
        throw new OperationTimeoutError('reset');
      }
      throw error;
    } finally {
      clearTimeout(operation?.timer);
      if (worker?.operation === operation) {
        worker.operation = null;
      }
      this._release(record, token);
    }
  }

  async models(chatId) {
    const normalized = normalizeChatId(chatId);
    const record = this._record(normalized);
    const worker = await this._ensureWorker(record);
    const state = await this._refreshState(record, worker);
    const current = state.model === undefined || state.model === null ? null : modelShape(state.model);
    if (state.model !== undefined && state.model !== null && !current) {
      throw new AgentError('OMP returned an invalid current model');
    }
    const response = await this._sendCommand(worker, 'get_available_models');
    if (!isObject(response.data) || !Array.isArray(response.data.models)) {
      throw new AgentError('OMP returned an invalid model catalog');
    }
    const models = response.data.models.map(modelShape);
    if (models.some((model) => !model)) {
      throw new AgentError('OMP returned an invalid model catalog');
    }
    return { current, models };
  }

  async setModel(chatId, provider, modelId) {
    const normalized = normalizeChatId(chatId);
    if (typeof provider !== 'string' || !provider || typeof modelId !== 'string' || !modelId) {
      throw new TypeError('Provider and model id are required');
    }
    const record = this._record(normalized);
    const token = this._reserve(record, 'setModel');
    const operationPromise = this._setModel(record, token, provider, modelId);
    record.operationPromise = operationPromise;
    try {
      return await operationPromise;
    } finally {
      if (record.operationPromise === operationPromise) {
        record.operationPromise = null;
      }
    }
  }

  async _setModel(record, token, provider, modelId) {
    let worker;
    let operation;
    try {
      worker = await this._ensureWorker(record);
      operation = {
        kind: 'setModel',
        generation: this.nextRequestId,
        callbacks: {},
        deferred: createDeferred(),
        timer: null,
        done: false,
        aborted: false,
        emittedTexts: new Set(),
        token,
      };
      worker.operation = operation;
      this._startOperationTimer(record, worker, operation, token);
      const response = await this._sendCommand(worker, 'set_model', { provider, modelId });
      const state = await this._refreshState(record, worker);
      operation.done = true;
      clearTimeout(operation.timer);
      const selected = modelShape(response.data?.model || response.data) || modelShape(state.model);
      if (!selected) {
        throw new AgentError('OMP returned an invalid selected model');
      }
      return selected;
    } catch (error) {
      if (token.cancelled && (token.timeout || worker?.terminated)) {
        throw new OperationTimeoutError('setModel');
      }
      throw error;
    } finally {
      clearTimeout(operation?.timer);
      if (worker?.operation === operation) {
        worker.operation = null;
      }
      this._release(record, token);
    }
  }

  _invalidateDialogs(worker) {
    for (const dialogId of [...worker.dialogs.keys()]) {
      this._closeDialog(worker, dialogId, { cancelled: true });
    }
  }

  _settleOperationAborted(worker) {
    const operation = worker.operation;
    if (!operation || operation.done) {
      return;
    }
    operation.aborted = true;
    operation.done = true;
    clearTimeout(operation.timer);
    if (operation.kind === 'run') {
      operation.deferred.resolve({ status: 'aborted' });
    } else {
      operation.deferred.reject(new AgentError(`${operation.kind} aborted`));
    }
  }

  _terminateWorker(worker, { rejectOperations = false } = {}) {
    if (!worker || worker.closed || worker.terminated) {
      return Promise.resolve();
    }
    if (rejectOperations) {
      this._settleOperationAborted(worker);
    }
    if (worker.terminationPromise) {
      return worker.terminationPromise;
    }

    worker.terminating = true;
    worker.readyDeferred.reject(new AgentError('OMP worker terminated'));
    this._invalidateDialogs(worker);
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError('OMP worker terminated'));
    }
    worker.pending.clear();

    const child = worker.child;
    const closeDeferred = createDeferred();
    const onClose = () => closeDeferred.resolve();
    if (child?.once) {
      child.once('close', onClose);
      child.once('exit', onClose);
    }

    worker.terminationPromise = (async () => {
      try {
        if (typeof child?.terminate === 'function') {
          await child.terminate();
        } else if (typeof child?.kill === 'function') {
          if (child.kill('SIGTERM') === false) {
            throw new AgentError('OMP worker refused termination');
          }
        } else {
          throw new AgentError('OMP worker has no termination method');
        }
      } catch (error) {
        const failure = asError(error, 'OMP worker termination failed');
        worker.terminationFailed = failure;
        worker.failure ||= failure;
        worker.terminating = false;
        throw failure;
      }

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(1000, this.timeoutMs));
        closeDeferred.promise.then(() => {
          clearTimeout(timer);
          resolve();
        }).catch(NOOP);
      });
      worker.terminating = false;
      this._markWorkerClosed(worker);
    })();
    worker.terminationPromise.catch(NOOP);
    return worker.terminationPromise;
  }

  async abort(chatId) {
    const normalized = normalizeChatId(chatId);
    const record = this.records.get(normalized);
    if (!record || (!record.busy && !record.starting && !record.worker?.operation &&
      !record.worker?.dialogs.size && !record.worker?.terminating && !record.worker?.terminationFailed)) {
      return false;
    }
    const token = record.busy;
    if (token) {
      token.cancelled = true;
    }
    if (record.starting) {
      record.startCancelled = true;
    }
    const worker = record.worker;
    if (worker) {
      try {
        this._writeFrame(worker, { id: this._nextId('abort'), type: 'abort' });
      } catch {
        // The forced termination below is the fail-safe path.
      }
      this._settleOperationAborted(worker);
      await this._terminateWorker(worker, { rejectOperations: true });
    }
    return true;
  }

  isBusy(chatId) {
    let normalized;
    try {
      normalized = normalizeChatId(chatId);
    } catch {
      return false;
    }
    const record = this.records.get(normalized);
    return Boolean(record?.busy || record?.starting || record?.worker?.operation ||
      record?.worker?.dialogs.size || record?.worker?.terminating || record?.worker?.terminationFailed);
  }

  answer(chatId, dialogId, response) {
    let normalized;
    try {
      normalized = normalizeChatId(chatId);
    } catch {
      return false;
    }
    if (typeof dialogId !== 'string' || !isObject(response)) {
      return false;
    }
    const worker = this.records.get(normalized)?.worker;
    const pending = worker?.dialogs.get(dialogId);
    if (!pending || pending.closed) {
      return false;
    }

    let wireResponse;
    const keys = Object.keys(response);
    if (keys.length === 1 && typeof response.value === 'string' &&
      (pending.dialog.method === 'input' || pending.dialog.method === 'editor' ||
        (pending.dialog.method === 'select' && Array.isArray(pending.dialog.options) &&
          pending.dialog.options.includes(response.value)))) {
      wireResponse = { value: response.value };
    } else if (keys.length === 1 && typeof response.confirmed === 'boolean' && pending.dialog.method === 'confirm') {
      wireResponse = { confirmed: response.confirmed };
    } else if (keys.length === 1 && response.cancelled === true) {
      wireResponse = { cancelled: true };
    } else {
      return false;
    }

    pending.closed = true;
    worker.dialogs.delete(dialogId);
    clearTimeout(pending.timer);
    try {
      this._writeFrame(worker, { type: 'extension_ui_response', id: dialogId, ...wireResponse });
    } catch {
      return false;
    }
    const callback = pending.operation?.callbacks?.onDialogClosed;
    if (typeof callback === 'function') {
      Promise.resolve()
        .then(() => callback(dialogId))
        .catch((error) => {
          this._workerFailure(worker, asError(error, 'Dialog close callback failed'));
          void this._terminateWorker(worker, { rejectOperations: true });
        })
        .catch(NOOP);
    }
    return true;
  }

  async close() {
    if (this.closed && this.records.size === 0) {
      return;
    }
    this.closed = true;
    const records = [...this.records.values()];
    for (const record of records) {
      if (record.busy) {
        record.busy.cancelled = true;
      }
    }
    const errors = await Promise.all(records.map(async (record) => {
      let terminationError = null;
      if (record.worker) {
        try {
          await this._terminateWorker(record.worker, { rejectOperations: true });
        } catch (error) {
          terminationError = error;
        }
      }
      if (record.starting) {
        try {
          await record.starting;
        } catch {
          // Expected when shutdown races startup.
        }
      }
      if (record.operationPromise) {
        await Promise.allSettled([record.operationPromise]);
      }
      return terminationError;
    }));
    const terminationError = errors.find(Boolean);
    if (terminationError) {
      throw terminationError;
    }
    this.records.clear();
  }
}

export const agent = new AgentBridge();

export { AgentError, RpcCommandError, validateSessionFile };
