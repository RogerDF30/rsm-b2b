/* Admin console. Loaded only by admin.html; app.js provides el/money/api. */

let PASS = '';
let ORDERS = [], ORDER_FILTER = 'All';
let CAT = null;            // { products, categories, banners, settings, published_at }
let USERS = [], DEPTS = [], USERS_LOADED = false;
let TAB = 'orders';
let PROD_FILTER = { q: '', cat: 'All', hidden: 'all' };

/* ------------------------------------------------------------------ boot */

async function bootAdmin() {
  await Catalog.load();
  mount();
  PASS = sessionStorage.getItem('rsm_admin') || '';
  PASS ? loadAll() : gate();
}

function gate(msg) {
  document.getElementById('gate').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  if (msg) toast(msg, 'error');
  document.getElementById('gateForm').onsubmit = e => {
    e.preventDefault();
    PASS = document.getElementById('apass').value;
    sessionStorage.setItem('rsm_admin', PASS);
    loadAll();
  };
}

async function loadAll() {
  try {
    /* Two calls, not three. Apps Script serialises requests from one user and
       adminCatalog alone takes 15 seconds, so a third parallel call at unlock
       was enough to make the browser give up with "Failed to fetch". The
       roster is fetched when the Users tab is first opened instead. */
    const [o, c] = await Promise.all([
      api('adminList', { admin_pass: PASS }),
      api('adminCatalog', { admin_pass: PASS }),
    ]);
    ORDERS = o.orders;
    CAT = c;
    document.getElementById('gate').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    paint();
  } catch (err) {
    sessionStorage.removeItem('rsm_admin');
    PASS = '';
    gate(err.message);
  }
}

/* ----------------------------------------------------------------- chrome */

function paint() {
  const nav = document.getElementById('adminTabs');
  nav.textContent = '';
  [['orders', `Orders (${ORDERS.length})`],
   ['catalogue', `Catalogue (${CAT.products.length})`],
   ['banners', `Banners (${CAT.banners.length})`],
   ['users', USERS_LOADED ? `Users (${USERS.length})` : 'Users'],
   ['appearance', 'Appearance']].forEach(([k, label]) =>
    nav.append(el('button', {
      class: 'chip' + (TAB === k ? ' on' : ''),
      onclick: () => { TAB = k; paint(); },
    }, label)));

  const host = document.getElementById('panel');
  host.textContent = '';
  ({ orders: paintOrders, catalogue: paintCatalogue, banners: paintBanners,
     users: paintUsers, appearance: paintAppearance })[TAB](host);

  const pub = document.getElementById('publishBar');
  pub.textContent = '';
  pub.append(
    el('span', { class: 'small muted' },
      CAT.published_at ? 'Last published ' + CAT.published_at : 'Never published'),
    el('button', { class: 'btn btn-sm', onclick: publish }, 'Publish to site'));
}

/* ----------------------------------------------------------------- orders */

function paintOrders(host) {
  const counts = { All: ORDERS.length };
  for (const o of ORDERS) counts[o.status] = (counts[o.status] || 0) + 1;

  const filters = el('div', { class: 'filters' });
  for (const k of ['All', 'Pending Approval', 'Approved', 'Rejected', 'Closed']) {
    filters.append(el('button', {
      class: 'chip' + (ORDER_FILTER === k ? ' on' : ''),
      onclick: () => { ORDER_FILTER = k; paint(); },
    }, `${k} (${counts[k] || 0})`));
  }

  const list = ORDER_FILTER === 'All' ? ORDERS : ORDERS.filter(o => o.status === ORDER_FILTER);
  host.append(filters,
    el('div', { class: 'row-between', style: 'margin-bottom:12px' },
      el('span', { class: 'small muted' }, `${list.length} shown`),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost btn-sm', onclick: exportCsv }, 'Export CSV'),
        el('button', { class: 'btn btn-sm', onclick: raiseOrder }, 'Raise order'))),
    el('div', { class: 'panel', style: 'padding:0;overflow-x:auto' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Order'), el('th', {}, 'Requester'), el('th', {}, 'LOB'),
          el('th', {}, 'Event'), el('th', { class: 'num' }, 'Items'),
          el('th', { class: 'num' }, 'Total'), el('th', {}, 'Status'), el('th', {}, ''))),
        el('tbody', {}, list.map(o => el('tr', {},
          el('td', {}, el('strong', {}, o.order_id),
            el('div', { class: 'small muted' }, o.created_at)),
          el('td', {}, o.requester_name,
            el('div', { class: 'small muted' }, o.requester_email)),
          el('td', {}, o.lob),
          el('td', {}, o.event_date),
          el('td', { class: 'num' }, o.line_count),
          el('td', { class: 'num mono' }, money(o.grand_total)),
          el('td', {}, el('span', { class: 'status ' + o.status.split(' ')[0].toLowerCase() }, o.status)),
          el('td', { class: 'right' },
            el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openOrder(o.order_id) }, 'Open'))))))));
  if (!list.length) host.append(el('div', { class: 'empty' }, el('h2', {}, 'No orders')));
}

async function openOrder(id) {
  const r = await api('adminOrder', { admin_pass: PASS, order_id: id });
  const o = r.order;
  drawer(el('div', {},
    drawerHead(o.order_id, el('span', { class: 'status ' + o.status.split(' ')[0].toLowerCase() }, o.status)),
    kvTable([
      ['Requester', `${o.requester_name} (${o.requester_email})`],
      ['LOB', o.lob], ['Approver', o.lob_approver || '—'],
      ['Event date', o.event_date], ['Purpose', o.purpose],
      ['Ship to', `${o.ship_name}, ${o.ship_street}, ${o.ship_city} ${o.ship_state || ''} ${o.ship_pincode}`],
      ['Bill to', `${o.bill_name || o.ship_name}, ${o.bill_street || o.ship_street}, ${o.bill_city || o.ship_city} ${o.bill_pincode || o.ship_pincode}`],
      ['Decided by', o.decided_by || '—'], ['Decided at', o.decided_at || '—'],
      ['Rejection reason', o.rejection_reason || '—'],
    ]),
    el('h3', { style: 'margin-top:20px' }, 'Items'),
    el('table', { class: 'tbl' }, el('tbody', {}, r.lines.map(l => el('tr', {},
      el('td', {}, l.product_name, el('div', { class: 'small muted' }, l.variant_sku)),
      el('td', {}, l.size || '—'),
      el('td', { class: 'num' }, qty(l.qty)),
      el('td', { class: 'num mono' }, money(l.line_total_with_tax)))))),
    r.files.length ? el('div', {},
      el('h3', { style: 'margin-top:20px' }, 'Evidence'),
      r.files.map(f => el('div', { class: 'file-row' },
        el('a', { class: 'grow', href: f.drive_url, target: '_blank' }, f.filename)))) : null,
    el('h3', { style: 'margin-top:20px' }, 'Actions'),
    el('div', { class: 'row', style: 'flex-wrap:wrap' },
      o.status === 'Pending Approval'
        ? el('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
            await api('adminResend', { admin_pass: PASS, order_id: o.order_id });
            toast('Approval email resent.');
          } }, 'Resend approval email') : null,
      o.status === 'Approved'
        ? el('button', { class: 'btn btn-sm', onclick: () =>
            document.getElementById('closeBox').classList.remove('hidden') }, 'Close with tracking')
        : null),
    o.status === 'Approved' ? el('div', { id: 'closeBox', class: 'hidden', style: 'margin-top:14px' },
      el('div', { class: 'form-grid' },
        field('Courier', el('input', { type: 'text', id: 'courier' })),
        field('Tracking number', el('input', { type: 'text', id: 'trackno' })),
        field('Tracking URL', el('input', { type: 'text', id: 'trackurl' }), true)),
      el('button', { class: 'btn', onclick: async () => {
        await api('closeOrder', {
          admin_pass: PASS, order_id: o.order_id,
          courier: val('courier'), tracking_no: val('trackno'), tracking_url: val('trackurl'),
        });
        toast('Order closed. Requester notified.');
        closeDrawer(); loadAll();
      } }, 'Mark closed and notify')) : null));
}

