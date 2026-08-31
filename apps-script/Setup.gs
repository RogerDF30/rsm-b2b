/**
 * One-time backend setup. Run setupBackend() from the editor, once.
 *
 * Order of operations:
 *   1. Create a blank Google Sheet, copy its id into Script Property SHEET_ID.
 *   2. Create a Drive folder for evidence, copy its id into FOLDER_ID.
 *   3. Set API_TOKEN, PEPPER, ADMIN_PASS, SENDER_ALIAS, SITE_URL.
 *   4. Run setupBackend()  -> creates every tab with its header row.
 *   5. Paste sheet-seed/*.csv into the matching tabs (File > Import > Append).
 *   6. Add rows to Users and Approvers, then run seedPasswords().
 *   7. Deploy > New deployment > Web app, execute as Me, access Anyone.
 *   8. Paste the /exec URL into assets/js/app.js CONFIG.API_URL.
 */

var TAB_HEADERS = {
  Config: ['key', 'value', 'note'],

  Users: ['email', 'full_name', 'lob', 'password_hash', 'salt', 'must_reset',
    'failed_attempts', 'locked_until', 'default_ship_name', 'default_ship_phone',
    'default_ship_street', 'default_ship_city', 'default_ship_pincode',
    'active', 'created_at', 'last_login'],

  Approvers: ['approver_name', 'approver_email', 'receives_all', 'active'],

  /* The RSM-side line of business and the partner who sanctions its spend.
     This is what feeds the two checkout dropdowns. It is NOT the same as
     Approvers, which is who receives the approval email. */
  Departments: ['lob', 'approver_name', 'active'],

  Products: ['sku', 'name', 'category', 'subcategory', 'description', 'moq',
    'gst_rate', 'base_price', 'has_sizes', 'image', 'lead_time_days',
    'active', 'sort_order', 'related_skus', 'auto_related_skus'],

  /* Homepage banners. image_url points at a Drive file shared
     anyone-with-link, uploaded through the admin console. */
  Banners: ['slug', 'title', 'subtitle', 'image_url', 'link_url',
    'sort_order', 'active'],

  /* Free-form site settings: logo urls, hero copy. key/value so new ones
     need no schema change. */
  Settings: ['key', 'value', 'note'],

  Variants: ['variant_sku', 'parent_sku', 'size', 'stock_qty', 'active'],

  PriceTiers: ['parent_sku', 'min_qty', 'max_qty', 'unit_price'],

  Categories: ['slug', 'parent_slug', 'label', 'sort_order', 'active'],

  Orders: ['order_id', 'created_at', 'requester_email', 'requester_name',
    'requester_phone', 'lob', 'lob_approver', 'event_date', 'purpose', 'cost_centre',
    'ship_name', 'ship_phone', 'ship_email', 'ship_street', 'ship_city',
    'ship_state', 'ship_pincode', 'ship_country',
    'bill_name', 'bill_phone', 'bill_street', 'bill_city', 'bill_state',
    'bill_pincode', 'bill_country',
    'subtotal', 'tax_total', 'shipping_total', 'grand_total', 'status',
    'token_expires_at', 'decided_by', 'decided_at', 'rejection_reason',
    'notified_at', 'closed_by', 'closed_at', 'courier', 'tracking_no',
    'tracking_url', 'zoho_so_id', 'raised_by'],

  OrderLines: ['order_id', 'line_no', 'parent_sku', 'variant_sku',
    'product_name', 'size', 'qty', 'group_qty', 'tier_applied', 'unit_price',
    'line_total', 'gst_rate', 'tax_amount', 'line_total_with_tax', 'below_moq',
    'list_unit_price', 'negotiated'],

  Files: ['file_id', 'order_id', 'filename', 'mime', 'bytes', 'drive_url',
    'uploaded_by', 'uploaded_at'],

  AuditLog: ['ts', 'actor_email', 'action', 'entity', 'entity_id',
    'before', 'after', 'user_agent'],

  /* Storefront behaviour, written by fnTrack. One row per event, trimmed to
     the newest EVENT_CAP rows. Nothing here identifies a person beyond the
     email of someone already signed in. */
  Events: ['ts', 'session_id', 'visitor_id', 'is_new', 'referrer', 'title',
    'device', 'event', 'path', 'sku', 'query', 'qty', 'value',
    'user_email', 'user_agent']
};

function setupBackend() {
  var ss = book();
  Object.keys(TAB_HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = TAB_HEADERS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    sh.getRange(1, 1, 1, head.length)
      .setFontWeight('bold').setBackground('#F4F8FB');
    sh.setFrozenRows(1);
  });

  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  console.log('Created ' + Object.keys(TAB_HEADERS).length + ' tabs.');
  console.log('Next: import the sheet-seed CSVs, then add Users and Approvers rows.');
}

