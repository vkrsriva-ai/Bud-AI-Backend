// BuD AI — backend
// One job: receive a receipt photo, send it to Claude Vision, return categorized JSON.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

// Anthropic client — reads ANTHROPIC_API_KEY from environment, never hardcoded.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Accept one image file in memory, max 10MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const CATEGORIES = [
  'Grocery & Food',
  'Personal Care & Beauty',
  'Clothing & Apparel',
  'Electronics & Appliances',
  'Household Supplies & Cleaning',
  'Furniture & Home Decor',
  'Dining & Restaurants',
  'Health & Pharmacy',
  'Pet',
  'Other',
];

// The lean categorization prompt. This is the product IP.
const PROMPT = `You are BuD AI, a receipt-parsing engine.

Read EVERY line item on this receipt image. For each item, assign exactly one category from this list:
${CATEGORIES.map((c) => `- ${c}`).join('\n')}

Decode common merchant abbreviations when you can (e.g. KS = Kirkland Signature, GV = Great Value, CHBNI = Chobani). Use your best judgment; if an item is genuinely ambiguous, use "Other".

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{
  "merchant": "store name",
  "subtotal": 0.00,
  "tax": 0.00,
  "total": 0.00,
  "items": [
    { "name": "decoded item name", "price": 0.00, "category": "one of the categories" }
  ],
  "category_totals": {
    "Grocery & Food": 0.00
  }
}

Rules:
- "category_totals" must only include categories that actually appear, and must sum to the subtotal.
- All money values are numbers, not strings, rounded to 2 decimals.
- If you cannot read the receipt at all, return {"error": "unreadable"}.`;

// TEMPORARY diagnostic — tells us if the key is reaching the code. Remove later.
app.get('/keycheck', (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY;
  res.json({
    keyPresent: !!k,
    length: k ? k.length : 0,
    startsWith: k ? k.slice(0, 7) : null,
    hasWhitespace: k ? /\s/.test(k) : false,
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'BuD AI backend is running' });
});

app.post('/analyze', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded. Send form-data with key "receipt".' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Image },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    // Pull the text out and parse it. Strip code fences just in case.
    const raw = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(502).json({ error: 'Model did not return valid JSON', raw });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to analyze receipt', detail: err?.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BuD AI backend listening on ${PORT}`));
