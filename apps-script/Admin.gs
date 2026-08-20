/**
 * Admin console: catalogue, banners, site settings, and publishing.
 *
 * Every handler here is behind requireAdmin(). Deletes are SOFT: a product is
 * deactivated, never removed, so nothing an admin does is unrecoverable and the
 * order history keeps resolving its product names.
 *
 * PUBLISHING
 * The storefront reads a static assets/products.json committed to the repo,
 * which is why it loads instantly. Editing the Sheet does NOT change the live
 * site. fnAdminPublish() regenerates products.json and site.json and commits
 * them through the GitHub Contents API. Needs two Script Properties:
 *
 *   GITHUB_REPO   e.g. RogerDF30/rsm-b2b
 *   GITHUB_TOKEN  fine-grained PAT, that repo only, Contents: read and write
 */

var PRODUCTS_PATH = 'assets/products.json';
var SITE_PATH = 'assets/site.json';

/* ------------------------------------------------------------------ read */

function fnAdminCatalog(req) {
  requireAdmin(req);

  var tiers = {};
  readTab(SHEETS.TIERS).forEach(function (t) {
    var k = String(t.parent_sku).trim();
    (tiers[k] = tiers[k] || []).push({
      min_qty: Number(t.min_qty),
      max_qty: t.max_qty === '' ? null : Number(t.max_qty),
      unit_price: Number(t.unit_price)
    });
  });

  var sizes = {};
  readTab(SHEETS.VARIANTS).forEach(function (v) {
    var k = String(v.parent_sku).trim();
    (sizes[k] = sizes[k] || []).push(String(v.size));
  });

  var products = readTab(SHEETS.PRODUCTS).map(function (p) {
    var sku = String(p.sku).trim();
    return {
      sku: sku, name: p.name, category: p.category, subcategory: p.subcategory,
      description: p.description, moq: Number(p.moq || 0),
      gst_rate: Number(p.gst_rate || 0), base_price: Number(p.base_price || 0),
      has_sizes: String(p.has_sizes).toUpperCase() === 'TRUE',
      image: p.image, lead_time_days: Number(p.lead_time_days || 14),
      active: String(p.active).toUpperCase() !== 'FALSE',
      sort_order: Number(p.sort_order || 0),
      /* Two sources, deliberately kept apart. related_skus is what a human
         picked in the console and is never touched by the auto-mapper;
         auto_related_skus is generated and is rewritten on every run. The
         storefront shows the union, manual first. */
      related_skus: splitSkus(p.related_skus),
      auto_related_skus: splitSkus(p.auto_related_skus),
      related_all: mergeSkus(splitSkus(p.related_skus), splitSkus(p.auto_related_skus)),
      sizes: (sizes[sku] || []).sort(sizeOrder),
      tiers: (tiers[sku] || []).sort(function (a, b) { return a.min_qty - b.min_qty; })
    };
  });

  return {
    ok: true,
    products: symmetriseRelated(products),
    categories: readTab(SHEETS.CATEGORIES).map(function (c) {
      return {
        slug: String(c.slug), parent_slug: String(c.parent_slug),
        label: String(c.label), sort_order: Number(c.sort_order || 0),
        active: String(c.active).toUpperCase() !== 'FALSE'
      };
    }),
    banners: readBanners(true),
    settings: readSettings(),
    published_at: PropertiesService.getScriptProperties().getProperty('PUBLISHED_AT') || ''
  };
}

function splitSkus(cell) {
  return String(cell || '').split(',')
    .map(function (x) { return x.trim().toUpperCase(); })
    .filter(String);
}

/** Manual list first, then anything the auto-mapper added that is not already in it. */
function mergeSkus(manual, auto) {
  var seen = {}, out = [];
  manual.concat(auto).forEach(function (s) {
    if (!seen[s]) { seen[s] = 1; out.push(s); }
  });
  return out;
}

/**
 * Related products are a mutual relationship, not a one-way pointer: if the
 * grey cap lists the navy cap, the navy cap lists the grey cap. Saving a
 * product writes that back into its partners (see syncReciprocal), and this
 * closes the loop for pairs authored before that rule existed, so the console
 * and the storefront always agree.
 *
 * Order is preserved: what the admin picked comes first, inherited links after.
 */
