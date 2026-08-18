/**
 * RSM B2B Store - configuration and sheet access.
 *
 * Script Properties that MUST be set before this works (Project Settings ->
 * Script Properties). Nothing secret lives in this file.
 *
 *   SHEET_ID      the backend spreadsheet id
 *   FOLDER_ID     Drive folder for evidence uploads
 *   API_TOKEN     shared token the static site sends (matches CONFIG.API_TOKEN)
 *   PEPPER        long random string, used for password hashing and HMAC tokens
 *   ADMIN_PASS    password for admin.html
 *   SENDER_ALIAS  e.g. rsm@companystore.io  (must be a verified "send as" alias)
 *   SITE_URL      https://<user>.github.io/rsm-b2b   (used in emails)
 */

var SHEETS = {
  CONFIG: 'Config',
  USERS: 'Users',
  APPROVERS: 'Approvers',
  PRODUCTS: 'Products',
  VARIANTS: 'Variants',
  TIERS: 'PriceTiers',
  CATEGORIES: 'Categories',
  ORDERS: 'Orders',
  LINES: 'OrderLines',
  FILES: 'Files',
  AUDIT: 'AuditLog'
};

var ORDER_PREFIX = 'RSMB';
/* Continues the Magento sequence. RSMB013681 was the last live order,
   15 June 2026. */
var ORDER_SEQ_START = 13682;

var SESSION_HOURS = 12;
var RESET_MINUTES = 60;
var APPROVAL_DAYS = 14;
var MAX_FAILED_LOGINS = 5;
var LOCKOUT_MINUTES = 15;

function prop(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && fallback === undefined) {
    throw new Error('Script Property "' + key + '" is not set.');
  }
  return v || fallback;
}

function book() {
  return SpreadsheetApp.openById(prop('SHEET_ID'));
}

function sheet(name) {
  var sh = book().getSheetByName(name);
  if (!sh) throw new Error('Sheet tab "' + name + '" is missing. Run setupBackend().');
  return sh;
}

/** Whole tab as an array of objects keyed by the header row. */
function readTab(name) {
  var values = sheet(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).map(function (row, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, c) { if (h) o[h] = row[c]; });
    return o;
  }).filter(function (o) {
    // drop fully blank rows
    return Object.keys(o).some(function (k) { return k !== '_row' && o[k] !== ''; });
  });
}

function headerIndex(name) {
  var head = sheet(name).getRange(1, 1, 1, sheet(name).getLastColumn()).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { if (h) map[String(h).trim()] = i + 1; });
  return map;
}

/** Append one object, ordered by the tab's header row. */
function appendRow(name, obj) {
  var sh = sheet(name);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(head.map(function (h) {
    var v = obj[String(h).trim()];
    return v === undefined || v === null ? '' : v;
  }));
}

/** Patch named fields on one row. */
function updateRow(name, rowNumber, patch) {
  var idx = headerIndex(name);
  var sh = sheet(name);
  Object.keys(patch).forEach(function (k) {
    if (idx[k]) sh.getRange(rowNumber, idx[k]).setValue(patch[k]);
  });
}

function now() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
}

function audit(actor, action, entity, entityId, before, after) {
  try {
    appendRow(SHEETS.AUDIT, {
      ts: now(), actor_email: actor || 'system', action: action,
      entity: entity, entity_id: entityId,
      before: before ? JSON.stringify(before).slice(0, 4000) : '',
      after: after ? JSON.stringify(after).slice(0, 4000) : '',
      user_agent: ''
    });
  } catch (err) {
    // An audit failure must never take down the operation it was recording.
    console.error('audit failed: ' + err.message);
  }
}

/** Every write goes through here. Sheets is not transactional. */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('System busy, please retry.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function nextOrderId() {
  return withLock(function () {
    var props = PropertiesService.getScriptProperties();
    var n = Number(props.getProperty('ORDER_SEQ') || ORDER_SEQ_START);
    props.setProperty('ORDER_SEQ', String(n + 1));
    return ORDER_PREFIX + Utilities.formatString('%06d', n);
  });
}
