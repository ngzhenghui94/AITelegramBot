import { handleUpdate } from '../lib/telegram.js';

export const config = {
  maxDuration: 30,
};

function summarizeUpdate(update) {
  const message = update?.message;
  const callbackQuery = update?.callback_query;
  const callbackMessage = callbackQuery?.message;
  const chat = message?.chat || callbackMessage?.chat;
  const from = message?.from || callbackQuery?.from;

  return {
    update_id: update?.update_id,
    update_type: callbackQuery ? 'callback_query' : message ? 'message' : 'unknown',
    chat_id: chat?.id,
    chat_type: chat?.type,
    from_id: from?.id,
    from_username: from?.username,
    text: message?.text,
    has_voice: Boolean(message?.voice),
    has_caption: Boolean(message?.caption),
  };
}

export default async function handler(req, res) {
  console.log('Webhook received:', req.method);
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const update = req.body;
    console.log('Update summary:', JSON.stringify(summarizeUpdate(update)));
    
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
