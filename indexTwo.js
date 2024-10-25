import Groq from "groq-sdk";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from 'mongodb';

const url = "mongodb+srv://daniel:f3mrfnu8ohFcL7SJ@tgchatgpt.mc7jksn.mongodb.net/?retryWrites=true&w=majority&appName=tgchatgpt";
const dbName = 'groq_chatbot';
const collectionName = 'conversations';

dotenv.config();

const model = "llama-3.1-70b-versatile";
const telegramBotApiKey = process.env.TELEGRAMBOTAPIKEY;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramBotApiKey || !groqApiKey) {
  throw new Error("Missing API keys. Please set TELEGRAMBOTAPIKEY and GROQ_API_KEY environment variables.");
}

const bot = new TelegramBot(telegramBotApiKey, { polling: true });
const groqClient = new Groq({ apiKey: groqApiKey });

async function connectToDatabase() {
  try {
    const client = await MongoClient.connect(url);
    return client;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function disconnectFromDatabase(client) {
  try {
    await client.close();
  } catch (error) {
    console.error(error);
  }
}
let conversation

async function main() {
  try {
    console.log('Connecting to MongoDB');
    const client = await connectToDatabase();
    console.log('Connected to MongoDB');

    const db = client.db(dbName);
    const conversations = db.collection(collectionName);

    bot.on('message', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (text === '/start') {
          await bot.sendMessage(chatId, 'Welcome to the Groq-powered chatbot!');
        } else {
          await bot.sendChatAction(chatId, 'typing');
          const response = await getGroqChatCompletion(text);
          const formattedResponse = formatMessage(response);
          const chunkSize = 4096;
          const chunks = [];

          for (let i = 0; i < formattedResponse.length; i += chunkSize) {
            chunks.push(formattedResponse.substring(i, i + chunkSize));
          }

          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
          }
        }

        conversation = await conversations.findOne({ chatId: chatId });
        if (!conversation) {
          conversation = { chatId: chatId, messages: [] };
          await conversations.insertOne(conversation);
        }

        conversation.messages.push({ text: text });
        await conversations.updateOne({ chatId: chatId }, { $set: { messages: conversation.messages } });
      } catch (error) {
        console.error(error);
        await bot.sendMessage(msg.chat.id, 'Error: Unable to process your request.');
      }
    });

    bot.on('message_update', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text;

        const conversation = await conversations.findOne({ chatId: chatId });
        if (!conversation) {
          throw new Error('Conversation not found');
        }

        conversation.messages.push({ text: text });
        await conversations.updateOne({ chatId: chatId }, { $set: { messages: conversation.messages } });

      } catch (error) {
        console.error(error);
        await bot.sendMessage(msg.chat.id, 'Error: Unable to process your request.');
      }
    });

    bot.on('message_delete', async (msg) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text;

        const conversation = await conversations.findOne({ chatId: chatId });
        if (!conversation) {
          throw new Error('Conversation not found');
        }

        conversation.messages = conversation.messages.filter((message) => message.text !== text);
        await conversations.updateOne({ chatId: chatId }, { $set: { messages: conversation.messages } });

      } catch (error) {
        console.error(error);
        await bot.sendMessage(msg.chat.id, 'Error: Unable to process your request.');
      }
    });

    process.on('SIGINT', async () => {
      await disconnectFromDatabase(client);
      process.exit(0);
    });
  } catch (error) {
    console.error(error);
  }
}

async function getGroqChatCompletion(text) {
  try {
    const chatCompletion = await groqClient.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: text,
        },
      ],
      model,
    });
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error(error);
    throw new Error('Unable to get chat completion from Groq API');
  }
}

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
  console.error(error);
});

main();