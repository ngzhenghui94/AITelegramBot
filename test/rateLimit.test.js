import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRateLimit, resetInMemoryRateLimits } from '../lib/rateLimit.js';

test('checkRateLimit blocks a chat after its hourly allowance is used', async (t) => {
  const originalChatLimit = process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
  const originalGlobalLimit = process.env.RATE_LIMIT_GLOBAL_PER_DAY;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  t.after(() => {
    if (originalChatLimit === undefined) delete process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
    else process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = originalChatLimit;
    if (originalGlobalLimit === undefined) delete process.env.RATE_LIMIT_GLOBAL_PER_DAY;
    else process.env.RATE_LIMIT_GLOBAL_PER_DAY = originalGlobalLimit;
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    resetInMemoryRateLimits();
  });

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = '2';
  process.env.RATE_LIMIT_GLOBAL_PER_DAY = '100';
  resetInMemoryRateLimits();

  const now = new Date('2026-05-29T12:00:00Z');

  assert.equal((await checkRateLimit('151894779', now)).allowed, true);
  assert.equal((await checkRateLimit('151894779', now)).allowed, true);

  const blocked = await checkRateLimit('151894779', now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'chat_hour');
  assert.match(blocked.message, /hourly limit/i);
});

test('checkRateLimit blocks all chats after the daily global allowance is used', async (t) => {
  const originalChatLimit = process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
  const originalGlobalLimit = process.env.RATE_LIMIT_GLOBAL_PER_DAY;
  const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  t.after(() => {
    if (originalChatLimit === undefined) delete process.env.RATE_LIMIT_PER_CHAT_PER_HOUR;
    else process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = originalChatLimit;
    if (originalGlobalLimit === undefined) delete process.env.RATE_LIMIT_GLOBAL_PER_DAY;
    else process.env.RATE_LIMIT_GLOBAL_PER_DAY = originalGlobalLimit;
    if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    resetInMemoryRateLimits();
  });

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.RATE_LIMIT_PER_CHAT_PER_HOUR = '100';
  process.env.RATE_LIMIT_GLOBAL_PER_DAY = '2';
  resetInMemoryRateLimits();

  const now = new Date('2026-05-29T12:00:00Z');

  assert.equal((await checkRateLimit('111', now)).allowed, true);
  assert.equal((await checkRateLimit('222', now)).allowed, true);

  const blocked = await checkRateLimit('333', now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'global_day');
  assert.match(blocked.message, /daily bot limit/i);
});
