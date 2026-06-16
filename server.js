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

// Accept one file (image or PDF) in memory, max 20MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
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

// The categorization prompt. This is the product IP.
const PROMPT = `You are BuD AI, a receipt-parsing engine. Read the receipt image and return categorized spending.

CATEGORIES — assign each item exactly one:
${CATEGORIES.map((c) => `- ${c}`).join('\n')}

=== COLUMN ALIGNMENT (read carefully) ===
On some receipts (notably Costco) the price column is visually offset and a price may sit on a slightly different baseline than its item name. Align each item NAME with ITS OWN price by following the receipt's logic, not just horizontal position. The reliable cross-check is the math: the item prices (after discounts) must sum to the printed subtotal. If your first reading does not sum to the subtotal, re-read the alignment — a systematic off-by-one between names and prices is the most common cause.

=== DISCOUNTS AND COUPONS (critical) ===
A discount is a line with a NEGATIVE price — the minus sign comes AFTER the number, e.g. "10.00-". It is NOT a product and must not be emitted as an item.
- Directly associated with the discount is a reference like "/1959104" — the number after the slash is the ITEM CODE of the product the discount applies to.
- Find the product line whose item code matches (e.g. "1959104 HOTO SCRUB 49.99") and SUBTRACT the discount from that product, emitting ONE net line (Hoto Scrub at 39.99).
- IMPORTANT: a normal product that merely sits next to a discount line is still its own item. For example "WEEDCLEAR 24.99" is a real product and must be emitted normally; only the line with the negative price is the discount. Do not confuse an adjacent product with the coupon.
- If a discount's reference item code cannot be matched, emit it as a negative line item named "Discount" so totals still reconcile.

=== TAX CODES (merchant-aware) ===
Each item line usually carries a single-letter tax code; capture it as "tax_code" (null if none). Meaning varies by merchant — record the letter as printed:
- COSTCO: "E" = food/grocery (lower rate), "A" = non-food (higher rate). These reconcile: sum of E-coded prices × E rate = the printed "E ...% TAX" amount, same for A.
- WALMART: "F" (sometimes "N") = food; "H" = health/pharmacy; general non-food often has NO code.
- Read the bottom tax-rate breakdown (e.g. "A 8.00% TAX 6.88", "E 4.00% TAX 6.22") into "tax_breakdown" with code, rate, amount.
Capture codes even when unsure of meaning; they validate categories downstream.

=== NAME DECODING ===
Decode abbreviations using context, especially the price and tax code:
- KS / KIRKLAND = Kirkland Signature, GV = Great Value, CHBNI = Chobani.
- Beware false friends: "LE TOP" on an apparel-priced, non-food-taxed line means a Ladies' Top (clothing), NOT a laptop. A real laptop would never cost ~$13. Let price and tax code sanity-check your guess. When unsure, prefer the literal reading and set a low confidence flag rather than inventing an unrelated product.
- If genuinely ambiguous, categorize as "Other" and flag low confidence.

=== CONFIDENCE ===
For each item add "confidence": "high" or "low". Use "low" when the name was hard to read or the category is a guess — these become 1-tap user corrections later.

=== OUTPUT ===
Your entire response must be ONE JSON object and nothing else. Do not write any sentence before or after it. Do not use markdown code fences. Start your response with the character "{" and end it with "}". Use exactly this shape:
{
  "merchant": "store name",
  "items": [
    { "name": "decoded net item name", "price": 0.00, "category": "one category", "tax_code": "E", "confidence": "high" }
  ],
  "tax_breakdown": [
    { "code": "A", "rate": 8.0, "amount": 0.00 }
  ],
  "printed_subtotal": 0.00,
  "printed_tax": 0.00,
  "printed_total": 0.00
}

RULES:
- "items" must already have discounts netted in. The sum of all item prices should equal printed_subtotal.
- Report the printed_subtotal / printed_tax / printed_total exactly as shown on the receipt (for cross-checking). Do not invent them.
- All money values are numbers, rounded to 2 decimals.
- If you cannot read the receipt at all, return {"error": "unreadable"}.`;

// ---- Helpers ----
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Call the model with the file and a given instruction, return parsed JSON (or throws).
async function callModel(fileBlock, instructionText) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      { role: 'user', content: [fileBlock, { type: 'text', text: instructionText }] },
    ],
  });

  let raw = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  const jsonText =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? raw.slice(firstBrace, lastBrace + 1)
      : raw;

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    const err = new Error('Model did not return valid JSON');
    err.raw = raw;
    err.parseError = e.message;
    throw err;
  }
}

