import dotenv from 'dotenv';
dotenv.config();

const config = {
    env: process.env.NODE_ENV || 'development',
    telegram: {
        botApiKey: process.env.TELEGRAM_BOT_API_KEY,
        adminId: process.env.ADMINID,
        logApiKey: process.env.LOGAPIKEY,
    },
    groq: {
        apiKey: process.env.GROQ_API_KEY,
        textModel: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
        audioModel: 'whisper-large-v3',
    },
    redis: {
        url: process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    },
    server: {
        port: process.env.PORT || 3000,
    },
    limits: {
        maxHistoryLength: 10,
        inactivityTimeout: 30 * 60, // 30 minutes in seconds
        rateLimitWindow: 60, // 60 seconds
        maxMessagesPerWindow: 10,
        maxVoiceFileSize: 20 * 1024 * 1024, // 20 MB
    },
};

// Validation
const missingKeys = [];
if (!config.telegram.botApiKey) missingKeys.push('TELEGRAM_BOT_API_KEY');
if (!config.groq.apiKey) missingKeys.push('GROQ_API_KEY');

if (missingKeys.length > 0) {
    throw new Error(`Missing required environment variables: ${missingKeys.join(', ')}`);
}

export default config;
