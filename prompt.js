const CATEGORIES = [
  'Grocery & Food', 'Personal Care & Beauty', 'Clothing & Apparel',
  'Electronics & Appliances', 'Household Supplies & Cleaning', 'Furniture & Home Decor',
  'Dining & Restaurants', 'Health & Pharmacy', 'Pet', 'Other',
];

const EXTRACTION_PROMPT = `You are a US retail receipt parser for a budgeting app. Read the receipt photo and return structured data.

CATEGORIES — assign each item to exactly one:
${CATEGORIES.map((c) => '- ' + c).join('\n')}

ITEM NAMES — decode merchant abbreviations into a readable net name:
- KS / KIRK = Kirkland Signature; GV = Great Value; MM = Member's Mark; CHBNI = Chobani.
- Strip leading item numbers and trailing codes. Keep names human-readable.

TAX CODES — capture the per-line tax code EXACTLY as printed to the right of the price (a single character). If the line has NO code, use null. Do NOT copy a neighbor's code and do NOT invent one.
The bottom-of-receipt tax-rate breakdown is SEPARATE from the per-line flags, and its letters MAY DIFFER from them — never assume they match. Read each breakdown line into "tax_breakdown" with its letter, rate %, and printed amount exactly as shown.
Merchant hints (record what is printed, even if it differs from these):
- COSTCO bottom breakdown: "E" ~ food/grocery (lower rate), "A" ~ non-food (higher rate).
- WALMART: "F"/"N" ~ food, "H" ~ health/pharmacy; general non-food often has NO code.

PRICES — the net price actually charged per line (after any instant savings shown on that line). Numbers only.

CONFIDENCE — per item, "high" or "low". Use "low" when the name, price, or category is uncertain.

OUTPUT — your entire response must be ONE JSON object and nothing else. No prose, no markdown fences. Start with "{" and end with "}". Use exactly this shape:
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
}`;

function correctionPrompt(diff) {
  return `Your previous extraction does not reconcile: the line items you returned sum to a subtotal that is off by ${diff} versus the printed subtotal on the receipt.
Re-examine the photo carefully. The cause is almost always one of:
- a line item was missed entirely (items spanning two printed lines, or faint/edge lines),
- a price digit was misread (1 vs 7, 3 vs 8, a missing or extra decimal),
- a discount / instant-savings line was not subtracted, or a deposit / bag fee was skipped.
Return the FULL corrected JSON in the exact same shape and with the same tax_code rules (capture as printed, null if none).`;
}

module.exports = { CATEGORIES, EXTRACTION_PROMPT, correctionPrompt };
