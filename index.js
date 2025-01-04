import Groq from 'groq-sdk';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import redisClient from './redisClient.js';


// Define __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


dotenv.config();

// 'llama-3.1-70b-versatile' model for text handling
// 'whisper-large-v3' model for voice recordings
const textModel = process.env.AI_MODEL || 'llama-3.1-70b-versatile';
const telegramBotApiKey = process.env.TELEGRAM_BOT_API_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramBotApiKey || !groqApiKey) {
  logger.error(
    'Missing API keys. Please set TELEGRAM_BOT_API_KEY and GROQ_API_KEY environment variables.'
  );
  throw new Error(
    'Missing API keys. Please set TELEGRAM_BOT_API_KEY and GROQ_API_KEY environment variables.'
  );
}

const bot = new TelegramBot(telegramBotApiKey, { polling: true });
const groqClient = new Groq({ apiKey: groqApiKey });

// const conversationHistories = {};
const MAX_HISTORY_LENGTH = 10; // Adjust as needed
const INACTIVITY_TIMEOUT_SECONDS = 30 * 60; // 30 minutes in seconds
// const inactivityTimers = {};


bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id.toString();

    // Fetch conversation history from Redis
    let conversationHistory = await redisClient.get(`conversation:${chatId}`);
    if (conversationHistory) {
      conversationHistory = JSON.parse(conversationHistory);
    } else {
      conversationHistory = [];
    }

    if (msg.text === '/start') {
      await bot.sendMessage(chatId, 'Welcome to the Groq-powered chatbot!');
      await redisClient.del(`conversation:${chatId}`);
      logger.info(`Started new conversation with chat ID ${chatId}.`);
    } else if (msg.text === '/clear') {
      await redisClient.del(`conversation:${chatId}`);
      await bot.sendMessage(chatId, 'Conversation history cleared.');
      logger.info(`Cleared conversation history for chat ID ${chatId}.`);
    } else if (msg.voice) {
      await bot.sendChatAction(chatId, 'typing');

      // Handle voice message
      const transcription = await transcribeVoiceMessage(msg.voice.file_id, chatId);

      if (transcription) {
        // Add user's transcribed message to the conversation history
        conversationHistory.push({ role: 'user', content: transcription });

        // Limit conversation history
        if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) {
          conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH * 2);
        }

        // Get the response from the Groq API
        const response = await getGroqChatCompletion(conversationHistory);

        // Add assistant's response to the conversation history
        conversationHistory.push({ role: 'assistant', content: response });

        // Save updated conversation history to Redis with expiration
        await redisClient.setEx(
          `conversation:${chatId}`,
          INACTIVITY_TIMEOUT_SECONDS,
          JSON.stringify(conversationHistory)
        );

        // Send the response
        const formattedResponse = formatMessage(response);
        await sendMessageInChunks(chatId, formattedResponse);
        logger.info(`Processed voice message for chat ID ${chatId}.`);
      }
    } else if (msg.text) {
      await bot.sendChatAction(chatId, 'typing');

      // Add user's message to the conversation history
      conversationHistory.push({ role: 'user', content: msg.text });

      // Limit conversation history
      if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) {
        conversationHistory = conversationHistory.slice(-MAX_HISTORY_LENGTH * 2);
      }

      // Get the response from the Groq API
      const response = await getGroqChatCompletion(conversationHistory);

      // Add assistant's response to the conversation history
      conversationHistory.push({ role: 'assistant', content: response });

      // Save updated conversation history to Redis with expiration
      await redisClient.setEx(
        `conversation:${chatId}`,
        INACTIVITY_TIMEOUT_SECONDS,
        JSON.stringify(conversationHistory)
      );

      // Send the response
      const formattedResponse = formatMessage(response);
      await sendMessageInChunks(chatId, formattedResponse);
      logger.info(`Processed text message for chat ID ${chatId}.`);
    } else {
      await bot.sendMessage(chatId, 'Please send a text or voice message.');
      logger.warn(`Received unrecognized message type from chat ID ${chatId}.`);
    }
  } catch (error) {
    logger.error('Error processing message:', error);
    await bot.sendMessage(msg.chat.id, 'Error: Unable to process your request.');
  }
});




