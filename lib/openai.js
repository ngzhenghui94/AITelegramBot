import logger from './logger.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const TRANSCRIPTION_TIMEOUT_MS = 90_000;

async function requestTranscription(form, signal) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  const abortRequest = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortRequest, { once: true });
  }

  let response;
  try {
    response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('OpenAI transcription request failed');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok === false || (response.status && response.status >= 400)) {
    throw new Error(`OpenAI transcription request failed (HTTP ${response.status})`);
  }
  return body;
}

export async function transcribeAudio(audioBuffer, filename = 'audio.ogg', { signal } = {}) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);
  form.append('model', 'gpt-transcribe');

  const transcription = await requestTranscription(form, signal);
  if (typeof transcription?.text !== 'string' || !transcription.text.trim()) {
    logger.warn('OpenAI transcription returned no user-visible text.');
    throw new Error('OpenAI transcription contained no text');
  }
  return transcription.text;
}

export default { transcribeAudio };
