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
      related_skus: String(p.related_skus || '').split(',')
        .map(function (x) { return x.trim(); }).filter(String),
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
    p.related_skus.forEach(function (s) {
      if (s === p.sku || !known[s]) return;
      link[p.sku][s] = 1;
      link[s][p.sku] = 1;
    });
  });

  products.forEach(function (p) {
    var seen = {}, out = [];
    p.related_skus.forEach(function (s) {
      if (link[p.sku][s] && !seen[s]) { seen[s] = 1; out.push(s); }
    });
    Object.keys(link[p.sku]).forEach(function (s) {
      if (!seen[s]) { seen[s] = 1; out.push(s); }
    });
    p.related_skus = out;
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
        related: p.related_skus.filter(function (s) { return liveSkus[s]; })
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
