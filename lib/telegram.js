import logger from './logger.js';
import { getConversation, setConversation, deleteConversation } from './redis.js';
import { getChatCompletion, transcribeAudio } from './groq.js';
import { formatMessage } from './formatter.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_HISTORY_LENGTH = 10;
const INACTIVITY_TIMEOUT_SECONDS = 30 * 60; // 30 minutes

function getTelegramApiUrl() {
  const token = process.env.TELEGRAM_BOT_API_KEY;
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_API_KEY environment variable');
  }
  return `${TELEGRAM_API_BASE}${token}`;
}

async function telegramRequest(method, body = {}) {
  const url = `${getTelegramApiUrl()}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
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

async function sendMessageInChunks(chatId, text) {
  const chunkSize = 4096;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.substring(i, i + chunkSize);
    await sendMessage(chatId, chunk, { parse_mode: 'HTML' });
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

export async function handleUpdate(update) {
  const message = update.message;
  
  if (!message) {
    logger.warn('Received update without message');
    return;
  }
  
  const chatId = message.chat.id.toString();
  
  try {
    // Fetch conversation history from Redis
    let conversationHistory = await getConversation(chatId);
    
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
        // Add user's transcribed message to the conversation history
        conversationHistory.push({ role: 'user', content: transcription });
        
        // Limit conversation history
        if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) {
          conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH * 2);
        }
        
        // Get the response from the Groq API
        const response = await getChatCompletion(conversationHistory);
        
        // Add assistant's response to the conversation history
        conversationHistory.push({ role: 'assistant', content: response });
        
        // Save updated conversation history to Redis with expiration
        await setConversation(chatId, conversationHistory, INACTIVITY_TIMEOUT_SECONDS);
        
        // Send the response
        const formattedResponse = formatMessage(response);
        await sendMessageInChunks(chatId, formattedResponse);
        logger.info(`Processed voice message for chat ID ${chatId}.`);
      }
      
    } else if (message.text) {
      await sendChatAction(chatId, 'typing');
      
      // Add user's message to the conversation history
      conversationHistory.push({ role: 'user', content: message.text });
      
      // Limit conversation history
      if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) {
        conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH * 2);
      }
      
      // Get the response from the Groq API
      const response = await getChatCompletion(conversationHistory);
      
      // Add assistant's response to the conversation history
      conversationHistory.push({ role: 'assistant', content: response });
      
      // Save updated conversation history to Redis with expiration
      await setConversation(chatId, conversationHistory, INACTIVITY_TIMEOUT_SECONDS);
      
      // Send the response
      const formattedResponse = formatMessage(response);
      await sendMessageInChunks(chatId, formattedResponse);
      logger.info(`Processed text message for chat ID ${chatId}.`);
      
      await notifyAdmin(`[message] ${JSON.stringify(message)}`);
      
    } else {
      await sendMessage(chatId, 'Please send a text or voice message.');
      logger.warn(`Received unrecognized message type from chat ID ${chatId}.`);
    }
    
  } catch (error) {
    logger.error('Error processing message:', error);
    await sendMessage(chatId, 'Error: Unable to process your request.');
    await notifyAdmin(`[message] Error logged by - ${chatId}. ${error} ----- ${JSON.stringify(message)}`);
  }
}

export default { handleUpdate };

