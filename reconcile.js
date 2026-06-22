// ---------- helpers ----------
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const normCode = (c) => {
  if (c == null) return null;
  const s = String(c).trim().toUpperCase();
  return s === '' ? null : s;
};
// rate may arrive as 8 (percent) or 0.08 (fraction). Always return a fraction for math.
const asFraction = (rate) => {
  const r = num(rate);
  return r >= 1 ? r / 100 : r;
};

// State-agnostic: the lowest printed tax rate on the receipt is treated as the "food" rate,
// and only true grocery maps to it. Works in any state because rates come from the receipt itself.
const FOOD_CATS = new Set(['Grocery & Food']);

function reconcile(parsed) {
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  // 1) MONEY RECONCILIATION (primary, reliable — this is the real gate)
  const computedSubtotal = round2(items.reduce((s, it) => s + num(it.price), 0));
  const printedSubtotal = parsed.printed_subtotal != null ? round2(parsed.printed_subtotal) : null;
  const subtotalDiff = printedSubtotal != null ? round2(computedSubtotal - printedSubtotal) : null;
  const subtotalMatches = printedSubtotal == null ? null : Math.abs(subtotalDiff) <= 0.01;

  // 2) CATEGORY TOTALS
  const categoryTotals = {};
  for (const it of items) {
    const cat = it.category || 'Other';
    categoryTotals[cat] = round2((categoryTotals[cat] || 0) + num(it.price));
  }

  // 3) TAX CROSS-CHECK (advisory only — per-line codes are unreliable across warehouses)
  const breakdown = Array.isArray(parsed.tax_breakdown) ? parsed.tax_breakdown : [];
  const allRates = breakdown.map((x) => asFraction(x && x.rate)).filter((r) => r > 0);
  const minRate = allRates.length ? Math.min(...allRates) : 0;

  const taxChecks = [];
  let codesMatchedSomething = false;

  for (const t of breakdown) {
    const code = normCode(t && t.code);
    if (code == null || t.rate == null) continue;
    const rateFrac = asFraction(t.rate);
    const printedAmt = round2(num(t.amount));

    // (a) try matching by the literal per-line code
    const byCode = items.filter((it) => normCode(it.tax_code) === code);
    // (b) fallback when literal codes don't line up: lowest printed rate -> food cats, higher -> the rest
    const isLowRate = rateFrac <= minRate;
    const byCategory = items.filter((it) =>
      isLowRate ? FOOD_CATS.has(it.category) : !FOOD_CATS.has(it.category)
    );

    const usedFallback = byCode.length === 0;
    if (!usedFallback) codesMatchedSomething = true;
    const matched = usedFallback ? byCategory : byCode;

    const base = round2(matched.reduce((s, it) => s + num(it.price), 0));
    const expectedTax = round2(base * rateFrac);
    const taxMatches = Math.abs(expectedTax - printedAmt) <= 0.02; // 2c tolerance for rounding

    taxChecks.push({
      code, rate_pct: round2(rateFrac * 100), base,
      expected_tax: expectedTax, printed_tax: printedAmt,
      matches: taxMatches, matched_by: usedFallback ? 'category' : 'tax_code',
    });
  }
  const allTaxMatch = taxChecks.length > 0 && taxChecks.every((c) => c.matches);

  // 4) LOW CONFIDENCE -> 1-tap correction queue
  const lowConfidenceItems = items
    .map((it, i) => ({ i, it }))
    .filter(({ it }) => String(it.confidence || '').toLowerCase() === 'low')
    .map(({ i, it }) => ({ index: i, name: it.name, price: num(it.price) }));

  return { items, categoryTotals, computedSubtotal, printedSubtotal, subtotalDiff,
           subtotalMatches, taxChecks, codesMatchedSomething, allTaxMatch, lowConfidenceItems };
}

function buildResponse(parsed) {
  const v = reconcile(parsed);
  const moneyOk = v.subtotalMatches !== false; // null (no printed subtotal) does NOT block
  const needsReview = !moneyOk || v.lowConfidenceItems.length > 0;

  return {
    merchant: parsed.merchant || 'Unknown',
    items: v.items,
    category_totals: v.categoryTotals,
    computed_subtotal: v.computedSubtotal,
    printed_subtotal: v.printedSubtotal,
    printed_tax: parsed.printed_tax != null ? round2(parsed.printed_tax) : null,
    printed_total: parsed.printed_total != null ? round2(parsed.printed_total) : null,
    tax_breakdown: Array.isArray(parsed.tax_breakdown) ? parsed.tax_breakdown : [],
    verification: {
      subtotal_matches: v.subtotalMatches,
      difference: v.subtotalDiff,
      tax_code_checks: v.taxChecks,
      tax_codes_reconcile: v.allTaxMatch,        // advisory, never blocks
      tax_codes_present: v.codesMatchedSomething,
      low_confidence_items: v.lowConfidenceItems,
      needs_review: needsReview,
      review_message: !moneyOk
        ? `Receipt doesn't add up (off by ${v.subtotalDiff}). Check the flagged line prices.`
        : (v.lowConfidenceItems.length > 0
            ? `${v.lowConfidenceItems.length} item(s) need a quick confirm.`
            : null),
    },
  };
}

module.exports = { reconcile, buildResponse, round2, normCode, asFraction };
