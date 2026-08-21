/**
 * Order submission, lookup, approval decisions and closure.
 *
 * Prices are ALWAYS recomputed here from the Products and PriceTiers tabs.
 * The browser sends its own figures only so a mismatch can be rejected.
 */

/* --------------------------------------------------------------- catalogue */

function catalogMaps() {
  var products = {};
  readTab(SHEETS.PRODUCTS).forEach(function (p) {
    if (String(p.active).toUpperCase() === 'FALSE') return;
    products[String(p.sku).trim()] = p;
  });

  var tiers = {};
  readTab(SHEETS.TIERS).forEach(function (t) {
    var k = String(t.parent_sku).trim();
    (tiers[k] = tiers[k] || []).push({
      min_qty: Number(t.min_qty),
      max_qty: t.max_qty === '' ? null : Number(t.max_qty),
      unit_price: Number(t.unit_price)
    });
  });
  return { products: products, tiers: tiers };
}

/** Highest tier whose min_qty is still <= n. Mirrors pickTier() in app.js. */
function serverPickTier(list, n) {
  var best = null;
  (list || []).forEach(function (t) {
    if (n >= t.min_qty && (!best || t.min_qty > best.min_qty)) best = t;
  });
  return best;
}

/**
 * Authoritative pricing. Quantity rolls up by parent SKU across sizes, the
 * matching tier applies to every line in that group, and the group total must
 * meet the product MOQ.
 */
