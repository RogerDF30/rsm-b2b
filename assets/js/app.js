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
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn, token: CONFIG.API_TOKEN, session: Auth.token(), ...payload }),
    });
  } catch (err) {
    /* fetch only rejects on a network-level failure, and the browser's own
       wording for that is the unhelpful "Failed to fetch". */
    throw new Error('The backend did not respond. Check your connection and try again.');
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* Same envelope as api(), over XMLHttpRequest, because fetch cannot report
   upload progress and evidence files are large enough for a submit to look
   frozen without a bar. */
function apiUpload(fn, payload = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.API_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.upload.onload = () => onProgress(1);
    }
    xhr.onload = () => {
      let d;
      try { d = JSON.parse(xhr.responseText); }
      catch (err) { reject(new Error('The server sent a reply we could not read.')); return; }
      if (!d.ok) reject(new Error(d.error || 'Request failed'));
      else resolve(d);
    };
    xhr.onerror = () => {
      const err = new Error('The upload did not reach the server. Check your connection.');
      err.transport = true;             // lets the caller retry over fetch
      reject(err);
    };
    xhr.send(JSON.stringify({ fn, token: CONFIG.API_TOKEN, session: Auth.token(), ...payload }));
  });
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
  get products() { return this._data ? this._data.products : []; },
  get categories() { return this._data ? this._data.categories : []; },
  bySku(sku) { return this._bySku[sku]; },
};

/* Banners and site settings, published alongside products.json. Absent on a
   store that has never published, so every read is defensive. */
