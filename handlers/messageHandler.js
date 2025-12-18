import config from '../config.js';
import logger from '../utils/logger.js';
import redisClient from '../redisClient.js';
import * as taskManager from '../taskManager.js';
import { transcribeVoiceMessage } from './voiceHandler.js';
import { formatMessage } from '../utils/formatter.js';

export class MessageHandler {
    constructor(bot, groqClient, telelogger) {
        this.bot = bot;
        this.groqClient = groqClient;
        this.telelogger = telelogger;
    }

    async handleMessage(msg) {
        try {
            const chatId = msg.chat.id.toString();

            // Rate Limiting
            if (await this.checkRateLimit(chatId)) return;

            // Get Conversation History
            let conversationHistory = await this.getConversationHistory(chatId);

            if (msg.text) {
                if (msg.text.startsWith('/')) {
                    await this.handleCommand(msg, chatId, conversationHistory);
                } else {
                    await this.handleTextMessage(msg, chatId, conversationHistory);
                }
            } else if (msg.voice) {
                await this.handleVoiceMessage(msg, chatId, conversationHistory);
            } else {
                await this.bot.sendMessage(chatId, 'Please send a text or voice message.');
                logger.warn(`Received unrecognized message type from chat ID ${chatId}.`);
            }

        } catch (error) {
            logger.error('Error processing message:', error);
            await this.bot.sendMessage(msg.chat.id, 'Error: Unable to process your request.');
            if (config.telegram.adminId) {
                await this.telelogger.sendMessage(config.telegram.adminId, `[error] ${error.message} \nMessage: ${JSON.stringify(msg)}`);
            }
        }
    }

    async checkRateLimit(chatId) {
        const rateLimitKey = `rate_limit:${chatId}`;
        const messageCount = await redisClient.incr(rateLimitKey);

        if (messageCount === 1) {
            await redisClient.expire(rateLimitKey, config.limits.rateLimitWindow);
        }

        if (messageCount > config.limits.maxMessagesPerWindow) {
            if (messageCount === config.limits.maxMessagesPerWindow + 1) {
                await this.bot.sendMessage(chatId, 'You are sending messages too fast. Please wait a minute.');
            }
            logger.warn(`Rate limit exceeded for chat ID ${chatId}.`);
            return true;
        }
        return false;
    }

    async getConversationHistory(chatId) {
        let history = await redisClient.get(`conversation:${chatId}`);
        return history ? JSON.parse(history) : [];
    }

    async saveConversationHistory(chatId, history) {
        await redisClient.setex(
            `conversation:${chatId}`,
            config.limits.inactivityTimeout,
            JSON.stringify(history)
        );
    }

    async handleCommand(msg, chatId, conversationHistory) {
        const text = msg.text;
        if (text === '/start') {
            await this.bot.sendMessage(chatId, 'Welcome to the Groq-powered chatbot! You can also manage your tasks with /addtask, /tasks, and /orbit.');
            await redisClient.del(`conversation:${chatId}`);
            logger.info(`Started new conversation with chat ID ${chatId}.`);
        } else if (text === '/clear') {
            await redisClient.del(`conversation:${chatId}`);
            await this.bot.sendMessage(chatId, 'Conversation history cleared.');
            logger.info(`Cleared conversation history for chat ID ${chatId}.`);
        } else if (text.startsWith('/addtask')) {
            const parts = text.split(' ');
            if (parts.length < 3) {
                await this.bot.sendMessage(chatId, 'Usage: /addtask <HH:MM> <Description>');
            } else {
                const time = parts[1];
                const description = parts.slice(2).join(' ');
                await taskManager.addTask(chatId, description, time);
                await this.bot.sendMessage(chatId, `Task added: ${description} at ${time}`);
            }
        } else if (text === '/tasks') {
            const tasks = await taskManager.getTasks(chatId);
            if (tasks.length === 0) {
                await this.bot.sendMessage(chatId, 'No tasks found.');
            } else {
                let response = '<b>Your Tasks:</b>\n';
                tasks.forEach((t, index) => {
                    response += `${index + 1}. [${t.time}] ${t.description}\n`;
                });
                await this.bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
            }
        } else if (text === '/orbit') {
            const tasks = await taskManager.getOrbit(chatId);
            if (tasks.length === 0) {
                await this.bot.sendMessage(chatId, 'Your Orbit is empty.');
            } else {
                let response = '<b>Your Orbit (Schedule):</b>\n';
                tasks.forEach(t => {
                    response += `• <b>${t.time}</b>: ${t.description}\n`;
                });
                await this.bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
            }
        } else if (text === '/clearorbit') {
            await taskManager.clearTasks(chatId);
            await this.bot.sendMessage(chatId, 'Orbit cleared. All tasks removed.');
        } else {
            await this.bot.sendMessage(chatId, 'Unknown command.');
        }
    }

    async handleTextMessage(msg, chatId, conversationHistory) {
        await this.bot.sendChatAction(chatId, 'typing');
        conversationHistory.push({ role: 'user', content: msg.text });
        await this.processGroqResponse(chatId, conversationHistory);
        logger.info(`Processed text message for chat ID ${chatId}.`);

        if (config.telegram.adminId) {
            await this.telelogger.sendMessage(config.telegram.adminId, `[message] ${JSON.stringify(msg)}`);
        }
    }

    async handleVoiceMessage(msg, chatId, conversationHistory) {
        await this.bot.sendChatAction(chatId, 'typing');
        const transcription = await transcribeVoiceMessage(this.bot, this.groqClient, msg.voice.file_id, chatId);

        if (transcription) {
            conversationHistory.push({ role: 'user', content: transcription });
            await this.processGroqResponse(chatId, conversationHistory);
            logger.info(`Processed voice message for chat ID ${chatId}.`);
        }
    }

    async processGroqResponse(chatId, conversationHistory) {
        // Limit history
        if (conversationHistory.length > config.limits.maxHistoryLength * 2) {
            conversationHistory = conversationHistory.slice(-config.limits.maxHistoryLength * 2);
        }

        try {
            const chatCompletion = await this.groqClient.chat.completions.create({
                messages: conversationHistory,
                model: config.groq.textModel,
            });
            const response = chatCompletion.choices[0]?.message?.content || '';

            conversationHistory.push({ role: 'assistant', content: response });
            await this.saveConversationHistory(chatId, conversationHistory);

            const formattedResponse = formatMessage(response);
            await this.sendMessageInChunks(chatId, formattedResponse);

        } catch (error) {
            logger.error('Unable to get chat completion from Groq API:', error);
            await this.bot.sendMessage(chatId, 'I am having trouble processing your request right now.');
        }
    }

    async sendMessageInChunks(chatId, text) {
        const chunkSize = 4096;
        for (let i = 0; i < text.length; i += chunkSize) {
            const chunk = text.substring(i, i + chunkSize);
            await this.bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
        }
    }
}