// Take parsed model output and compute totals, category breakdown, and verification.
function verify(parsed) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const computedSubtotal = round(items.reduce((s, it) => s + (Number(it.price) || 0), 0));

  const categoryTotals = {};
  for (const it of items) {
    const cat = it.category || 'Other';
    categoryTotals[cat] = round((categoryTotals[cat] || 0) + (Number(it.price) || 0));
  }

  const printedSubtotal = parsed.printed_subtotal != null ? round(parsed.printed_subtotal) : null;
  const subtotalMatches =
    printedSubtotal != null && Math.abs(computedSubtotal - printedSubtotal) < 0.01;

  const taxChecks = [];
  for (const t of parsed.tax_breakdown || []) {
    if (t == null || t.code == null || t.rate == null) continue;
    const base = round(
      items
        .filter((it) => (it.tax_code || '').toUpperCase() === String(t.code).toUpperCase())
        .reduce((s, it) => s + (Number(it.price) || 0), 0)
    );
    const expected = round(base * (Number(t.rate) / 100));
    const printedAmt = t.amount != null ? round(t.amount) : null;
    taxChecks.push({
      code: t.code,
      rate: t.rate,
      coded_item_base: base,
      expected_tax: expected,
      printed_tax: printedAmt,
      matches: printedAmt != null && Math.abs(expected - printedAmt) < 0.02,
    });
  }
  const allTaxMatch = taxChecks.length > 0 && taxChecks.every((c) => c.matches);
  const lowConfidenceItems = items.filter((it) => it.confidence === 'low').map((it) => it.name);

  return {
    items,
    categoryTotals,
    computedSubtotal,
    printedSubtotal,
    subtotalMatches,
    taxChecks,
    allTaxMatch,
    lowConfidenceItems,
  };
}

// Build the constraint-aware retry instruction: hand the model the hard targets it must hit.
function buildRetryPrompt(parsed, v) {
  const taxTargets = (parsed.tax_breakdown || [])
    .filter((t) => t && t.code != null && t.rate != null)
    .map((t) => {
      const targetBase = t.amount != null ? round((Number(t.amount) / Number(t.rate)) * 100) : null;
      return `  - Items coded "${t.code}" must sum to about ${targetBase} (because ${t.code} is taxed at ${t.rate}% and the printed ${t.code} tax is ${t.amount}).`;
    })
    .join('\n');

  return `${PROMPT}

=== SECOND-PASS RECONCILIATION (important) ===
A first reading of this receipt did NOT reconcile. Your previous item prices summed to ${v.computedSubtotal}, but the printed subtotal is ${v.printedSubtotal}. You misread one or more LINE PRICES — most likely in a cramped or crossed-out section. Re-read the price column very carefully, digit by digit.

You MUST satisfy these hard constraints from the receipt's own printed totals:
  - All item prices (after discounts) must sum to exactly ${v.printedSubtotal}.
${taxTargets ? taxTargets + '\n' : ''}Use these targets to find your misread: if a tax-code group is off, the wrong price is in that group. Adjust ONLY the price(s) you misread until both the subtotal and every tax-code group reconcile. Do not invent items or change correct prices. Return the same JSON shape as before.`;
}

app.get('/', (req, res) => {
  res.json({ status: 'BuD AI backend is running' });
});

app.post('/analyze', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Send form-data with key "receipt" (image or PDF).' });
    }

    const base64Data = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    const isPdf = mediaType === 'application/pdf' || (req.file.originalname || '').toLowerCase().endsWith('.pdf');
    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };

    // ---- First pass ----
    let parsed;
    try {
      parsed = await callModel(fileBlock, PROMPT);
    } catch (e) {
      console.error('First-pass parse failed:\n', e.raw || e.message);
      return res.status(502).json({ error: e.message, parse_error: e.parseError, raw: e.raw });
    }
    if (parsed.error) return res.json(parsed); // e.g. unreadable

    let v = verify(parsed);
    let attempts = 1;
    let usedSecondPass = false;

    // ---- Second pass: only if the first didn't reconcile and we have a subtotal to target ----
    if (!v.subtotalMatches && v.printedSubtotal != null) {
      usedSecondPass = true;
      attempts = 2;
      try {
        const retryPrompt = buildRetryPrompt(parsed, v);
        const parsed2 = await callModel(fileBlock, retryPrompt);
        if (!parsed2.error) {
          const v2 = verify(parsed2);
          // Keep the second pass only if it's actually better (closer to the printed subtotal).
          const firstDiff = Math.abs(v.computedSubtotal - v.printedSubtotal);
          const secondDiff =
            v2.printedSubtotal != null ? Math.abs(v2.computedSubtotal - v2.printedSubtotal) : Infinity;
          if (secondDiff <= firstDiff) {
            parsed = parsed2;
            v = v2;
          }
        }
      } catch (e) {
        console.error('Second-pass failed, keeping first result:\n', e.raw || e.message);
        // Fall through with the first-pass result.
      }
    }

    const response = {
      merchant: parsed.merchant || 'Unknown',
      items: v.items,
      category_totals: v.categoryTotals,
      computed_subtotal: v.computedSubtotal,
      printed_subtotal: v.printedSubtotal,
      printed_tax: parsed.printed_tax != null ? round(parsed.printed_tax) : null,
      printed_total: parsed.printed_total != null ? round(parsed.printed_total) : null,
      tax_breakdown: parsed.tax_breakdown || [],
      verification: {
        subtotal_matches: v.subtotalMatches,
        difference: v.printedSubtotal != null ? round(v.computedSubtotal - v.printedSubtotal) : null,
        tax_code_checks: v.taxChecks,
        tax_codes_reconcile: v.allTaxMatch,
        low_confidence_items: v.lowConfidenceItems,
        attempts,
        used_second_pass: usedSecondPass,
        needs_review: !v.subtotalMatches || v.lowConfidenceItems.length > 0,
        review_message: !v.subtotalMatches
          ? `This receipt still doesn't add up (off by ${round(v.computedSubtotal - v.printedSubtotal)}). Please review the flagged line prices.`
          : null,
      },
    };

    return res.json(response);
  } catch (err) {
    console.error('Analyze error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to analyze receipt', detail: err?.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BuD AI backend listening on ${PORT}`));