function priceOrder(rawLines) {
  var cat = catalogMaps();
  var groups = {};

  rawLines.forEach(function (l) {
    var sku = String(l.parent_sku).trim();
    var n = Math.floor(Number(l.qty) || 0);
    if (n <= 0) return;
    (groups[sku] = groups[sku] || []).push({
      parent_sku: sku, variant_sku: l.variant_sku || sku,
      size: l.size || '', qty: n
    });
  });

  // The kit builder can put a sized product in the cart with the size still to
  // be chosen. The cart makes the requester split it, but nothing stops a
  // hand-made POST, so refuse an unsized line here too.
  Object.keys(groups).forEach(function (sku) {
    var p = cat.products[sku];
    // p is the raw sheet row, so has_sizes is the string 'TRUE'/'FALSE'
    if (!p || String(p.has_sizes).toUpperCase() !== 'TRUE') return;
    groups[sku].forEach(function (i) {
      if (!i.size) {
        throw new Error(p.name + ' needs a size on every unit. Open the cart and split the quantity across sizes.');
      }
    });
  });

  var lines = [], subtotal = 0, taxTotal = 0;

  Object.keys(groups).forEach(function (sku) {
    var p = cat.products[sku];
    if (!p) throw new Error('Product ' + sku + ' is no longer available.');

    var items = groups[sku];
    var groupQty = items.reduce(function (a, i) { return a + i.qty; }, 0);
    var moq = Number(p.moq || 1);
    if (groupQty < moq) {
      throw new Error(p.name + ' needs at least ' + moq + ' units. You have ' + groupQty + '.');
    }

    var tier = serverPickTier(cat.tiers[sku], groupQty);
    var unit = tier ? tier.unit_price : Number(p.base_price);
    var gst = Number(p.gst_rate || 0);
    var band = tier ? (tier.max_qty ? tier.min_qty + '-' + tier.max_qty : tier.min_qty + '+') : '';

    items.forEach(function (i) {
      var lineTotal = unit * i.qty;
      var tax = lineTotal * gst / 100;
      subtotal += lineTotal;
      taxTotal += tax;
      lines.push({
        parent_sku: sku, variant_sku: i.variant_sku, product_name: p.name,
        size: i.size, qty: i.qty, group_qty: groupQty, tier_applied: band,
        unit_price: unit, line_total: lineTotal, gst_rate: gst,
        tax_amount: round2(tax), line_total_with_tax: round2(lineTotal + tax)
      });
    });
  });

  if (!lines.length) throw new Error('The order has no valid lines.');

  return {
    lines: lines,
    subtotal: round2(subtotal),
    tax_total: round2(taxTotal),
    grand_total: round2(subtotal + taxTotal)
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

/* ------------------------------------------------------------- submission */

function fnSubmitOrder(req) {
  var user = requireSession(req);
  var o = req.order || {};
  var files = req.files || [];

  if (!files.length) throw new Error('At least one evidence file is required.');
  ['requester_name', 'lob', 'lob_approver', 'event_date', 'purpose', 'ship_name',
   'ship_phone', 'ship_street', 'ship_city', 'ship_pincode'].forEach(function (k) {
    if (!String(o[k] || '').trim()) throw new Error('Missing required field: ' + k);
  });

  var priced = priceOrder(req.lines || []);

  // The browser's total is advisory. A mismatch means the tier table changed
  // under the user, or the payload was tampered with. Either way, stop.
  if (req.client_total !== undefined && req.client_total !== null &&
      Math.abs(Number(req.client_total) - priced.grand_total) > 1) {
    throw new Error('Prices have changed since you loaded the catalogue. Please review your cart.');
  }

  var orderId = nextOrderId();
  var stored = saveEvidence(orderId, files, user.email);

  var exp = Date.now() + APPROVAL_DAYS * 86400000;
  var approvers = activeApprovers();
  if (!approvers.length) throw new Error('No approvers are configured. Contact CompanyStore.IO.');

  withLock(function () {
    appendRow(SHEETS.ORDERS, {
      order_id: orderId, created_at: now(),
      requester_email: user.email, requester_name: o.requester_name,
      requester_phone: o.requester_phone || '', lob: o.lob,
      lob_approver: o.lob_approver || '',
      event_date: o.event_date, purpose: o.purpose,
      cost_centre: o.cost_centre || '',
      ship_name: o.ship_name, ship_phone: o.ship_phone, ship_email: user.email,
      ship_street: o.ship_street, ship_city: o.ship_city,
      ship_state: o.ship_state || '', ship_pincode: o.ship_pincode,
      ship_country: o.ship_country || 'India',
      bill_name: o.bill_name || o.ship_name, bill_phone: o.bill_phone || o.ship_phone,
      bill_street: o.bill_street || o.ship_street, bill_city: o.bill_city || o.ship_city,
      bill_state: o.bill_state || o.ship_state || '',
      bill_pincode: o.bill_pincode || o.ship_pincode,
      bill_country: o.bill_country || 'India',
      subtotal: priced.subtotal, tax_total: priced.tax_total,
      shipping_total: 0, grand_total: priced.grand_total,
      status: 'Pending Approval',
      token_expires_at: exp,
      decided_by: '', decided_at: '', rejection_reason: '',
      notified_at: '', closed_by: '', closed_at: '',
      courier: '', tracking_no: '', tracking_url: '', zoho_so_id: ''
    });

    priced.lines.forEach(function (l, i) {
      appendRow(SHEETS.LINES, {
        order_id: orderId, line_no: i + 1, parent_sku: l.parent_sku,
        variant_sku: l.variant_sku, product_name: l.product_name, size: l.size,
        qty: l.qty, group_qty: l.group_qty, tier_applied: l.tier_applied,
        unit_price: l.unit_price, line_total: l.line_total,
        gst_rate: l.gst_rate, tax_amount: l.tax_amount,
        line_total_with_tax: l.line_total_with_tax
      });
    });
  });

  audit(user.email, 'order_submitted', 'order', orderId, null,
    { total: priced.grand_total, lines: priced.lines.length });

  sendApprovalEmails(orderId, exp);
  withLock(function () {
    var row = findOrderRow(orderId);
    updateRow(SHEETS.ORDERS, row._row, { notified_at: now() });
  });

  // after the approval email, never before: the email is what actually moves
  // the order forward, the chat message only tells the room about it
  notifyChat('submitted', findOrderRow(orderId), { items: priced.lines.length });

  return { ok: true, order_id: orderId, total: priced.grand_total };
}

function saveEvidence(orderId, files, actor) {
  var parent = DriveApp.getFolderById(prop('FOLDER_ID'));
  var folder = parent.createFolder(orderId);
  var out = [];

  files.forEach(function (f) {
    var bytes = Utilities.base64Decode(f.data);
    if (bytes.length > 8 * 1024 * 1024) throw new Error(f.name + ' is over 8 MB.');
    var blob = Utilities.newBlob(bytes, f.mime || 'application/octet-stream', f.name);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    appendRow(SHEETS.FILES, {
      file_id: file.getId(), order_id: orderId, filename: f.name,
      mime: f.mime || '', bytes: bytes.length, drive_url: file.getUrl(),
      uploaded_by: actor, uploaded_at: now()
    });
    out.push({ filename: f.name, drive_url: file.getUrl() });
  });
  return out;
}

function activeApprovers() {
  return readTab(SHEETS.APPROVERS).filter(function (a) {
    return String(a.active).toUpperCase() !== 'FALSE' && String(a.approver_email).indexOf('@') > 0;
  });
}

/* ----------------------------------------------------------------- lookup */

function findOrderRow(orderId) {
  var rows = readTab(SHEETS.ORDERS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].order_id).trim() === String(orderId).trim()) return rows[i];
  }
  return null;
}