function symmetriseRelated(products) {
  var known = {}, link = {};
  products.forEach(function (p) { known[p.sku] = 1; link[p.sku] = {}; });

  products.forEach(function (p) {
    p.related_all.forEach(function (s) {
      if (s === p.sku || !known[s]) return;
      link[p.sku][s] = 1;
      link[s][p.sku] = 1;
    });
  });

  products.forEach(function (p) {
    var seen = {}, out = [];
    p.related_all.forEach(function (s) {
      if (link[p.sku][s] && !seen[s]) { seen[s] = 1; out.push(s); }
    });
    Object.keys(link[p.sku]).forEach(function (s) {
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    });
    p.related_all = out;
  });
  return products;
}

/* XS S M L XL 2XL 3XL, not alphabetical. */
var SIZE_RANK = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
function sizeOrder(a, b) {
  var ia = SIZE_RANK.indexOf(a), ib = SIZE_RANK.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}

function readBanners(includeInactive) {
  return readTab(SHEETS.BANNERS)
    .filter(function (b) {
      return includeInactive || String(b.active).toUpperCase() !== 'FALSE';
    })
    .map(function (b) {
      return {
        slug: String(b.slug), title: String(b.title || ''),
        subtitle: String(b.subtitle || ''), image_url: String(b.image_url || ''),
        link_url: String(b.link_url || ''), sort_order: Number(b.sort_order || 0),
        active: String(b.active).toUpperCase() !== 'FALSE'
      };
    })
    .sort(function (a, b) { return a.sort_order - b.sort_order; });
}

function readSettings() {
  var out = {};
  readTab(SHEETS.SETTINGS).forEach(function (r) {
    if (r.key) out[String(r.key).trim()] = String(r.value === undefined ? '' : r.value);
  });
  return out;
}

/* ---------------------------------------------------------------- write */

function fnAdminSaveProduct(req) {
  requireAdmin(req);
  var p = req.product || {};
  var sku = String(p.sku || '').trim().toUpperCase();
  if (!sku) throw new Error('SKU is required.');
  if (!String(p.name || '').trim()) throw new Error('Product name is required.');
  if (!(Number(p.moq) > 0)) throw new Error('MOQ must be greater than zero.');

  var tiers = (p.tiers || [])
    .map(function (t) {
      return {
        min_qty: Math.floor(Number(t.min_qty) || 0),
        max_qty: t.max_qty === '' || t.max_qty === null ? '' : Math.floor(Number(t.max_qty)),
        unit_price: Number(t.unit_price) || 0
      };
    })
    .filter(function (t) { return t.min_qty > 0 && t.unit_price > 0; })
    .sort(function (a, b) { return a.min_qty - b.min_qty; });
  if (!tiers.length) throw new Error('At least one price tier is required.');
  if (tiers[0].min_qty !== Math.floor(Number(p.moq))) {
    throw new Error('The first price tier must start at the MOQ (' + p.moq + ').');
  }

  var sizes = (p.sizes || []).map(function (s) { return String(s).trim().toUpperCase(); })
    .filter(String);

  return withLock(function () {
    var existing = null;
    readTab(SHEETS.PRODUCTS).forEach(function (r) {
      if (String(r.sku).trim().toUpperCase() === sku) existing = r;
    });

    var related = [];
    (p.related_skus || []).forEach(function (s) {
      var v = String(s).trim().toUpperCase();
      if (v && v !== sku && related.indexOf(v) < 0) related.push(v);
    });

    var row = {
      sku: sku, name: p.name, category: p.category, subcategory: p.subcategory,
      description: p.description || '', moq: Math.floor(Number(p.moq)),
      gst_rate: Number(p.gst_rate) || 0, base_price: tiers[0].unit_price,
      has_sizes: sizes.length ? 'TRUE' : 'FALSE',
      image: p.image || '', lead_time_days: Number(p.lead_time_days) || 14,
      active: p.active === false ? 'FALSE' : 'TRUE',
      sort_order: Number(p.sort_order) || 0,
      related_skus: related.join(',')
    };

    if (existing) {
      updateRow(SHEETS.PRODUCTS, existing._row, row);
    } else {
      appendRow(SHEETS.PRODUCTS, row);
    }
    syncReciprocal(sku, related);

    replaceRowsFor(SHEETS.TIERS, 'parent_sku', sku, tiers.map(function (t) {
      return { parent_sku: sku, min_qty: t.min_qty, max_qty: t.max_qty, unit_price: t.unit_price };
    }));
    replaceRowsFor(SHEETS.VARIANTS, 'parent_sku', sku, sizes.map(function (s) {
      return { variant_sku: sku + '_' + s, parent_sku: sku, size: s, stock_qty: '', active: 'TRUE' };
    }));

    ensureCategory(p.category, p.subcategory);
    audit('admin', existing ? 'product_updated' : 'product_created', 'product', sku,
      existing ? { name: existing.name } : null, { name: row.name, active: row.active });
    return { ok: true, sku: sku, created: !existing };
  });
}

