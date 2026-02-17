import logger from './logger.js';
import { getConversation, setConversation, deleteConversation } from './redis.js';
import { getChatCompletion, generateFollowUpQuestions, transcribeAudio } from './groq.js';
import { formatMessage } from './formatter.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_HISTORY_LENGTH = 10;
const INACTIVITY_TIMEOUT_SECONDS = 30 * 60; // 30 minutes
const FOLLOW_UP_CALLBACK_PREFIX = 'followup:';
const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_BUTTON_TEXT_BYTES = 48;
const DEFAULT_FOLLOW_UP_QUESTIONS = [
  'Can you explain your answer in simpler terms?',
  'Can you give a practical example?',
  'What should I do next?',
];
const LEGACY_FOLLOW_UP_PROMPTS = {
  simple: 'Can you explain your last answer in simpler terms?',
  example: 'Can you give a practical example for your last answer?',
  next: 'What are the best next steps based on your last answer?',
};

function getTelegramApiUrl() {
  const token = process.env.TELEGRAM_BOT_API_KEY;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_API_KEY environment variable');
  }
  return `${TELEGRAM_API_BASE}${token}`;
}

async function telegramRequest(method, body = {}) {
  const url = `${getTelegramApiUrl()}/${method}`;
  console.log(`Telegram API request: ${method}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!data.ok) {
    console.error(`Telegram API error: ${data.description}`);
    throw new Error(`Telegram API error: ${data.description}`);
  }
  console.log(`Telegram API ${method} succeeded`);
  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function answerCallbackQuery(callbackQueryId, options = {}) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...options,
  });
}

async function sendChatAction(chatId, action) {
  return telegramRequest('sendChatAction', {
    chat_id: chatId,
    action,
  });
}

async function getFile(fileId) {
  return telegramRequest('getFile', { file_id: fileId });
}

function buildFollowUpReplyMarkup() {
  return {
    inline_keyboard: DEFAULT_FOLLOW_UP_QUESTIONS.map((question) => [
      {
        text: question,
        callback_data: buildFollowUpCallbackData(question),
      },
    ]),
  };
}

function truncateToUtf8Bytes(text, maxBytes) {
  let output = text;
  while (Buffer.byteLength(output, 'utf8') > maxBytes && output.length > 0) {
    output = output.slice(0, -1);
  }
  return output;
}

function normalizeFollowUpQuestion(question) {
  const compact = (question || '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  const withQuestionMark = compact.endsWith('?') ? compact : `${compact}?`;
  return withQuestionMark;
}

function buildFollowUpCallbackData(question) {
  const normalized = normalizeFollowUpQuestion(question);
  const maxPromptBytes = MAX_CALLBACK_DATA_BYTES - Buffer.byteLength(FOLLOW_UP_CALLBACK_PREFIX, 'utf8');
  const trimmedPrompt = truncateToUtf8Bytes(normalized, maxPromptBytes);
  return `${FOLLOW_UP_CALLBACK_PREFIX}${trimmedPrompt}`;
}

function buildFollowUpButtonText(question) {
  return truncateToUtf8Bytes(normalizeFollowUpQuestion(question), MAX_BUTTON_TEXT_BYTES);
}

function dedupeQuestions(questions) {
  const seen = new Set();
  const deduped = [];

  for (const question of questions) {
    const normalized = normalizeFollowUpQuestion(question);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

async function buildDynamicFollowUpReplyMarkup(userPrompt, assistantResponse) {
  const generatedQuestions = await generateFollowUpQuestions(userPrompt, assistantResponse);
  const fallbackQuestions = DEFAULT_FOLLOW_UP_QUESTIONS;
  const selectedQuestions = dedupeQuestions(
    generatedQuestions.length === 3 ? generatedQuestions : fallbackQuestions
  ).slice(0, 3);

  if (selectedQuestions.length < 3) {
    return buildFollowUpReplyMarkup();
  }

  return {
    inline_keyboard: selectedQuestions.map((question) => [
      {
        text: buildFollowUpButtonText(question),
        callback_data: buildFollowUpCallbackData(question),
      },
    ]),
  };
}

function getFollowUpPromptFromCallbackData(callbackData) {
  if (!callbackData || !callbackData.startsWith(FOLLOW_UP_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPrompt = callbackData.slice(FOLLOW_UP_CALLBACK_PREFIX.length).trim();
  if (!rawPrompt) {
    return null;
  }

  return LEGACY_FOLLOW_UP_PROMPTS[rawPrompt] || rawPrompt;
}

function trimConversationHistory(conversationHistory) {
  if (conversationHistory.length <= MAX_HISTORY_LENGTH * 2) {
    return conversationHistory;
  }
  return conversationHistory.slice(-MAX_HISTORY_LENGTH * 2);
}

async function sendMessageInChunks(chatId, text, options = {}) {
  const chunkSize = 4096;
  const chunks = [];
  const safeText = text?.length ? text : ' ';
  for (let i = 0; i < safeText.length; i += chunkSize) {
    chunks.push(safeText.substring(i, i + chunkSize));
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const isLastChunk = i === chunks.length - 1;
    await sendMessage(chatId, chunks[i], {
      parse_mode: 'HTML',
      ...(isLastChunk ? options : {}),
    });
  }
}

async function downloadFile(filePath) {
  const token = process.env.TELEGRAM_BOT_API_KEY;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

async function transcribeVoiceMessage(fileId, chatId) {
  try {
    // Get the file path from Telegram
    const file = await getFile(fileId);
    
    // Download the audio file to memory
    const audioBuffer = await downloadFile(file.file_path);
    
    // Check file size (20 MB limit)
    const maxFileSize = 20 * 1024 * 1024;
    if (audioBuffer.length > maxFileSize) {
      await sendMessage(chatId, 'The voice message is too large. Please send a smaller file.');
      return null;
    }
    
    // Transcribe using Groq
    const transcription = await transcribeAudio(audioBuffer, 'voice.ogg');
    return transcription;
  } catch (error) {
    logger.error('Error transcribing voice message:', error);
    await sendMessage(chatId, 'Unable to transcribe voice message.');
    return null;
  }
}

async function notifyAdmin(message) {
  const adminId = process.env.ADMINID;
  const logApiKey = process.env.LOGAPIKEY;
  
  if (!adminId || !logApiKey) {
    return;
  }
  
  try {
    const url = `${TELEGRAM_API_BASE}${logApiKey}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminId,
        text: message,
      }),
    });
  } catch (error) {
    logger.error('Error notifying admin:', error);
  }
}

