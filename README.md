
# Groq-Powered Telegram Chatbot

A Telegram bot powered by Groq for advanced text and voice message processing. This bot leverages cutting-edge AI models like `llama-3.3-70b-versatile` for text generation and `whisper-large-v3` for voice transcription, providing an interactive conversational experience.

---

## Features

- **Text Message Handling**: Engage in conversations with Groq's text generation model.
- **Voice Message Transcription**: Automatically transcribes voice messages into text and generates responses.
- **Conversation History**: Maintains a history of the conversation, ensuring context for intelligent responses.
- **Commands**:
  - `/start`: Start a new conversation.
  - `/clear`: Clear the current conversation history.

---

## Prerequisites

- Node.js (v16 or later)
- Redis for caching conversation histories
- Groq SDK API Key
- Telegram Bot API Key

---

## Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/your-repo/groq-telegram-bot.git
   cd groq-telegram-bot