/* -------------------------------------------------------------- catalogue */

function paintCatalogue(host) {
  const cats = ['All', ...new Set(CAT.products.map(p => p.category))];
  const f = el('div', { class: 'filters' },
    el('input', {
      type: 'text', placeholder: 'Search name or SKU', value: PROD_FILTER.q,
      style: 'max-width:240px',
      oninput: e => { PROD_FILTER.q = e.target.value; repaintProducts(); },
    }),
    ...cats.map(c => el('button', {
      class: 'chip' + (PROD_FILTER.cat === c ? ' on' : ''),
      onclick: () => { PROD_FILTER.cat = c; paint(); },
    }, c)),
    el('button', {
      class: 'chip' + (PROD_FILTER.hidden === 'hidden' ? ' on' : ''),
      onclick: () => {
        PROD_FILTER.hidden = PROD_FILTER.hidden === 'hidden' ? 'all' : 'hidden';
        paint();
      },
    }, 'Hidden only'));

  host.append(f,
    el('div', { class: 'row-between', style: 'margin-bottom:12px' },
      el('span', { class: 'small muted', id: 'prodCount' }, ''),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-ghost btn-sm', id: 'autoRelate',
          onclick: autoRelate }, 'Auto-map related'),
        el('button', { class: 'btn btn-sm', onclick: () => editProduct(null) }, 'Add product'))),
    el('div', { class: 'panel', style: 'padding:0;overflow-x:auto' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', {}, ''), el('th', {}, 'Product'), el('th', {}, 'Category'),
          el('th', { class: 'num' }, 'MOQ'), el('th', { class: 'num' }, 'From'),
          el('th', {}, 'Sizes'), el('th', {}, 'Related'), el('th', {}, 'Visible'), el('th', {}, ''))),
        el('tbody', { id: 'prodRows' }))));
  repaintProducts();
}

