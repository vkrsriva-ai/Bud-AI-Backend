const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { buildResponse } = require('./reconcile');
const { EXTRACTION_PROMPT, correctionPrompt } = require('./prompt');

const app = express();
app.use(express.json({ limit: '25mb' })); // base64 photos and multi-page PDFs are large

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cheap first pass, escalate only on failure. Override via Railway env vars.
const MODEL_FAST = process.env.MODEL_FAST || 'claude-sonnet-4-6';
const MODEL_STRONG = process.env.MODEL_STRONG || 'claude-opus-4-8';
const MAX_ATTEMPTS = 2;

// What we accept, split by how Claude must receive it.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PDF_TYPE = 'application/pdf';

// Map sloppy/missing mediaType to a canonical one using the filename extension.
const EXT_TO_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

function normalizeMediaType(mediaType, filename) {
  if (mediaType && (IMAGE_TYPES.includes(mediaType) || mediaType === PDF_TYPE)) {
    return mediaType;
  }
  if (filename) {
    const ext = String(filename).split('.').pop().toLowerCase();
    if (EXT_TO_TYPE[ext]) return EXT_TO_TYPE[ext];
  }
  return null;
}

// PDFs go in a 'document' block (reads selectable PDF text natively);
// jpg/png/etc go in an 'image' block.
function buildMediaBlock(base64, mediaType) {
  if (mediaType === PDF_TYPE) {
    return { type: 'document', source: { type: 'base64', media_type: PDF_TYPE, data: base64 } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

// Pull the first {...last} block out of a model response, tolerating stray prose or ``` fences.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function textFrom(msg) {
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// Core logic, with an injectable createMessage so the retry loop is testable without the live API.
async function analyzeReceipt(imageBase64, mediaType, deps = {}) {
  const createMessage = deps.createMessage || ((args) => anthropic.messages.create(args));
  const mediaBlock = buildMediaBlock(imageBase64, mediaType);

  const messages = [{ role: 'user', content: [mediaBlock, { type: 'text', text: EXTRACTION_PROMPT }] }];

  let attempts = 0;
  let usedSecondPass = false;
  let result = null;

  while (attempts < MAX_ATTEMPTS) {
    const model = attempts === 0 ? MODEL_FAST : MODEL_STRONG;
    if (attempts > 0) usedSecondPass = true;
    attempts += 1;

    const msg = await createMessage({ model, max_tokens: 4000, messages });
    const raw = textFrom(msg);
    const parsed = extractJson(raw);

    if (!parsed) {
      if (attempts >= MAX_ATTEMPTS) break;
      messages.push({ role: 'assistant', content: raw || '(no content)' });
      messages.push({ role: 'user', content: 'That was not valid JSON. Return ONLY the JSON object, starting with { and ending with }.' });
      continue;
    }

    result = buildResponse(parsed);

    const moneyFail = result.verification.subtotal_matches === false;
    if (!moneyFail || attempts >= MAX_ATTEMPTS) break;

    // Money didn't reconcile -> feed the discrepancy back and let the stronger model re-read.
    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
    messages.push({ role: 'user', content: correctionPrompt(result.verification.difference) });
  }

  if (!result) return { error: 'parse_failed', attempts, used_second_pass: usedSecondPass };

  result.verification.attempts = attempts;
  result.verification.used_second_pass = usedSecondPass;
  return result;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/analyze', async (req, res) => {
  try {
    const { image, mediaType, filename } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        error: 'missing_image',
        message: 'Send { image: <base64>, mediaType: "image/jpeg" | "image/png" | "application/pdf" }',
      });
    }

    const resolvedType = normalizeMediaType(mediaType, filename);
    if (!resolvedType) {
      return res.status(400).json({
        error: 'unsupported_type',
        message: `Unsupported mediaType "${mediaType || '(none)'}". Use one of: ${[...IMAGE_TYPES, PDF_TYPE].join(', ')}.`,
      });
    }

    const result = await analyzeReceipt(image, resolvedType);
    if (result.error) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    console.error('analyze error', err);
    return res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`BuD AI /analyze listening on :${PORT}`));
}

module.exports = { app, analyzeReceipt, extractJson };
