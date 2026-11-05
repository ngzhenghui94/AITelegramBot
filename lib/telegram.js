import { randomBytes } from 'node:crypto';

import logger from './logger.js';
import { agent as defaultAgent } from './agent.js';
import { transcribeAudio } from './openai.js';
import { formatMessage } from './formatter.js';
import { checkRateLimit } from './rateLimit.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const TELEGRAM_CHUNK_SIZE = 4096;
const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_MODEL_BUTTONS = 12;
const PREFERRED_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'];
const MAX_VOICE_FILE_SIZE = 20 * 1024 * 1024;
const DEFAULT_DIALOG_TIMEOUT_MS = 120_000;
const MAX_DIALOG_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MODEL_CALLBACK_PREFIX = 'omp-model:';
const DIALOG_CALLBACK_PREFIX = 'omp-dialog:';
const WELCOME_TEXT = [
  'Welcome. Send a message, forwarded text, caption, or voice note.',
  'The assistant may ask for approval or a clarification before using tools.',
  'Use /cancel to stop the current task, /reset to start a new session, /compact to compact it, and /model to choose a model.',
].join('\n');
const BUSY_TEXT = 'A task is already in progress. Please wait, answer its question, or use /cancel.';
const UNKNOWN_COMMAND_TEXT = 'Unknown command. Use /start, /reset, /clear, /compact, /model, or /cancel.';

function getTelegramApiUrl() {
  const token = process.env.TELEGRAM_BOT_API_KEY;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_API_KEY environment variable');
  }
  return `${TELEGRAM_API_BASE}${token}`;
}

