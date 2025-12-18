import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.resolve(__dirname, '..', 'temp');

// Ensure temp directory exists
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

export async function transcribeVoiceMessage(bot, groqClient, fileId, chatId) {
    const tempFilePath = path.join(tempDir, `audio_${chatId}_${Date.now()}.ogg`);

    try {
        // Get the file path from Telegram
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botApiKey}/${file.file_path}`;

        // Download the audio file and save it locally
        const response = await axios.get(fileUrl, {
            responseType: 'stream',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        // Create a write stream to save the file
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        // Wait for the file to finish writing
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Check the file size
        const stats = await fs.promises.stat(tempFilePath);
        if (stats.size > config.limits.maxVoiceFileSize) {
            await fs.promises.unlink(tempFilePath);
            await bot.sendMessage(chatId, 'The voice message is too large. Please send a smaller file.');
            return null;
        }

        // Create a read stream from the saved file
        const audioStream = fs.createReadStream(tempFilePath);

        // Send the audio file to the Groq API for transcription
        const transcriptionResult = await groqClient.audio.transcriptions.create({
            file: audioStream,
            model: config.groq.audioModel,
        });

        // Delete the temp file after transcription
        await fs.promises.unlink(tempFilePath);

        return transcriptionResult.text;
    } catch (error) {
        logger.error('Error transcribing voice message:', error.response?.data || error.message);

        // Clean up temp file if it exists
        try {
            if (fs.existsSync(tempFilePath)) {
                await fs.promises.unlink(tempFilePath);
            }
        } catch (cleanupError) {
            logger.error('Error cleaning up temp file:', cleanupError);
        }

        await bot.sendMessage(chatId, 'Unable to transcribe voice message.');
        return null;
    }
}
