const { priceCart, pickTier, nextTier } = require('../assets/js/app.js');

const SHIRT = { sku: 'SH', moq: 25, gst_rate: 5, base_price: 1000, tiers: [
  { min_qty: 25, max_qty: 49, unit_price: 1000 },
  { min_qty: 50, max_qty: 99, unit_price: 930 },
  { min_qty: 100, max_qty: 249, unit_price: 880 },
  { min_qty: 250, max_qty: '', unit_price: 820 },
]};
const MUG = { sku: 'MG', moq: 25, gst_rate: 18, base_price: 500, tiers: [
  { min_qty: 25, max_qty: 49, unit_price: 500 },
  { min_qty: 50, max_qty: '', unit_price: 465 },
]};
const look = s => ({ SH: SHIRT, MG: MUG })[s];

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
}

// 1. Sizes roll up by parent SKU: 10+12+8 = 30 -> the 25-49 tier for ALL lines.
let r = priceCart([
  { key: 'SH_M', sku: 'SH', size: 'M', qty: 10 },
  { key: 'SH_L', sku: 'SH', size: 'L', qty: 12 },
  { key: 'SH_XL', sku: 'SH', size: 'XL', qty: 8 },
], look);
t('rollup group qty', r.groups.SH.groupQty, 30);
t('rollup one unit price for every size', r.lines.map(l => l.unit), [1000, 1000, 1000]);
t('rollup subtotal', r.subtotal, 30000);
t('rollup tax at 5%', r.taxTotal, 1500);
t('rollup valid', r.valid, true);

// 2. Without rollup each line would sit below MOQ. With rollup it clears.
t('rollup clears MOQ', r.groups.SH.meetsMoq, true);

// 3. Below MOQ blocks the whole cart.
r = priceCart([{ key: 'SH_M', sku: 'SH', size: 'M', qty: 20 }], look);
t('below MOQ invalid', r.valid, false);
t('below MOQ short by', r.groups.SH.shortBy, 5);

// 4. Tier boundaries are inclusive on min_qty.
const at = n => priceCart([{ key: 'SH_M', sku: 'SH', size: 'M', qty: n }], look).lines[0].unit;
t('qty 49 -> 1000', at(49), 1000);
t('qty 50 -> 930', at(50), 930);
t('qty 99 -> 930', at(99), 930);
t('qty 100 -> 880', at(100), 880);
t('qty 250 -> 820', at(250), 820);
t('qty 5000 -> 820 (open top tier)', at(5000), 820);

// 5. Next-tier hint.
r = priceCart([{ key: 'SH_M', sku: 'SH', size: 'M', qty: 30 }], look);
t('next tier min', r.groups.SH.next.min_qty, 50);
t('units needed for next tier', r.groups.SH.needForNext, 20);
t('top tier has no next', priceCart([{ key: 'SH_M', sku: 'SH', size: 'M', qty: 300 }], look).groups.SH.next, null);

// 6. Groups price independently of each other.
r = priceCart([
  { key: 'SH_M', sku: 'SH', size: 'M', qty: 60 },
  { key: 'MG', sku: 'MG', size: '', qty: 30 },
], look);
t('shirt tier independent', r.groups.SH.unit, 930);
t('mug tier independent', r.groups.MG.unit, 500);
t('mixed subtotal', r.subtotal, 60 * 930 + 30 * 500);
t('per-product GST', Math.round(r.taxTotal), Math.round(60 * 930 * 0.05 + 30 * 500 * 0.18));

// 7. One bad group blocks the cart even if the other is fine.
r = priceCart([
  { key: 'SH_M', sku: 'SH', size: 'M', qty: 60 },
  { key: 'MG', sku: 'MG', size: '', qty: 5 },
], look);
t('one bad group blocks', r.valid, false);
t('blocked names only the bad group', r.blocked.map(b => b.product.sku), ['MG']);

// 8. Empty cart is not valid.
t('empty cart invalid', priceCart([], look).valid, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
