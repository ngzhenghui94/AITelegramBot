import Groq from 'groq-sdk';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import config from './config.js';
import logger from './utils/logger.js';
import redisClient from './redisClient.js';
import { MessageHandler } from './handlers/messageHandler.js';

// Initialize Groq
const groqClient = new Groq({ apiKey: config.groq.apiKey });

// Initialize Telegram Bot
const bot = new TelegramBot(config.telegram.botApiKey, { polling: true });

// Initialize Logger Bot (if configured)
let telelogger;
if (config.telegram.logApiKey) {
  telelogger = new TelegramBot(config.telegram.logApiKey);
}

// Initialize Message Handler
const messageHandler = new MessageHandler(bot, groqClient, telelogger);

// Bot Event Listeners
bot.on('message', (msg) => {
  messageHandler.handleMessage(msg);
});

bot.on('error', (error) => {
  logger.error('Telegram bot encountered an error:', error);
});

// Health check server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(config.server.port, () => {
  logger.info(`Health check server running on port ${config.server.port}`);
});

logger.info('Bot started successfully.');