/* ------------------------------------------------- automatic related links */

var RELATED_MAX = 6;
var RELATED_MIN = 2;

/* Words that describe a colourway or an audience rather than the product, so
   the grey cap and the navy cap collapse to the same family. */
var RELATED_NOISE = new RegExp(
  '\\b(black|white|navy|blue|grey|gray|green|red|beige|cream|pink|sky|maroon|' +
  'yellow|orange|brown|silver|gold|teal|purple|olive|charcoal|ivory|tan|' +
  'burgundy|standard|standar|unisex|female|male|mens|womens|colour|color|' +
  'mrp|discount|discounted)\\b', 'g');

/** "OMG Twill Cotton Cap- Standard Sky Blue" -> "omg twill cotton cap" */
function familyKey(name) {
  return String(name || '').toLowerCase()
    .replace(RELATED_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Leading word of the name, which is how this catalogue carries brand. */
function brandOf(name) {
  var w = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(' ');
  return w[0] || '';
}

/**
 * Fill in related products across the whole catalogue.
 *
 * Two passes. First every colour variant of the same item is linked to its
 * siblings, which is the pairing a buyer actually expects. Then each product is
 * topped up from its own subcategory, nearest brand and price first, until it
 * has RELATED_MAX links.
 *
 * Links already on a product are kept: a hand-picked set is never discarded,
 * only extended. Every link is written both ways, and hidden products are
 * neither linked to nor given links. Writing is one bulk setValues, not a
 * save-per-product, so the whole catalogue costs a single round trip.
 */
function fnAdminAutoRelate(req) {
  requireAdmin(req);
  var dryRun = req.dry_run === true;

  /* Escape hatch: wipe the hand-picked column as well and rebuild everything
     from scratch. Needed once, because an earlier version of this function
     wrote its output into related_skus before the two columns were separated.
     The literal is required so this can never fire by accident, and no button
     in the console offers it. */
  var resetManual = req.reset_manual === 'CLEAR';

  return withLock(function () {
    if (resetManual && !dryRun) {
      var psh = sheet(SHEETS.PRODUCTS);
      var mcol = headerIndex(SHEETS.PRODUCTS).related_skus;
      if (psh.getLastRow() > 1) {
        psh.getRange(2, mcol, psh.getLastRow() - 1, 1).clearContent();
      }
      audit('admin', 'related_manual_cleared', 'catalogue', '', null, null);
    }

    var rows = readTab(SHEETS.PRODUCTS);
    var live = rows.filter(function (r) {
      return String(r.active).toUpperCase() !== 'FALSE' && String(r.sku).trim();
    });

    var info = {}, order = [];
    live.forEach(function (r) {
      var sku = String(r.sku).trim().toUpperCase();
      info[sku] = {
        sku: sku, row: r._row, name: String(r.name || ''),
        family: familyKey(r.name), brand: brandOf(r.name),
        category: String(r.category || ''), subcategory: String(r.subcategory || ''),
        price: Number(r.base_price || 0),
        links: {}, manual: {}
      };
      order.push(sku);
    });

    /* Seed from the MANUAL column only. Last run's own output is deliberately
       discarded: it is recomputed from scratch below, so a product that has
       since changed category does not keep the neighbours it had under the old
       one. Hand-picked links survive because they live in a different column. */
    live.forEach(function (r) {
      var sku = String(r.sku).trim().toUpperCase();
      splitSkus(r.related_skus).forEach(function (other) {
        if (other !== sku && info[other]) {
          info[sku].links[other] = 1;
          info[other].links[sku] = 1;
          // both ends count as manual, so the pair is never also written as auto
          info[sku].manual[other] = 1;
          info[other].manual[sku] = 1;
        }
      });
    });

    function degree(sku) { return Object.keys(info[sku].links).length; }
    function join(a, b, force) {
      if (a === b || !info[a] || !info[b] || info[a].links[b]) return false;
      if (!force && (degree(a) >= RELATED_MAX || degree(b) >= RELATED_MAX)) return false;
      info[a].links[b] = 1;
      info[b].links[a] = 1;
      return true;
    }

    // pass 1: colour variants of the same product, always linked
    var families = {}, variantLinks = 0;
    order.forEach(function (sku) {
      var k = info[sku].family;
      if (k) (families[k] = families[k] || []).push(sku);
    });
    Object.keys(families).forEach(function (k) {
      var group = families[k];
      if (group.length < 2) return;
      for (var i = 0; i < group.length; i++) {
        for (var j = i + 1; j < group.length; j++) {
          if (join(group[i], group[j], true)) variantLinks++;
        }
      }
    });

    // pass 2: top up from the same subcategory, nearest brand and price first
    var topUps = 0;
    order.forEach(function (sku) {
      var me = info[sku];
      if (degree(sku) >= RELATED_MAX) return;

      var pool = order.filter(function (other) {
        return other !== sku && !me.links[other] &&
               info[other].subcategory === me.subcategory &&
               info[other].family !== me.family;
      });
      pool.sort(function (a, b) {
        var sameBrand = (info[b].brand === me.brand) - (info[a].brand === me.brand);
        if (sameBrand) return sameBrand;
        return priceGap(me.price, info[a].price) - priceGap(me.price, info[b].price);
      });
      for (var i = 0; i < pool.length && degree(sku) < RELATED_MAX; i++) {
        if (join(sku, pool[i], false)) topUps++;
      }
    });

    // pass 3: nobody is left with an empty row. Filling in subcategory order
    // is greedy, so whoever is considered last can find every neighbour already
    // at the cap; those products are given a partner anyway, widening to the
    // category when the subcategory holds nothing else.
    var rescued = 0;
    order.forEach(function (sku) {
      if (degree(sku) >= RELATED_MIN) return;
      var me = info[sku];

      var pool = order.filter(function (other) {
        return other !== sku && !me.links[other] && info[other].family !== me.family &&
               info[other].subcategory === me.subcategory;
      });
      if (!pool.length) {
        pool = order.filter(function (other) {
          return other !== sku && !me.links[other] && info[other].family !== me.family &&
                 info[other].category === me.category;
        });
      }
      pool.sort(function (a, b) {
        return priceGap(me.price, info[a].price) - priceGap(me.price, info[b].price);
      });
      for (var i = 0; i < pool.length && degree(sku) < RELATED_MIN; i++) {
        if (join(sku, pool[i], true)) rescued++;
      }
    });

    var result = {
      ok: true, products: order.length,
      variant_links: variantLinks, topped_up: topUps, rescued: rescued,
      reset_manual: resetManual,
      with_related: 0, still_empty: [], dry_run: dryRun
    };
    order.forEach(function (sku) {
      if (degree(sku)) result.with_related++;
      else result.still_empty.push(sku);
    });

    if (!dryRun) {
      var sh = sheet(SHEETS.PRODUCTS);
      var col = headerIndex(SHEETS.PRODUCTS).auto_related_skus;
      if (!col) throw new Error('Products has no auto_related_skus column. Run Upgrade first.');

      var last = sh.getLastRow();
      var values = sh.getRange(2, col, last - 1, 1).getValues();
      var skuValues = sh.getRange(2, headerIndex(SHEETS.PRODUCTS).sku, last - 1, 1).getValues();
      for (var i = 0; i < skuValues.length; i++) {
        var s = String(skuValues[i][0]).trim().toUpperCase();
        if (!info[s]) continue;
        // only what this run added; the manual column keeps the rest
        values[i][0] = Object.keys(info[s].links).filter(function (o) {
          return !info[s].manual[o];
        }).join(',');
      }
      sh.getRange(2, col, last - 1, 1).setValues(values);
      audit('admin', 'auto_related', 'catalogue', '', null,
        { variant_links: variantLinks, topped_up: topUps });
    }
    return result;
  });
}

/** Distance between two prices, symmetric in ratio so 100 vs 200 ranks like 200 vs 100. */
function priceGap(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  if (a <= 0 || b <= 0) return 999;
  return a > b ? a / b : b / a;
}

/**
 * Make every other product agree about `sku`.
 *
 * Anything named in `related` gains sku; anything that still names sku but was
 * dropped from the list loses it. Only rows that actually change are written.
 * Called inside the save lock, after the product's own row is in place.
 */
function syncReciprocal(sku, related) {
  var wanted = {};
  related.forEach(function (s) { wanted[s] = 1; });

  readTab(SHEETS.PRODUCTS).forEach(function (r) {
    var other = String(r.sku).trim().toUpperCase();
    if (!other || other === sku) return;

    var list = String(r.related_skus || '').split(',')
      .map(function (x) { return x.trim().toUpperCase(); })
      .filter(String);
    var has = list.indexOf(sku) >= 0;

    if (wanted[other] && !has) {
      list.push(sku);
    } else if (!wanted[other] && has) {
      list = list.filter(function (x) { return x !== sku; });
    } else {
      return;                       // already correct, leave the row alone
    }
    updateRow(SHEETS.PRODUCTS, r._row, { related_skus: list.join(',') });
  });
}

/** Delete every row for a key, then write the replacements. */
function replaceRowsFor(tab, keyCol, key, rows) {
  var sh = sheet(tab);
  var data = sh.getDataRange().getValues();
  var head = data[0].map(function (h) { return String(h).trim(); });
  var col = head.indexOf(keyCol);
  if (col < 0) throw new Error(tab + ' has no ' + keyCol + ' column.');

  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][col]).trim().toUpperCase() === String(key).toUpperCase()) {
      sh.deleteRow(i + 1);
    }
  }
  rows.forEach(function (r) { appendRow(tab, r); });
}

