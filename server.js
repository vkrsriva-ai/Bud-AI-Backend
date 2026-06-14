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
Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
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

    // Build the right content block: PDFs go as a "document", images as an "image".
    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content: [
            fileBlock,
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

    if (parsed.error) {
      return res.json(parsed); // e.g. {"error":"unreadable"}
    }

    // === VERIFICATION LAYER ===
    // We don't trust the model's arithmetic. We compute everything from the items
    // ourselves, build category_totals, and flag any mismatch against the printed numbers.
    const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    // Sum the line items (discounts are already netted into prices by the prompt).
    const computedSubtotal = round(items.reduce((sum, it) => sum + (Number(it.price) || 0), 0));

    // Build category_totals from the items, not from the model.
    const categoryTotals = {};
    for (const it of items) {
      const cat = it.category || 'Other';
      categoryTotals[cat] = round((categoryTotals[cat] || 0) + (Number(it.price) || 0));
    }

    // Compare our computed subtotal to what the receipt printed.
    const printedSubtotal = parsed.printed_subtotal != null ? round(parsed.printed_subtotal) : null;
    const subtotalMatches =
      printedSubtotal != null && Math.abs(computedSubtotal - printedSubtotal) < 0.01;

    // Tax-code cross-check: for each printed tax line (e.g. A 8% = 6.88), sum the
    // item prices carrying that code and verify base * rate ≈ printed amount.
    // This independently confirms items were read and coded correctly.
    const taxChecks = [];
    for (const t of parsed.tax_breakdown || []) {
      if (t == null || t.code == null || t.rate == null) continue;
      const base = round(
        items
          .filter((it) => (it.tax_code || '').toUpperCase() === String(t.code).toUpperCase())
          .reduce((sum, it) => sum + (Number(it.price) || 0), 0)
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

    // Collect anything the user might want to review.
    const lowConfidenceItems = items
      .filter((it) => it.confidence === 'low')
      .map((it) => it.name);

    const response = {
      merchant: parsed.merchant || 'Unknown',
      items,
      category_totals: categoryTotals,
      computed_subtotal: computedSubtotal,
      printed_subtotal: printedSubtotal,
      printed_tax: parsed.printed_tax != null ? round(parsed.printed_tax) : null,
      printed_total: parsed.printed_total != null ? round(parsed.printed_total) : null,
      tax_breakdown: parsed.tax_breakdown || [],
      verification: {
        subtotal_matches: subtotalMatches,
        difference: printedSubtotal != null ? round(computedSubtotal - printedSubtotal) : null,
        tax_code_checks: taxChecks,
        tax_codes_reconcile: allTaxMatch,
        low_confidence_items: lowConfidenceItems,
        needs_review: !subtotalMatches || lowConfidenceItems.length > 0,
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
