import { createClient } from 'redis';
import logger from './logger.js';

let redisClient = null;

async function getRedisClient() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

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
    logger.error('Redis Client Error', err);
  });

  await redisClient.connect();
  return redisClient;
}

export async function getConversation(chatId) {
  try {
    const client = await getRedisClient();
    const data = await client.get(`conversation:${chatId}`);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    logger.error('Error getting conversation from Redis:', error);
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

