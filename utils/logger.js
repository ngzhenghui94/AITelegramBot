// utils/logger.js
import winston from 'winston';
import path from 'path';

// Define log file paths
const logDirectory = path.resolve('logs');
const errorLog = path.join(logDirectory, 'error.log');
const combinedLog = path.join(logDirectory, 'combined.log');

// Create the logger instance
const logger = winston.createLogger({
  level: 'info', // Minimum level to log
  defaultMeta: { service: 'telegram-bot', environment: process.env.NODE_ENV || 'development' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json() // Log in JSON format
  ),
  transports: [
    // Log errors to error.log
    new winston.transports.File({ filename: errorLog, level: 'error' }),
    // Log all levels to combined.log
    new winston.transports.File({ filename: combinedLog }),
  ],
});

// If not in production, also log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(), // Colorize console output
        winston.format.simple()
      ),
    })
  );
}

export default logger;
