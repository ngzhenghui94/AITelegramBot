#!/usr/bin/env node

import 'dotenv/config';
import { handleUpdate, shutdownTelegram } from '../lib/telegram.js';
import { agent } from '../lib/agent.js';
import { checkAgentRuntime } from '../lib/agentRuntime.js';
import logger from '../lib/logger.js';

const shutdown = new AbortController();
let stopping = false;
let closing;

function closeAgent() {
  closing ||= shutdownTelegram();
  // The main finally block observes errors; signals may arrive before it does.
  closing.catch(() => {});
  return closing;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    shutdown.abort();
    logger.info('Stopping polling and cancelling active agent work.');
    closeAgent();
  });
}

async function telegramRequest(method, body = {}, signal = shutdown.signal) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_API_KEY}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

async function main() {
  let offset = 0;
  let ready = false;
  try {
    for (const name of ['TELEGRAM_BOT_API_KEY', 'OPENAI_API_KEY', 'ADMINID']) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}; configure it in .env before running npm start.`);
      }
    }
    if (!/^[1-9]\d*$/.test(process.env.ADMINID)) {
      throw new Error('ADMINID must be the positive numeric Telegram user ID allowed to use this private agent.');
    }
    await checkAgentRuntime();
    const bot = await telegramRequest('getMe');
    const webhook = await telegramRequest('getWebhookInfo');
    if (webhook.url) {
      throw new Error('A webhook is configured. Run npm run delete-webhook before starting local polling.');
    }
    await agent.start(process.env.ADMINID);

    while (!stopping) {
      const updates = await telegramRequest('getUpdates', {
        offset,
        timeout: ready ? 30 : 0,
        allowed_updates: ['message', 'callback_query'],
      });
      if (!ready) {
        logger.info(`Polling started for @${bot.username}. Press Ctrl+C to stop.`);
        ready = true;
      }
      for (const update of updates) {
        if (stopping) break;
        // handleUpdate admits long tasks without waiting for their completion,
        // so later updates can approve tools or cancel an active agent.
        await handleUpdate(update);
        offset = update.update_id + 1;
      }
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    // Updates are acknowledged after admission, not after the agent task finishes.
    await closeAgent();
    if (stopping && offset > 0) {
      await telegramRequest('getUpdates', {
        offset,
        timeout: 0,
        limit: 1,
      }, AbortSignal.timeout(10_000));
    }
  }
}

main().catch((error) => {
  if (stopping && error.name === 'AbortError') return;
  logger.error(error.message);
  process.exitCode = 1;
});
