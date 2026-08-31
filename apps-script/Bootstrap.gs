/**
 * One-shot setup. Run bootstrap() ONCE from the Apps Script editor.
 *
 * It creates everything the backend needs and prints what you have to paste
 * back into the frontend:
 *
 *   1. the backend Google Sheet, with all eleven tabs
 *   2. the Drive folder that evidence uploads land in
 *   3. Script Properties: the fixed API_TOKEN plus a random PEPPER and
 *      ADMIN_PASS
 *   4. the catalogue, pulled straight from the live products.json so there is
 *      no CSV importing by hand
 *   5. one approver row (roger@companystore.io) and one demo user
 *
 * Running it a second time is refused, so a stray click cannot regenerate
 * PEPPER and lock every user out. Use rebuildCatalogue() to re-seed products
 * after a price change, and resetAdminPassword() to rotate the console password.
 */

var CATALOGUE_URL = 'https://b2b.rsmus.companystore.gifts/assets/products.json';
var SITE = 'https://b2b.rsmus.companystore.gifts';

/* Fixed so assets/js/app.js can be configured before the first run. This is
   NOT a secret: it ships in the public frontend and only blocks casual
   traffic. PEPPER and ADMIN_PASS below are generated and never committed. */
var FIXED_API_TOKEN = 'rsm_XkCA0HS327rSxemHHRHIymHolJcf';

function bootstrap() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_ID')) {
    throw new Error(
      'Already bootstrapped. Sheet ' + props.getProperty('SHEET_ID') +
      '. Use rebuildCatalogue() to re-seed products, or resetSecrets() to ' +
      'rotate secrets (that invalidates every password).');
  }

  var log = [];

  // 1. backend spreadsheet
  var ss = SpreadsheetApp.create('RSM B2B Store - Backend');
  props.setProperty('SHEET_ID', ss.getId());
  log.push('Sheet:  ' + ss.getUrl());

  // 2. evidence folder
  var folder = DriveApp.createFolder('RSM B2B Store - Evidence');
  props.setProperty('FOLDER_ID', folder.getId());
  log.push('Folder: ' + folder.getUrl());

  // 3. secrets
  var apiToken = FIXED_API_TOKEN;
  props.setProperties({
    API_TOKEN: apiToken,
    PEPPER: randomToken(32),
    ADMIN_PASS: randomToken(9),
    SENDER_ALIAS: 'rsm@companystore.io',
    SITE_URL: SITE,
    ORDER_SEQ: String(ORDER_SEQ_START)
  }, false);

  // 4. tabs
  setupBackend();
  log.push('Tabs:   ' + Object.keys(TAB_HEADERS).length + ' created');

  // 5. catalogue
  var counts = rebuildCatalogue();
  log.push('Catalogue: ' + counts.products + ' products, ' +
    counts.variants + ' variants, ' + counts.tiers + ' tier rows, ' +
    counts.categories + ' categories');

  // 6. departments and their sanctioning partners
  seedDepartments();
  log.push('Departments: ' + readTab(SHEETS.DEPARTMENTS).length + ' seeded');

  // 7. site settings and a starter banner
  seedSiteContent();
  log.push('Settings + banner seeded');

  // 8. one approver and one demo user
  appendRow(SHEETS.APPROVERS, {
    approver_name: 'Roger Daniel', approver_email: 'roger@companystore.io',
    receives_all: 'TRUE', active: 'TRUE'
  });
  var demoPass = randomToken(8);
  var salt = randomToken(12);
  appendRow(SHEETS.USERS, {
    email: 'demo@rsmus.com', full_name: 'Demo Requester', lob: 'Consulting',
    password_hash: hashPassword(demoPass, salt), salt: salt,
    must_reset: 'FALSE', failed_attempts: 0, locked_until: '',
    default_ship_name: 'Demo Recipient', default_ship_phone: '9812345678',
    default_ship_street: 'HQ 27, The Headquarters, Sector 27',
    default_ship_city: 'Gurugram', default_ship_pincode: '122002',
    active: 'TRUE', created_at: now(), last_login: ''
  });

  var out = [
    '',
    '=================================================================',
    ' RSM B2B backend is ready.',
    '=================================================================',
    ''
  ].concat(log).concat([
    '',
    '--- PASTE INTO assets/js/app.js -------------------------------',
    "  API_TOKEN: '" + apiToken + "',",
    '',
    '--- KEEP SOMEWHERE SAFE ---------------------------------------',
    '  admin.html password : ' + props.getProperty('ADMIN_PASS'),
    '  demo sign-in        : demo@rsmus.com / ' + demoPass,
    '',
    '--- NEXT ------------------------------------------------------',
    '  Nothing. The web app is already deployed and app.js already',
    '  points at it. Open the store and sign in as the demo user.',
    '  ' + SITE + '/login.html',
    '=================================================================',
    ''
  ]).join('\n');

  console.log(out);
  return out;
}

