# Telegram OMP Agent

A private Telegram interface to the [OMP](https://github.com/can1357/oh-my-pi) agent harness. Text, captions, and transcribed voice messages go to persistent OMP sessions, which can read and edit files, execute code, search the web, and delegate work using OMP's tools.

OMP is the default and only chat backend. The bot runs as a long-lived local polling process; the former direct-completion and Vercel webhook paths have been removed.

## Requirements

- Node.js 18 or newer for the bot.
- A running Linux Docker engine and permission to build/run containers.
- The compiled Linux `omp` executable on `PATH`, matching the Docker host architecture. Set `OMP_BIN` if it is installed elsewhere.
- A Telegram bot token and the positive numeric Telegram user ID of its owner.
- An OpenAI API key with access to the chosen OMP model. Voice transcription additionally needs `gpt-transcribe` access.
- Optional Upstash Redis credentials for rate limits that survive bot restarts.

The bot requires Docker. There is no fallback that runs agent tools on the host.

## Setup

Install the bot dependencies:

```bash
npm ci
```

Configure `.env` (ignored by Git):

```env
TELEGRAM_BOT_API_KEY=your_telegram_bot_token
ADMINID=your_positive_numeric_telegram_user_id
OPENAI_API_KEY=your_openai_api_key
AI_MODEL=gpt-6.1-sol
```

`ADMINID` is now required. Both the sender ID and private chat ID must match it. Group chats and other users cannot invoke the agent, use commands, answer questions, or approve actions.

Build the isolated worker and start the bot:

```bash
npm run setup-agent

# Only needed when migrating a bot that still has a webhook; preserves pending updates.
npm run delete-webhook

npm start
```

The image build uses only the installed OMP binary and `Dockerfile.agent`. It does not send the repository, `.env`, or your personal OMP configuration to Docker. It includes Git, Node.js/npm, Python, and Chromium for agent work.

Wait for `Polling started for @...`, then open the bot's private chat and send `/start`. Example tasks:

- "List the files in your workspace."
- "Write a Python script that validates a CSV file, then run it on a small sample."
- "Read this documentation URL and explain the important changes."

Only one polling process may use a bot token. Keep the machine and Docker engine running. Use a process supervisor if you need automatic restart after a polling/network failure or reboot; `npm start` itself does not install one.

## Commands

| Command | Behavior |
|---|---|
| `/start` | Show how to use the private agent. |
| `/reset`, `/clear` | Start a fresh OMP conversation. Workspace files and archived session files are not deleted. |
| `/compact` | Ask OMP to compact older history. Very short sessions have nothing to compact. Counts against the prompt rate limit. |
| `/model` | Show the current model and a bounded selection from OMP's available models. |
| `/model provider/model-id` | Select another available model, for example `/model openai/gpt-6.1-sol`. |
| `/cancel` | Cancel the active task and stop its container, including background tools. The next request resumes the saved session in a new worker. |

One task runs at a time. Ordinary prompts received while a task is busy are rejected with a busy notice, not silently queued. Approval answers and cancellation remain available while the task runs. Unknown slash commands are not forwarded to OMP's administrative command interface.

## Tool approvals and questions

OMP runs in `always-ask` mode. Reads are normally allowed; writes and execution require explicit approval in Telegram.

- The bot sends the tool's full approval details and buttons for a single-call decision. It does not offer blanket or remembered approval grants.
- Only the authorized user can answer. Buttons are bound to the exact chat, message, and outstanding request, and can be used only once.
- A question needing free text must be answered using Telegram's **Reply** action on that question. An unrelated message is never treated as an approval.
- Unanswered requests expire and are cancelled; they are never automatically approved.
- `/cancel`, completion, or worker failure invalidates outstanding requests. Unsupported or secret-input dialogs fail closed.
- Private model reasoning and raw tool output are not forwarded as chat messages. Assistant text is delivered after each completed assistant message.

Approval authorizes that specific operation. Read its details: code execution can access the worker's files, network, and provider credentials. Web pages and tool results are untrusted input, not permission to take further actions.

## Isolation and persistent state

Each authorized conversation has an OMP container with:

- UID/GID `10001`, a read-only image, dropped Linux capabilities, and no-new-privileges.
- Limits of 2 CPUs, 2 GiB RAM, and 256 processes; a temporary `/tmp` filesystem.
- Separate Docker volumes for `/home/agent` and `/workspace`.
- No host repository/home mounts, Docker socket, or host-network mode.
- No Telegram token, Redis credentials, admin-log token, or personal OMP profile.

Only `OPENAI_API_KEY` and configured search-provider keys are passed into the worker. Internet access is available. Container isolation and approval prompts reduce risk; they do not make arbitrary code harmless or impose a network allowlist.

Host metadata in `.agent-state/` records the exact OMP session file for each chat. New and reset sessions are saved before they are reported ready, even before the first message. Worker home and workspace volumes are named `telegram-omp-home-<chat-id>` and `telegram-omp-workspace-<chat-id>`. Keep the metadata and volumes together when backing up or moving the bot. They contain private conversation/workspace data and are not encrypted by this application.

The worker does not inherit this project's or your personal OMP instructions, extensions, skills, or credentials. Its workspace starts separately from the bot repository. Optional external integrations need their own setup inside that environment.

On Ctrl+C or SIGTERM, the bot stops polling, cancels active work, and removes live worker containers. Persistent volumes remain. Updates are acknowledged after admission, so interrupted tasks are not automatically replayed; check the saved state before repeating an operation with side effects.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AI_MODEL` | `gpt-6.1-sol` | Model for new sessions. Bare IDs use the `openai` provider. Resumed sessions retain their selected model. |
| `OMP_BIN` | `omp` on `PATH` | Compiled Linux executable used by `npm run setup-agent`. |
| `OMP_DOCKER_IMAGE` | `telegram-omp-agent:local` | Image built and launched for workers. |
| `OMP_STATE_DIR` | `.agent-state` | Host-side persistent session pointers. |
| `OMP_TASK_TIMEOUT_MS` | `600000` | Per-operation deadline; expiry stops the worker. |
| `OMP_APPROVAL_TIMEOUT_MS` | `120000` | Maximum time to answer an approval/question. |
| `OMP_MAX_COST_USD` | `5` | OMP's cumulative session spending guard. Already-running requests can exceed it. |
| `RATE_LIMIT_PER_CHAT_PER_HOUR` | `20` | Accepted prompts per private chat per UTC hour. |
| `RATE_LIMIT_GLOBAL_PER_DAY` | `200` | Accepted prompts per bot per UTC day. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | unset | Optional persistent rate-limit counters. Without them, counters reset when the bot restarts. |

Optional search keys passed through to OMP: `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, and `FIRECRAWL_API_KEY`. Availability of individual search backends depends on OMP's provider support and credentials.

Prompt limits count requests, not agent steps, tokens, or dollars. Voice is rate-limited before download/transcription. OMP's spending guard does not cover voice transcription or arbitrary separately billed services called by approved tools. Use provider-side spending limits as well.

Restart the bot after changing environment variables. After upgrading the installed OMP binary, rebuild with `npm run setup-agent` and restart. Protect Docker access: controlling the Docker daemon is a host-level privilege, even though individual workers are restricted.

## Migration from the chatbot

- OMP sessions replace the old 30-minute Redis conversation cache and Redis model preferences. Old chat history is not imported; the first OMP run starts a new session.
- Redis is now used only for optional rate limiting.
- `LOGAPIKEY` is no longer used. Private conversations and approval details are not mirrored to a separate logging bot.
- Generated follow-up buttons have been replaced by genuine OMP approval/question controls.
- Vercel deployment scripts, the webhook handler, and the direct OpenAI chat-completion path are removed. Long-running agent work and interactive approvals require the local worker.

## Troubleshooting

- **No response:** use the private chat from the user configured in `ADMINID`. Check that the polling process and Docker are running.
- **Webhook conflict:** run `npm run webhook-info`; its URL must be empty. Stop the old deployment before `npm run delete-webhook`.
- **Missing image:** run `npm run setup-agent`. A package-manager shim is not a compiled OMP executable; point `OMP_BIN` at the actual Linux binary.
- **Model error:** check API credits and access, and choose a model present in `/model`. There is no silent provider fallback.
- **Expired buttons:** repeat the task or wait for the next question; old buttons cannot grant permission.
- **Stuck task:** send `/cancel`. A failed container stop blocks replacement work. If that happens, confirm the named worker has been removed with `docker ps -a`, then restart the bot.
- **Voice failure:** check transcription access and keep audio below 20 MB.

Run the behavioral test suite with `npm test`. Tests use isolated protocol/Telegram doubles; live provider/container checks are separate operational smoke checks.

## License

ISC
