import logger from './logger.js';

const textModel = process.env.AI_MODEL || 'gpt-6.1-sol';
const MAX_FOLLOW_UP_QUESTIONS = 3;
const MAX_FOLLOW_UP_CHARS = 32;
const MAX_FOLLOW_UP_WORDS = 6;
const FOLLOW_UP_PROMPT = [
  'Generate exactly 3 follow-up questions for a chatbot user.',
  'Requirements:',
  '- Questions must be natural, specific, and relevant to the assistant response.',
  '- Keep each question concise: 2-6 words, max 32 characters.',
  '- Do not include numbering, prefixes, or quotation marks.',
  '- Return ONLY valid JSON.',
  '- JSON format: {"questions":["q1?","q2?","q3?"]}.',
  '- No markdown, no explanations, no extra keys.',
].join('\n');

async function requestOpenAI(endpoint, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }

  const multipart = body instanceof FormData;
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(!multipart && { 'Content-Type': 'application/json' }),
    },
    body: multipart ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI ${endpoint} request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function getChatCompletion(conversation) {
  const response = await requestOpenAI('responses', {
    model: textModel,
    input: conversation,
    store: false,
  });
  if (response.status !== 'completed') {
    throw new Error('OpenAI response did not complete');
  }

  const text = (response.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .map((part) => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '')
    .join('');
  if (!text.trim()) {
    throw new Error('OpenAI response contained no text');
  }
  return text;
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
      .map((question) => question.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((question) => Buffer.byteLength(question, 'utf8') <= MAX_FOLLOW_UP_CHARS)
      .filter((question) => {
        const wordCount = question.split(' ').filter(Boolean).length;
        return wordCount >= 2 && wordCount <= MAX_FOLLOW_UP_WORDS;
      })
      .slice(0, MAX_FOLLOW_UP_QUESTIONS);
  } catch (error) {
    logger.warn('Failed to parse follow-up question JSON from OpenAI response.');
    return [];
  }
}

export async function generateFollowUpQuestions(userPrompt, assistantResponse) {
  try {
    const userPromptExcerpt = (userPrompt || '').slice(0, 800);
    const assistantResponseExcerpt = (assistantResponse || '').slice(0, 1200);

    const rawContent = await getChatCompletion([
      { role: 'system', content: FOLLOW_UP_PROMPT },
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
    ]);
    const questions = parseFollowUpQuestions(rawContent);
    if (questions.length === MAX_FOLLOW_UP_QUESTIONS) {
      return questions;
    }

    logger.warn('OpenAI follow-up generation returned fewer than 3 valid questions.');
    return [];
  } catch (error) {
    logger.warn('OpenAI follow-up generation failed:', error.message);
    return [];
  }
}

export async function transcribeAudio(audioBuffer, filename = 'audio.ogg') {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);
  form.append('model', 'gpt-transcribe');
  const transcription = await requestOpenAI('audio/transcriptions', form);
  if (typeof transcription.text !== 'string' || !transcription.text.trim()) {
    throw new Error('OpenAI transcription contained no text');
  }
  return transcription.text;
}

export default {
  getChatCompletion,
  generateFollowUpQuestions,
  transcribeAudio,
};