function ensureCategory(category, subcategory) {
  if (!category || !subcategory) return;
  var exists = readTab(SHEETS.CATEGORIES).some(function (c) {
    return String(c.slug).trim() === String(subcategory).trim() &&
           String(c.parent_slug).trim() === String(category).trim();
  });
  if (!exists) {
    appendRow(SHEETS.CATEGORIES, {
      slug: subcategory, parent_slug: category, label: subcategory,
      sort_order: readTab(SHEETS.CATEGORIES).length, active: 'TRUE'
    });
  }
}

/**
 * Soft delete. The row stays and the product is deactivated, so historic
 * orders still resolve and a mistake is one toggle away from undone.
 * The caller must echo the SKU back, which is what stops a stray click.
 */
function fnAdminDeleteProduct(req) {
  requireAdmin(req);
  var sku = String(req.sku || '').trim().toUpperCase();
  if (String(req.confirm || '').trim().toUpperCase() !== sku) {
    throw new Error('Type the SKU exactly to confirm.');
  }
  return withLock(function () {
    var hit = null;
    readTab(SHEETS.PRODUCTS).forEach(function (r) {
      if (String(r.sku).trim().toUpperCase() === sku) hit = r;
    });
    if (!hit) throw new Error('No product ' + sku + '.');
    updateRow(SHEETS.PRODUCTS, hit._row, { active: 'FALSE' });
    audit('admin', 'product_deactivated', 'product', sku, { active: 'TRUE' }, { active: 'FALSE' });
    return { ok: true };
  });
}

