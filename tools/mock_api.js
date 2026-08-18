/* Local stand-in for the Apps Script web app, used only to test the frontend
   end to end before deployment. It mirrors the response SHAPES of the handlers
   in apps-script/, and re-implements priceOrder() so the server-side pricing
   check is exercised. It is NOT the backend and is not deployed. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/products.json')));
const BY_SKU = Object.fromEntries(catalog.products.map(p => [p.sku, p]));

const USERS = {
  'neha.garg@rsmus.com': {
    email: 'neha.garg@rsmus.com', full_name: 'Neha Garg', lob: 'Consulting',
    password: 'DemoPass2026!', default_ship_name: 'Preeti Lakesh',
    default_ship_phone: '8744083233',
    default_ship_street: '9th & 10th Floor, HQ 27, The Headquarters, Sector 27',
    default_ship_city: 'Gurugram', default_ship_pincode: '122002',
  },
};
const ADMIN_PASS = 'admin2026';
const API_TOKEN = 'rsm-demo-token';

let seq = 13682;
const orders = {}, lines = {}, files = {};

/* Same rule as apps-script/Orders.gs priceOrder(). */
function priceOrder(raw) {
  const groups = {};
  for (const l of raw) {
    const n = Math.floor(Number(l.qty) || 0);
    if (n > 0) (groups[l.parent_sku] = groups[l.parent_sku] || []).push({ ...l, qty: n });
  }
  const out = [];
  let subtotal = 0, taxTotal = 0;
  for (const [sku, items] of Object.entries(groups)) {
    const p = BY_SKU[sku];
    if (!p) throw new Error(`Product ${sku} is no longer available.`);
    const groupQty = items.reduce((a, i) => a + i.qty, 0);
    if (groupQty < p.moq) {
      throw new Error(`${p.name} needs at least ${p.moq} units. You have ${groupQty}.`);
    }
    let tier = null;
    for (const t of p.tiers) if (groupQty >= t.min_qty && (!tier || t.min_qty > tier.min_qty)) tier = t;
    const unit = tier ? tier.unit_price : p.base_price;
    const band = tier ? (tier.max_qty ? `${tier.min_qty}-${tier.max_qty}` : `${tier.min_qty}+`) : '';
    for (const i of items) {
      const lineTotal = unit * i.qty;
      const tax = lineTotal * p.gst_rate / 100;
      subtotal += lineTotal; taxTotal += tax;
      out.push({
        parent_sku: sku, variant_sku: i.variant_sku, product_name: p.name,
        size: i.size || '', qty: i.qty, group_qty: groupQty, tier_applied: band,
        unit_price: unit, line_total: lineTotal, gst_rate: p.gst_rate,
        tax_amount: r2(tax), line_total_with_tax: r2(lineTotal + tax),
      });
    }
  }
  if (!out.length) throw new Error('The order has no valid lines.');
  return { lines: out, subtotal: r2(subtotal), tax_total: r2(taxTotal), grand_total: r2(subtotal + taxTotal) };
}
const r2 = n => Math.round(n * 100) / 100;
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

const ADMIN_STATE = {
  hidden: new Set(),
  related: {},
  banners: [
    { slug: 'welcome', title: 'RSM branded merchandise',
      subtitle: 'Browse the approved catalogue.', image_url: '',
      link_url: 'category.html?cat=Apparel', sort_order: 0, active: true },
  ],
  settings: {
    logo_url: 'assets/brand/rsm-logo.png',
    logo_white_url: 'assets/brand/rsm-logo-white.png',
    hero_title: 'RSM branded merchandise',
    hero_subtitle: 'Browse the approved catalogue.',
    footer_note: 'RSM Business Store, operated by CompanyStore.IO',
  },
  published_at: '',
};
const admin = req => {
  if (req.admin_pass !== ADMIN_PASS) throw new Error('Admin password is incorrect.');
};

