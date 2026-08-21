/* RSM B2B Store - shared client logic.
   Catalogue rendering is fully static (products.json). The Apps Script API is
   only touched for login, reset, upload, submit, decide and close. */

const CONFIG = {
  // Live Apps Script deployment. Re-deploy to the SAME deployment id
  // (clasp deploy --deploymentId ...) so this URL never has to change.
  API_URL: 'https://script.google.com/macros/s/AKfycbyDezChvk8YkvxbdaPMB0W5sKK1znGFH7F6B9T0ficleUdVTPGk22tPD-MI_hZeelaf/exec',
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

/* ---------------------------------------------------------------- tracking */

/* Fire-and-forget usage events. Analytics must never be able to break the
   shop, so every call is wrapped, unawaited, and silent on failure. Nothing
   personal is recorded beyond the email of someone already signed in. */
const Track = {
  /* A session is one browser tab visit; a visitor persists across visits.
     Both are random ids with nothing personal in them, and the visitor id is
     what makes "new vs returning" possible at all. */
  vid() {
    try {
      let v = localStorage.getItem('rsm_vid');
      if (!v) {
        v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('rsm_vid', v);
        return { id: v, isNew: true };
      }
      return { id: v, isNew: false };
    } catch (err) {
      return { id: '', isNew: false };   // storage blocked; count it as a session only
    }
  },

  sid() {
    let s = sessionStorage.getItem('rsm_sid');
    if (!s) {
      s = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('rsm_sid', s);
    }
    return s;
  },

  /* Searches fire once the typing settles, otherwise every keystroke becomes
     a row. A search that found nothing is recorded separately: that list is
     the most useful thing on the dashboard, because it is people asking for
     products the catalogue does not have. */
  _searchTimer: null,
  search(q, results) {
    clearTimeout(this._searchTimer);
    const term = (q || '').trim();
    if (term.length < 2) return;
    this._searchTimer = setTimeout(() => {
      this.event(results ? 'search' : 'search_empty', { query: term, qty: results });
    }, 900);
  },

  event(name, props = {}) {
    try {
      const u = Auth.user();
      const v = this.vid();
      // referrer is only meaningful on the first page of a visit
      const firstOfSession = !sessionStorage.getItem('rsm_seen');
      if (firstOfSession) sessionStorage.setItem('rsm_seen', '1');

      const body = JSON.stringify({
        fn: 'track', token: CONFIG.API_TOKEN,
        session: this.sid(), visitor: v.id, event: name,
        is_new: v.isNew ? 1 : 0,
        ref: firstOfSession ? (document.referrer || '') : '',
        path: location.pathname.split('/').pop() || 'index.html',
        title: document.title.replace(' | RSM Business Store', ''),
        user_email: u ? u.email : '',
        ua: navigator.userAgent,
        ...props,
      });
      // keepalive so an event fired during navigation still leaves the page
      fetch(CONFIG.API_URL, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
      }).catch(() => {});
    } catch (err) {
      /* never surface an analytics failure to a shopper */
    }
  },
};

/* ------------------------------------------------------------------- catalogue */

const Catalog = {
  _data: null,
  async load() {
    if (this._data) return this._data;
    const [res] = await Promise.all([fetch('assets/products.json'), Site.load()]);
    this._data = await res.json();
    this._bySku = Object.fromEntries(this._data.products.map(p => [p.sku, p]));
    return this._data;
  },
  get products() { return this._data.products; },
  get categories() { return this._data.categories; },
  bySku(sku) { return this._bySku[sku]; },
};

/* Banners and site settings, published alongside products.json. Absent on a
   store that has never published, so every read is defensive. */
