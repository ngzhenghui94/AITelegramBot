import Groq from 'groq-sdk';
import logger from './logger.js';

const textModel = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const MAX_FOLLOW_UP_QUESTIONS = 3;
const FOLLOW_UP_SYSTEM_PROMPT = [
  'Generate exactly 3 follow-up questions for a chatbot user.',
  'Requirements:',
  '- Questions must be natural, specific, and relevant to the assistant response.',
  '- Keep each question concise (max 55 characters).',
  '- Return ONLY valid JSON.',
  '- JSON format: {"questions":["q1?","q2?","q3?"]}.',
  '- No markdown, no explanations, no extra keys.',
].join('\n');

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
    console.log('Calling Groq API for chat completion...');
    const client = getGroqClient();
    const chatCompletion = await client.chat.completions.create({
      messages: conversation,
      model: textModel,
    });
    console.log('Groq API chat completion received');
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Groq API error:', error.message);
    throw new Error(`Unable to get chat completion from Groq API: ${error.message}`);
  }
}

function parseFollowUpQuestions(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return [];
  }

  try {
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    if (!Array.isArray(parsed.questions)) {
      return [];
    }

    return parsed.questions
      .filter((item) => typeof item === 'string')
      .map((question) => question.trim())
      .filter(Boolean)
      .slice(0, MAX_FOLLOW_UP_QUESTIONS);
  } catch (error) {
    logger.warn('Failed to parse follow-up question JSON from Groq response.');
    return [];
  }
}

export async function generateFollowUpQuestions(userPrompt, assistantResponse) {
  try {
    const client = getGroqClient();
    const userPromptExcerpt = (userPrompt || '').slice(0, 800);
    const assistantResponseExcerpt = (assistantResponse || '').slice(0, 1200);

    const completion = await client.chat.completions.create({
      model: textModel,
      temperature: 0.7,
      messages: [
        { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `User message: ${userPromptExcerpt}`,
            '',
            `Assistant response: ${assistantResponseExcerpt}`,
            '',
            'Produce the JSON now.',
          ].join('\n'),
        },
      ],
    });

    const rawContent = completion.choices[0]?.message?.content || '';
    const questions = parseFollowUpQuestions(rawContent);
    if (questions.length === MAX_FOLLOW_UP_QUESTIONS) {
      return questions;
    }

    logger.warn('Groq follow-up generation returned fewer than 3 valid questions.');
    return [];
  } catch (error) {
    logger.warn('Groq follow-up generation failed:', error.message);
    return [];
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
  generateFollowUpQuestions,
  transcribeAudio,
};
