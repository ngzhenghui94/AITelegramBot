# OpenAI-Powered Telegram Chatbot

A Telegram bot powered by OpenAI for text and voice messages, designed to run on **Vercel** serverless functions.

Chat replies, follow-up questions, and conversation compaction use the Responses API with `gpt-6.1-sol` by default. Voice messages use `gpt-transcribe` through the audio transcription API.

---

## Features

- **Text Message Handling**: Generate replies and follow-up buttons with OpenAI's Responses API.
- **Voice Message Transcription**: Transcribe Telegram OGG voice messages with OpenAI, then generate a reply.
- **Conversation History**: Maintains context using Redis for intelligent responses.
- **Serverless Architecture**: Runs on Vercel with webhook-based message handling.
- **Commands**:
  - `/start`: Start a new conversation.
  - `/clear`: Clear the current conversation history.
  - `/reset`: Clear the current conversation history.
  - `/compact`: Summarize the current conversation history into a shorter session memory.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- [Upstash Redis](https://upstash.com/) account (or any Redis-compatible service)
- [OpenAI API key](https://platform.openai.com/api-keys) with model access and available API credits
- [Telegram Bot Token](https://core.telegram.org/bots#creating-a-new-bot) (from @BotFather)

---

## Project Structure

```
├── api/
│   └── webhook.js      # Vercel serverless function for Telegram webhook
├── lib/
│   ├── formatter.js    # Message formatting utilities
│   ├── openai.js       # Responses API and voice transcription
│   ├── logger.js       # Serverless-compatible logger
│   ├── redis.js        # Redis client for conversation storage
│   └── telegram.js     # Telegram message handling logic
├── scripts/
│   └── set-webhook.js  # Webhook management script
├── package.json
└── vercel.json         # Vercel configuration
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

Create a local `.env` file with your credentials. This file is ignored by Git; never commit API keys.

```env
TELEGRAM_BOT_API_KEY=your_telegram_bot_token
OPENAI_API_KEY=your-openai-api-key
AI_MODEL=gpt-6.1-sol
UPSTASH_REDIS_REST_URL=https://your-upstash-redis-url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token
RATE_LIMIT_PER_CHAT_PER_HOUR=20
RATE_LIMIT_GLOBAL_PER_DAY=200
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
- `OPENAI_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RATE_LIMIT_PER_CHAT_PER_HOUR` (optional, defaults to `20`)
- `RATE_LIMIT_GLOBAL_PER_DAY` (optional, defaults to `200`)
- `AI_MODEL` (optional, defaults to `gpt-6.1-sol`; must be an OpenAI model supporting the Responses API)
- `ADMINID` (optional)
- `LOGAPIKEY` (optional)

The OpenAI key needs access to `POST /v1/responses` and `POST /v1/audio/transcriptions`. Model listing, file storage, and agent permissions are not needed. Configure the key in every Vercel environment where the bot will run.

When migrating from Groq, replace the old `AI_MODEL` value with `gpt-6.1-sol` (or remove it to use the default). `GROQ_API_KEY` is no longer used. Environment changes require a new deployment.

Responses are requested with `store: false`; conversation history still uses Redis. Each OpenAI request has a 90-second timeout, and the webhook allows 300 seconds for the sequential voice, reply, and follow-up calls.

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
3. Copy the REST URL and REST token from the dashboard
4. Set them as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in your environment variables

Redis is used for conversation history and cross-instance rate limits. Without Upstash configured, rate limits fall back to in-memory counters, which are useful locally but not reliable across Vercel serverless instances.

## Rate Limits

Prompt processing is limited before OpenAI text generation:

- `RATE_LIMIT_PER_CHAT_PER_HOUR`: maximum accepted prompts per chat per UTC hour. Default: `20`.
- `RATE_LIMIT_GLOBAL_PER_DAY`: maximum accepted prompts across all chats per UTC day. Default: `200`.

Commands such as `/start` and `/clear` do not count against the AI limits.

An accepted prompt normally makes two Responses API calls: one reply and one follow-up-question request. `/compact` counts as one prompt and makes one Responses call. Voice transcription runs before these checks, so these limits are not a hard spending cap on transcription or total API usage.

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

### OpenAI requests failing?

1. Verify `OPENAI_API_KEY` is set and has access to the required endpoints.
2. Check that `AI_MODEL` is an available OpenAI model, not the previous Groq model ID.
3. Check API credits, model access, and rate limits in the OpenAI dashboard.

### Voice messages not working?

1. Ensure `OPENAI_API_KEY` can call `/v1/audio/transcriptions` with `gpt-transcribe`.
2. Check that audio files are under the bot's existing 20 MB limit.

### Redis connection issues?

1. Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are correct
2. Ensure the Upstash database is active
3. Check Vercel logs for Redis warnings

---

## License

ISC
