/* RSM B2B Store - shared client logic.
   Catalogue rendering is fully static (products.json). The Apps Script API is
   only touched for login, reset, upload, submit, decide and close. */

const CONFIG = {
  // Paste the /exec URL after deploying apps-script/. Everything except
  // browsing is inert until this is set.
  API_URL: 'https://script.google.com/macros/s/AKfycbyy4GQmuJGFcqVMbeznFUjrbwIVj6vZdkJ13KrHVvXg1RUD0V7r2Y845ep_F1ASZrtP/exec',
  API_TOKEN: 'rsm_XkCA0HS327rSxemHHRHIymHolJcf',
  CURRENCY: '₹',
};

/* ---------------------------------------------------------------- utilities */

const money = n =>
  CONFIG.CURRENCY + Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

const qty = n => Number(n || 0).toLocaleString('en-IN');

const param = k => new URLSearchParams(location.search).get(k) || '';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    // Coerce anything that is not already a Node (numbers especially) to text,
    // otherwise appendChild throws on a plain value.
    n.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function toast(msg, kind = 'info') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = el('div', { class: 'toast toast-' + kind }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
}

/* --------------------------------------------------------------- API client */

/* Apps Script cannot answer a CORS preflight, so every POST goes out as
   text/plain with a JSON string body. Changing this breaks all writes. */
async function api(fn, payload = {}) {
  if (!CONFIG.API_URL) throw new Error('API_URL is not configured yet.');
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn, token: CONFIG.API_TOKEN, session: Auth.token(), ...payload }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ------------------------------------------------------------------- catalogue */

const Catalog = {
  _data: null,
  async load() {
    if (this._data) return this._data;
    const res = await fetch('assets/products.json');
    this._data = await res.json();
    this._bySku = Object.fromEntries(this._data.products.map(p => [p.sku, p]));
    return this._data;
  },
  get products() { return this._data.products; },
  get categories() { return this._data.categories; },
  bySku(sku) { return this._bySku[sku]; },
};

/* --------------------------------------------------------------------- auth */

const Auth = {
  token() { return sessionStorage.getItem('rsm_session') || ''; },
  user() {
    try { return JSON.parse(sessionStorage.getItem('rsm_user') || 'null'); }
    catch { return null; }
  },
  set(token, user) {
    sessionStorage.setItem('rsm_session', token);
    sessionStorage.setItem('rsm_user', JSON.stringify(user));
  },
  clear() {
    sessionStorage.removeItem('rsm_session');
    sessionStorage.removeItem('rsm_user');
  },
  /* Catalogue is public. Only checkout calls this. */
  require(next) {
    if (this.user()) return true;
    location.href = 'login.html?next=' + encodeURIComponent(next || location.pathname.split('/').pop());
    return false;
  },
};

/* --------------------------------------------------------------------- cart */

const Cart = {
  read() {
    try { return JSON.parse(sessionStorage.getItem('rsm_cart') || '[]'); }
    catch { return []; }
  },
  write(items) {
    sessionStorage.setItem('rsm_cart', JSON.stringify(items));
    Cart.paintCount();
  },
  /* One line per variant. Sized products key on variant_sku, plain products on sku. */
  add(sku, size, n) {
    const items = Cart.read();
    const key = size ? sku + '_' + size : sku;
    const hit = items.find(i => i.key === key);
    if (hit) hit.qty += n;
    else items.push({ key, sku, size: size || '', qty: n });
    Cart.write(items);
  },
  setQty(key, n) {
    const items = Cart.read();
    const hit = items.find(i => i.key === key);
    if (!hit) return;
    if (n <= 0) return Cart.remove(key);
    hit.qty = n;
    Cart.write(items);
  },
  remove(key) { Cart.write(Cart.read().filter(i => i.key !== key)); },
  clear() { sessionStorage.removeItem('rsm_cart'); Cart.paintCount(); },
  count() { return Cart.read().reduce((a, i) => a + i.qty, 0); },
  paintCount() {
    const n = Cart.count();
    document.querySelectorAll('[data-cart-count]').forEach(e => {
      e.textContent = n;
      e.classList.toggle('hidden', n === 0);
    });
  },
};

/* ---------------------------------------------------------------- pricing */

/* Tier resolution, per the client rule:
   quantity rolls up by PARENT SKU across sizes, the matching tier's unit price
   applies to every line in that group, and the group total must meet the MOQ. */
