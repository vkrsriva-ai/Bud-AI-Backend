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

// ===== T1.4 (support): which categories are "food-rate" categories =====
// Rule A from the validation run: food tax rate applies to Grocery, BUT pet food maps to Pet
// and prepared/restaurant food maps to Dining. For the cross-check, a line is "food-rate-expected"
// if it is Grocery, Pet, or Dining. Anything else expects the non-food (higher) rate.
// NOTE (6/26): taxonomy is now 13 categories. Alcohol, Tools/Hardware, and Gas & Transport are all
// NON-food-rate, so they are intentionally absent here. Gas is often 0%-rated or separately taxed;
// the layered-tax handling below keeps that from creating false review flags.
const FOOD_RATE_CATS = new Set(['Grocery & Food', 'Pet', 'Dining & Restaurants']);
// ===== end T1.4 (support) =====

// ===== T1.1 (pairing half): attach each discount to its parent product by item_number =====
// A discount line is a negative-price line. If it shares an item_number with a positive-price
// "parent" line, it inherits the parent's category and is marked as a discount (not a product).
// Discounts with no matching parent stay as-is (the prompt already routes orphan discounts to "Other").
// DISPLAY = netted (handled downstream): we DO NOT merge the line away — the negative line is kept
// in storage so a future "you saved $X" tally can sum it. We only fix its CATEGORY here.
//
// RETURNS (6/26): on a refund receipt the sign convention is MIRRORED. Returned items are NEGATIVE
// (money back) and clawed-back discounts are POSITIVE (they reduce the refund). So when
// isReturn is true, the "parent" line is the negative one and the "discount" line is the positive one.
// We flip the sign test accordingly; everything else (inherit category, mark is_discount) is identical.
function applyDiscountInheritance(rawItems, isReturn = false) {
  const items = rawItems.map((it) => ({ ...it })); // shallow copy so we never mutate caller's objects

  // On a purchase, parents have price > 0 and discounts < 0. On a return, that flips.
  const isParentPrice = (p) => (isReturn ? num(p) < 0 : num(p) > 0);
  const isDiscountPrice = (p) => (isReturn ? num(p) > 0 : num(p) < 0);

  // Index the most recent parent line per item_number.
  const parentByNumber = new Map();
  for (const it of items) {
    const n = it.item_number == null ? null : String(it.item_number).trim();
    if (n && isParentPrice(it.price)) parentByNumber.set(n, it);
  }

  for (const it of items) {
    const n = it.item_number == null ? null : String(it.item_number).trim();
    const isDiscount = isDiscountPrice(it.price);
    if (isDiscount && n && parentByNumber.has(n)) {
      const parent = parentByNumber.get(n);
      it.category = parent.category;      // inherit parent's category
      it.is_discount = true;             // mark as a discount line (for counting + future display netting)
      it.parent_item_number = n;
    } else if (isDiscount) {
      it.is_discount = true;             // orphan discount: still a discount, category left as extracted (usually "Other")
    }
  }
  return items;
}
// ===== end T1.1 (pairing half) =====

