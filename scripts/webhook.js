#!/usr/bin/env node

// Polling requires an empty webhook URL. Keep this utility for migration/status.

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


async function deleteWebhook() {
  console.log('Deleting webhook...');
  
  const response = await fetch(`${apiUrl}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  
  const data = await response.json();
  
  if (data.ok) {
    console.log('Webhook deleted successfully; pending updates are preserved.');
  } else {
    console.error('Failed to delete webhook:', data.description);
    process.exit(1);
  }
}

async function getWebhookInfo() {
  console.log('Getting webhook info...');
  
  const response = await fetch(`${apiUrl}/getWebhookInfo`);
  const data = await response.json();
  
  if (data.ok) {
    console.log('Webhook info:');
    console.log(JSON.stringify(data.result, null, 2));
  } else {
    console.error('Failed to get webhook info:', data.description);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  npm run delete-webhook   # Switch to local polling');
  console.log('  npm run webhook-info     # Check webhook status');
  process.exit(0);
}

const command = args[0];

if (command === '--delete') {
  deleteWebhook();
} else if (command === '--info') {
  getWebhookInfo();
} else {
  console.error('Invalid argument. Use --delete or --info.');
  process.exit(1);
}