async function telegramRequest(method, body = {}, signal) {
  const response = await fetch(`${getTelegramApiUrl()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(30_000),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.ok === false || !data?.ok) {
    const description = data?.description || `HTTP ${response.status || 'error'}`;
    throw new Error(`Telegram API error: ${description}`);
  }

  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: String(text ?? ''),
    ...options,
  });
}

function isTelegramHtmlParseError(error) {
  return /can't parse entities|parse entities/i.test(error?.message || '');
}

async function answerCallbackQuery(callbackQueryId, options = {}) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...options,
  });
}

async function safeAnswerCallbackQuery(callbackQuery, options = {}) {
  if (!callbackQuery?.id) {
    return;
  }
  try {
    await answerCallbackQuery(callbackQuery.id, options);
  } catch (error) {
    logger.warn('Unable to acknowledge Telegram callback:', error.message);
  }
}

async function sendChatAction(chatId, action) {
  return telegramRequest('sendChatAction', {
    chat_id: chatId,
    action,
  });
}

async function getFile(fileId, signal) {
  return telegramRequest('getFile', { file_id: fileId }, signal);
}

async function downloadFile(filePath, signal) {
  const token = process.env.TELEGRAM_BOT_API_KEY;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_API_KEY environment variable');
  }

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to download voice message (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function truncateToUtf8Bytes(text, maxBytes) {
  let output = String(text ?? '');
  while (Buffer.byteLength(output, 'utf8') > maxBytes && output.length > 0) {
    output = output.slice(0, -1);
  }
  return output;
}

function truncateAtWordBoundaryUtf8(text, maxBytes) {
  const trimmed = truncateToUtf8Bytes(text, maxBytes);
  if (trimmed === text || !trimmed.includes(' ')) {
    return trimmed;
  }
  const lastSpaceIndex = trimmed.lastIndexOf(' ');
  return lastSpaceIndex > 0 ? trimmed.slice(0, lastSpaceIndex).trim() : trimmed;
}

/**
 * Preserve the old HTML formatting fallback, but allow tool/UI messages to be
 * sent as plain text. Buttons are deliberately only attached to the last chunk.
 */
export async function sendMessageInChunks(chatId, text, options = {}) {
  const { plainText = false, ...telegramOptions } = options;
  const safeText = String(text ?? '').length > 0 ? String(text) : ' ';
  const chunks = [];
  let index = 0;
  while (index < safeText.length) {
    let end = Math.min(index + TELEGRAM_CHUNK_SIZE, safeText.length);
    if (
      end < safeText.length &&
      end > index &&
      safeText.charCodeAt(end - 1) >= 0xD800 &&
      safeText.charCodeAt(end - 1) <= 0xDBFF
    ) {
      end -= 1;
    }
    if (end === index) end += 1;
    chunks.push(safeText.slice(index, end));
    index = end;
  }

  let lastResult;
  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    const chunkOptions = plainText
      ? (isLastChunk ? { ...telegramOptions } : {})
      : {
        parse_mode: 'HTML',
        ...(isLastChunk ? telegramOptions : {}),
      };

    try {
      lastResult = await sendMessage(chatId, chunks[index], chunkOptions);
    } catch (error) {
      if (!isTelegramHtmlParseError(error)) {
        throw error;
      }
      const { parse_mode: ignoredParseMode, ...plainOptions } = chunkOptions;
      logger.warn('Telegram rejected HTML formatting; retrying as plain text.');
      lastResult = await sendMessage(chatId, chunks[index], plainOptions);
    }
  }
  return lastResult;
}

function isForwardedMessage(message) {
  return Boolean(
    message?.forward_origin ||
    message?.forward_from ||
    message?.forward_from_chat ||
    message?.forward_sender_name ||
    message?.forward_date
  );
}

function getForwardedSource(message) {
  if (!isForwardedMessage(message)) {
    return null;
  }

  const origin = message.forward_origin;
  if (origin?.type === 'user') {
    const first = origin.sender_user?.first_name || '';
    const last = origin.sender_user?.last_name || '';
    const fullName = `${first} ${last}`.trim();
    return fullName || origin.sender_user?.username || 'a user';
  }
  if (origin?.type === 'hidden_user') {
    return origin.sender_user_name || 'a hidden user';
  }
  if (origin?.type === 'chat' || origin?.type === 'channel') {
    return origin.chat?.title || origin.chat?.username || 'a chat';
  }
  if (message.forward_from_chat?.title) {
    return message.forward_from_chat.title;
  }
  if (message.forward_from) {
    const first = message.forward_from.first_name || '';
    const last = message.forward_from.last_name || '';
    const fullName = `${first} ${last}`.trim();
    return fullName || message.forward_from.username || 'a user';
  }
  return message.forward_sender_name || null;
}

function detectMessageMediaType(message) {
  if (message?.photo) return 'photo';
  if (message?.video) return 'video';
  if (message?.document) return 'document';
  if (message?.animation) return 'animation';
  if (message?.audio) return 'audio';
  if (message?.sticker) return 'sticker';
  if (message?.poll) return 'poll';
  if (message?.location) return 'location';
  if (message?.contact) return 'contact';
  return 'message';
}

function extractPromptFromMessage(message) {
  const forwarded = isForwardedMessage(message);
  const source = getForwardedSource(message);
  const text = message?.text?.trim();
  const caption = message?.caption?.trim();
  const mediaType = detectMessageMediaType(message);

  if (text) {
    if (!forwarded) return text;
    const sourceLabel = source ? ` from ${source}` : '';
    return `Forwarded text${sourceLabel}:\n${text}`;
  }
  if (caption) {
    if (!forwarded) return caption;
    const sourceLabel = source ? ` from ${source}` : '';
    return `Forwarded ${mediaType}${sourceLabel} with caption:\n${caption}`;
  }
  if (forwarded) {
    const sourceLabel = source ? ` from ${source}` : '';
    return `Forwarded ${mediaType}${sourceLabel} with no text. Ask the user what to focus on.`;
  }
  return null;
}

function getTelegramCommand(text) {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith('/')) return null;
  return trimmed.split(/\s+/, 1)[0].slice(1).split('@', 1)[0].toLowerCase();
}

function getAdminId() {
  const raw = String(process.env.ADMINID ?? '').trim();
  return /^[1-9]\d*$/.test(raw) ? raw : null;
}

function authorizedMessage(message) {
  const adminId = getAdminId();
  const chatId = message?.chat?.id;
  const senderId = message?.from?.id;
  return Boolean(
    adminId &&
    message?.chat?.type === 'private' &&
    chatId !== undefined &&
    senderId !== undefined &&
    String(chatId) === adminId &&
    String(senderId) === adminId
  );
}

function authorizedCallback(callbackQuery) {
  const adminId = getAdminId();
  const chat = callbackQuery?.message?.chat;
  const senderId = callbackQuery?.from?.id;
  return Boolean(
    adminId &&
    chat?.type === 'private' &&
    chat?.id !== undefined &&
    senderId !== undefined &&
    String(chat.id) === adminId &&
    String(senderId) === adminId
  );
}

function randomToken(prefix) {
  const token = `${prefix}${randomBytes(9).toString('base64url')}`;
  return truncateToUtf8Bytes(token, MAX_CALLBACK_DATA_BYTES);
}

function normalizeOption(option) {
  if (typeof option !== 'string') return null;
  return { value: option, label: option };
}

function optionKind(option) {
  if (option.label === 'Approve') return 'approve';
  if (option.label === 'Approve Once') return 'approve_once';
  if (option.label === 'Deny') return 'deny';
  return null;
}

function isApprovalDialog(dialog, options) {
  return options.some((option) => optionKind(option)) ||
    /\b(approval|approve|permission|allow|deny|tool call|run command)\b/i.test(
      `${dialog?.title || ''} ${dialog?.message || ''}`
    );
}

function filterDialogOptions(dialog, options) {
  if (!isApprovalDialog(dialog, options)) return options;

  const selected = [];
  const seenKinds = new Set();
  for (const option of options) {
    const kind = optionKind(option);
    if (!kind || seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    selected.push({
      ...option,
      displayLabel: option.label,
      kind,
    });
  }
  return selected;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildDialogText(dialog, options = []) {
  const lines = [];
  if (dialog?.title) lines.push(String(dialog.title));
  if (dialog?.message) lines.push(String(dialog.message));
  if (dialog?.method === 'input' || dialog?.method === 'editor') {
    lines.push('Reply to this message with your response.');
  }

  if (Array.isArray(dialog?.optionDetails) && options.length > 0) {
    const descriptions = options.map((option, index) => {
      const detail = dialog.optionDetails[index];
      if (detail === undefined || detail === null || detail === '') return `- ${option.label}`;
      const rendered = typeof detail === 'string' ? detail : safeJson(detail);
      return `- ${option.label}: ${rendered}`;
    });
    lines.push(descriptions.join('\n'));
  }

  return lines.join('\n\n') || 'The assistant needs your response.';
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!provider || !id || provider.includes('/') || id.includes('/')) return null;
  return {
    provider,
    id,
    key: `${provider}/${id}`,
    name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id,
  };
}

function parseModelArgument(argument) {
  if (!argument || argument.split('/').length !== 2) return null;
  const [provider, id] = argument.split('/');
  if (!provider || !id || /\s/.test(provider) || /\s/.test(id)) return null;
  return { provider, id };
}

function timeoutForDialog(dialog) {
  const raw = Number(dialog?.timeoutMs ?? dialog?.timeout ?? DEFAULT_DIALOG_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DIALOG_TIMEOUT_MS;
  return Math.min(raw, MAX_DIALOG_TIMEOUT_MS);
}

function isSecretDialog(dialog) {
  return dialog?.secret === true;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ERR_JOB_CANCELLED' || error?.message === 'Task cancelled';
}

class JobCancelledError extends Error {
  constructor() {
    super('Task cancelled');
    this.name = 'AbortError';
    this.code = 'ERR_JOB_CANCELLED';
  }
}

async function transcribeVoiceMessage(fileId, chatId, isActive, signal) {
  try {
    if (!isActive()) throw new JobCancelledError();
    const file = await getFile(fileId, signal);
    if (!isActive()) throw new JobCancelledError();
    const audioBuffer = await downloadFile(file.file_path, signal);
    if (!isActive()) throw new JobCancelledError();

    if (audioBuffer.length > MAX_VOICE_FILE_SIZE) {
      if (!isActive()) throw new JobCancelledError();
      await sendMessage(chatId, 'The voice message is too large. Please send a smaller file.');
      return null;
    }

    const transcription = await transcribeAudio(audioBuffer, 'voice.ogg', { signal });
    if (!isActive()) throw new JobCancelledError();
    return transcription;
  } catch (error) {
    if (isAbortError(error) || !isActive()) return null;
    logger.error('Error transcribing voice message:', error.message);
    await sendMessage(chatId, 'Unable to transcribe voice message.');
    return null;
  }
}

export function createTelegramHandler({ agent = defaultAgent } = {}) {
  const jobs = new Map();
  const allJobs = new Set();
  const cancelPending = new Map();
  const callbackRecords = new Map();
  const inputRecordsByChat = new Map();
  let stopping = false;

  function chatBusy(chatId) {
    if (jobs.has(chatId) || cancelPending.has(chatId)) return true;
    try {
      return Boolean(agent?.isBusy?.(chatId));
    } catch {
      return true;
    }
  }

  function isCurrent(job) {
    return !stopping && !job.cancelled && (jobs.get(job.chatId) === job);
  }

  function ensureCurrent(job) {
    if (!isCurrent(job)) throw new JobCancelledError();
  }

  function removeRecordKeyboard(record) {
    if (!record?.messageId || record.keyboardCleared) return;
    record.keyboardCleared = true;
    void telegramRequest('editMessageReplyMarkup', {
      chat_id: record.chatId,
      message_id: record.messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch((error) => {
      logger.warn('Unable to clear expired Telegram buttons:', error.message);
    });
  }

  function closeCallbackRecord(record) {
    if (!record || record.closed) return;
    record.closed = true;
    clearTimeout(record.timer);
    removeRecordKeyboard(record);
    for (const token of record.tokens || []) callbackRecords.delete(token);
    if (record.dialogKey && record.dialogId !== undefined) {
      const current = callbackRecords.get(record.dialogKey);
      if (current === record) callbackRecords.delete(record.dialogKey);
    }
    if (record.input) {
      const records = inputRecordsByChat.get(record.chatId);
      records?.delete(record);
      if (records?.size === 0) inputRecordsByChat.delete(record.chatId);
    }
  }

  function closeAllChatRecords(chatId) {
    for (const record of new Set(callbackRecords.values())) {
      if (record.chatId === chatId) closeCallbackRecord(record);
    }
    const inputRecords = inputRecordsByChat.get(chatId);
    if (inputRecords) {
      for (const record of [...inputRecords]) closeCallbackRecord(record);
    }
  }
  function closeJobRecords(job) {
    for (const record of new Set(callbackRecords.values())) {
      if (record.job === job) closeCallbackRecord(record);
    }
    const inputRecords = inputRecordsByChat.get(job.chatId);
    if (inputRecords) {
      for (const record of [...inputRecords]) {
        if (record.job === job) closeCallbackRecord(record);
      }
    }
  }

  function registerRecord(record) {
    const timeout = timeoutForDialog(record.dialog);
    record.timer = setTimeout(() => closeCallbackRecord(record), timeout);
    if (typeof record.timer.unref === 'function') record.timer.unref();
    for (const token of record.tokens || []) callbackRecords.set(token, record);
    if (record.input) {
      let records = inputRecordsByChat.get(record.chatId);
      if (!records) {
        records = new Set();
        inputRecordsByChat.set(record.chatId, records);
      }
      records.add(record);
    }
  }

  function callbacksFor(job, sourceMessageId) {
    return {
      onText: async (text) => {
        ensureCurrent(job);
        if (typeof text !== 'string' || !text.trim()) return;
        await sendMessageInChunks(job.chatId, formatMessage(text));
      },
      onDialog: async (dialog) => {
        ensureCurrent(job);
        if (!dialog || typeof dialog !== 'object' || !dialog.id) {
          throw new Error('Invalid assistant dialog');
        }
        if (isSecretDialog(dialog)) {
          await sendMessage(job.chatId, 'Secret input requests are not supported in Telegram.');
          throw new Error('Secret dialog is not supported');
        }

        const method = dialog.method;
        if (!['select', 'confirm', 'input', 'editor'].includes(method)) {
          throw new Error(`Unsupported assistant dialog method: ${method || 'unknown'}`);
        }

        const record = {
          type: 'dialog',
          chatId: job.chatId,
          senderId: job.chatId,
          sourceMessageId,
          job,
          dialog,
          dialogId: String(dialog.id),
          tokens: [],
          input: method === 'input' || method === 'editor',
          messageId: null,
          closed: false,
        };

        let markup;
        if (method === 'select') {
          const options = (Array.isArray(dialog.options) ? dialog.options : [])
            .map(normalizeOption)
            .filter(Boolean);
          record.allOptions = options;
          const visibleOptions = filterDialogOptions(dialog, options);
          if (visibleOptions.length === 0) throw new Error('Assistant dialog has no safe options');
          record.options = visibleOptions;
          markup = {
            inline_keyboard: visibleOptions.map((option) => {
              const token = randomToken(DIALOG_CALLBACK_PREFIX);
              record.tokens.push(token);
              callbackRecords.set(token, record);
              return [{
                text: truncateAtWordBoundaryUtf8(option.displayLabel || option.label, 32),
                callback_data: token,
              }];
            }),
          };
        } else if (method === 'confirm') {
          record.options = [
            { value: 'true', label: 'Yes', confirmed: true },
            { value: 'false', label: 'No', confirmed: false },
          ];
          markup = {
            inline_keyboard: record.options.map((option) => {
              const token = randomToken(DIALOG_CALLBACK_PREFIX);
              record.tokens.push(token);
              callbackRecords.set(token, record);
              return [{ text: option.label, callback_data: token }];
            }),
          };
        } else {
          markup = {
            force_reply: true,
            selective: true,
          };
        }

        registerRecord(record);
        try {
          const sent = await sendMessageInChunks(
            job.chatId,
            buildDialogText(dialog, record.allOptions || record.options || []),
            {
              plainText: true,
              ...(markup ? { reply_markup: markup } : {}),
            }
          );
          record.messageId = sent?.message_id === undefined ? null : String(sent.message_id);
          if (record.closed) removeRecordKeyboard(record);
          if (markup && !record.messageId) {
            closeCallbackRecord(record);
            throw new Error('Telegram did not return the dialog message id');
          }
        } catch (error) {
          closeCallbackRecord(record);
          throw error;
        }
      },
      onDialogClosed: async (dialogId) => {
        const id = typeof dialogId === 'object' ? dialogId?.id : dialogId;
        const records = [
          ...new Set(callbackRecords.values()),
          ...(inputRecordsByChat.get(job.chatId) || []),
        ];
        for (const record of records) {
          if (record.chatId === job.chatId && String(record.dialogId) === String(id)) {
            closeCallbackRecord(record);
          }
        }
      },
    };
  }

  async function sendError(job, error) {
    if (!isCurrent(job) || isAbortError(error)) return;
    try {
      await sendMessage(job.chatId, 'Error: Unable to process your request.');
    } catch (sendError) {
      logger.error('Unable to send Telegram error message:', sendError.message);
    }
  }

  function startJob(chatId, kind, operation) {
    if (stopping) return { status: 'stopping' };
    if (chatBusy(chatId)) return { status: 'busy' };

    const job = {
      chatId,
      kind,
      cancelled: false,
      cancelRequested: false,
      cancelFailed: false,
      abortStarted: false,
      controller: new AbortController(),
      finished: false,
      promise: null,
    };
    jobs.set(chatId, job);
    allJobs.add(job);
    job.promise = (async () => {
      try {
        await operation(job);
      } catch (error) {
        await sendError(job, error);
      } finally {
        job.finished = true;
        if (jobs.get(chatId) === job && !job.cancelRequested) jobs.delete(chatId);
        closeJobRecords(job);
        allJobs.delete(job);
      }
    })();
    // The tracked job must never become an unhandled rejection, even if a
    // future callback implementation throws outside the guarded operation.
    job.promise.catch(() => {});
    return { status: 'started', job };
  }

  async function cancelChat(chatId) {
    const job = jobs.get(chatId);
    if (!job && !chatBusy(chatId)) {
      await sendMessage(chatId, 'There is no active task to cancel.');
      return false;
    }

    if (job) {
      job.cancelled = true;
      job.cancelRequested = true;
      job.controller.abort();
      closeAllChatRecords(chatId);
    }

    let abortPromise = cancelPending.get(chatId);
    if (!abortPromise) {
      if (job) job.abortStarted = true;
      abortPromise = Promise.resolve().then(() => agent.abort(chatId));
      cancelPending.set(chatId, abortPromise);
    }

    void abortPromise.then(
      () => {
        if (job) {
          job.cancelFailed = false;
          job.cancelRequested = false;
          if (job.finished && jobs.get(chatId) === job) jobs.delete(chatId);
        }
        if (cancelPending.get(chatId) === abortPromise) cancelPending.delete(chatId);
      },
      async (error) => {
        if (job) job.cancelFailed = true;
        logger.error('Unable to abort assistant task:', error.message);
        if (cancelPending.get(chatId) === abortPromise) cancelPending.delete(chatId);
        try {
          await sendMessage(chatId, 'Cancellation failed; the task remains blocked. Please try /cancel again.');
        } catch (sendError) {
          logger.error('Unable to report cancellation failure:', sendError.message);
        }
      }
    ).catch((error) => logger.error('Cancellation cleanup failed:', error.message));

    try {
      await sendMessage(chatId, 'Cancellation requested.');
    } catch (sendError) {
      logger.error('Unable to report cancellation:', sendError.message);
    }
    return true;
  }

  async function performPrompt(job, prompt, sourceMessageId) {
    ensureCurrent(job);
    const rateLimit = await checkRateLimit(job.chatId);
    ensureCurrent(job);
    if (!rateLimit.allowed) {
      await sendMessage(job.chatId, rateLimit.message);
      return;
    }

    await sendChatAction(job.chatId, 'typing');
    ensureCurrent(job);
    await agent.run(job.chatId, prompt, callbacksFor(job, sourceMessageId));
  }

  async function performVoice(job, message) {
    ensureCurrent(job);
    const rateLimit = await checkRateLimit(job.chatId);
    ensureCurrent(job);
    if (!rateLimit.allowed) {
      await sendMessage(job.chatId, rateLimit.message);
      return;
    }

    await sendChatAction(job.chatId, 'typing');
    ensureCurrent(job);
    const transcription = await transcribeVoiceMessage(
      message.voice.file_id,
      job.chatId,
      () => isCurrent(job),
      job.controller.signal
    );
    ensureCurrent(job);
    if (!transcription) return;

    const caption = message.caption?.trim();
    const prompt = caption
      ? `Voice transcription:\n${transcription}\n\nCaption:\n${caption}`
      : transcription;
    await agent.run(job.chatId, prompt, callbacksFor(job, message.message_id));
  }

  async function resetChat(chatId, confirmation = 'Session reset.') {
    const result = startJob(chatId, 'reset', async (job) => {
      ensureCurrent(job);
      clearModelRecords(chatId);
      closeAllChatRecords(chatId);
      await agent.reset(chatId);
      ensureCurrent(job);
      await sendMessage(chatId, confirmation);
    });
    if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
    return result;
  }

  async function compactChat(chatId) {
    const result = startJob(chatId, 'compact', async (job) => {
      ensureCurrent(job);
      const rateLimit = await checkRateLimit(chatId);
      ensureCurrent(job);
      if (!rateLimit.allowed) {
        await sendMessage(chatId, rateLimit.message);
        return;
      }
      await sendChatAction(chatId, 'typing');
      ensureCurrent(job);
      await agent.compact(chatId, callbacksFor(job));
      ensureCurrent(job);
      await sendMessage(chatId, 'Session compacted.');
    });
    if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
    return result;
  }

  async function modelsChat(chatId) {
    const result = startJob(chatId, 'models', async (job) => {
      ensureCurrent(job);
      const response = await agent.models(chatId);
      ensureCurrent(job);
      const current = normalizeModel(response?.current);
      const models = (Array.isArray(response?.models) ? response.models : [])
        .map(normalizeModel)
        .filter(Boolean);

      const visible = [];
      if (current) visible.push(current);
      for (const id of PREFERRED_MODELS) {
        const model = models.find((candidate) => candidate.provider === 'openai' && candidate.id === id);
        if (model && !visible.some((item) => item.key === model.key)) visible.push(model);
      }
      for (const model of models) {
        if (!visible.some((item) => item.key === model.key)) visible.push(model);
        if (visible.length >= MAX_MODEL_BUTTONS) break;
      }

      clearModelRecords(chatId);
      const record = {
        type: 'model',
        chatId,
        senderId: chatId,
        tokens: [],
        models: visible,
        dialog: { timeoutMs: DEFAULT_DIALOG_TIMEOUT_MS },
        messageId: null,
        closed: false,
      };
      const keyboard = visible.map((model) => {
        const token = randomToken(MODEL_CALLBACK_PREFIX);
        record.tokens.push(token);
        callbackRecords.set(token, record);
        return [{
          text: `${model.key === current?.key ? '✓ ' : ''}${truncateAtWordBoundaryUtf8(model.name, 32)}`,
          callback_data: token,
        }];
      });
      registerRecord(record);

      const currentLabel = current ? current.key : 'unknown';
      const text = visible.length > 0
        ? `Current model: ${currentLabel}\nChoose a model for this chat:`
        : `Current model: ${currentLabel}\nNo models are currently available.`;
      try {
        const sent = await sendMessageInChunks(chatId, text, {
          plainText: true,
          ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        });
        record.messageId = sent?.message_id === undefined ? null : String(sent.message_id);
        if (record.closed) removeRecordKeyboard(record);
        if (keyboard.length > 0 && !record.messageId) throw new Error('Telegram did not return the model picker message id');
      } catch (error) {
        closeCallbackRecord(record);
        throw error;
      }
    });
    if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
    return result;
  }

  function clearModelRecords(chatId) {
    for (const record of new Set(callbackRecords.values())) {
      if (record.type === 'model' && record.chatId === chatId) closeCallbackRecord(record);
    }
  }

  async function setModelFromCommand(chatId, argument) {
    const model = parseModelArgument(argument);
    if (!model) {
      await sendMessage(chatId, 'Usage: /model provider/model-id, or /model to choose from available models.');
      return;
    }

    const result = startJob(chatId, 'set-model', async (job) => {
      ensureCurrent(job);
      await agent.setModel(chatId, model.provider, model.id);
      ensureCurrent(job);
      await sendMessage(chatId, `Model set to ${model.provider}/${model.id}.`);
    });
    if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
  }

  async function handleModelCallback(callbackQuery, record, chatId) {
    if (record.closed || record.messageId === null || String(callbackQuery.message?.message_id) !== record.messageId) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This model picker is no longer available.' });
      return;
    }
    const selected = record.models.find((model) => model.key === record.selectedKey);
    if (!selected) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This model choice is no longer available.' });
      return;
    }

    closeCallbackRecord(record);
    await safeAnswerCallbackQuery(callbackQuery);
    const result = startJob(chatId, 'set-model', async (job) => {
      ensureCurrent(job);
      await agent.setModel(chatId, selected.provider, selected.id);
      ensureCurrent(job);
      await sendMessage(chatId, `Model set to ${selected.key}.`);
    });
    if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
  }

  async function handleDialogCallback(callbackQuery, record, value, chatId) {
    if (
      record.closed ||
      record.messageId === null ||
      String(callbackQuery.message?.message_id) !== record.messageId ||
      String(callbackQuery.from?.id) !== record.senderId
    ) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This request is no longer available.' });
      return;
    }

    closeCallbackRecord(record);
    await safeAnswerCallbackQuery(callbackQuery);

    let response;
    if (record.dialog.method === 'confirm') {
      response = { confirmed: Boolean(value) };
    } else {
      response = { value: String(value) };
    }

    try {
      const accepted = await agent.answer(chatId, record.dialogId, response);
      if (accepted === false) {
        await sendMessage(chatId, 'This request is no longer available.');
      }
    } catch (error) {
      logger.warn('Unable to answer assistant dialog:', error.message);
    }
  }

  async function handleCallback(callbackQuery, chatId) {
    const data = typeof callbackQuery.data === 'string' ? callbackQuery.data : '';
    const record = callbackRecords.get(data);
    if (!record) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This option is no longer available.' });
      return;
    }
    if (record.chatId !== chatId || record.senderId !== String(callbackQuery.from.id)) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This option is not available to you.' });
      return;
    }

    const tokenEntry = record.tokens.includes(data);
    if (!tokenEntry || record.closed) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This option is no longer available.' });
      return;
    }

    if (record.type === 'model') {
      const selected = record.models.find((model) => {
        const index = record.tokens.indexOf(data);
        return index >= 0 && model.key === record.models[index]?.key;
      });
      if (!selected) {
        await safeAnswerCallbackQuery(callbackQuery, { text: 'This model choice is no longer available.' });
        return;
      }
      record.selectedKey = selected.key;
      await handleModelCallback(callbackQuery, record, chatId);
      return;
    }

    const index = record.tokens.indexOf(data);
    const option = record.options?.[index];
    if (!option) {
      await safeAnswerCallbackQuery(callbackQuery, { text: 'This option is no longer available.' });
      return;
    }
    const value = record.dialog.method === 'confirm' ? option.confirmed : option.value;
    await handleDialogCallback(callbackQuery, record, value, chatId);
  }

  async function answerTextDialog(message, chatId, prompt) {
    const records = inputRecordsByChat.get(chatId);
    if (!records || records.size === 0) return false;
    const replyMessageId = message.reply_to_message?.message_id;
    const record = [...records].reverse().find((candidate) =>
      !candidate.closed &&
      candidate.senderId === String(message.from.id) &&
      candidate.messageId !== null &&
      replyMessageId !== undefined &&
      String(replyMessageId) === candidate.messageId
    );
    if (!record) return false;

    if (!prompt) {
      await sendMessage(chatId, 'Please enter a response, or use /cancel.');
      return true;
    }

    closeCallbackRecord(record);
    try {
      const accepted = await agent.answer(chatId, record.dialogId, { value: prompt });
      if (accepted === false) await sendMessage(chatId, 'This request is no longer available.');
    } catch (error) {
      logger.warn('Unable to answer assistant dialog:', error.message);
    }
    return true;
  }

  async function handleMessage(message, chatId) {
    const text = message.text?.trim();
    const command = getTelegramCommand(text);

    if (command === 'cancel') {
      await cancelChat(chatId);
      return;
    }

    if (command === 'start') {
      if (chatBusy(chatId)) {
        await sendMessage(chatId, BUSY_TEXT);
        return;
      }
      await sendMessage(chatId, WELCOME_TEXT);
      return;
    }
    if (command === 'reset' || command === 'clear') {
      await resetChat(chatId, 'Session reset.');
      return;
    }
    if (command === 'compact') {
      await compactChat(chatId);
      return;
    }
    if (command === 'model') {
      const argumentsText = text.replace(/^\/\S+(?:\s+|$)/, '').trim();
      if (!argumentsText) {
        await modelsChat(chatId);
      } else {
        await setModelFromCommand(chatId, argumentsText.split(/\s+/)[0]);
      }
      return;
    }
    if (command) {
      await sendMessage(chatId, UNKNOWN_COMMAND_TEXT);
      return;
    }

    const extractedPrompt = extractPromptFromMessage(message);
    const answeredDialog = await answerTextDialog(message, chatId, extractedPrompt);
    if (answeredDialog) return;

    if (chatBusy(chatId)) {
      await sendMessage(chatId, BUSY_TEXT);
      return;
    }

    // A slash command must never be smuggled through a caption or forwarded
    // message to the assistant's OMP session.
    if (extractedPrompt?.trim().startsWith('/')) {
      await sendMessage(chatId, UNKNOWN_COMMAND_TEXT);
      return;
    }

    if (message.voice) {
      const result = startJob(chatId, 'voice', (job) => performVoice(job, message));
      if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
      return;
    }

    if (extractedPrompt) {
      const result = startJob(chatId, 'prompt', (job) => performPrompt(job, extractedPrompt, message.message_id));
      if (result.status === 'busy') await sendMessage(chatId, BUSY_TEXT);
      return;
    }

    await sendMessage(chatId, 'Please send text, voice, or a forwarded message with text/caption.');
  }

  async function handleUpdate(update) {
    if (stopping || !update || typeof update !== 'object') return;
    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      const chatId = callbackQuery.message?.chat?.id === undefined
        ? null
        : String(callbackQuery.message.chat.id);
      if (!authorizedCallback(callbackQuery)) {
        return;
      }
      if (!chatId) {
        await safeAnswerCallbackQuery(callbackQuery, { text: 'This option is no longer available.' });
        return;
      }
      await handleCallback(callbackQuery, chatId);
      return;
    }

    const message = update.message;
    if (!message || !authorizedMessage(message)) return;
    await handleMessage(message, String(message.chat.id));
  }

  async function shutdownTelegram() {
    if (stopping) return;
    stopping = true;

    const failures = [];
    const active = [...jobs.values()];
    for (const job of active) {
      job.cancelled = true;
      job.cancelRequested = true;
      job.controller.abort();
      closeAllChatRecords(job.chatId);
      if (!job.abortStarted) {
        job.abortStarted = true;
        const abortPromise = Promise.resolve().then(() => agent.abort(job.chatId));
        cancelPending.set(job.chatId, abortPromise);
      }
    }

    const abortResults = await Promise.allSettled([...cancelPending.values()]);
    for (const result of abortResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    const closePromise = Promise.resolve().then(() => agent.close());
    const jobResults = await Promise.allSettled([...allJobs].map((job) => job.promise));
    for (const result of jobResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }

    const closeResult = await Promise.allSettled([closePromise]);
    for (const result of closeResult) {
      if (result.status === 'rejected') failures.push(result.reason);
    }

    for (const record of new Set(callbackRecords.values())) closeCallbackRecord(record);
    for (const records of inputRecordsByChat.values()) {
      for (const record of [...records]) closeCallbackRecord(record);
    }
    jobs.clear();
    allJobs.clear();
    cancelPending.clear();
    callbackRecords.clear();
    inputRecordsByChat.clear();
    if (failures.length > 0) throw failures[0];
  }

  return {
    handleUpdate,
    shutdownTelegram,
    isBusy: (chatId) => chatBusy(String(chatId)),
  };
}

const defaultHandler = createTelegramHandler();

export const handleUpdate = defaultHandler.handleUpdate;
export const shutdownTelegram = defaultHandler.shutdownTelegram;

export default {
  handleUpdate,
  sendMessageInChunks,
  shutdownTelegram,
  createTelegramHandler,
};