/** Show or hide a product or a subcategory. */
function fnAdminToggle(req) {
  requireAdmin(req);
  var kind = req.kind, key = String(req.key || '').trim();
  var on = req.active === true;
  var tab = kind === 'category' ? SHEETS.CATEGORIES
          : kind === 'banner' ? SHEETS.BANNERS
          : SHEETS.PRODUCTS;
  var keyCol = kind === 'product' ? 'sku' : 'slug';

  return withLock(function () {
    var hit = null;
    readTab(tab).forEach(function (r) {
      if (String(r[keyCol]).trim().toUpperCase() === key.toUpperCase()) hit = r;
    });
    if (!hit) throw new Error('No ' + kind + ' "' + key + '".');
    updateRow(tab, hit._row, { active: on ? 'TRUE' : 'FALSE' });
    audit('admin', on ? 'shown' : 'hidden', kind, key, null, null);
    return { ok: true };
  });
}

/* --------------------------------------------------------------- images */

/**
 * Upload an image to the evidence folder's sibling "Site images" folder and
 * return a URL the storefront can render. Drive's /uc?export=view form is what
 * works in an <img>; the /file/d/.../view URL is a viewer page, not an image.
 */
function fnAdminUploadImage(req) {
  requireAdmin(req);
  var f = req.file || {};
  var bytes = Utilities.base64Decode(f.data || '');
  if (!bytes.length) throw new Error('Empty file.');
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB.');

  var parent = DriveApp.getFolderById(prop('FOLDER_ID')).getParents();
  var root = parent.hasNext() ? parent.next() : DriveApp.getRootFolder();
  var folders = root.getFoldersByName('RSM B2B Store - Site images');
  var folder = folders.hasNext() ? folders.next()
    : root.createFolder('RSM B2B Store - Site images');

  var blob = Utilities.newBlob(bytes, f.mime || 'image/png', f.name || 'image.png');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var url = 'https://drive.google.com/uc?export=view&id=' + file.getId();
  audit('admin', 'image_uploaded', 'file', file.getId(), null, { name: f.name });
  return { ok: true, url: url, file_id: file.getId() };
}

