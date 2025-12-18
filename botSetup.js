import Groq from 'groq-sdk';
import TelegramBot from 'node-telegram-bot-api';
import config from './config.js';
import logger from './utils/logger.js';
import { MessageHandler } from './handlers/messageHandler.js';

export function createBot(options = {}) {
    // Initialize Telegram Bot
    // If options.polling is true, it starts polling.
    const bot = new TelegramBot(config.telegram.botApiKey, options);

    // Initialize Groq
    const groqClient = new Groq({ apiKey: config.groq.apiKey });

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

    return { bot, messageHandler };
}
