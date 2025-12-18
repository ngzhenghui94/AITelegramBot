import redisClient from './redisClient.js';
import logger from './utils/logger.js';

const KEY_PREFIX = 'tasks';

/**
 * Adds a task for a specific chat ID.
 * @param {string} chatId - The chat ID.
 * @param {string} description - The task description.
 * @param {string} time - The time for the task.
 */
export async function addTask(chatId, description, time) {
    try {
        const key = `${KEY_PREFIX}:${chatId}`;
        const task = { description, time, createdAt: new Date().toISOString() };
        await redisClient.rpush(key, JSON.stringify(task));
        logger.info(`Task added for chat ID ${chatId}: ${description} at ${time}`);
    } catch (error) {
        logger.error(`Error adding task for chat ID ${chatId}:`, error);
        throw error;
    }
}

/**
 * Retrieves tasks for a specific chat ID.
 * @param {string} chatId - The chat ID.
 * @returns {Promise<Array>} - List of tasks.
 */
export async function getTasks(chatId) {
    try {
        const key = `${KEY_PREFIX}:${chatId}`;
        const tasks = await redisClient.lrange(key, 0, -1);
        return tasks.map(t => JSON.parse(t));
    } catch (error) {
        logger.error(`Error getting tasks for chat ID ${chatId}:`, error);
        return [];
    }
}

/**
 * Retrieves "Orbit" tasks (alias for getAllTasks for now, can be specialized).
 * @param {string} chatId - The chat ID.
 * @returns {Promise<Array>} - List of tasks.
 */
export async function getOrbit(chatId) {
    // Assuming Orbit means the daily schedule/tasks
    return await getTasks(chatId);
}

/**
 * Clears all tasks for a specific chat ID.
 * @param {string} chatId - The chat ID.
 */
export async function clearTasks(chatId) {
    try {
        const key = `${KEY_PREFIX}:${chatId}`;
        await redisClient.del(key);
        logger.info(`Tasks cleared for chat ID ${chatId}`);
    } catch (error) {
        logger.error(`Error clearing tasks for chat ID ${chatId}:`, error);
        throw error;
    }
}
