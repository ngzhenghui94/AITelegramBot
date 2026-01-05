import { handleUpdate } from '../lib/telegram.js';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const update = req.body;
    
    if (!update) {
      return res.status(400).json({ error: 'No update provided' });
    }

    // Process the update asynchronously
    await handleUpdate(update);

    // Return 200 immediately to acknowledge receipt
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    // Still return 200 to prevent Telegram from retrying
    return res.status(200).json({ ok: true, error: 'Processed with errors' });
  }
}