const ROUTES = {
  login(req) {
    const u = USERS[String(req.email || '').toLowerCase()];
    if (!u || u.password !== req.password) throw new Error('Email or password is incorrect.');
    const { password, ...pub } = u;
    return { ok: true, session: 'mock-session', user: pub };
  },
  resetRequest() { return { ok: true }; },
  meta() {
    return { ok: true, departments: [
      { lob: 'Assurance', approver: 'Kawalpreet Kaur' },
      { lob: 'CMG', approver: '' },
      { lob: 'Consulting', approver: 'Balasundaram Nagarajan' },
      { lob: 'Enterprises', approver: 'Gowri Srinivas' },
      { lob: 'ESS', approver: '' },
      { lob: 'IT', approver: 'Malleswara Reddy' },
      { lob: 'Talent', approver: '' },
      { lob: 'Tax', approver: '' },
    ]};
  },

  submitOrder(req) {
    if (!req.files || !req.files.length) throw new Error('At least one evidence file is required.');
    const priced = priceOrder(req.lines || []);
    if (req.client_total !== undefined && req.client_total !== null &&
        Math.abs(Number(req.client_total) - priced.grand_total) > 1) {
      throw new Error('Prices have changed since you loaded the catalogue.');
    }
    const id = 'RSMB' + String(seq++).padStart(6, '0');
    const o = req.order;
    orders[id] = {
      order_id: id, created_at: stamp(),
      requester_email: o.requester_email, requester_name: o.requester_name,
      lob: o.lob, event_date: o.event_date, purpose: o.purpose,
      ship_name: o.ship_name, ship_phone: o.ship_phone, ship_street: o.ship_street,
      ship_city: o.ship_city, ship_pincode: o.ship_pincode,
      subtotal: priced.subtotal, tax_total: priced.tax_total,
      grand_total: priced.grand_total, status: 'Pending Approval',
      decided_by: '', decided_at: '', rejection_reason: '',
      courier: '', tracking_no: '', tracking_url: '',
    };
    lines[id] = priced.lines;
    files[id] = req.files.map(f => ({ filename: f.name, bytes: f.bytes, drive_url: '#' }));
    return { ok: true, order_id: id, total: priced.grand_total };
  },

  getOrder(req) {
    const o = orders[req.order_id];
    if (!o || o.requester_email.toLowerCase() !== String(req.email).toLowerCase()) {
      throw new Error('No order found for that ID and email.');
    }
    return { ok: true, order: o, lines: lines[o.order_id], files: files[o.order_id] };
  },

  adminList(req) {
    if (req.admin_pass !== ADMIN_PASS) throw new Error('Admin password is incorrect.');
    return {
      ok: true,
      orders: Object.values(orders).reverse().map(o => ({ ...o, line_count: lines[o.order_id].length })),
    };
  },
  adminOrder(req) {
    if (req.admin_pass !== ADMIN_PASS) throw new Error('Admin password is incorrect.');
    const o = orders[req.order_id];
    return { ok: true, order: o, lines: lines[o.order_id], files: files[o.order_id] };
  },
  adminResend(req) {
    if (req.admin_pass !== ADMIN_PASS) throw new Error('Admin password is incorrect.');
    return { ok: true };
  },
  closeOrder(req) {
    if (req.admin_pass !== ADMIN_PASS) throw new Error('Admin password is incorrect.');
    const o = orders[req.order_id];
    if (o.status !== 'Approved') throw new Error('Only approved orders can be closed.');
    Object.assign(o, {
      status: 'Closed', courier: req.courier, tracking_no: req.tracking_no,
      tracking_url: req.tracking_url, closed_at: stamp(),
    });
    return { ok: true };
  },

  /* --- admin catalogue, mirroring apps-script/Admin.gs shapes ------------- */
  adminCatalog(req) {
    admin(req);
    return {
      ok: true,
      products: catalog.products.map(p => ({
        sku: p.sku, name: p.name, category: p.category, subcategory: p.subcategory,
        description: p.description, moq: p.moq, gst_rate: p.gst_rate,
        base_price: p.base_price, has_sizes: p.has_sizes, image: p.image,
        lead_time_days: 14, active: ADMIN_STATE.hidden.has(p.sku) ? false : true,
        sort_order: 0, related_skus: ADMIN_STATE.related[p.sku] || [],
        sizes: p.sizes, tiers: p.tiers,
      })),
      categories: catalog.categories.flatMap(c => c.subcategories.map((s, i) => ({
        slug: s, parent_slug: c.slug, label: s, sort_order: i, active: true }))),
      banners: ADMIN_STATE.banners,
      settings: ADMIN_STATE.settings,
      published_at: ADMIN_STATE.published_at,
    };
  },
  adminSaveProduct(req) {
    admin(req);
    const p = req.product;
    if (!p.sku) throw new Error('SKU is required.');
    if (!p.name) throw new Error('Product name is required.');
    if (!(Number(p.moq) > 0)) throw new Error('MOQ must be greater than zero.');
    const tiers = (p.tiers || []).filter(t => t.min_qty > 0 && t.unit_price > 0)
      .sort((a, b) => a.min_qty - b.min_qty);
    if (!tiers.length) throw new Error('At least one price tier is required.');
    if (tiers[0].min_qty !== Math.floor(Number(p.moq))) {
      throw new Error(`The first price tier must start at the MOQ (${p.moq}).`);
    }
    const hit = catalog.products.find(x => x.sku === p.sku);
    const row = { ...p, tiers, base_price: tiers[0].unit_price,
                  has_sizes: (p.sizes || []).length > 0 };
    if (hit) Object.assign(hit, row); else catalog.products.push(row);
    BY_SKU[p.sku] = hit || row;
    ADMIN_STATE.related[p.sku] = p.related_skus || [];
    return { ok: true, sku: p.sku, created: !hit };
  },
  adminDeleteProduct(req) {
    admin(req);
    if (String(req.confirm || '').toUpperCase() !== String(req.sku).toUpperCase()) {
      throw new Error('Type the SKU exactly to confirm.');
    }
    ADMIN_STATE.hidden.add(req.sku);
    return { ok: true };
  },
  adminToggle(req) {
    admin(req);
    if (req.kind === 'product') {
      req.active ? ADMIN_STATE.hidden.delete(req.key) : ADMIN_STATE.hidden.add(req.key);
    }
    if (req.kind === 'banner') {
      const b = ADMIN_STATE.banners.find(x => x.slug === req.key);
      if (b) b.active = req.active;
    }
    return { ok: true };
  },
  adminUploadImage(req) {
    admin(req);
    if (!req.file || !req.file.data) throw new Error('Empty file.');
    return { ok: true, url: 'assets/products/B2BRSMON-0013.webp', file_id: 'mock' };
  },
  adminSaveBanner(req) {
    admin(req);
    const b = req.banner;
    if (!b.slug) throw new Error('Banner slug is required.');
    const hit = ADMIN_STATE.banners.find(x => x.slug === b.slug);
    if (hit) Object.assign(hit, b); else ADMIN_STATE.banners.push({ ...b });
    ADMIN_STATE.banners.sort((x, y) => x.sort_order - y.sort_order);
    return { ok: true };
  },
  adminDeleteBanner(req) {
    admin(req);
    ADMIN_STATE.banners = ADMIN_STATE.banners.filter(b => b.slug !== req.slug);
    return { ok: true };
  },
  adminSaveSettings(req) {
    admin(req);
    Object.assign(ADMIN_STATE.settings, req.settings);
    return { ok: true, settings: ADMIN_STATE.settings };
  },
  adminPublish(req) {
    admin(req);
    ADMIN_STATE.published_at = stamp();
    const live = catalog.products.filter(p => !ADMIN_STATE.hidden.has(p.sku));
    return { ok: true, published_at: ADMIN_STATE.published_at,
             products: live.length, banners: ADMIN_STATE.banners.filter(b => b.active).length,
             note: 'GitHub Pages takes a minute or two to rebuild.' };
  },

  /* Test-only: stands in for the approver clicking the emailed link. */
  _decide(req) {
    const o = orders[req.order_id];
    if (!o) throw new Error('Order not found.');
    if (o.status !== 'Pending Approval') throw new Error('Already decided.');
    o.status = req.act === 'approve' ? 'Approved' : 'Rejected';
    o.decided_by = req.who;
    o.decided_at = stamp();
    o.rejection_reason = req.act === 'reject' ? (req.reason || '') : '';
    return { ok: true, status: o.status };
  },
};

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.txt': 'text/plain',
};

http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let out;
      try {
        const p = JSON.parse(body);
        if (p.token !== API_TOKEN) throw new Error('Unauthorised.');
        const h = ROUTES[p.fn];
        if (!h) throw new Error('Unknown function: ' + p.fn);
        out = h(p);
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.url.startsWith('/?fn=meta')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ROUTES.meta()));
    return;
  }

  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(8900, () => console.log('mock api + site on http://localhost:8900'));