function reconcile(parsed) {
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];

  // ===== Return detection (6/26): a refund receipt mirrors every sign. =====
  // Trust the prompt's transaction_type first; fall back to a negative printed total as a safety net.
  const transactionType =
    String(parsed.transaction_type || '').toLowerCase() === 'return'
      ? 'return'
      : (num(parsed.printed_total) < 0 ? 'return' : 'purchase');
  const isReturn = transactionType === 'return';
  // ===== end return detection =====

  // ===== T1.1 (pairing half): run discount inheritance before any totals =====
  const items = applyDiscountInheritance(rawItems, isReturn);
  // Product count excludes discount lines (a discount is not a purchased product).
  const productCount = items.filter((it) => !it.is_discount).length;
  // ===== end T1.1 =====

  // 1) MONEY RECONCILIATION (primary, reliable — this is the real gate)
  const computedSubtotal = round2(items.reduce((s, it) => s + num(it.price), 0));
  const printedSubtotal = parsed.printed_subtotal != null ? round2(parsed.printed_subtotal) : null;
  const subtotalDiff = printedSubtotal != null ? round2(computedSubtotal - printedSubtotal) : null;
  const subtotalMatches = printedSubtotal == null ? null : Math.abs(subtotalDiff) <= 0.01;

  // 2) CATEGORY TOTALS (discounts now sit in their parent's category, so totals net correctly)
  const categoryTotals = {};
  for (const it of items) {
    const cat = it.category || 'Other';
    categoryTotals[cat] = round2((categoryTotals[cat] || 0) + num(it.price));
  }

  // 3) TAX CROSS-CHECK (advisory only — per-line codes are unreliable across warehouses)
  const breakdown = Array.isArray(parsed.tax_breakdown) ? parsed.tax_breakdown : [];
  // Keep ALL printed rates including a legitimate 0% (e.g. VT food). Only drop missing/non-numeric.
  const allRates = breakdown
    .map((x) => (x && x.rate != null ? asFraction(x.rate) : null))
    .filter((r) => r != null && r >= 0);
  const minRate = allRates.length ? Math.min(...allRates) : 0;
  // Distinct rate VALUES (so 0% food + 7% non-food counts as two rates for the cross-check).
  const distinctRates = new Set(allRates.map((r) => round2(r)));

  // ===== T1.3 (support): map per-line tax_code letter -> printed rate, via the breakdown =====
  // Build a lookup from code-letter to its printed rate so we can reason about a line's rate
  // even when the literal letters differ between per-line flags and the bottom breakdown.
  const rateByCode = new Map();
  for (const t of breakdown) {
    const code = normCode(t && t.code);
    if (code != null && t.rate != null) rateByCode.set(code, asFraction(t.rate));
  }
  // ===== end T1.3 (support) =====

  const taxChecks = [];
  let codesMatchedSomething = false;

  for (const t of breakdown) {
    const code = normCode(t && t.code);
    // ===== T1.3: match a breakdown line by its printed RATE, not by a known code letter =====
    // Old behavior keyed off the code letter and silently produced base=0 when the letter
    // wasn't a known one (e.g. "GA TAX", Vermont labels). We now accept ANY label string and
    // drive the match off the rate. A breakdown line with no usable rate is skipped.
    if (t.rate == null) continue;
    const rateFrac = asFraction(t.rate);
    const printedAmt = round2(num(t.amount));

    // (a) try matching items by the literal per-line code (when the letters DO line up)
    const byCode = code == null ? [] : items.filter((it) => normCode(it.tax_code) === code);
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
    // ===== end T1.3 =====
  }
  const allTaxMatch = taxChecks.length > 0 && taxChecks.every((c) => c.matches);
  // A meaningful tax check only exists if we had breakdown rates to test against.
  const taxCheckRan = taxChecks.length > 0;
  const taxMismatch = taxCheckRan && !allTaxMatch;

  // ===== T1.4: food-code / category cross-check (advisory, option (a) = silent when unsure) =====
  // For each NON-discount line: if we can confidently tie the line to a rate, check whether the
  // line's category agrees with that rate. Food-rate categories (Grocery/Pet/Dining) should sit on
  // the lowest printed rate; everything else on a higher rate. A clear contradiction -> flag for review.
  // Option (a): if we CANNOT confidently determine the line's rate, we stay SILENT (no flag).
  const crossCheckFlags = [];
  const haveTwoRates = distinctRates.size >= 2; // need a low AND a high DISTINCT rate to tell them apart
  if (haveTwoRates) {
    items.forEach((it, i) => {
      if (it.is_discount) return;                       // discounts inherit; don't cross-check them
      const lineCode = normCode(it.tax_code);
      if (lineCode == null) return;                     // no code on line -> can't tie to a rate -> silent
      if (!rateByCode.has(lineCode)) return;            // line code not in breakdown -> can't tie -> silent
      const lineRate = rateByCode.get(lineCode);
      const lineIsFoodRate = lineRate <= minRate;       // is this line on the lowest (food) rate?
      const catIsFoodRate = FOOD_RATE_CATS.has(it.category);
      if (lineIsFoodRate !== catIsFoodRate) {
        crossCheckFlags.push({
          index: i,
          name: it.name,
          category: it.category,
          tax_code: it.tax_code,
          reason: catIsFoodRate
            ? 'Categorized as food, but the line is taxed at a non-food rate.'
            : 'Categorized as non-food, but the line is taxed at the food rate.',
        });
      }
    });
  }
  const crossCheckMismatch = crossCheckFlags.length > 0;
  // ===== end T1.4 =====

  // 4) LOW CONFIDENCE -> 1-tap correction queue
  const lowConfidenceItems = items
    .map((it, i) => ({ i, it }))
    .filter(({ it }) => String(it.confidence || '').toLowerCase() === 'low')
    .map(({ i, it }) => ({ index: i, name: it.name, price: num(it.price) }));

  // ===== Internal tax log (6/26): merchants compute tax correctly ~100% of the time, and real
  // receipts use layered/overlapping tax bases (a base rate on everything + a surcharge on a subset,
  // e.g. prepared food). Our simple one-rate-one-category model can't model overlap, so a "mismatch"
  // here is usually BENIGN (layered tax), occasionally a real miscategorization signal. Decision:
  // do NOT surface tax/cross-check mismatches to the USER. Keep computing them and emit them on an
  // internal channel so they can be reviewed during validation. Turn this off post-launch. =====
  const taxInternalLog =
    (taxMismatch || crossCheckMismatch)
      ? {
          reason: 'tax_or_crosscheck_mismatch_silenced',
          note: 'Likely layered/overlapping tax bases (benign) or a real miscategorization. User NOT notified; logged for validation.',
          subtotal_reconciled: subtotalMatches,        // if subtotal still ties, the math is trustworthy
          tax_mismatch: taxMismatch,
          cross_check_mismatch: crossCheckMismatch,
          cross_check_flags: crossCheckFlags,
          tax_checks: taxChecks,
        }
      : null;
  // ===== end internal tax log =====

  return { items, productCount, categoryTotals, computedSubtotal, printedSubtotal, subtotalDiff,
           subtotalMatches, taxChecks, codesMatchedSomething, allTaxMatch, taxCheckRan, taxMismatch,
           crossCheckFlags, crossCheckMismatch, lowConfidenceItems,
           transactionType, taxInternalLog };
}