/**
 * Hash the plaintext in a temporary `initial_password` column into
 * password_hash + salt, then blank the plaintext. Add that column, fill it,
 * run this, delete the column.
 */
function seedPasswords() {
  var rows = readTab(SHEETS.USERS);
  var idx = headerIndex(SHEETS.USERS);
  if (!idx.initial_password) {
    throw new Error('Add a temporary "initial_password" column to Users first.');
  }
  var sh = sheet(SHEETS.USERS);
  var n = 0;

  rows.forEach(function (u) {
    var pw = String(u.initial_password || '').trim();
    if (!pw) return;
    var salt = randomToken(12);
    updateRow(SHEETS.USERS, u._row, {
      salt: salt, password_hash: hashPassword(pw, salt),
      must_reset: 'TRUE', failed_attempts: 0, locked_until: '',
      active: u.active || 'TRUE', created_at: u.created_at || now()
    });
    sh.getRange(u._row, idx.initial_password).setValue('');
    n++;
  });
  console.log('Hashed ' + n + ' passwords. Now delete the initial_password column.');
}

/** Sanity check after setup. Run it and read the log. */
function healthCheck() {
  var problems = [];
  ['SHEET_ID', 'FOLDER_ID', 'API_TOKEN', 'PEPPER', 'ADMIN_PASS'].forEach(function (k) {
    try { prop(k); } catch (err) { problems.push('Missing Script Property: ' + k); }
  });

  Object.keys(TAB_HEADERS).forEach(function (t) {
    try { sheet(t); } catch (err) { problems.push(err.message); }
  });

  try {
    var products = readTab(SHEETS.PRODUCTS).length;
    var tiers = readTab(SHEETS.TIERS).length;
    var users = readTab(SHEETS.USERS).length;
    var approvers = activeApprovers().length;
    console.log('products=' + products + ' tiers=' + tiers +
      ' users=' + users + ' active approvers=' + approvers);
    if (!products) problems.push('Products tab is empty.');
    if (!tiers) problems.push('PriceTiers tab is empty.');
    if (!approvers) problems.push('No active approvers.');

    // Every product must have at least one tier, or pricing silently falls
    // back to base_price and the MOQ ladder is meaningless.
    var haveTiers = {};
    readTab(SHEETS.TIERS).forEach(function (t) { haveTiers[String(t.parent_sku).trim()] = 1; });
    var missing = readTab(SHEETS.PRODUCTS)
      .filter(function (p) { return !haveTiers[String(p.sku).trim()]; })
      .map(function (p) { return p.sku; });
    if (missing.length) {
      problems.push(missing.length + ' products have no tier rows: ' +
        missing.slice(0, 10).join(', ') + (missing.length > 10 ? '…' : ''));
    }
  } catch (err) {
    problems.push(err.message);
  }

  try {
    DriveApp.getFolderById(prop('FOLDER_ID'));
  } catch (err) {
    problems.push('FOLDER_ID is not a folder this account can open.');
  }

  console.log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'All checks passed.');
  return problems;
}


/**
 * Bring an already-bootstrapped Sheet up to the current schema. Idempotent.
 *
 * Inserts the Orders.lob_approver column IN PLACE rather than rewriting the
 * header row, so existing order rows stay aligned with their data.
 */
