import { Redis } from '@upstash/redis';

let redisClient = null;

function getRedisClient() {
  if (redisClient) {
    return redisClient;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn('Upstash Redis credentials not set - conversation history disabled');
    return null;
  }

  console.log('Initializing Upstash Redis client...');
  redisClient = new Redis({
    url,
    token,
  });

  return redisClient;
}

export async function getConversation(chatId) {
  try {
    const client = getRedisClient();
    if (!client) {
      return [];
    }
    
    console.log('Getting conversation from Redis...');
    const data = await client.get(`conversation:${chatId}`);
    console.log('Redis get succeeded');
    return data ? (typeof data === 'string' ? JSON.parse(data) : data) : [];
  } catch (error) {
    console.error('Redis getConversation error:', error.message);
    return [];
  }
}

export async function setConversation(chatId, conversation, ttlSeconds) {
  try {
    const client = getRedisClient();
    if (!client) {
      return;
    }
    
    console.log('Saving conversation to Redis...');
    await client.setex(
      `conversation:${chatId}`,
      ttlSeconds,
      JSON.stringify(conversation)
    );
    console.log('Redis set succeeded');
  } catch (error) {
    console.error('Redis setConversation error:', error.message);
  }
}

export async function deleteConversation(chatId) {
  try {
    const client = getRedisClient();
    if (!client) {
      return;
    }
    
    await client.del(`conversation:${chatId}`);
    console.log('Redis delete succeeded');
  } catch (error) {
    console.error('Redis deleteConversation error:', error.message);
  }
}

export default {
  getConversation,
  setConversation,
  deleteConversation,
};