function buildResponse(parsed) {
  const v = reconcile(parsed);
  const moneyOk = v.subtotalMatches !== false; // null (no printed subtotal) does NOT block

  // ===== Review triggers (REVISED 6/26) =====
  // SUPERSEDES the earlier 6/23 rule. Tax mismatch and cross-check mismatch NO LONGER notify the user:
  // merchants compute tax correctly ~100% of the time and the usual cause of a "mismatch" is layered
  // tax bases (benign). They are still computed and emitted on the internal log (taxInternalLog) for
  // our own validation review. The user is only asked to review things they can actually act on:
  //   1) the receipt's MONEY doesn't add up (subtotal mismatch), or
  //   2) an item was flagged low-confidence (a 1-tap "Needs Review" item).
  const needsReview = !moneyOk || v.lowConfidenceItems.length > 0;

  // Human-readable review message, most-serious-first. (Label shown to the user is "Needs Review".)
  let reviewMessage = null;
  if (!moneyOk) {
    reviewMessage = `Receipt doesn't add up (off by ${v.subtotalDiff}). Check the flagged line prices.`;
  } else if (v.lowConfidenceItems.length > 0) {
    reviewMessage = `${v.lowConfidenceItems.length} item(s) need a quick confirm.`;
  }
  // ===== end review triggers =====

  return {
    merchant: parsed.merchant || 'Unknown',
    transaction_type: v.transactionType,        // 6/26: 'purchase' or 'return'
    date: parsed.date != null ? parsed.date : null,            // 6/26: launch-critical for trends
    state: parsed.state != null ? parsed.state : null,
    store_address: parsed.store_address != null ? parsed.store_address : null, // 6/26
    items: v.items,
    product_count: v.productCount,              // T1.1: excludes discount lines
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
      tax_check_ran: v.taxCheckRan,
      tax_mismatch: v.taxMismatch,               // still reported in data, but no longer triggers review
      category_cross_check_flags: v.crossCheckFlags, // still reported in data
      low_confidence_items: v.lowConfidenceItems,
      needs_review: needsReview,
      review_message: reviewMessage,
    },
    // 6/26: internal-only channel. NOT shown to the user. Review during validation; disable post-launch.
    _internal_tax_log: v.taxInternalLog,
  };
}

module.exports = { reconcile, buildResponse, round2, normCode, asFraction, applyDiscountInheritance };