/* -------------------------------------------------------- banners, settings */

function fnAdminSaveBanner(req) {
  requireAdmin(req);
  var b = req.banner || {};
  var slug = String(b.slug || '').trim();
  if (!slug) throw new Error('Banner slug is required.');

  return withLock(function () {
    var hit = null;
    readTab(SHEETS.BANNERS).forEach(function (r) {
      if (String(r.slug).trim() === slug) hit = r;
    });
    var row = {
      slug: slug, title: b.title || '', subtitle: b.subtitle || '',
      image_url: b.image_url || '', link_url: b.link_url || '',
      sort_order: Number(b.sort_order) || 0,
      active: b.active === false ? 'FALSE' : 'TRUE'
    };
    if (hit) updateRow(SHEETS.BANNERS, hit._row, row);
    else appendRow(SHEETS.BANNERS, row);
    audit('admin', hit ? 'banner_updated' : 'banner_created', 'banner', slug, null, null);
    return { ok: true };
  });
}

function fnAdminDeleteBanner(req) {
  requireAdmin(req);
  var slug = String(req.slug || '').trim();
  return withLock(function () {
    replaceRowsFor(SHEETS.BANNERS, 'slug', slug, []);
    audit('admin', 'banner_deleted', 'banner', slug, null, null);
    return { ok: true };
  });
}

function fnAdminSaveSettings(req) {
  requireAdmin(req);
  var patch = req.settings || {};
  return withLock(function () {
    var rows = readTab(SHEETS.SETTINGS);
    Object.keys(patch).forEach(function (k) {
      var hit = null;
      rows.forEach(function (r) { if (String(r.key).trim() === k) hit = r; });
      if (hit) updateRow(SHEETS.SETTINGS, hit._row, { value: patch[k] });
      else appendRow(SHEETS.SETTINGS, { key: k, value: patch[k], note: '' });
    });
    audit('admin', 'settings_saved', 'settings', '', null, { keys: Object.keys(patch) });
    return { ok: true, settings: readSettings() };
  });
}

/* -------------------------------------------------------------- publish */

/**
 * Rebuild the two static files the storefront reads and commit them.
 * Only active products and categories are published, which is what makes the
 * show/hide toggles real.
 */