const Site = {
  settings: {}, banners: [], departments: [],
  async load() {
    try {
      const res = await fetch('assets/site.json');
      if (!res.ok) return;
      const d = await res.json();
      this.settings = d.settings || {};
      this.banners = d.banners || [];
      /* Published alongside the catalogue so checkout does not have to wait on
         a live Apps Script call to fill two dropdowns. */
      this.departments = d.departments || [];
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

  /* Ordering under the MOQ is allowed: the vendor may still accept it, and a
     requester who needs eight of something should not be forced to buy
     twenty-five. It is flagged everywhere it appears rather than blocked, and
     the approver sees the flag before deciding. */
  const belowMoq = Object.values(groupInfo).filter(g => !g.meetsMoq);
  return {
    lines, groups: groupInfo, subtotal, taxTotal,
    grandTotal: subtotal + taxTotal,
    belowMoq,
    blocked: belowMoq,        // old name, kept so nothing breaks mid-deploy
    valid: lines.length > 0,
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

const ICONS = {
  user: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"/>' +
        '<path d="M4.6 20c1.3-3.7 4-5.6 7.4-5.6S18.1 16.3 19.4 20"/></svg>',
  cart: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M2.5 4h2.3l2.2 10.5h9.6L19 7H6.4"/><circle cx="9.5" cy="19" r="1.5"/>' +
        '<circle cx="16.5" cy="19" r="1.5"/></svg>',
  search: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/>' +
          '<path d="M15.5 15.5 21 21"/></svg>',
  burger: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
         'stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/* Three bands, the same order the RSM store has used since Magento: account
   strip, logo and search, then the category rail. */
function header(active) {
  const u = Auth.user();
  /* The rail follows the catalogue, so a new heading appears the moment a
     product is published under it. The four originals are the fallback for
     pages that mount before the catalogue is loaded. */
  const cats = Catalog.categories.length
    ? Catalog.categories.map(c => c.slug)
    : ['Apparel', 'Drinkware', 'Travel', 'Utilities'];

  return el('header', { class: 'site-head' },
    el('div', { class: 'util' },
      el('div', { class: 'wrap util-inner' },
        u ? el('span', { class: 'util-name' }, 'Welcome, ' + (u.full_name || u.email)) : null,
        u
          ? el('a', { href: '#', onclick: e => { e.preventDefault(); Auth.clear(); location.reload(); } }, 'Sign out')
          : el('a', { href: 'login.html' }, 'Sign in'),
        el('a', { class: 'util-btn', href: 'status.html' }, 'Track an order'))),

    el('div', { class: 'wrap head-inner' },
      el('button', {
        class: 'burger', type: 'button', 'aria-label': 'Menu',
        onclick: () => openMenu(active), html: ICONS.burger,
      }),
      el('a', { class: 'brand', href: 'index.html' },
        el('img', { class: 'brand-logo', alt: 'RSM',
          src: Site.get('logo_url', 'assets/brand/rsm-logo.png') })),
      el('form', { class: 'search', action: 'all.html', method: 'get' },
        el('input', { type: 'search', name: 'q', 'aria-label': 'Search products',
          placeholder: 'Search entire store here...' }),
        el('button', { type: 'submit', 'aria-label': 'Search', html: ICONS.search })),
      el('div', { class: 'head-icons' },
        el('a', { class: 'icon-btn', href: u ? 'status.html' : 'login.html',
          title: u ? 'Your orders' : 'Sign in', html: ICONS.user }),
        el('a', { class: 'icon-btn', href: 'cart.html', title: 'Cart', html: ICONS.cart },
          el('span', { 'data-cart-count': '1', class: 'pill hidden' }, '0')))),

    el('nav', { class: 'catnav' },
      el('div', { class: 'wrap catnav-inner' },
        cats.map(c => catnavItem(c, active)),
        el('a', { class: 'catnav-top' + (active === 'All' ? ' on' : ''), href: 'all.html' },
          'All products'),
        el('a', { class: 'catnav-top nav-kit' + (active === 'Kit' ? ' on' : ''), href: 'kit.html' },
          'Build a kit'))));
}

/* One category plus its subcategories. The subcategory list comes from the
   catalogue, so a new subcategory appears in the rail without a code change. */
function catnavItem(cat, active) {
  /* login.html, reset.html and status.html mount the chrome without loading
     the catalogue, so there may be no subcategories to hang a menu on. */
  const meta = Catalog.categories.find(c => c.slug === cat);
  const subs = meta ? meta.subcategories : [];
  const href = 'category.html?cat=' + encodeURIComponent(cat);

  return el('div', { class: 'catnav-item' },
    el('a', { class: 'catnav-top' + (active === cat ? ' on' : ''), href },
      cat, subs.length ? el('span', { class: 'caret' }, '\u02c5') : null),
    subs.length
      ? el('div', { class: 'catnav-menu' }, subs.map(s =>
          el('a', { href: href + '&sub=' + encodeURIComponent(s) }, s)))
      : null);
}

/* The category rail does not survive a phone: five headings with dropdowns
   either overflow or scroll sideways. On small screens the rail is hidden and
   this drawer carries the same links, subcategories included. */
function openMenu(active) {
  closeMenu();
  const u = Auth.user();
  const cats = Catalog.categories.length
    ? Catalog.categories
    : ['Apparel', 'Drinkware', 'Travel', 'Utilities'].map(c => ({ slug: c, label: c, subcategories: [] }));

  const panel = el('nav', { class: 'menu-panel', 'aria-label': 'Site menu' },
    el('div', { class: 'menu-head' },
      el('span', { class: 'menu-title' }, 'Menu'),
      el('button', { class: 'menu-x', type: 'button', 'aria-label': 'Close', onclick: closeMenu, html: ICONS.close })),

    el('div', { class: 'menu-body' },
      cats.map(c => el('div', { class: 'menu-group' },
        el('a', {
          class: 'menu-cat' + (active === c.slug ? ' on' : ''),
          href: 'category.html?cat=' + encodeURIComponent(c.slug),
        }, c.label),
        (c.subcategories || []).map(sub => el('a', {
          class: 'menu-sub',
          href: 'category.html?cat=' + encodeURIComponent(c.slug) + '&sub=' + encodeURIComponent(sub),
        }, sub)))),

      el('div', { class: 'menu-group' },
        el('a', { class: 'menu-cat', href: 'all.html' }, 'All products'),
        el('a', { class: 'menu-cat', href: 'kit.html' }, 'Build a kit'),
        el('a', { class: 'menu-cat', href: 'status.html' }, 'Track an order')),

      el('div', { class: 'menu-group' },
        u
          ? el('a', { class: 'menu-sub', href: '#', onclick: e => { e.preventDefault(); Auth.clear(); location.reload(); } },
              'Sign out of ' + (u.full_name || u.email))
          : el('a', { class: 'menu-sub', href: 'login.html' }, 'Sign in'))));

  const shade = el('div', {
    class: 'menu-shade', id: 'menuShade',
    onclick: e => { if (e.target.id === 'menuShade') closeMenu(); },
  }, panel);

  document.body.append(shade);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', menuEscape);
  panel.querySelector('a, button')?.focus();
}

function closeMenu() {
  document.getElementById('menuShade')?.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', menuEscape);
}

function menuEscape(e) {
  if (e.key === 'Escape') closeMenu();
}

function footer() {
  return el('footer', { class: 'site-foot' },
    el('div', { class: 'wrap foot-inner' },
      el('p', { class: 'foot-help' },
        'For questions about your order, please contact Customer Service at ',
        el('a', { href: 'mailto:helpdesk@companystore.io' }, 'helpdesk@companystore.io'), '.'),
      el('p', { class: 'foot-links' },
        el('a', { href: 'privacy.html' }, 'Privacy policy'), ' | ',
        el('a', { href: 'returns.html' }, 'Returns & refunds'), ' | ',
        el('a', { href: 'faq.html' }, 'FAQ'), ' | ',
        el('a', { href: 'status.html' }, 'Track an order')),
      el('p', { class: 'foot-note small' },
        Site.get('footer_note', 'RSM Business Store, operated by CompanyStore.IO')),
      el('p', { class: 'foot-copy small' },
        '\u00a9 ' + new Date().getFullYear() + ' RSM US LLP. All rights reserved.')));
}

function mount(active) {
  document.body.prepend(header(active));
  document.body.append(footer());
  Cart.paintCount();

  /* The console is staff-only, and its own calls are slow enough already:
     every tracking POST queues behind them in Apps Script, which is how the
     unlock ended up failing. Nothing to learn from watching ourselves. */
  const page = location.pathname.split('/').pop();
  if (page === 'admin.html' || page === 'analytics.html') return;

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