function priceCart(items, lookup) {
  const groups = {};
  for (const it of items) {
    (groups[it.sku] = groups[it.sku] || []).push(it);
  }

  const lines = [];
  const groupInfo = {};
  let subtotal = 0, taxTotal = 0;

  for (const [sku, gitems] of Object.entries(groups)) {
    const p = lookup(sku);
    if (!p) continue;

    const groupQty = gitems.reduce((a, i) => a + i.qty, 0);
    const tier = pickTier(p.tiers, groupQty);
    const unit = tier ? tier.unit_price : p.base_price;
    const next = nextTier(p.tiers, groupQty);

    groupInfo[sku] = {
      product: p,
      groupQty,
      tier,
      unit,
      next,
      needForNext: next ? next.min_qty - groupQty : 0,
      meetsMoq: groupQty >= p.moq,
      shortBy: Math.max(0, p.moq - groupQty),
    };

    for (const it of gitems) {
      const lineTotal = unit * it.qty;
      const tax = lineTotal * (p.gst_rate / 100);
      subtotal += lineTotal;
      taxTotal += tax;
      lines.push({
        ...it, product: p, groupQty, unit, lineTotal,
        gst_rate: p.gst_rate, tax, lineTotalWithTax: lineTotal + tax,
        tierLabel: tier ? tierLabel(tier) : '',
      });
    }
  }

  const blocked = Object.values(groupInfo).filter(g => !g.meetsMoq);
  return {
    lines, groups: groupInfo, subtotal, taxTotal,
    grandTotal: subtotal + taxTotal,
    blocked,
    valid: lines.length > 0 && blocked.length === 0,
  };
}

/* Highest tier whose min_qty is still <= the group quantity. */
function pickTier(tiers, n) {
  let best = null;
  for (const t of tiers || []) {
    if (n >= t.min_qty && (!best || t.min_qty > best.min_qty)) best = t;
  }
  return best;
}

function nextTier(tiers, n) {
  let best = null;
  for (const t of tiers || []) {
    if (t.min_qty > n && (!best || t.min_qty < best.min_qty)) best = t;
  }
  return best;
}

function tierLabel(t) {
  return t.max_qty ? `${t.min_qty}–${t.max_qty}` : `${t.min_qty}+`;
}

/* ------------------------------------------------------------------ chrome */

function header(active) {
  const u = Auth.user();
  return el('header', { class: 'site-head' },
    el('div', { class: 'wrap head-inner' },
      el('a', { class: 'brand', href: 'index.html' },
        el('img', { class: 'brand-logo', src: 'assets/brand/rsm-logo.png', alt: 'RSM' }),
        el('span', { class: 'brand-sub' }, 'Business Store')),
      el('nav', { class: 'nav' },
        ['Apparel', 'Drinkware', 'Travel', 'Utilities'].map(c =>
          el('a', {
            href: 'category.html?cat=' + encodeURIComponent(c),
            class: active === c ? 'on' : '',
          }, c))),
      el('div', { class: 'head-right' },
        u
          ? el('div', { class: 'who' },
              el('span', { class: 'who-name' }, u.full_name || u.email),
              el('a', { href: '#', class: 'link-quiet', onclick: e => { e.preventDefault(); Auth.clear(); location.reload(); } }, 'Sign out'))
          : el('a', { class: 'link-quiet', href: 'login.html' }, 'Sign in'),
        el('a', { class: 'cart-btn', href: 'cart.html' }, 'Cart',
          el('span', { 'data-cart-count': '1', class: 'pill hidden' }, '0')))));
}

function footer() {
  return el('footer', { class: 'site-foot' },
    el('div', { class: 'wrap foot-inner' },
      el('span', {}, 'RSM Business Store, operated by CompanyStore.IO'),
      el('a', { href: 'status.html', class: 'link-quiet' }, 'Track an order')));
}

function mount(active) {
  document.body.prepend(header(active));
  document.body.append(footer());
  Cart.paintCount();
}

/* Catalogue tile, shared by index.html and category.html. */
function productCard(p) {
  const lowest = Math.min(...p.tiers.map(t => t.unit_price));
  return el('a', { class: 'card', href: 'product.html?sku=' + encodeURIComponent(p.sku) },
    el('div', { class: 'card-img' }, el('img', { src: p.image, alt: p.name, loading: 'lazy' })),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-sku' }, p.sku),
      el('div', { class: 'card-name' }, p.name),
      p.has_sizes ? el('div', { class: 'tag' }, p.sizes.length + ' sizes') : null,
      el('div', { class: 'card-moq' }, 'MOQ ' + qty(p.moq)),
      el('div', { class: 'card-price' },
        el('span', { class: 'from' }, 'from'),
        money(lowest))));
}

/* Node test harness only. Ignored by the browser. */
if (typeof module !== 'undefined') {
  module.exports = { priceCart, pickTier, nextTier, tierLabel };
}
