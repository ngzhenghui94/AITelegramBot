import { createBot } from '../botSetup.js';
import config from '../config.js';

// Initialize bot WITHOUT polling
const { bot } = createBot({ polling: false });

export default async function handler(req, res) {
    try {
        if (req.method === 'POST') {
            const { body } = req;

            // Process the update
            if (body) {
                bot.processUpdate(body);
            }

            res.status(200).json({ ok: true });
        } else {
            // Optional: Check webhook status or set webhook
            res.status(200).send('Telegram Bot Webhook is active!');
        }
    } catch (error) {
        console.error('Error in webhook handler:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