function orderLines(orderId) {
  return readTab(SHEETS.LINES).filter(function (l) {
    return String(l.order_id).trim() === String(orderId).trim();
  });
}

function orderFiles(orderId) {
  return readTab(SHEETS.FILES).filter(function (f) {
    return String(f.order_id).trim() === String(orderId).trim();
  });
}

function fnGetOrder(req) {
  var o = findOrderRow(req.order_id);
  var email = String(req.email || '').trim().toLowerCase();
  // The email must match the requester. Order IDs are sequential and guessable,
  // which is exactly the hole the old system had.
  if (!o || String(o.requester_email).trim().toLowerCase() !== email) {
    throw new Error('No order found for that ID and email.');
  }
  return { ok: true, order: o, lines: orderLines(o.order_id), files: orderFiles(o.order_id) };
}

/* -------------------------------------------------------------- decisions */

function applyDecision(orderId, action, approverEmail, reason) {
  return withLock(function () {
    var o = findOrderRow(orderId);
    if (!o) throw new Error('Order ' + orderId + ' not found.');
    if (o.status !== 'Pending Approval') {
      return { already: true, status: o.status, order: o };
    }

    var status = action === 'approve' ? 'Approved' : 'Rejected';
    updateRow(SHEETS.ORDERS, o._row, {
      status: status, decided_by: approverEmail, decided_at: now(),
      rejection_reason: action === 'reject' ? (reason || '') : ''
    });
    audit(approverEmail, 'order_' + status.toLowerCase(), 'order', orderId,
      { status: o.status }, { status: status, reason: reason || '' });

    o.status = status;
    o.decided_by = approverEmail;
    o.rejection_reason = reason || '';
    return { already: false, status: status, order: o };
  });
}

/* Both the approval page and the API land here, so one hook covers approve and
   reject. Called outside the lock: a slow webhook should not hold the sheet. */
function announceDecision(result) {
  if (!result || result.already) return;
  notifyChat(result.status === 'Approved' ? 'approved' : 'rejected', result.order);
}

/* --------------------------------------------------------------- closure */

function fnCloseOrder(req) {
  requireAdmin(req);
  var result = withLock(function () {
    var o = findOrderRow(req.order_id);
    if (!o) throw new Error('Order not found.');
    if (o.status !== 'Approved') throw new Error('Only approved orders can be closed.');
    updateRow(SHEETS.ORDERS, o._row, {
      status: 'Closed', closed_at: now(), closed_by: 'admin',
      courier: req.courier || '', tracking_no: req.tracking_no || '',
      tracking_url: req.tracking_url || ''
    });
    audit('admin', 'order_closed', 'order', o.order_id,
      { status: 'Approved' }, { tracking: req.tracking_no || '' });
    o.status = 'Closed';
    o.courier = req.courier || '';
    o.tracking_no = req.tracking_no || '';
    o.tracking_url = req.tracking_url || '';
    return o;
  });
  sendClosureEmail(result);
  return { ok: true };
}

/* ----------------------------------------------------------------- admin */

function fnAdminList(req) {
  requireAdmin(req);
  var lines = readTab(SHEETS.LINES);
  var counts = {};
  lines.forEach(function (l) {
    var k = String(l.order_id).trim();
    counts[k] = (counts[k] || 0) + 1;
  });
  var orders = readTab(SHEETS.ORDERS).map(function (o) {
    o.line_count = counts[String(o.order_id).trim()] || 0;
    return o;
  }).reverse();
  return { ok: true, orders: orders };
}

function fnAdminOrder(req) {
  requireAdmin(req);
  var o = findOrderRow(req.order_id);
  if (!o) throw new Error('Order not found.');
  return { ok: true, order: o, lines: orderLines(o.order_id), files: orderFiles(o.order_id) };
}

function fnAdminResend(req) {
  requireAdmin(req);
  var o = findOrderRow(req.order_id);
  if (!o) throw new Error('Order not found.');
  if (o.status !== 'Pending Approval') throw new Error('That order already has a decision.');
  var exp = Date.now() + APPROVAL_DAYS * 86400000;
  updateRow(SHEETS.ORDERS, o._row, { token_expires_at: exp, notified_at: now() });
  sendApprovalEmails(o.order_id, exp);
  audit('admin', 'approval_resent', 'order', o.order_id, null, null);
  return { ok: true };
}