const Site = {
  settings: {}, banners: [],
  async load() {
    try {
      const res = await fetch('assets/site.json');
      if (!res.ok) return;
      const d = await res.json();
      this.settings = d.settings || {};
      this.banners = d.banners || [];
    } catch (err) {
      // a missing site.json is not an error, the defaults below cover it
    }
  },
  get(key, fallback) {
    const v = this.settings[key];
    return v === undefined || v === '' ? fallback : v;
  },
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

/* Unit price this product would carry at a given quantity. */
function unitAt(p, n) {
  const t = pickTier(p.tiers, n);
  return t ? t.unit_price : p.base_price;
}

/* Cheapest tier on the card, which is what "from ₹x" means. */
function lowestPrice(p) {
  return Math.min(...(p.tiers || []).map(t => t.unit_price).concat(p.base_price || Infinity));
}

/* ------------------------------------------------------------- filtering */

/* One filter model shared by the category pages, the all-products page and
   the kit builder, so "Drinkware under ₹500" cannot mean two different things
   in two places. */
const Filters = {
  state: { q: '', sort: 'featured', min: 0, max: Infinity, moq: Infinity, cat: '', sub: '' },

  reset() {
    this.state = { q: '', sort: 'featured', min: 0, max: Infinity, moq: Infinity, cat: '', sub: '' };
  },

  matches(p) {
    const s = this.state, price = lowestPrice(p);
    if (price < s.min || price > s.max) return false;
    if (p.moq > s.moq) return false;
    if (s.cat && p.category !== s.cat) return false;
    if (s.sub && p.subcategory !== s.sub) return false;
    const q = s.q.trim().toLowerCase();
    if (!q) return true;
    const hay = `${p.name} ${p.sku} ${p.category} ${p.subcategory} ${p.description || ''}`.toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  },

  apply(products) {
    const s = this.state;
    const out = products.filter(p => this.matches(p));
    if (s.sort === 'pl') out.sort((a, b) => lowestPrice(a) - lowestPrice(b));
    else if (s.sort === 'ph') out.sort((a, b) => lowestPrice(b) - lowestPrice(a));
    else if (s.sort === 'az') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (s.sort === 'moq') out.sort((a, b) => a.moq - b.moq);
    return out;
  },

  /* Renders the bar into `host`. `opts.categories` adds a category select,
     which the all-products page wants and a category page does not. */
  bar(host, opts, onChange) {
    opts = opts || {};
    const s = this.state;
    const fire = () => onChange();

    const field = (label, input) =>
      el('label', { class: 'fbar-fld' }, el('span', {}, label), input);

    const search = el('input', {
      type: 'search', id: 'fq', placeholder: 'Search name or SKU', value: s.q,
      oninput: e => { s.q = e.target.value; fire(); },
    });

    const sort = el('select', {
      id: 'fsort', onchange: e => { s.sort = e.target.value; fire(); },
    }, [['featured', 'Featured'], ['pl', 'Price: low to high'], ['ph', 'Price: high to low'],
        ['az', 'Name A–Z'], ['moq', 'MOQ: low to high']].map(([v, t]) =>
      el('option', { value: v, selected: s.sort === v ? 'selected' : null }, t)));

    const min = el('input', { type: 'number', min: '0', id: 'fmin', placeholder: 'Min',
      value: s.min || '', oninput: e => { s.min = Number(e.target.value) || 0; fire(); } });
    const max = el('input', { type: 'number', min: '0', id: 'fmax', placeholder: 'Max',
      value: isFinite(s.max) ? s.max : '', oninput: e => { s.max = Number(e.target.value) || Infinity; fire(); } });

    const moq = el('input', { type: 'number', min: '0', id: 'fmoq', placeholder: 'Any',
      value: isFinite(s.moq) ? s.moq : '',
      oninput: e => { s.moq = Number(e.target.value) || Infinity; fire(); } });

    const bits = [field('Search', search), field('Sort', sort),
      el('label', { class: 'fbar-fld' }, el('span', {}, 'Price'),
        el('span', { class: 'fbar-range' }, min, el('i', {}, '–'), max)),
      field('MOQ up to', moq)];

    if (opts.categories) {
      const cat = el('select', {
        id: 'fcat', onchange: e => { s.cat = e.target.value; s.sub = ''; fire(); },
      }, el('option', { value: '' }, 'All categories'),
         ...opts.categories.map(c => el('option', { value: c, selected: s.cat === c ? 'selected' : null }, c)));
      bits.splice(1, 0, field('Category', cat));
    }

    host.append(el('div', { class: 'fbar' }, ...bits,
      el('button', {
        class: 'btn btn-ghost btn-sm', style: 'margin-left:auto',
        onclick: () => { const keep = s.cat, sub = s.sub; Filters.reset();
          Filters.state.cat = opts.keepCategory ? keep : ''; Filters.state.sub = opts.keepCategory ? sub : '';
          host.textContent = ''; Filters.bar(host, opts, onChange); fire(); },
      }, 'Reset')));
  },
};

/* ----------------------------------------------------------- kit builder */

/* A kit is one unit of each item per employee, so every product in it is
   ordered `emp` times. That means the MOQ has to be met by the headcount
   alone, and the price each item contributes is its tier price at `emp`. */
function kitEligible(products, emp, budget) {
  return products.filter(p =>
    (p.tiers || []).length && p.moq <= emp && unitAt(p, emp) <= budget);
}

function buildOneKit(pool, emp, budget, target, allowRepeat) {
  const kit = { items: [], per: 0 };
  const usedSub = new Set();
  let avail = pool.slice();
  const ok = p => allowRepeat || !usedSub.has(p.subcategory);
  const add = p => {
    kit.items.push(p);
    kit.per += unitAt(p, emp);
    usedSub.add(p.subcategory);
    avail = avail.filter(x => x.sku !== p.sku);
  };

  while (kit.items.length < target) {
    const c = avail.filter(p => ok(p) && kit.per + unitAt(p, emp) <= budget);
    if (!c.length) break;
    const pick = c.sort(() => Math.random() - 0.5).slice(0, 6);
    add(pick[Math.floor(Math.random() * pick.length)]);
  }
  // spend the remainder on the closest-fitting item still available
  for (let i = 0; i < 40; i++) {
    const left = budget - kit.per;
    if (left <= Math.min(50, budget * 0.03)) break;
    const c = avail.filter(p => ok(p) && unitAt(p, emp) <= left);
    if (!c.length) break;
    c.sort((x, y) => Math.abs(left - unitAt(x, emp)) - Math.abs(left - unitAt(y, emp)));
    add(c[0]);
  }
  return kit.items.length ? kit : null;
}

function buildKits(pool, emp, budget, count) {
  if (!pool.length) return [];
  // one item per subcategory keeps a kit varied, unless the filter has already
  // narrowed things to a single subcategory
  const allowRepeat = new Set(pool.map(p => p.subcategory)).size < 2;
  const avg = pool.reduce((s, p) => s + unitAt(p, emp), 0) / pool.length;
  const maxItems = Math.max(2, Math.min(10, Math.floor(budget / Math.max(1, avg * 0.6))));
  const targets = [];
  for (let i = maxItems; i >= 1; i--) targets.push(i);

  const kits = [], seen = new Set();
  for (let a = 0; kits.length < count && a < count * 120; a++) {
    const k = buildOneKit(pool, emp, budget, targets[a % targets.length], allowRepeat);
    if (!k) continue;
    const key = k.items.map(p => p.sku).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    kits.push(k);
  }
  kits.sort((a, b) => b.per - a.per || b.items.length - a.items.length);
  return kits;
}

/* ------------------------------------------------------------------ chrome */

function header(active) {
  const u = Auth.user();
  return el('header', { class: 'site-head' },
    el('div', { class: 'wrap head-inner' },
      el('a', { class: 'brand', href: 'index.html' },
        el('img', { class: 'brand-logo', alt: 'RSM',
          src: Site.get('logo_url', 'assets/brand/rsm-logo.png') }),
        el('span', { class: 'brand-sub' }, 'Business Store')),
      el('nav', { class: 'nav' },
        ['Apparel', 'Drinkware', 'Travel', 'Utilities'].map(c =>
          el('a', {
            href: 'category.html?cat=' + encodeURIComponent(c),
            class: active === c ? 'on' : '',
          }, c)),
        el('a', { href: 'all.html', class: active === 'All' ? 'on' : '' }, 'All products'),
        el('a', { href: 'kit.html', class: 'nav-kit' + (active === 'Kit' ? ' on' : '') }, 'Build a kit')),
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
      el('span', {}, Site.get('footer_note', 'RSM Business Store, operated by CompanyStore.IO')),
      el('a', { href: 'status.html', class: 'link-quiet' }, 'Track an order')));
}

function mount(active) {
  document.body.prepend(header(active));
  document.body.append(footer());
  Cart.paintCount();
  Track.event('page_view');
  // one counter for "how much are people actually doing", not per-element
  document.addEventListener('click', e => {
    if (e.target.closest('a, button')) Track.event('click');
  }, { passive: true });
}

/* Catalogue tile, shared by index.html and category.html. */
function productCard(p) {
  const lowest = lowestPrice(p);
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
