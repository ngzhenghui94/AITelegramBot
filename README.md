# Groq-Powered Telegram Chatbot

A Telegram bot powered by Groq for advanced text and voice message processing, designed to run on **Vercel** serverless functions.

This bot leverages cutting-edge AI models like `llama-3.3-70b-versatile` for text generation and `whisper-large-v3` for voice transcription, providing an interactive conversational experience.

---

## Features

- **Text Message Handling**: Engage in conversations with Groq's text generation model.
- **Voice Message Transcription**: Automatically transcribes voice messages into text and generates responses.
- **Conversation History**: Maintains context using Redis for intelligent responses.
- **Serverless Architecture**: Runs on Vercel with webhook-based message handling.
- **Commands**:
  - `/start`: Start a new conversation.
  - `/clear`: Clear the current conversation history.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- [Upstash Redis](https://upstash.com/) account (or any Redis-compatible service)
- [Groq API Key](https://console.groq.com/)
- [Telegram Bot Token](https://core.telegram.org/bots#creating-a-new-bot) (from @BotFather)

---

## Project Structure

```
├── api/
│   └── webhook.js      # Vercel serverless function for Telegram webhook
├── lib/
│   ├── formatter.js    # Message formatting utilities
│   ├── groq.js         # Groq API client
│   ├── logger.js       # Serverless-compatible logger
│   ├── redis.js        # Redis client for conversation storage
│   └── telegram.js     # Telegram message handling logic
├── scripts/
│   └── set-webhook.js  # Webhook management script
├── package.json
├── vercel.json         # Vercel configuration
└── .env.example        # Environment variables template
```

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-repo/groq-telegram-bot.git
cd groq-telegram-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
TELEGRAM_BOT_API_KEY=your_telegram_bot_token
GROQ_API_KEY=your_groq_api_key
REDIS_URL=redis://default:password@your-redis-host:port
```

---

## Deployment to Vercel

### 1. Login to Vercel

```bash
vercel login
```

### 2. Deploy

```bash
npm run deploy
```

Or manually:

```bash
vercel --prod
```

### 3. Configure Environment Variables on Vercel

Go to your [Vercel Dashboard](https://vercel.com/dashboard) → Your Project → Settings → Environment Variables.

Add the following variables:
- `TELEGRAM_BOT_API_KEY`
- `GROQ_API_KEY`
- `REDIS_URL`
- `AI_MODEL` (optional, defaults to `llama-3.3-70b-versatile`)
- `ADMINID` (optional)
- `LOGAPIKEY` (optional)

### 4. Set Up the Telegram Webhook

After deployment, set the webhook to point to your Vercel URL:

```bash
npm run set-webhook https://your-app.vercel.app
```

Verify the webhook is set:

```bash
npm run webhook-info
```

---

## Local Development

For local testing, you can use Vercel's development server:

```bash
npm run dev
```

To test webhooks locally, you'll need a tunneling service like [ngrok](https://ngrok.com/):

```bash
# In one terminal
npm run dev

# In another terminal
ngrok http 3000

# Then set webhook to ngrok URL
npm run set-webhook https://your-ngrok-url.ngrok.io
```

---

## Redis Setup (Upstash Recommended)

For serverless environments, [Upstash Redis](https://upstash.com/) is recommended:

1. Create a free account at [upstash.com](https://upstash.com/)
2. Create a new Redis database
3. Copy the Redis URL from the dashboard
4. Set it as `REDIS_URL` in your environment variables

Example URL format:
```
redis://default:your-password@your-region.upstash.io:6379
```

---

## Webhook Management

```bash
# Set webhook
npm run set-webhook https://your-app.vercel.app

# Get webhook info
npm run webhook-info

# Delete webhook (for switching back to polling mode)
npm run delete-webhook
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook` | POST | Telegram webhook endpoint |

---

## Troubleshooting

### Bot not responding?

1. Check webhook status: `npm run webhook-info`
2. Verify environment variables are set in Vercel dashboard
3. Check Vercel function logs for errors

### Voice messages not working?

1. Ensure `GROQ_API_KEY` is valid
2. Check that audio files are under 20MB

### Redis connection issues?

1. Verify `REDIS_URL` is correct
2. Ensure your Redis provider allows connections from Vercel's IPs
3. Check if SSL/TLS is required (use `rediss://` instead of `redis://`)

---

## License

ISC