function upgradeSchema() {
  var ss = book();
  var done = [];

  // 0. below_moq on OrderLines. Orders under the minimum are accepted now, and
  //    the approver is told which lines are short.
  var linesSh = ss.getSheetByName(SHEETS.LINES);
  if (linesSh) {
    var lineHead = linesSh.getRange(1, 1, 1, linesSh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    if (lineHead.indexOf('below_moq') < 0) {
      linesSh.getRange(1, lineHead.length + 1).setValue('below_moq')
        .setFontWeight('bold').setBackground('#F4F8FB');
      done.push('added below_moq to OrderLines');
    }
  }

  /* 0b. Negotiated pricing. An admin can raise an order for a client at a
         price that was agreed off the catalogue. list_unit_price keeps the
         tier price the line would otherwise have carried, so the size of the
         concession stays on the record instead of vanishing into the total. */
  if (linesSh) {
    ['list_unit_price', 'negotiated'].forEach(function (col) {
      var h = linesSh.getRange(1, 1, 1, linesSh.getLastColumn()).getValues()[0]
        .map(function (x) { return String(x).trim(); });
      if (h.indexOf(col) < 0) {
        linesSh.getRange(1, h.length + 1).setValue(col)
          .setFontWeight('bold').setBackground('#F4F8FB');
        done.push('added ' + col + ' to OrderLines');
      }
    });
  }

  // 0c. raised_by on Orders, so an admin-raised order is visible as one.
  var ordersSh0 = ss.getSheetByName(SHEETS.ORDERS);
  if (ordersSh0) {
    var oHead0 = ordersSh0.getRange(1, 1, 1, ordersSh0.getLastColumn()).getValues()[0]
      .map(function (x) { return String(x).trim(); });
    if (oHead0.indexOf('raised_by') < 0) {
      ordersSh0.getRange(1, oHead0.length + 1).setValue('raised_by')
        .setFontWeight('bold').setBackground('#F4F8FB');
      done.push('added raised_by to Orders');
    }
  }

  // 1. Departments tab
  if (!ss.getSheetByName(SHEETS.DEPARTMENTS)) {
    var sh = ss.insertSheet(SHEETS.DEPARTMENTS);
    var head = TAB_HEADERS.Departments;
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#F4F8FB');
    sh.setFrozenRows(1);
    done.push('created the Departments tab');
  }
  if (!readTab(SHEETS.DEPARTMENTS).length) {
    seedDepartments();
    done.push('seeded ' + readTab(SHEETS.DEPARTMENTS).length + ' departments');
  }

  // 2. Banners and Settings tabs
  [SHEETS.BANNERS, SHEETS.SETTINGS].forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var sh2 = ss.insertSheet(name);
    var h = TAB_HEADERS[name];
    sh2.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setBackground('#F4F8FB');
    sh2.setFrozenRows(1);
    done.push('created the ' + name + ' tab');
  });
  if (!readTab(SHEETS.SETTINGS).length || !readTab(SHEETS.BANNERS).length) {
    seedSiteContent();
    done.push('seeded site settings and a starter banner');
  }

  /* 2b. Shipping and handling rate. Added after the store was live, so a
         Settings tab that already exists will not have it. */
  if (ss.getSheetByName(SHEETS.SETTINGS)) {
    var hasPct = readTab(SHEETS.SETTINGS).some(function (r) {
      return String(r.key).trim() === 'shipping_pct';
    });
    if (!hasPct) {
      appendRow(SHEETS.SETTINGS, {
        key: 'shipping_pct', value: String(SHIPPING_PCT_DEFAULT),
        note: 'Shipping and handling, as a percentage of the subtotal before GST'
      });
      done.push('seeded shipping_pct at ' + SHIPPING_PCT_DEFAULT + '%');
    }
  }

  // 3. Products.related_skus, and the column the auto-mapper owns
  var pIdx = headerIndex(SHEETS.PRODUCTS);
  ['related_skus', 'auto_related_skus'].forEach(function (col) {
    if (headerIndex(SHEETS.PRODUCTS)[col]) return;
    var ps = sheet(SHEETS.PRODUCTS);
    ps.getRange(1, ps.getLastColumn() + 1).setValue(col)
      .setFontWeight('bold').setBackground('#F4F8FB');
    done.push('added Products.' + col);
  });

  // 3b. Events tab, added after the store was already live
  if (!ss.getSheetByName(SHEETS.EVENTS)) {
    var ev = ss.insertSheet(SHEETS.EVENTS);
    var eh = TAB_HEADERS.Events;
    ev.getRange(1, 1, 1, eh.length).setValues([eh])
      .setFontWeight('bold').setBackground('#F4F8FB');
    ev.setFrozenRows(1);
    done.push('created the Events tab');
  } else {
    // Events shipped before visitor, device and referrer existed. appendRow
    // writes by header name, so a missing column silently drops its value.
    var ev = sheet(SHEETS.EVENTS);
    var have = headerIndex(SHEETS.EVENTS);
    TAB_HEADERS.Events.forEach(function (col) {
      if (have[col]) return;
      ev.getRange(1, ev.getLastColumn() + 1).setValue(col)
        .setFontWeight('bold').setBackground('#F4F8FB');
      done.push('added Events.' + col);
    });
  }

  // 4. Orders.lob_approver, inserted right after lob
  var idx = headerIndex(SHEETS.ORDERS);
  if (!idx.lob_approver) {
    var orders = sheet(SHEETS.ORDERS);
    orders.insertColumnAfter(idx.lob);
    orders.getRange(1, idx.lob + 1).setValue('lob_approver')
      .setFontWeight('bold').setBackground('#F4F8FB');
    done.push('inserted Orders.lob_approver after column ' + idx.lob);
  }

  console.log(done.length ? 'Upgraded:\n- ' + done.join('\n- ') : 'Already up to date.');
  return done;
}
