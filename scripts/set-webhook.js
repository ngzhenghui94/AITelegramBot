#!/usr/bin/env node

/**
 * Script to set or delete the Telegram webhook for your bot.
 * 
 * Usage:
 *   node scripts/set-webhook.js <vercel-url>     # Set webhook
 *   node scripts/set-webhook.js --delete          # Delete webhook
 *   node scripts/set-webhook.js --info            # Get webhook info
 * 
 * Examples:
 *   node scripts/set-webhook.js https://your-app.vercel.app
 *   node scripts/set-webhook.js --delete
 */

import dotenv from 'dotenv';
dotenv.config();

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const token = process.env.TELEGRAM_BOT_API_KEY;

if (!token) {
  console.error('Error: TELEGRAM_BOT_API_KEY environment variable is not set.');
  console.error('Please create a .env file with your bot token.');
  process.exit(1);
}

const apiUrl = `${TELEGRAM_API_BASE}${token}`;

async function setWebhook(url) {
  const webhookUrl = `${url}/api/webhook`;
  console.log(`Setting webhook to: ${webhookUrl}`);
  
  const response = await fetch(`${apiUrl}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message'],
    }),
  });
  
  const data = await response.json();
  
  if (data.ok) {
    console.log('✅ Webhook set successfully!');
    console.log(`   URL: ${webhookUrl}`);
  } else {
    console.error('❌ Failed to set webhook:', data.description);
    process.exit(1);
  }
}

async function deleteWebhook() {
  console.log('Deleting webhook...');
  
  const response = await fetch(`${apiUrl}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  
  const data = await response.json();
  
  if (data.ok) {
    console.log('✅ Webhook deleted successfully!');
  } else {
    console.error('❌ Failed to delete webhook:', data.description);
    process.exit(1);
  }
}

async function getWebhookInfo() {
  console.log('Getting webhook info...');
  
  const response = await fetch(`${apiUrl}/getWebhookInfo`);
  const data = await response.json();
  
  if (data.ok) {
    console.log('📋 Webhook Info:');
    console.log(JSON.stringify(data.result, null, 2));
  } else {
    console.error('❌ Failed to get webhook info:', data.description);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  node scripts/set-webhook.js <vercel-url>   # Set webhook');
  console.log('  node scripts/set-webhook.js --delete        # Delete webhook');
  console.log('  node scripts/set-webhook.js --info          # Get webhook info');
  process.exit(0);
}

const command = args[0];

if (command === '--delete') {
  deleteWebhook();
} else if (command === '--info') {
  getWebhookInfo();
} else if (command.startsWith('http')) {
  setWebhook(command);
} else {
  console.error('Error: Invalid argument. Provide a URL or use --delete/--info');
  process.exit(1);
}