/** Logo, hero copy and one banner, all editable in the admin console. */
function seedSiteContent() {
  if (!readTab(SHEETS.SETTINGS).length) {
    [['logo_url', SITE + '/assets/brand/rsm-logo.png', 'Header logo, cerulean on light'],
     ['logo_white_url', SITE + '/assets/brand/rsm-logo-white.png', 'Hero logo, white on midnight'],
     ['hero_title', 'RSM branded merchandise', ''],
     ['hero_subtitle', 'Browse the approved catalogue. Sign in at checkout to raise an order for approval.', ''],
     ['footer_note', 'RSM Business Store, operated by CompanyStore.IO', ''],
     ['shipping_pct', '8', 'Shipping and handling, as a percentage of the subtotal before GST']
    ].forEach(function (r) {
      appendRow(SHEETS.SETTINGS, { key: r[0], value: r[1], note: r[2] });
    });
  }
  if (!readTab(SHEETS.BANNERS).length) {
    appendRow(SHEETS.BANNERS, {
      slug: 'welcome', title: 'RSM branded merchandise',
      subtitle: 'Browse the approved catalogue. Sign in at checkout to raise an order for approval.',
      image_url: '', link_url: 'category.html?cat=Apparel',
      sort_order: 0, active: 'TRUE'
    });
  }
}

/**
 * Line of business -> the RSM partner who sanctions its spend.
 *
 * The four filled rows are the real pairs used in the old Magento approval
 * sheet. The rest are the LOBs seen in the order history with no partner on
 * record: fill them in the Departments tab, no redeploy needed.
 */
function seedDepartments() {
  if (readTab(SHEETS.DEPARTMENTS).length) return;
  [['Assurance', 'Kawalpreet Kaur'],
   ['CMG', ''],
   ['Consulting', 'Balasundaram Nagarajan'],
   ['Enterprises', 'Gowri Srinivas'],
   ['ESS', ''],
   ['IT', 'Malleswara Reddy'],
   ['Talent', ''],
   ['Tax', '']].forEach(function (d) {
    appendRow(SHEETS.DEPARTMENTS, { lob: d[0], approver_name: d[1], active: 'TRUE' });
  });
}

/**
 * Load Products, Variants, PriceTiers and Categories from the published
 * products.json. Safe to re-run: it clears those four tabs and refills them,
 * and never touches Orders, OrderLines, Users, Approvers or the AuditLog.
 */
function rebuildCatalogue() {
  var res = UrlFetchApp.fetch(CATALOGUE_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not read ' + CATALOGUE_URL + ': HTTP ' + res.getResponseCode());
  }
  var data = JSON.parse(res.getContentText());

  return withLock(function () {
    [SHEETS.PRODUCTS, SHEETS.VARIANTS, SHEETS.TIERS, SHEETS.CATEGORIES]
      .forEach(function (t) {
        var sh = sheet(t);
        if (sh.getLastRow() > 1) {
          sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
        }
      });

    var products = [], variants = [], tiers = [], cats = [];

    data.products.forEach(function (p, i) {
      products.push([
        p.sku, p.name, p.category, p.subcategory, p.description,
        p.moq, p.gst_rate, p.base_price, p.has_sizes ? 'TRUE' : 'FALSE',
        p.image, 14, 'TRUE', i
      ]);
      (p.tiers || []).forEach(function (t) {
        tiers.push([p.sku, t.min_qty, t.max_qty === null ? '' : t.max_qty, t.unit_price]);
      });
      (p.sizes || []).forEach(function (s) {
        variants.push([p.sku + '_' + s, p.sku, s, '', 'TRUE']);
      });
    });

    var n = 0;
    (data.categories || []).forEach(function (c) {
      (c.subcategories || []).forEach(function (s) {
        cats.push([s, c.slug, s, n++, 'TRUE']);
      });
    });

    write(SHEETS.PRODUCTS, products);
    write(SHEETS.VARIANTS, variants);
    write(SHEETS.TIERS, tiers);
    write(SHEETS.CATEGORIES, cats);

    var counts = {
      products: products.length, variants: variants.length,
      tiers: tiers.length, categories: cats.length
    };
    console.log('Catalogue rebuilt: ' + JSON.stringify(counts));
    return counts;
  });
}

/** Bulk write, far cheaper than appendRow in a loop. */
function write(tab, rows) {
  if (!rows.length) return;
  sheet(tab).getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Rotate the admin console password.
 *
 * PEPPER is deliberately left alone: changing it invalidates every stored
 * password and every outstanding approval link. API_TOKEN is left alone too,
 * because it has to match the value committed in app.js; to change that, edit
 * FIXED_API_TOKEN, push with clasp, and update app.js in the same change.
 */
function resetAdminPassword() {
  var adminPass = randomToken(9);
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASS', adminPass);
  console.log('New admin.html password: ' + adminPass);
  return adminPass;
}

/** Print the values the frontend needs, without regenerating anything. */
function showConfig() {
  var p = PropertiesService.getScriptProperties();
  console.log([
    'API_TOKEN   : ' + p.getProperty('API_TOKEN'),
    'ADMIN_PASS  : ' + p.getProperty('ADMIN_PASS'),
    'SHEET_ID    : ' + p.getProperty('SHEET_ID'),
    'FOLDER_ID   : ' + p.getProperty('FOLDER_ID'),
    'SITE_URL    : ' + p.getProperty('SITE_URL'),
    'web app URL : ' + ScriptApp.getService().getUrl()
  ].join('\n'));
}
