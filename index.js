import http from 'http';
import config from './config.js';
import logger from './utils/logger.js';
import { createBot } from './botSetup.js';

// Initialize Bot with Polling (for local development/Heroku)
const { bot } = createBot({ polling: true });

// Health check server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(config.server.port, () => {
  logger.info(`Health check server running on port ${config.server.port}`);
});

logger.info('Bot started successfully.');