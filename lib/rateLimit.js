import { Redis } from '@upstash/redis';
import logger from './logger.js';

const DEFAULT_PER_CHAT_PER_HOUR = 20;
const DEFAULT_GLOBAL_PER_DAY = 200;
const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

let redisClient = null;
const inMemoryCounts = new Map();

function parseLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(`${name} must be a positive integer; using ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function getRedisClient() {
  if (redisClient) {
    return redisClient;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getUtcHourBucket(now) {
  return now.toISOString().slice(0, 13);
}

function getUtcDayBucket(now) {
  return now.toISOString().slice(0, 10);
}

async function incrementCounter(key, ttlSeconds) {
  const client = getRedisClient();
  if (client) {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, ttlSeconds);
    }
    return count;
  }

  const current = inMemoryCounts.get(key) || 0;
  const next = current + 1;
  inMemoryCounts.set(key, next);
  return next;
}

export function resetInMemoryRateLimits() {
  inMemoryCounts.clear();
  redisClient = null;
}

export async function checkRateLimit(chatId, now = new Date()) {
  const perChatLimit = parseLimit('RATE_LIMIT_PER_CHAT_PER_HOUR', DEFAULT_PER_CHAT_PER_HOUR);
  const globalLimit = parseLimit('RATE_LIMIT_GLOBAL_PER_DAY', DEFAULT_GLOBAL_PER_DAY);
  const chatBucket = getUtcHourBucket(now);
  const dayBucket = getUtcDayBucket(now);

  const chatCount = await incrementCounter(
    `rate_limit:chat:${chatId}:${chatBucket}`,
    SECONDS_PER_HOUR
  );

  if (chatCount > perChatLimit) {
    return {
      allowed: false,
      reason: 'chat_hour',
      limit: perChatLimit,
      count: chatCount,
      message: `Hourly limit reached. Please try again later. (${perChatLimit} AI requests/hour)`,
    };
  }

  const globalCount = await incrementCounter(
    `rate_limit:global:${dayBucket}`,
    SECONDS_PER_DAY
  );

  if (globalCount > globalLimit) {
    return {
      allowed: false,
      reason: 'global_day',
      limit: globalLimit,
      count: globalCount,
      message: `Daily bot limit reached. AI replies are paused to prevent unexpected billing. (${globalLimit} AI requests/day)`,
    };
  }

  return {
    allowed: true,
    perChatRemaining: Math.max(perChatLimit - chatCount, 0),
    globalRemaining: Math.max(globalLimit - globalCount, 0),
  };
}

export default {
  checkRateLimit,
  resetInMemoryRateLimits,
};
