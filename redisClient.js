import { Redis } from '@upstash/redis';
import config from './config.js';
import logger from './utils/logger.js';

// Initialize Upstash Redis
// It automatically looks for UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
// Or we can pass them explicitly from our config if mapped.

const redisClient = new Redis({
  url: config.redis.url,
  token: config.redis.token,
});

export default redisClient;