async function processUserPrompt(chatId, userPrompt) {
  let conversationHistory = await getConversation(chatId);
  conversationHistory.push({ role: 'user', content: userPrompt });
  conversationHistory = trimConversationHistory(conversationHistory);

  const response = await getChatCompletion(conversationHistory);
  conversationHistory.push({ role: 'assistant', content: response });
  await setConversation(chatId, conversationHistory, INACTIVITY_TIMEOUT_SECONDS);

  const replyMarkup = await buildDynamicFollowUpReplyMarkup(userPrompt, response);
  const formattedResponse = formatMessage(response);
  await sendMessageInChunks(chatId, formattedResponse, {
    reply_markup: replyMarkup,
  });
}

export async function handleUpdate(update) {
  console.log('handleUpdate called');
  const message = update.message;
  const callbackQuery = update.callback_query;
  const callbackMessage = callbackQuery?.message;
  let chatId = message?.chat?.id?.toString() || callbackMessage?.chat?.id?.toString() || null;
  
  try {
    if (callbackQuery) {
      const followUpPrompt = getFollowUpPromptFromCallbackData(callbackQuery.data);

      if (!chatId || !followUpPrompt) {
        await answerCallbackQuery(callbackQuery.id, {
          text: 'This option is no longer available.',
          show_alert: false,
        });
        logger.warn('Received invalid callback query payload.');
        return;
      }

      await answerCallbackQuery(callbackQuery.id);
      await sendChatAction(chatId, 'typing');
      await processUserPrompt(chatId, followUpPrompt);
      logger.info(`Processed follow-up callback for chat ID ${chatId}.`);
      return;
    }

    if (!message) {
      console.warn('Received update without message');
      return;
    }

    console.log(`Processing message from chat ${chatId}:`, message.text || '[voice/other]');

    if (message.text === '/start') {
      await sendMessage(chatId, 'Welcome to the Groq-powered chatbot!');
      await deleteConversation(chatId);
      logger.info(`Started new conversation with chat ID ${chatId}.`);
      
    } else if (message.text === '/clear') {
      await deleteConversation(chatId);
      await sendMessage(chatId, 'Conversation history cleared.');
      logger.info(`Cleared conversation history for chat ID ${chatId}.`);
      
    } else if (message.voice) {
      await sendChatAction(chatId, 'typing');
      
      const transcription = await transcribeVoiceMessage(message.voice.file_id, chatId);
      
      if (transcription) {
        await processUserPrompt(chatId, transcription);
        logger.info(`Processed voice message for chat ID ${chatId}.`);
      }
      
    } else if (message.text) {
      await sendChatAction(chatId, 'typing');
      await processUserPrompt(chatId, message.text);
      logger.info(`Processed text message for chat ID ${chatId}.`);
      
      await notifyAdmin(`[message] ${JSON.stringify(message)}`);
      
    } else {
      await sendMessage(chatId, 'Please send a text or voice message.');
      logger.warn(`Received unrecognized message type from chat ID ${chatId}.`);
    }
    
  } catch (error) {
    logger.error('Error processing message:', error);
    if (chatId) {
      await sendMessage(chatId, 'Error: Unable to process your request.');
    }
    await notifyAdmin(
      `[message] Error logged by - ${chatId || 'unknown'}. ${error} ----- ${JSON.stringify(message || callbackQuery)}`
    );
  }
}

export default { handleUpdate };
