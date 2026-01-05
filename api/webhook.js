import { handleUpdate } from '../lib/telegram.js';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  console.log('Webhook received:', req.method);
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const update = req.body;
    console.log('Update received:', JSON.stringify(update, null, 2));
    
    if (!update) {
      console.error('No update body received');
      return res.status(400).json({ error: 'No update provided' });
    }

    // Check required env vars
    if (!process.env.TELEGRAM_BOT_API_KEY) {
      console.error('Missing TELEGRAM_BOT_API_KEY');
      return res.status(500).json({ error: 'Missing TELEGRAM_BOT_API_KEY' });
    }
    if (!process.env.GROQ_API_KEY) {
      console.error('Missing GROQ_API_KEY');
      return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    }

    // Process the update
    await handleUpdate(update);
    console.log('Update processed successfully');

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error.message, error.stack);
    // Still return 200 to prevent Telegram from retrying
    return res.status(200).json({ ok: true, error: error.message });
  }
}

