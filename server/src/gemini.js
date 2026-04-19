const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const MAX_HISTORY_TURNS = 8;

function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured on the server');
    error.statusCode = 500;
    throw error;
  }

  return { apiKey, model };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({
      role: item.role,
      content: typeof item.content === 'string' ? item.content.trim() : '',
    }))
    .filter((item) => item.content)
    .slice(-MAX_HISTORY_TURNS);
}

function buildTranscriptText(transcript) {
  const fullText = transcript?.fullText?.trim();
  if (fullText) {
    return fullText;
  }

  return (transcript?.segments || [])
    .filter((segment) => segment?.text)
    .map((segment) => {
      if (segment.startOffset == null) {
        return segment.text;
      }

      const totalSeconds = Math.max(0, Math.floor(Number(segment.startOffset) || 0));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = String(totalSeconds % 60).padStart(2, '0');
      return `[${minutes}:${seconds}] ${segment.text}`;
    })
    .join('\n')
    .trim();
}

function buildContents({ transcriptText, history, message }) {
  const contents = [];

  contents.push({
    role: 'user',
    parts: [
      {
        text:
          'You are a meeting assistant. Answer only using the provided meeting transcript. ' +
          'If the answer is not supported by the transcript, say that the transcript does not contain that information.\n\n' +
          `Meeting transcript:\n${transcriptText}`,
      },
    ],
  });

  for (const item of history) {
    contents.push({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: item.content }],
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: message }],
  });

  return contents;
}

function extractGeminiText(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return '';
  }

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

async function askGeminiAboutTranscript({ transcript, message, history }) {
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (!trimmedMessage) {
    const error = new Error('Message is required');
    error.statusCode = 400;
    throw error;
  }

  const transcriptText = buildTranscriptText(transcript);
  if (!transcriptText) {
    const error = new Error('Transcript does not contain any text to analyze');
    error.statusCode = 400;
    throw error;
  }

  const safeHistory = sanitizeHistory(history);
  const { apiKey, model } = getGeminiConfig();
  const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: buildContents({
        transcriptText,
        history: safeHistory,
        message: trimmedMessage,
      }),
      generationConfig: {
        temperature: 0.3,
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      'Gemini request failed';
    const error = new Error(message);
    error.statusCode = response.status || 502;
    throw error;
  }

  const answer = extractGeminiText(data);
  if (!answer) {
    const error = new Error('Gemini returned an empty response');
    error.statusCode = 502;
    throw error;
  }

  return {
    answer,
    model,
  };
}

module.exports = {
  askGeminiAboutTranscript,
};