function visibleProducts() {
  const q = PROD_FILTER.q.trim().toLowerCase();
  return CAT.products.filter(p => {
    if (PROD_FILTER.cat !== 'All' && p.category !== PROD_FILTER.cat) return false;
    if (PROD_FILTER.hidden === 'hidden' && p.active) return false;
    if (q && !(`${p.name} ${p.sku}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function repaintProducts() {
  const rows = document.getElementById('prodRows');
  if (!rows) return;
  const list = visibleProducts();
  document.getElementById('prodCount').textContent =
    `${list.length} of ${CAT.products.length} products`;
  rows.textContent = '';
  rows.append(...list.map(p => el('tr', { style: p.active ? '' : 'opacity:.5' },
    el('td', {}, p.image
      ? el('img', { class: 'thumb', src: p.image, alt: '' })
      : el('div', { class: 'thumb' })),
    el('td', {}, el('strong', {}, p.name),
      el('div', { class: 'small muted' }, p.sku)),
    el('td', {}, p.category, el('div', { class: 'small muted' }, p.subcategory)),
    el('td', { class: 'num' }, qty(p.moq)),
    el('td', { class: 'num mono' }, p.tiers.length ? money(p.tiers[0].unit_price) : '—'),
    el('td', { class: 'small' }, p.sizes.length ? p.sizes.join(' ') : '—'),
    el('td', { class: 'num small' }, p.related_all.length || '—'),
    el('td', {}, toggle(p.active, async on => {
      await api('adminToggle', { admin_pass: PASS, kind: 'product', key: p.sku, active: on });
      p.active = on; repaintProducts();
    })),
    el('td', { class: 'right' },
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editProduct(p) }, 'Edit')))));
}

function editProduct(p) {
  const isNew = !p;
  p = p || {
    sku: '', name: '', category: 'Apparel', subcategory: '', description: '',
    moq: 25, gst_rate: 18, image: '', sizes: [], related_skus: [], active: true,
    tiers: [{ min_qty: 25, max_qty: 49, unit_price: 0, gst_rate: '' }],
  };
  const draft = JSON.parse(JSON.stringify(p));

  const tierBox = el('div', { id: 'tierBox' });
  const paintTiers = () => {
    tierBox.textContent = '';
    draft.tiers.forEach((t, i) => tierBox.append(
      el('div', { class: 'row', style: 'margin-bottom:6px' },
        el('input', { type: 'number', min: '1', value: t.min_qty, style: 'width:90px',
          oninput: e => { t.min_qty = Number(e.target.value); } }),
        el('span', { class: 'small muted' }, 'to'),
        el('input', { type: 'number', value: t.max_qty ?? '', placeholder: 'open',
          style: 'width:90px',
          oninput: e => { t.max_qty = e.target.value === '' ? '' : Number(e.target.value); } }),
        el('span', { class: 'small muted' }, '@ ₹'),
        el('input', { type: 'number', min: '0', step: '0.01', value: t.unit_price,
          style: 'width:110px',
          oninput: e => { t.unit_price = Number(e.target.value); } }),
        /* Blank inherits the product's rate. Only a tier that crosses a slab
           boundary — apparel either side of ₹2,500 — needs its own. */
        el('span', { class: 'small muted' }, 'GST'),
        el('input', { type: 'number', min: '0', step: '0.01', style: 'width:80px',
          value: t.gst_rate ?? '', placeholder: String(draft.gst_rate ?? ''),
          title: 'Leave blank to use the product rate',
          oninput: e => { t.gst_rate = e.target.value === '' ? '' : Number(e.target.value); } }),
        el('span', { class: 'small muted' }, '%'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: () => { draft.tiers.splice(i, 1); paintTiers(); } }, 'Remove'))));
    tierBox.append(el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm',
      onclick: () => {
        const last = draft.tiers[draft.tiers.length - 1];
        draft.tiers.push({ min_qty: last ? (last.max_qty || last.min_qty) + 1 : draft.moq,
                           max_qty: '', unit_price: last ? last.unit_price : 0,
                           gst_rate: last ? last.gst_rate ?? '' : '' });
        paintTiers();
      },
    }, 'Add tier'));
  };
  paintTiers();

  const imgPreview = el('img', {
    src: draft.image || '', alt: '',
    style: 'max-width:120px;max-height:120px;object-fit:contain;background:var(--off);border-radius:8px',
  });

  drawer(el('div', {},
    drawerHead(isNew ? 'Add product' : draft.sku),
    el('div', { class: 'form-grid' },
      field('SKU', el('input', { type: 'text', id: 'f_sku', value: draft.sku,
        readonly: isNew ? null : 'readonly',
        oninput: e => { draft.sku = e.target.value.toUpperCase(); } })),
      field('Name', el('input', { type: 'text', id: 'f_name', value: draft.name,
        oninput: e => { draft.name = e.target.value; } })),
      field('Category', selectOf(
        [...new Set(CAT.categories.map(c => c.parent_slug))], draft.category,
        v => { draft.category = v; })),
      field('Subcategory', el('input', { type: 'text', value: draft.subcategory,
        list: 'subcats', oninput: e => { draft.subcategory = e.target.value; } })),
      field('MOQ', el('input', { type: 'number', min: '1', value: draft.moq,
        oninput: e => { draft.moq = Number(e.target.value); } })),
      field('GST %', el('input', { type: 'number', min: '0', step: '0.01', value: draft.gst_rate,
        oninput: e => { draft.gst_rate = Number(e.target.value); paintTiers(); } }),
        false),
      field('Description', el('textarea', {
        oninput: e => { draft.description = e.target.value; },
      }, draft.description || ''), true),
      field('Sizes, space separated. Leave blank for a product with no sizes',
        el('input', { type: 'text', value: draft.sizes.join(' '),
          placeholder: 'XS S M L XL 2XL',
          oninput: e => { draft.sizes = e.target.value.split(/\s+/).filter(Boolean); } }), true)),

    el('datalist', { id: 'subcats' },
      [...new Set(CAT.categories.map(c => c.slug))].map(s => el('option', { value: s }))),

    el('h3', { style: 'margin-top:18px' }, 'Image'),
    el('div', { class: 'row' }, imgPreview,
      el('div', { class: 'grow' },
        el('input', { type: 'file', accept: 'image/*', onchange: async e => {
          const file = e.target.files[0];
          if (!file) return;
          toast('Uploading…');
          const data = await toBase64(file);
          try {
            const r = await api('adminUploadImage', {
              admin_pass: PASS,
              file: { name: file.name, mime: file.type, data },
            });
            draft.image = r.url;
            imgPreview.src = r.url;
            toast('Image uploaded.');
          } catch (err) { toast(err.message, 'error'); }
        } }),
        el('input', { type: 'text', value: draft.image, placeholder: 'or paste an image URL',
          style: 'margin-top:8px',
          oninput: e => { draft.image = e.target.value; imgPreview.src = e.target.value; } }))),

    el('h3', { style: 'margin-top:18px' }, 'Price tiers'),
    el('div', { class: 'small muted', style: 'margin-bottom:8px' },
      'The first tier must start at the MOQ. Leave the upper bound blank on the last one.'),
    tierBox,

    el('h3', { style: 'margin-top:18px' }, 'Related products'),
    el('div', { class: 'small muted', style: 'margin-bottom:8px' },
      'Shown together on the product page. Useful for kits.'),
    relatedPicker(draft),

    el('div', { class: 'row', style: 'margin-top:22px;flex-wrap:wrap' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('adminSaveProduct', { admin_pass: PASS, product: draft });
          toast(isNew ? 'Product added.' : 'Product saved.');
          closeDrawer(); await loadAll();
        } catch (err) { toast(err.message, 'error'); }
      } }, isNew ? 'Add product' : 'Save changes'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'),
      isNew ? null : el('button', {
        class: 'btn btn-ghost', style: 'margin-left:auto;color:#D93025;border-color:#F0B6B1',
        onclick: () => confirmDelete(draft.sku),
      }, 'Delete'))));
}

/**
 * Fill in related products across the whole catalogue: colour variants first,
 * then a top-up from the same subcategory. Anything picked by hand is kept, so
 * this is safe to re-run after adding products.
 */
async function autoRelate() {
  const btn = document.getElementById('autoRelate');
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Mapping…';
  try {
    const r = await api('adminAutoRelate', { admin_pass: PASS });
    toast(`${r.variant_links} variant links, ${r.topped_up} suggested. ` +
          `${r.with_related} of ${r.products} products now show related items.`);
    await loadAll();
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = was;
  }
}

/**
 * Related products: a thumbnail strip of what is attached, plus a modal that
 * shows the whole catalogue as a searchable image grid you can multi-select.
 * Choices are held in a working copy so Cancel really cancels.
 */
function relatedPicker(draft) {
  const box = el('div', { id: 'relatedPicker' });
  const grid = el('div', { class: 'rel-strip', id: 'relSelected' });
  const count = el('span', { class: 'small muted', id: 'relCount' });

  const repaint = () => {
    count.textContent = draft.related_skus.length + ' selected';
    grid.textContent = '';
    if (!draft.related_skus.length) {
      grid.append(el('div', { class: 'small muted' }, 'None selected'));
      return;
    }
    draft.related_skus.forEach((sku, i) => {
      const p = CAT.products.find(x => x.sku === sku);
      grid.append(el('div', { class: 'rel-tile', 'data-sku': sku },
        el('img', { src: (p && p.image) || '', alt: (p && p.name) || sku, loading: 'lazy' }),
        el('div', { class: 'rel-name' }, (p && p.name) || sku),
        el('div', { class: 'rel-sku' }, sku),
        el('button', {
          type: 'button', class: 'rel-x', title: 'Remove',
          onclick: () => { draft.related_skus.splice(i, 1); repaint(); },
        }, '✕')));
    });
  };
  repaint();

  box.append(grid, el('div', { class: 'row', style: 'margin-top:10px' },
    el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm', id: 'relChoose',
      onclick: () => relatedModal(draft, repaint),
    }, 'Choose related products'),
    count));
  return box;
}

/** Full-catalogue image grid, multi-select, applied only on Done. */
function relatedModal(draft, onDone) {
  const pool = CAT.products.filter(p => p.active && p.sku !== draft.sku);
  const chosen = new Set(draft.related_skus);
  let term = '';
  let cat = '';

  const grid = el('div', { class: 'pick-grid', id: 'pickGrid' });
  const countLbl = el('span', { class: 'small muted', id: 'pickCount' });

  const paint = () => {
    const t = term.trim().toLowerCase();
    const list = pool.filter(p =>
      (!cat || p.category === cat) &&
      (!t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t)));

    grid.textContent = '';
    if (!list.length) {
      grid.append(el('div', { class: 'small muted' }, 'No products match.'));
    }
    list.forEach(p => {
      const on = chosen.has(p.sku);
      grid.append(el('button', {
        type: 'button',
        class: 'pick-tile' + (on ? ' on' : ''),
        'data-sku': p.sku,
        onclick: e => {
          const tile = e.currentTarget;
          if (chosen.has(p.sku)) { chosen.delete(p.sku); tile.classList.remove('on'); }
          else { chosen.add(p.sku); tile.classList.add('on'); }
          countLbl.textContent = chosen.size + ' selected';
        },
      },
        el('span', { class: 'pick-mark' }, '✓'),
        el('img', { src: p.image || '', alt: p.name, loading: 'lazy' }),
        el('span', { class: 'pick-name' }, p.name),
        el('span', { class: 'pick-sku' }, p.sku)));
    });
    countLbl.textContent = chosen.size + ' selected';
  };

  const search = el('input', {
    type: 'search', id: 'pickSearch', placeholder: 'Search name or SKU',
    oninput: e => { term = e.target.value; paint(); },
  });

  const catSel = selectOf(
    [...new Set(pool.map(p => p.category))].filter(Boolean).sort(), '',
    v => { cat = v; paint(); }, 'All categories');
  catSel.id = 'pickCat';

  paint();

  const modal = el('div', { class: 'modal', id: 'relModal',
    onclick: e => { if (e.target.id === 'relModal') close(); } },
    el('div', { class: 'modal-inner' },
      el('div', { class: 'row-between', style: 'margin-bottom:12px' },
        el('h3', { style: 'margin:0' }, 'Related products'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => close() }, 'Close')),
      el('div', { class: 'row', style: 'gap:10px;margin-bottom:12px' },
        el('div', { class: 'grow' }, search), catSel),
      grid,
      el('div', { class: 'row-between', style: 'margin-top:14px' },
        countLbl,
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm',
            onclick: () => close() }, 'Cancel'),
          el('button', { type: 'button', class: 'btn btn-sm', id: 'pickDone',
            onclick: () => {
              // keep the existing order, append newcomers in catalogue order
              const kept = draft.related_skus.filter(s => chosen.has(s));
              pool.forEach(p => {
                if (chosen.has(p.sku) && !kept.includes(p.sku)) kept.push(p.sku);
              });
              draft.related_skus.length = 0;
              kept.forEach(s => draft.related_skus.push(s));
              close();
              onDone();
            } }, 'Done')))));

  function close() {
    document.removeEventListener('keydown', esc);
    modal.remove();
  }
  function esc(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', esc);

  document.body.appendChild(modal);
  search.focus();
}

function confirmDelete(sku) {
  drawer(el('div', {},
    drawerHead('Delete ' + sku),
    el('div', { class: 'note' },
      el('strong', {}, 'This hides the product, it does not erase it. '),
      'The row stays in the Sheet so past orders still resolve, and you can ' +
      'switch it back on from the Hidden filter at any time.'),
    el('label', { class: 'field', style: 'margin-top:16px' },
      el('span', {}, 'Type ' + sku + ' to confirm'),
      el('input', { type: 'text', id: 'delConfirm' })),
    el('div', { class: 'row' },
      el('button', { class: 'btn', style: 'background:#D93025', onclick: async () => {
        try {
          await api('adminDeleteProduct', {
            admin_pass: PASS, sku, confirm: val('delConfirm'),
          });
          toast(sku + ' hidden.');
          closeDrawer(); await loadAll();
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Delete product'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'))));
}

/* ---------------------------------------------------------------- banners */

function paintBanners(host) {
  host.append(
    el('div', { class: 'row-between', style: 'margin-bottom:12px' },
      el('span', { class: 'small muted' },
        'Shown on the homepage, in sort order. The first one is the large hero.'),
      el('button', { class: 'btn btn-sm', onclick: () => editBanner(null) }, 'Add banner')),
    el('div', { class: 'stack' }, CAT.banners.map(b => el('div', { class: 'panel' },
      el('div', { class: 'row-between', style: 'align-items:flex-start' },
        el('div', { class: 'row', style: 'align-items:flex-start' },
          b.image_url
            ? el('img', { src: b.image_url, alt: '',
                style: 'width:150px;height:70px;object-fit:cover;border-radius:8px;background:var(--off)' })
            : el('div', { style: 'width:150px;height:70px;border-radius:8px;background:var(--off)' }),
          el('div', {},
            el('strong', {}, b.title || b.slug),
            el('div', { class: 'small muted' }, b.subtitle || ''),
            el('div', { class: 'small muted' }, b.slug + ' · order ' + b.sort_order))),
        el('div', { class: 'row' },
          toggle(b.active, async on => {
            await api('adminToggle', { admin_pass: PASS, kind: 'banner', key: b.slug, active: on });
            b.active = on;
          }),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => editBanner(b) }, 'Edit')))))));
  if (!CAT.banners.length) host.append(el('div', { class: 'empty' }, el('h2', {}, 'No banners yet')));
}

function editBanner(b) {
  const isNew = !b;
  const draft = Object.assign(
    { slug: '', title: '', subtitle: '', image_url: '', link_url: '', sort_order: 0, active: true },
    b || {});
  const prev = el('img', { src: draft.image_url || '', alt: '',
    style: 'max-width:100%;max-height:150px;object-fit:cover;border-radius:8px;background:var(--off)' });

  drawer(el('div', {},
    drawerHead(isNew ? 'Add banner' : draft.slug),
    el('div', { class: 'form-grid' },
      field('Slug, a short id', el('input', { type: 'text', value: draft.slug,
        readonly: isNew ? null : 'readonly',
        oninput: e => { draft.slug = e.target.value.trim(); } })),
      field('Sort order', el('input', { type: 'number', value: draft.sort_order,
        oninput: e => { draft.sort_order = Number(e.target.value); } })),
      field('Title', el('input', { type: 'text', value: draft.title,
        oninput: e => { draft.title = e.target.value; } }), true),
      field('Subtitle', el('input', { type: 'text', value: draft.subtitle,
        oninput: e => { draft.subtitle = e.target.value; } }), true),
      field('Link, e.g. category.html?cat=Apparel', el('input', { type: 'text', value: draft.link_url,
        oninput: e => { draft.link_url = e.target.value; } }), true)),
    el('h3', { style: 'margin-top:14px' }, 'Image'),
    prev,
    el('input', { type: 'file', accept: 'image/*', style: 'margin-top:10px', onchange: async e => {
      const file = e.target.files[0];
      if (!file) return;
      toast('Uploading…');
      try {
        const r = await api('adminUploadImage', {
          admin_pass: PASS,
          file: { name: file.name, mime: file.type, data: await toBase64(file) },
        });
        draft.image_url = r.url; prev.src = r.url; toast('Image uploaded.');
      } catch (err) { toast(err.message, 'error'); }
    } }),
    el('input', { type: 'text', value: draft.image_url, placeholder: 'or paste an image URL',
      style: 'margin-top:8px',
      oninput: e => { draft.image_url = e.target.value; prev.src = e.target.value; } }),
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('adminSaveBanner', { admin_pass: PASS, banner: draft });
          toast('Banner saved.'); closeDrawer(); await loadAll();
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Save banner'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'),
      isNew ? null : el('button', {
        class: 'btn btn-ghost', style: 'margin-left:auto;color:#D93025;border-color:#F0B6B1',
        onclick: async () => {
          await api('adminDeleteBanner', { admin_pass: PASS, slug: draft.slug });
          toast('Banner removed.'); closeDrawer(); await loadAll();
        },
      }, 'Remove'))));
}

/* ------------------------------------------------------------------ users */

function paintUsers(host) {
  if (!USERS_LOADED) {
    host.append(el('div', { class: 'panel' }, el('span', { class: 'muted' }, 'Loading users…')));
    api('adminUsers', { admin_pass: PASS })
      .then(u => { USERS = u.users; DEPTS = u.departments; USERS_LOADED = true; paint(); })
      .catch(err => toast(err.message, 'error'));
    return;
  }

  host.append(
    el('div', { class: 'row-between', style: 'margin-bottom:12px' },
      el('span', { class: 'small muted' },
        'People who can sign in and raise orders. Deactivating one blocks the next sign-in.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-sm btn-ghost', onclick: importUsers }, 'Import list'),
        el('button', { class: 'btn btn-sm', onclick: addUser }, 'Add user'))),
    el('div', { class: 'stack' }, USERS.map(u => el('div', { class: 'panel' },
      el('div', { class: 'row-between', style: 'align-items:flex-start' },
        el('div', {},
          el('strong', {}, u.full_name || u.email),
          el('div', { class: 'small muted' }, u.email),
          el('div', { class: 'small muted' },
            [u.lob || 'No department',
             u.last_login ? 'last signed in ' + u.last_login : 'never signed in'].join(' \u00b7 '))),
        toggle(u.active, async on => {
          await api('adminToggle', { admin_pass: PASS, kind: 'user', key: u.email, active: on });
          u.active = on;
        }, ['Active', 'Inactive']))))));
  if (!USERS.length) host.append(el('div', { class: 'empty' }, el('h2', {}, 'No users yet')));
}

function addUser() {
  const draft = { email: '', full_name: '', lob: '', password: '' };

  drawer(el('div', {},
    drawerHead('Add user'),
    el('div', { class: 'form-grid' },
      field('Email', el('input', { type: 'email', autocomplete: 'off',
        oninput: e => { draft.email = e.target.value.trim(); } })),
      field('Full name', el('input', { type: 'text',
        oninput: e => { draft.full_name = e.target.value; } })),
      field('Department', selectOf(DEPTS, '', v => { draft.lob = v; }, 'Not set')),
      field('First password, at least 10 characters', el('input', {
        type: 'text', autocomplete: 'off',
        oninput: e => { draft.password = e.target.value; } }))),
    el('div', { class: 'small muted', style: 'margin-top:10px' },
      'Give the password to the user yourself. They can change it from the ' +
      'sign-in page with Forgot password.'),
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', { class: 'btn', onclick: async () => {
        try {
          await api('adminAddUser', { admin_pass: PASS, user: draft });
          toast(draft.email + ' added.');
          closeDrawer(); await loadAll();
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Add user'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'))));
}

/**
 * Bulk import, for carrying a roster over from the old store.
 *
 * Paste either the Magento customer export or a plain "email, name" list. The
 * password is typed here and posted straight to the backend; it is never put
 * in a file and never leaves this form. Nothing is emailed to the people
 * being added, and an address that already has an account is skipped rather
 * than overwritten, so the same list can be pasted twice without resetting
 * anybody's password.
 */
function importUsers() {
  const state = { text: '', password: '', lob: '' };
  const preview = el('div', { class: 'small muted' }, 'Nothing pasted yet.');

  function parse(text) {
    const rows = [], seen = {};
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const cells = line.split(',').map(c => c.trim());
      // Magento export: header row first, email in column 1, names in 9 and 12.
      if (i === 0 && /^email\b/i.test(cells[0])) return;
      const email = (cells[0] || '').toLowerCase();
      if (email.indexOf('@') < 1) return;
      if (seen[email]) return;
      seen[email] = 1;
      let name = '';
      if (cells.length >= 12) name = [cells[8], cells[11]].filter(Boolean).join(' ').trim();
      if (!name) name = cells.slice(1).filter(Boolean).join(' ').trim();
      if (!name) name = email.split('@')[0].replace(/[._]+/g, ' ');
      rows.push({ email: email, full_name: name, lob: state.lob });
    });
    return rows;
  }

  function refresh() {
    const rows = parse(state.text);
    preview.textContent = rows.length
      ? rows.length + ' account' + (rows.length === 1 ? '' : 's') + ' found. First: ' +
        rows[0].full_name + ' (' + rows[0].email + ')'
      : 'Nothing recognised. Each line needs an email address.';
  }

  drawer(el('div', {},
    drawerHead('Import users'),
    el('div', { class: 'form-grid' },
      field('Paste the list', el('textarea', { rows: 10, spellcheck: 'false',
        placeholder: 'email,firstname,lastname  or  a Magento customer export',
        oninput: e => { state.text = e.target.value; refresh(); } }), true),
      field('Department for everyone in this list',
        selectOf(DEPTS, '', v => { state.lob = v; refresh(); }, 'Not set')),
      field('First password, at least 7 characters', el('input', {
        type: 'text', autocomplete: 'off',
        oninput: e => { state.password = e.target.value; } }))),
    el('div', { style: 'margin-top:10px' }, preview),
    el('div', { class: 'small muted', style: 'margin-top:10px' },
      'Everyone gets the same first password and no email is sent. Give it to ' +
      'them yourself, and ask them to change it from the sign-in page with ' +
      'Forgot password. Addresses that already have an account are skipped.'),
    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', { class: 'btn', onclick: async ev => {
        const rows = parse(state.text);
        if (!rows.length) return toast('Nothing to import.', 'error');
        if (state.password.length < 7) return toast('Password must be at least 7 characters.', 'error');
        const btn = ev.target;
        btn.disabled = true; btn.textContent = 'Importing…';
        try {
          const r = await api('adminBulkUsers',
            { admin_pass: PASS, users: rows, password: state.password });
          const bits = [r.added.length + ' added'];
          if (r.skipped.length) bits.push(r.skipped.length + ' already existed');
          if (r.failed.length) bits.push(r.failed.length + ' failed');
          toast(bits.join(', ') + '.');
          closeDrawer(); USERS_LOADED = false; await loadAll();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Import';
        }
      } }, 'Import'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'))));
}

/* ------------------------------------------------------------- appearance */

function paintAppearance(host) {
  const s = Object.assign({}, CAT.settings);
  const rows = [
    ['logo_url', 'Header logo URL', 'Cerulean mark, shown on light backgrounds'],
    ['logo_white_url', 'Hero logo URL', 'White mark, shown on the dark hero'],
    ['hero_title', 'Hero title', ''],
    ['hero_subtitle', 'Hero subtitle', ''],
    ['footer_note', 'Footer note', ''],
    ['shipping_pct', 'Shipping & handling (%)',
      'Charged on the order value before GST, on every order, admin-raised or not, ' +
      'and itself taxed at the highest GST rate on that order. Blank falls back to 8%. ' +
      'Orders use the new rate at once; publish to show it in the storefront cart.'],
  ];

  host.append(el('div', { class: 'panel', style: 'max-width:700px' },
    el('h2', {}, 'Site appearance'),
    ...rows.map(([k, label, note]) => {
      const input = el('input', { type: 'text', value: s[k] || '',
        oninput: e => { s[k] = e.target.value; } });
      const isLogo = k.indexOf('logo') === 0;
      const prev = isLogo ? el('img', { src: s[k] || '', alt: '',
        style: 'height:30px;margin-top:8px;' + (k === 'logo_white_url'
          ? 'background:var(--ink);padding:6px 10px;border-radius:6px' : '') }) : null;
      return el('label', { class: 'field' },
        el('span', {}, label),
        input,
        note ? el('span', { class: 'small muted' }, note) : null,
        isLogo ? el('input', { type: 'file', accept: 'image/*', style: 'margin-top:8px',
          onchange: async e => {
            const file = e.target.files[0];
            if (!file) return;
            toast('Uploading…');
            try {
              const r = await api('adminUploadImage', {
                admin_pass: PASS,
                file: { name: file.name, mime: file.type, data: await toBase64(file) },
              });
              s[k] = r.url; input.value = r.url; if (prev) prev.src = r.url;
              toast('Uploaded.');
            } catch (err) { toast(err.message, 'error'); }
          } }) : null,
        prev);
    }),
    el('button', { class: 'btn', onclick: async () => {
      try {
        const r = await api('adminSaveSettings', { admin_pass: PASS, settings: s });
        CAT.settings = r.settings;
        toast('Saved. Publish to push it live.');
      } catch (err) { toast(err.message, 'error'); }
    } }, 'Save appearance')));
}

/* ---------------------------------------------------------------- publish */

async function publish() {
  if (!confirm('Publish the catalogue and site settings to the live store?')) return;
  toast('Publishing…');
  try {
    const r = await api('adminPublish', { admin_pass: PASS });
    CAT.published_at = r.published_at;
    toast(`Published ${r.products} products and ${r.banners} banners. ${r.note}`);
    paint();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ----------------------------------------------------------------- shared */

function drawer(inner) {
  closeDrawer();
  document.body.append(el('div', {
    class: 'drawer', id: 'drawer',
    onclick: e => { if (e.target.id === 'drawer') closeDrawer(); },
  }, el('div', { class: 'drawer-inner' }, inner)));
}
function closeDrawer() { document.getElementById('drawer')?.remove(); }

function drawerHead(title, extra) {
  return el('div', { class: 'row-between', style: 'margin-bottom:14px' },
    el('div', { class: 'row' },
      el('h2', { style: 'border:0;padding:0;margin:0' }, title), extra || null),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: closeDrawer }, 'Close'));
}

function kvTable(pairs) {
  return el('table', { class: 'spec-table' }, el('tbody', {},
    pairs.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, String(v || '—'))))));
}

function field(label, input, full) {
  return el('label', { class: 'field' + (full ? ' full' : '') },
    el('span', {}, label), input);
}

function selectOf(values, current, onchange, blankLabel) {
  return el('select', { onchange: e => onchange(e.target.value) },
    blankLabel ? el('option', { value: '', selected: current ? null : 'selected' }, blankLabel) : null,
    ...values.map(v => el('option', { value: v, selected: v === current ? 'selected' : null }, v)));
}

/* An actual switch, because this sets a state rather than performing an
   action. role="switch" and aria-checked mean a screen reader says "on" or
   "off" rather than reading it as a button. */
function toggle(on, fn, labels) {
  const [onLabel, offLabel] = labels || ['Visible', 'Hidden'];
  const knob = el('span', { class: 'sw-knob' });
  const track = el('span', { class: 'sw-track' }, knob);
  const label = el('span', { class: 'sw-label' }, on ? onLabel : offLabel);

  const b = el('button', {
    type: 'button', class: 'sw' + (on ? ' on' : ''),
    role: 'switch', 'aria-checked': on ? 'true' : 'false',
    onclick: async () => {
      if (b.disabled) return;
      const next = !b.classList.contains('on');
      b.disabled = true;
      try {
        await fn(next);
        b.classList.toggle('on', next);
        b.setAttribute('aria-checked', next ? 'true' : 'false');
        label.textContent = next ? onLabel : offLabel;
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        b.disabled = false;
      }
    },
  }, track, label);
  return b;
}

const val = id => document.getElementById(id).value.trim();

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function exportCsv() {
  const cols = ['order_id', 'created_at', 'requester_name', 'requester_email', 'lob',
    'lob_approver', 'event_date', 'status', 'subtotal', 'tax_total', 'grand_total',
    'decided_by', 'decided_at', 'rejection_reason', 'courier', 'tracking_no'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...ORDERS.map(o => cols.map(c => esc(o[c])).join(','))].join('\n');
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: 'rsm-orders.csv',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}


/* ------------------------------------------------------- raise an order */

let DEPT_DETAILS = [], OFFICES = null;

/**
 * Raise an order for a client at a price agreed off the catalogue.
 *
 * This is checkout.html with one addition. Everything a requester fills in is
 * here in the same shape — the same department and approver pairing, the same
 * office address presets for shipping and billing, the same evidence drop,
 * the same below-MOQ warning — because an order raised here has to be the
 * same record as one raised by the client, or the two cannot be read side by
 * side. The addition is the price box: a requester's order is priced entirely
 * by the tier table with no way past it, and this is the only path that may
 * override it. Leave the box empty and the line charges the catalogue price.
 *
 * Price is per product, not per size, because every size of a product shares
 * one price everywhere else in the system.
 */
async function raiseOrder() {
  if (!USERS_LOADED) {
    toast('Loading the user list...');
    try {
      const u = await api('adminUsers', { admin_pass: PASS });
      USERS = u.users; DEPTS = u.departments;
      DEPT_DETAILS = u.department_details || DEPTS.map(lob => ({ lob, approver: '' }));
      USERS_LOADED = true;
    } catch (err) { return toast(err.message, 'error'); }
  }
  if (!DEPT_DETAILS.length) DEPT_DETAILS = DEPTS.map(lob => ({ lob, approver: '' }));

  /* Same static file checkout uses, so the office list cannot drift between
     the two forms. Absent, the address fields simply stay hand-typed. */
  if (OFFICES === null) {
    try { OFFICES = (await (await fetch('assets/offices.json')).json()).offices || []; }
    catch (err) { OFFICES = []; }
  }

  const people = USERS.filter(u => u.active);
  if (!people.length) return toast('No active accounts to raise an order for.', 'error');

  const products = CAT.products.filter(p => p.active)
    .slice().sort((a, b) => a.name.localeCompare(b.name));

  const draft = {
    requester_email: '', requester_name: '', requester_phone: '',
    lob: '', lob_approver: '', event_date: '', purpose: '', cost_centre: '',
    ship_name: '', ship_phone: '', ship_street: '', ship_city: '',
    ship_state: '', ship_pincode: '', ship_country: 'India',
    bill_name: '', bill_phone: '', bill_street: '', bill_city: '',
    bill_state: '', bill_pincode: '', bill_country: 'India',
  };
  let picks = [], uploads = [], search = '';
  let sameAsShip = true, approverAuto = false;
  let shipPreset = 'My saved address', billPreset = 'My saved address';
  let approveNow = false, notifyRequester = false;

  const whoHost = el('div', { class: 'form-grid' });
  const ctxHost = el('div', { class: 'form-grid' });
  const resultsHost = el('div', { class: 'stack', style: 'margin-top:10px' });
  const linesHost = el('div', { class: 'stack' });
  const fileHost = el('div', { style: 'margin-top:12px' });
  const shipHost = el('div', { class: 'form-grid' });
  const billBox = el('div', {});
  const summaryHost = el('div', {});

  const SAVED = 'My saved address', OTHER = 'Another address';
  const chosen = () => people.find(u => u.email === draft.requester_email);

  /* Pricing preview. Mirrors priceOrder() on the backend, which stays the
     authority: this only shows the admin what they are about to commit. */
  function quote() {
    const rows = [];
    let net = 0, tax = 0, listNet = 0, listTotal = 0;
    for (const pick of picks) {
      const p = products.find(x => x.sku === pick.sku);
      if (!p) continue;
      const qty = Object.values(pick.qty).reduce((a, n) => a + (Number(n) || 0), 0);
      const tier = pickTier(p.tiers, qty);
      const listUnit = tier ? tier.unit_price : p.base_price;
      const set = pick.price !== '' && isFinite(Number(pick.price)) && Number(pick.price) >= 0;
      const unit = set ? Number(pick.price) : listUnit;
      /* The tier's rate, not the product's: apparel changes slab with volume.
         A negotiated price does not re-pick the slab, matching the backend. */
      const gst = tierGst(tier, p);
      rows.push({ p, qty, listUnit, unit, gst, negotiated: set,
        belowMoq: qty > 0 && qty < Number(p.moq || 1) });
      if (!qty) continue;
      net += unit * qty;
      tax += unit * qty * gst / 100;
      listNet += listUnit * qty;
      listTotal += listUnit * qty * (1 + gst / 100);
    }
    /* Same rule as priceOrder() on the backend: a percentage of the goods
       value before GST, added after tax and not taxed itself. The catalogue
       comparison carries its own shipping, worked out on the catalogue
       subtotal, so the concession shown is the concession on the goods. */
    const pctRaw = Number(CAT.settings.shipping_pct);
    const pct = isFinite(pctRaw) && pctRaw >= 0 ? pctRaw : 8;
    const shipping = Math.round(net * pct) / 100;
    const listShipping = Math.round(listNet * pct) / 100;

    /* The fee carries GST at the highest rate actually charged on the order. */
    const shipGst = rows.reduce((m, r) => r.qty ? Math.max(m, r.gst) : m, 0);
    const shipTax = Math.round(shipping * shipGst) / 100;
    const listShipTax = Math.round(listShipping * shipGst) / 100;

    return { rows, net, tax, pct, shipping, shipGst, shipTax,
      total: net + tax + shipping + shipTax,
      listTotal: listTotal + listShipping + listShipTax };
  }

  const bind = k => el('input', { type: 'text', value: draft[k],
    oninput: e => { draft[k] = e.target.value; } });

  function paintWho() {
    whoHost.textContent = '';
    /* Free text with the known partners offered, exactly as checkout does:
       approvers change and cross-LOB sanctioning happens. The department's
       own partner fills in until it is typed over. */
    const approverList = el('datalist', { id: 'raiseApprovers' },
      DEPT_DETAILS.filter(d => d.approver)
        .map(d => el('option', { value: d.approver }, d.lob)));

    const fillApprover = () => {
      const hit = DEPT_DETAILS.find(d => d.lob === draft.lob);
      if (hit && hit.approver && (!draft.lob_approver || approverAuto)) {
        draft.lob_approver = hit.approver;
        approverAuto = true;
      }
    };

    whoHost.append(
      field('Client', selectOf(people.map(u => u.email), draft.requester_email, email => {
        const u = people.find(x => x.email === email);
        draft.requester_email = email;
        if (u) {
          draft.requester_name = u.full_name || '';
          draft.requester_phone = u.default_ship_phone || '';
          draft.lob = u.lob || draft.lob;
        }
        fillApprover();
        applyPreset('ship', shipPreset);
        applyPreset('bill', billPreset);
        paintWho(); paintShip(); paintBilling();
      }, 'Choose an account')),
      field('Full name', el('input', { type: 'text', value: draft.requester_name,
        oninput: e => { draft.requester_name = e.target.value; } })),
      field('Department / LOB', selectOf(DEPTS, draft.lob, v => {
        draft.lob = v; fillApprover(); paintWho();
      }, 'Select a department')),
      field('Contact number', el('input', { type: 'tel', value: draft.requester_phone,
        oninput: e => { draft.requester_phone = e.target.value; } })),
      field('Approver', el('div', {},
        el('input', { type: 'text', value: draft.lob_approver, list: 'raiseApprovers',
          autocomplete: 'off', style: 'width:100%',
          placeholder: 'RSM partner who sanctioned this spend',
          oninput: e => { draft.lob_approver = e.target.value; approverAuto = false; } }),
        approverList), true));
  }

  function paintCtx() {
    ctxHost.textContent = '';
    ctxHost.append(
      field('Event / required-by date', el('input', { type: 'date', value: draft.event_date,
        oninput: e => { draft.event_date = e.target.value; } })),
      field('Cost centre or reference', el('input', { type: 'text', value: draft.cost_centre,
        placeholder: 'Optional',
        oninput: e => { draft.cost_centre = e.target.value; } })),
      field('Purpose', el('textarea', {
        style: 'min-height:64px',
        placeholder: 'Why this order is being raised. This is shown to the approver.',
        oninput: e => { draft.purpose = e.target.value; } }, draft.purpose), true));
  }

  /* Ship or bill to the client's saved address, one of the RSM offices, or an
     address typed by hand. Same three choices, and the same office file, as
     the storefront checkout. Fields stay editable after a pick. */
  function applyPreset(kind, label) {
    const set = v => {
      draft[kind + '_name'] = v.name; draft[kind + '_phone'] = v.phone;
      draft[kind + '_street'] = v.street; draft[kind + '_city'] = v.city;
      draft[kind + '_state'] = v.state; draft[kind + '_pincode'] = v.pincode;
    };
    const office = OFFICES.find(o => o.label === label);
    if (office) {
      set({ name: office.contact_name, phone: office.contact_phone, street: office.street,
        city: office.city, state: office.state, pincode: office.pincode });
    } else if (label === SAVED) {
      const u = chosen();
      set({ name: (u && (u.default_ship_name || u.full_name)) || '',
        phone: (u && u.default_ship_phone) || '', street: (u && u.default_ship_street) || '',
        city: (u && u.default_ship_city) || '', state: '',
        pincode: (u && u.default_ship_pincode) || '' });
    } else {
      set({ name: '', phone: '', street: '', city: '', state: '', pincode: '' });
    }
  }

  function presetSelect(kind) {
    const opts = [SAVED, ...OFFICES.map(o => o.label), OTHER];
    const current = kind === 'ship' ? shipPreset : billPreset;
    return selectOf(opts, current, label => {
      if (kind === 'ship') shipPreset = label; else billPreset = label;
      applyPreset(kind, label);
      kind === 'ship' ? paintShip() : paintBilling();
    }, null);
  }

  function addressFields(host, kind) {
    const note = OFFICES.find(o => o.label === (kind === 'ship' ? shipPreset : billPreset));
    host.append(
      field(kind === 'ship' ? 'Deliver to' : 'Bill to',
        el('div', {}, presetSelect(kind),
          note && note.note
            ? el('div', { class: 'small muted', style: 'margin-top:5px' }, note.note)
            : null), true),
      field(kind === 'ship' ? 'Recipient name' : 'Billing name', bind(kind + '_name')),
      field('Phone', el('input', { type: 'tel', value: draft[kind + '_phone'],
        oninput: e => { draft[kind + '_phone'] = e.target.value; } })),
      field('Street address', el('textarea', { style: 'min-height:64px',
        oninput: e => { draft[kind + '_street'] = e.target.value; } },
        draft[kind + '_street']), true),
      field('City', bind(kind + '_city')),
      field('State', bind(kind + '_state')),
      field('PIN code', bind(kind + '_pincode')),
      field('Country', bind(kind + '_country')));
  }

  function paintShip() {
    shipHost.textContent = '';
    addressFields(shipHost, 'ship');
  }

  function paintBilling() {
    billBox.textContent = '';
    billBox.append(el('label', { class: 'row small', style: 'margin-bottom:14px;cursor:pointer' },
      el('input', {
        type: 'checkbox', style: 'width:auto',
        checked: sameAsShip ? 'checked' : null,
        onchange: e => { sameAsShip = e.target.checked; paintBilling(); },
      }),
      el('span', {}, 'Same as shipping address')));
    if (sameAsShip) return;
    const grid = el('div', { class: 'form-grid' });
    addressFields(grid, 'bill');
    billBox.append(grid);
  }

  /* 197 products is too many for a dropdown, so this is the catalogue search
     the storefront has: name, SKU, category or sub-category. */
  const searchBox = el('input', {
    type: 'search', placeholder: 'Search by product name, SKU or category',
    oninput: e => { search = e.target.value; paintResults(); },
  });

  function paintResults() {
    resultsHost.textContent = '';
    const q = search.trim().toLowerCase();
    if (!q) return;
    const hits = products.filter(p =>
      !picks.some(k => k.sku === p.sku) &&
      [p.name, p.sku, p.category, p.subcategory].join(' ').toLowerCase().includes(q));
    if (!hits.length) {
      resultsHost.append(el('div', { class: 'small muted' }, 'Nothing matches ' + search + '.'));
      return;
    }
    hits.slice(0, 12).forEach(p => resultsHost.append(
      el('div', { class: 'row-between', style: 'padding:6px 0;border-bottom:1px solid var(--line)' },
        el('div', {},
          el('div', { style: 'font-weight:600' }, p.name),
          el('div', { class: 'small muted' },
            [p.sku, p.subcategory || p.category, money(p.base_price),
             'GST ' + (p.gst_rate || 0) + '%'].filter(Boolean).join(' · '))),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => {
          picks.push({ sku: p.sku, price: '', qty: {} });
          search = ''; searchBox.value = '';
          paintResults(); paintLines();
        } }, 'Add'))));
    if (hits.length > 12) {
      resultsHost.append(el('div', { class: 'small muted' },
        `${hits.length - 12} more match. Narrow the search.`));
    }
  }

  function paintLines() {
    linesHost.textContent = '';
    const q = quote();

    if (!picks.length) {
      linesHost.append(el('div', { class: 'small muted' }, 'No products added yet.'));
    }

    picks.forEach((pick, idx) => {
      const p = products.find(x => x.sku === pick.sku);
      if (!p) return;
      const row = q.rows.find(r => r.p.sku === pick.sku) || {};

      const qtyHost = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' });
      if (p.has_sizes && p.sizes.length) {
        p.sizes.forEach(size => qtyHost.append(
          el('label', { class: 'field', style: 'width:84px' },
            el('span', {}, size),
            el('input', { type: 'number', min: '0', step: '1', value: pick.qty[size] || '',
              oninput: e => { pick.qty[size] = Number(e.target.value) || 0; paintLines(); } }))));
      } else {
        qtyHost.append(el('label', { class: 'field', style: 'width:120px' },
          el('span', {}, 'Quantity'),
          el('input', { type: 'number', min: '0', step: '1', value: pick.qty[''] || '',
            oninput: e => { pick.qty[''] = Number(e.target.value) || 0; paintLines(); } })));
      }

      linesHost.append(el('div', { class: 'panel' },
        el('div', { class: 'row-between', style: 'align-items:flex-start' },
          el('div', {},
            el('strong', {}, p.name),
            el('div', { class: 'small muted' },
              [p.sku, 'MOQ ' + (p.moq || 1),
               'GST ' + (row.qty ? row.gst : (p.gst_rate || 0)) + '%' +
                 (row.qty && row.gst !== Number(p.gst_rate || 0) ? ' at this quantity' : '')
              ].join(' · '))),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
            onclick: () => { picks.splice(idx, 1); paintLines(); paintResults(); } }, 'Remove')),
        qtyHost,
        el('div', { class: 'row', style: 'margin-top:8px;align-items:flex-end;gap:14px' },
          el('label', { class: 'field', style: 'width:190px' },
            el('span', {}, 'Negotiated unit price'),
            el('input', { type: 'number', min: '0', step: '0.01', value: pick.price,
              placeholder: row.listUnit != null ? String(row.listUnit) : 'Catalogue price',
              oninput: e => { pick.price = e.target.value.trim(); paintLines(); } })),
          el('div', { class: 'small muted' },
            !row.qty
              ? 'Enter a quantity to see the tier price.'
              : row.negotiated
                ? `Catalogue price at ${row.qty} units is ${money(row.listUnit)}. Charging ${money(row.unit)}.`
                : `Catalogue price at ${row.qty} units is ${money(row.listUnit)}.`))));
    });

    paintSummary(q);
  }

  function paintSummary(q) {
    summaryHost.textContent = '';
    const diff = q.total - q.listTotal;
    const changed = q.rows.filter(r => r.negotiated && r.qty).length;
    const short = q.rows.filter(r => r.belowMoq);

    summaryHost.append(
      el('table', { class: 'totals' }, el('tbody', {},
        el('tr', {}, el('td', {}, 'Subtotal'), el('td', {}, money(q.net))),
        el('tr', {}, el('td', {}, 'GST'), el('td', {}, money(q.tax))),
        el('tr', {}, el('td', {}, 'Shipping & handling'),
          el('td', {}, money(q.shipping))),
        q.shipTax
          ? el('tr', {}, el('td', {}, `GST on shipping & handling (${q.shipGst}%)`),
              el('td', {}, money(q.shipTax)))
          : null,
        el('tr', {}, el('td', {}, 'Catalogue total'), el('td', {}, money(q.listTotal))),
        el('tr', {}, el('td', {},
          diff < 0 ? 'Concession' : diff > 0 ? 'Uplift' : 'Difference'),
          el('td', {}, money(Math.abs(diff)) +
            (changed ? ` · ${changed} product${changed === 1 ? '' : 's'}` : ''))),
        el('tr', { class: 'grand' }, el('td', {}, 'Total'), el('td', {}, money(q.total))))),
      short.length
        ? el('div', { class: 'warn', style: 'margin:12px 0' },
            el('strong', {}, 'Below minimum order quantity. '),
            short.map(r => `${r.p.name}: ${r.qty} of ${r.p.moq}`).join('; ') +
            '. The order can be raised, and this is shown to the approver.')
        : null,
      el('div', { class: 'small muted', style: 'margin-top:10px' },
        `Shipping and handling is charged at ${q.pct}% of the order value ` +
        'before GST, and carries GST at the highest rate on the order. ' +
        'Change the percentage in the Appearance tab.'));
  }

  /* Same drop zone as checkout, except nothing here requires a file: the
     person raising the order is the one who would have vetted the evidence. */
  const drop = el('div', { class: 'drop' },
    el('strong', {}, 'Click to choose files'),
    el('div', { class: 'small muted' },
      'or drag them here. PNG, JPG or PDF, up to 8 MB each. Optional.'));
  const fileInput = el('input', {
    type: 'file', multiple: 'multiple', accept: '.png,.jpg,.jpeg,.pdf', class: 'hidden',
    onchange: e => takeFiles(e.target.files),
  });
  drop.append(fileInput);
  drop.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    takeFiles(e.dataTransfer.files);
  };

  async function takeFiles(list) {
    for (const file of list) {
      if (file.size > 8 * 1024 * 1024) { toast(`${file.name} is over 8 MB`, 'error'); continue; }
      uploads.push({ name: file.name, mime: file.type || 'application/octet-stream',
        bytes: file.size, data: await toBase64(file) });
      paintFiles();
    }
  }

  function paintFiles() {
    fileHost.textContent = '';
    uploads.forEach((f, i) => fileHost.append(
      el('div', { class: 'file-row' },
        el('span', { class: 'grow' }, f.name),
        el('span', { class: 'muted small' }, (f.bytes / 1024).toFixed(0) + ' KB'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: () => { uploads.splice(i, 1); paintFiles(); } }, 'Remove'))));
  }

  function collect() {
    const lines = [], prices = {};
    for (const pick of picks) {
      const p = products.find(x => x.sku === pick.sku);
      if (!p) continue;
      for (const [size, n] of Object.entries(pick.qty)) {
        const qty = Number(n) || 0;
        if (qty <= 0) continue;
        lines.push({ parent_sku: p.sku, size: size || '', qty,
          variant_sku: size ? `${p.sku}_${size}` : p.sku });
      }
      if (pick.price !== '' && isFinite(Number(pick.price))) prices[p.sku] = Number(pick.price);
    }
    const order = { ...draft };
    if (sameAsShip) {
      for (const k of ['name', 'phone', 'street', 'city', 'state', 'pincode', 'country']) {
        order['bill_' + k] = draft['ship_' + k];
      }
    }
    return { lines, prices, order };
  }

  const MISSING = {
    requester_email: 'Choose the client.',
    lob: 'Choose a department.',
    event_date: 'Set the event date.',
    purpose: 'Enter the purpose.',
    ship_name: 'Enter the recipient name.',
    ship_phone: 'Enter the delivery phone number.',
    ship_street: 'Enter the street address.',
    ship_city: 'Enter the city.',
    ship_pincode: 'Enter the PIN code.',
  };

  applyPreset('ship', shipPreset);
  applyPreset('bill', billPreset);
  paintWho(); paintCtx(); paintShip(); paintBilling(); paintLines(); paintResults();

  drawer(el('div', {},
    drawerHead('Raise an order'),
    el('p', { class: 'small muted' },
      'The same form the client would fill in, with one addition: a price box ' +
      'per product. Leave it empty and the line charges the catalogue price. ' +
      'The order is recorded against the client’s own account, so it appears ' +
      'under their login.'),

    el('div', { class: 'panel' }, el('h2', {}, 'Client'), whoHost),
    el('div', { class: 'panel' }, el('h2', {}, 'Order context'), ctxHost),
    el('div', { class: 'panel' }, el('h2', {}, 'Items'),
      el('label', { class: 'field full' }, el('span', {}, 'Add a product'), searchBox),
      resultsHost,
      el('div', { style: 'margin-top:14px' }, linesHost)),
    el('div', { class: 'panel' }, el('h2', {}, 'Evidence'),
      el('p', { class: 'small muted', style: 'margin-top:-6px' },
        'Attach the quote or the written approval behind the negotiated price. ' +
        'Not required, unlike a client’s own order.'),
      drop, fileHost),
    el('div', { class: 'panel' }, el('h2', {}, 'Shipping address'), shipHost),
    el('div', { class: 'panel' }, el('h2', {}, 'Billing address'), billBox),
    el('div', { class: 'panel' }, el('h2', {}, 'Order summary'), summaryHost),

    el('div', { class: 'panel' }, el('h2', {}, 'Approval'),
      el('div', { class: 'stack' },
        el('label', { class: 'row small', style: 'gap:8px;cursor:pointer' },
          el('input', { type: 'checkbox', style: 'width:auto',
            onchange: e => { approveNow = e.target.checked; } }),
          el('span', {}, 'Mark approved now, without routing it to the approvers')),
        el('label', { class: 'row small', style: 'gap:8px;cursor:pointer' },
          el('input', { type: 'checkbox', style: 'width:auto',
            onchange: e => { notifyRequester = e.target.checked; } }),
          el('span', {}, 'Email the client a confirmation')))),

    el('div', { class: 'row', style: 'margin-top:20px' },
      el('button', { class: 'btn', onclick: async ev => {
        const btn = ev.target;
        const { lines, prices, order } = collect();

        for (const [k, msg] of Object.entries(MISSING)) {
          if (!String(order[k] || '').trim()) return toast(msg, 'error');
        }
        if (!lines.length) return toast('Add at least one product with a quantity.', 'error');

        btn.disabled = true;
        const was = btn.textContent;
        btn.textContent = 'Raising...';
        try {
          const r = await api('adminCreateOrder', {
            admin_pass: PASS, order, lines, prices, files: uploads,
            approve_now: approveNow, notify_requester: notifyRequester,
          });
          toast(`${r.order_id} raised · ${r.status} · ${money(r.total)}`);
          closeDrawer();
          await loadAll();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = was;
        }
      } }, 'Raise order'),
      el('button', { class: 'btn btn-ghost', onclick: closeDrawer }, 'Cancel'))));
}

bootAdmin();