async function transcribeVoiceMessage(fileId, chatId) {
  // Declare tempFilePath outside the try block
  const tempFilePath = path.join(__dirname, `temp_audio_${chatId}.ogg`);

  try {
    // Get the file path from Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${telegramBotApiKey}/${file.file_path}`;

    // Download the audio file and save it locally
    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // Create a write stream to save the file
    const writer = fs.createWriteStream(tempFilePath);

    // Pipe the response data to the file
    response.data.pipe(writer);

    // Wait for the file to finish writing
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Check the file size
    const stats = fs.statSync(tempFilePath);
    const maxFileSize = 20 * 1024 * 1024; // 20 MB
    if (stats.size > maxFileSize) {
      fs.unlinkSync(tempFilePath); // Delete the temp file
      await bot.sendMessage(chatId, 'The voice message is too large. Please send a smaller file.');
      return null;
    }

    // Create a read stream from the saved file
    const audioStream = fs.createReadStream(tempFilePath);

    // Send the audio file to the Groq API for transcription
    const transcriptionResult = await groqClient.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-large-v3', // Use the transcription model
    });

    // Delete the temp file after transcription
    fs.unlinkSync(tempFilePath);

    return transcriptionResult.text;
  } catch (error) {
    // If there's an error, ensure the temp file is deleted
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    // **Log the error**
    logger.error('Error transcribing voice message:', error.response?.data || error.message);

    await bot.sendMessage(chatId, 'Unable to transcribe voice message.');
    return null;
  }
}

async function getGroqChatCompletion(conversation) {
  try {
    const chatCompletion = await groqClient.chat.completions.create({
      messages: conversation,
      model: textModel,
    });
    logger.info('Received chat completion from Groq API.');
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    logger.error('Unable to get chat completion from Groq API:', error);
    throw new Error(`Unable to get chat completion from Groq API: ${error.message}`);
  }
}

async function sendMessageInChunks(chatId, text) {
  const chunkSize = 4096;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.substring(i, i + chunkSize);
    await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
  }
}
// ... (Your formatting functions remain unchanged)
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function applyHandPoints(text) {
  return text.replace(/^(#+) (.*)$/gm, '<b>$2</b>');
}

function applyBold(text) {
  return text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
}

function applyItalic(text) {
  return text.replace(/(?<!\*)\*(?!\*)(?!\*\*)(.*?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
}

function applyCode(text) {
  return text.replace(/```([\w]*?)\n([\s\S]*?)```/g, '<pre lang="$1">\n$2\n</pre>');
}

function applyMonospace(text) {
  return text.replace(/(?<!`)`(?!`)(.*?)(?<!`)`(?!`)/g, '<code>$1</code>');
}

function applyLink(text) {
  return text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
}

function applyUnderline(text) {
  return text.replace(/__(.*?)__/g, '<u>$1</u>');
}

function applyStrikethrough(text) {
  return text.replace(/~~(.*?)~~/g, '<s>$1</s>');
}

function applyHeader(text) {
  return text.replace(/^(#{1,6})\s+(.*)/gm, '<b><u>$2</u></b>');
}

function applyExcludeCode(text) {
  const lines = text.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (!inCodeBlock) {
      let formattedLine = lines[i];
      formattedLine = applyHeader(formattedLine);
      formattedLine = applyLink(formattedLine);
      formattedLine = applyBold(formattedLine);
      formattedLine = applyItalic(formattedLine);
      formattedLine = applyUnderline(formattedLine);
      formattedLine = applyStrikethrough(formattedLine);
      formattedLine = applyMonospace(formattedLine);
      formattedLine = applyHandPoints(formattedLine);
      lines[i] = formattedLine;
    }
  }

  return lines.join('\n');
}

function formatMessage(text) {
  const formattedText = escapeHtml(text);
  const formattedTextWithCode = applyExcludeCode(formattedText);
  const formattedTextWithCodeBlocks = applyCode(formattedTextWithCode);
  return formattedTextWithCodeBlocks;
}


bot.on('error', (error) => {
  logger.error('Telegram bot encountered an error:', error);
});