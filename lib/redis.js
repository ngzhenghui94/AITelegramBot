import { createClient } from 'redis';
import logger from './logger.js';

let redisClient = null;

async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable not set');
  }
  
  console.log('Connecting to Redis...');

  redisClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          return new Error('Redis connection failed after 3 retries');
        }
        return Math.min(retries * 100, 1000);
      },
    },
  });

  redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
  });

  await redisClient.connect();
  console.log('Redis connected');
  return redisClient;
}

export async function getConversation(chatId) {
  try {
    console.log('Getting conversation from Redis...');
    const client = await getRedisClient();
    const data = await client.get(`conversation:${chatId}`);
    console.log('Redis get succeeded');
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Redis getConversation error:', error.message);
    // Return empty array to allow bot to continue without Redis
    return [];
  }
}

export async function setConversation(chatId, conversation, ttlSeconds) {
  try {
    const client = await getRedisClient();
    await client.setEx(
      `conversation:${chatId}`,
      ttlSeconds,
      JSON.stringify(conversation)
    );
  } catch (error) {
    logger.error('Error setting conversation in Redis:', error);
  }
}

export async function deleteConversation(chatId) {
  try {
    const client = await getRedisClient();
    await client.del(`conversation:${chatId}`);
  } catch (error) {
    logger.error('Error deleting conversation from Redis:', error);
  }
}

export default {
  getConversation,
  setConversation,
  deleteConversation,
};

