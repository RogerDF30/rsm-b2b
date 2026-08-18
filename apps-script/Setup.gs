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
    'active', 'sort_order'],

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
    'tracking_url', 'zoho_so_id'],

  OrderLines: ['order_id', 'line_no', 'parent_sku', 'variant_sku',
    'product_name', 'size', 'qty', 'group_qty', 'tier_applied', 'unit_price',
    'line_total', 'gst_rate', 'tax_amount', 'line_total_with_tax'],

  Files: ['file_id', 'order_id', 'filename', 'mime', 'bytes', 'drive_url',
    'uploaded_by', 'uploaded_at'],

  AuditLog: ['ts', 'actor_email', 'action', 'entity', 'entity_id',
    'before', 'after', 'user_agent']
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

  // 2. Orders.lob_approver, inserted right after lob
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
