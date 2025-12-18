import config from './config.js';
import * as taskManager from './taskManager.js';
import { MessageHandler } from './handlers/messageHandler.js';
import { formatMessage } from './utils/formatter.js';

console.log('--- Verification Start ---');

// Check Config
console.log('Config loaded:', !!config);
if (!config.telegram.botApiKey) {
    console.warn('Warning: TELEGRAM_BOT_API_KEY is missing (expected in this env?)');
}

// Check Formatter
const formatted = formatMessage('**Hello**');
console.log('Formatter check:', formatted === '<b>Hello</b>' ? 'PASS' : 'FAIL');

// Check Task Manager (Mock Redis would be needed for real test, but we check import)
console.log('TaskManager loaded:', !!taskManager.addTask);

// Check MessageHandler
console.log('MessageHandler loaded:', !!MessageHandler);

console.log('--- Verification End ---');
