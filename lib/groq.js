import Groq from 'groq-sdk';
import logger from './logger.js';

const textModel = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

let groqClient = null;

function getGroqClient() {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('Missing GROQ_API_KEY environment variable');
    }
    groqClient = new Groq({ apiKey });
  }
  return groqClient;
}

export async function getChatCompletion(conversation) {
  try {
    const client = getGroqClient();
    const chatCompletion = await client.chat.completions.create({
      messages: conversation,
      model: textModel,
    });
    logger.info('Received chat completion from Groq API.');
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    logger.error('Unable to get chat completion from Groq API:', error);
    throw new Error(`Unable to get chat completion from Groq API: ${error.message}`);
  }
}

export async function transcribeAudio(audioBuffer, filename = 'audio.ogg') {
  try {
    const client = getGroqClient();
    
    // Create a File object from the buffer for the Groq API
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });
    
    const transcriptionResult = await client.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
    });

    logger.info('Received transcription from Groq API.');
    return transcriptionResult.text;
  } catch (error) {
    logger.error('Error transcribing audio:', error);
    throw error;
  }
}

export default {
  getChatCompletion,
  transcribeAudio,
};