function fnAdminPublish(req) {
  requireAdmin(req);

  var cat = buildCatalogueJson();
  var site = buildSiteJson();

  /* Repo is known; only the token needs adding by hand, and deliberately so:
     it should be a fine-grained PAT limited to this one repository. */
  var repo = prop('GITHUB_REPO', 'RogerDF30/rsm-b2b');
  var token = prop('GITHUB_TOKEN', '');
  if (!token) {
    throw new Error('Publishing needs a GitHub token. In the Apps Script ' +
      'editor: Project Settings, Script Properties, add GITHUB_TOKEN. Use a ' +
      'fine-grained personal access token limited to ' + repo +
      ' with Contents: Read and write.');
  }

  var stamp = now();
  var msg = 'Publish catalogue from the admin console, ' + stamp;
  commitFile(repo, token, PRODUCTS_PATH, JSON.stringify(cat, null, 1), msg);
  commitFile(repo, token, SITE_PATH, JSON.stringify(site, null, 1), msg);

  PropertiesService.getScriptProperties().setProperty('PUBLISHED_AT', stamp);
  audit('admin', 'published', 'site', repo, null,
    { products: cat.products.length, banners: site.banners.length });

  return {
    ok: true, published_at: stamp,
    products: cat.products.length, banners: site.banners.length,
    note: 'GitHub Pages takes a minute or two to rebuild.'
  };
}

function buildCatalogueJson() {
  var full = fnAdminCatalog({ admin_pass: prop('ADMIN_PASS') });
  var live = full.products.filter(function (p) { return p.active; });
  var liveSkus = {};
  live.forEach(function (p) { liveSkus[p.sku] = 1; });

  var carried = carryOverStaticFields();

  var cats = {};
  full.categories.filter(function (c) { return c.active; })
    .forEach(function (c) { (cats[c.parent_slug] = cats[c.parent_slug] || []).push(c.label); });

  return {
    generated_from: 'admin console',
    generated_at: now(),
    pricing_status: 'from the Sheet',
    categories: Object.keys(cats).sort().map(function (k) {
      return { slug: k, label: k, subcategories: cats[k].sort() };
    }),
    products: live.map(function (p) {
      var was = carried[p.sku] || {};
      return {
        sku: p.sku, name: p.name, url_key: was.url_key || '', category: p.category,
        subcategory: p.subcategory, attribute_set: was.attribute_set || '',
        description: p.description, specs: was.specs || [],
        moq: p.moq, gst_rate: p.gst_rate, base_price: p.base_price,
        tiers: p.tiers, sizes: p.sizes, has_sizes: p.has_sizes,
        image: p.image, weight: was.weight || '', active: true,
        // only point at products that are still live
        related: p.related_all.filter(function (s) { return liveSkus[s]; })
      };
    })
  };
}

/**
 * specs, url_key, weight and attribute_set came from the Magento scrape and
 * have no column in the Sheet, so a publish built purely from the Sheet would
 * blank the spec table on 127 product pages. Read them back off the catalogue
 * that is already live and carry them forward.
 *
 * A fetch failure is not fatal: a product with no specs still sells.
 */
function carryOverStaticFields() {
  var out = {};
  try {
    var res = UrlFetchApp.fetch(CATALOGUE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return out;
    JSON.parse(res.getContentText()).products.forEach(function (p) {
      out[String(p.sku).trim().toUpperCase()] = {
        url_key: p.url_key || '', attribute_set: p.attribute_set || '',
        weight: p.weight || '', specs: p.specs || []
      };
    });
  } catch (err) {
    console.log('carryOverStaticFields: ' + err.message);
  }
  return out;
}

function buildSiteJson() {
  return {
    generated_at: now(),
    settings: readSettings(),
    banners: readBanners(false)
  };
}

/** PUT a file through the GitHub Contents API, creating or updating it. */
function commitFile(repo, token, path, content, message) {
  var base = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // An update needs the current blob sha; a create must omit it.
  var sha = null;
  var probe = UrlFetchApp.fetch(base, { headers: headers, muteHttpExceptions: true });
  if (probe.getResponseCode() === 200) sha = JSON.parse(probe.getContentText()).sha;

  var body = {
    message: message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8)
  };
  if (sha) body.sha = sha;

  var res = UrlFetchApp.fetch(base, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('GitHub rejected ' + path + ' (HTTP ' + code + '): ' +
      res.getContentText().slice(0, 300));
  }
}
