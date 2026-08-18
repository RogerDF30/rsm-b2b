/**
 * Outbound mail. Sent from SENDER_ALIAS, which must be a verified Workspace
 * "send as" alias, so approvals do not appear to come from a personal mailbox.
 * RSM runs Microsoft: confirm SPF and DMARC alignment before go-live.
 */

var CSS = [
  'body{font-family:Manrope,Arial,Helvetica,sans-serif;color:#00153D;margin:0;background:#F4F8FB}',
  '.wrap{max-width:720px;margin:0 auto;background:#fff;padding:28px}',
  '.bar{height:4px;background:#009CDE;width:56px;margin-bottom:18px}',
  'h2{margin:0 0 4px;font-size:20px}',
  'h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#5B6A80;',
  '   border-bottom:1px solid #DCE5EE;padding-bottom:6px;margin:26px 0 10px}',
  'table{width:100%;border-collapse:collapse;font-size:14px}',
  'th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;',
  '   color:#5B6A80;padding:8px;border-bottom:1px solid #DCE5EE}',
  'td{padding:9px 8px;border-bottom:1px solid #DCE5EE}',
  '.num{text-align:right}',
  '.btn{display:inline-block;padding:13px 30px;border-radius:8px;color:#fff;',
  '     text-decoration:none;font-weight:700;font-size:15px}',
  '.ok{background:#009CDE}.no{background:#00153D}',
  '.note{background:#E4F3FC;border-left:3px solid #009CDE;padding:12px 14px;font-size:14px}',
  '.quiet{background:#F4F8FB;border-left:3px solid #9AA6B8;padding:12px 14px;font-size:14px}',
  '.muted{color:#5B6A80;font-size:13px}',
  '.kv td:first-child{color:#5B6A80;width:34%}'
].join('');

/* Sheets hands back real Date objects. Printed raw they render as
   "Wed Sep 30 2026 00:00:00 GMT+0530 (India Standard Time)", which is not
   something to put in front of a client. */
function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'd MMM yyyy');
  return v === null || v === undefined ? '' : String(v);
}

/* ScriptApp returns the domain-scoped /a/<domain>/macros/ URL. Approvers are
   on @rsmus.com, so send them the plain form. */
function execUrl() {
  return ScriptApp.getService().getUrl().replace(/\/a\/[^\/]+\/macros\//, '/macros/');
}

function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function send(to, subject, html) {
  MailApp.sendEmail({
    to: to, subject: subject, htmlBody: html,
    name: 'RSM Business Store',
    replyTo: prop('SENDER_ALIAS', 'rsm@companystore.io')
  });
}

function page(inner) {
  return '<html><head><style>' + CSS + '</style></head><body><div class="wrap">' +
    '<div class="bar"></div>' + inner +
    '<p class="muted" style="margin-top:28px">RSM Business Store, operated by CompanyStore.IO.</p>' +
    '</div></body></html>';
}

function lineTable(lines) {
  var rows = lines.map(function (l) {
    return '<tr><td>' + esc(l.product_name) +
      (l.size ? '<div class="muted">Size ' + esc(l.size) + '</div>' : '') +
      '</td><td>' + esc(l.variant_sku) + '</td>' +
      '<td class="num">' + l.qty + '</td>' +
      '<td class="num">' + inr(l.unit_price) + '</td>' +
      '<td class="num">' + inr(l.line_total_with_tax) + '</td></tr>';
  }).join('');
  return '<table><thead><tr><th>Product</th><th>SKU</th><th class="num">Qty</th>' +
    '<th class="num">Unit</th><th class="num">Total inc GST</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function kv(pairs) {
  return '<table class="kv"><tbody>' + pairs.map(function (p) {
    return '<tr><td>' + esc(p[0]) + '</td><td>' + esc(p[1]) + '</td></tr>';
  }).join('') + '</tbody></table>';
}

/* ---------------------------------------------------------- approval mail */

/**
 * One mail per approver, each carrying its own signed, expiring link. This is
 * what makes a decision attributable, and what retires the shared code.
 */
function sendApprovalEmails(orderId, exp) {
  var o = findOrderRow(orderId);
  var lines = orderLines(orderId);
  var files = orderFiles(orderId);
  var base = execUrl();

  activeApprovers().forEach(function (a) {
    var email = String(a.approver_email).trim();
    var approveUrl = base + '?t=' + packApproval(orderId, email, exp, 'approve');
    var rejectUrl = base + '?t=' + packApproval(orderId, email, exp, 'reject');

    var html = page(
      '<h2>Order approval request</h2>' +
      '<p class="muted">' + esc(orderId) + ' is waiting on your decision.</p>' +

      '<h3>Order details</h3>' +
      kv([
        ['Order ID', orderId],
        ['Requested by', o.requester_name + ' (' + o.requester_email + ')'],
        ['Department (LOB)', o.lob],
        ['Event date', fmtDate(o.event_date)],
        ['Purpose', o.purpose],
        ['Order value', inr(o.grand_total) + ' including GST']
      ]) +

      '<h3>Items</h3>' + lineTable(lines) +
      '<table style="margin-top:10px"><tbody>' +
      '<tr><td class="num">Subtotal</td><td class="num" style="width:140px">' + inr(o.subtotal) + '</td></tr>' +
      '<tr><td class="num">GST</td><td class="num">' + inr(o.tax_total) + '</td></tr>' +
      '<tr><td class="num"><b>Total</b></td><td class="num"><b>' + inr(o.grand_total) + '</b></td></tr>' +
      '</tbody></table>' +

      '<h3>Evidence supplied</h3>' +
      (files.length
        ? files.map(function (f) {
            return '<div style="padding:6px 0"><a href="' + esc(f.drive_url) + '">' +
              esc(f.filename) + '</a></div>';
          }).join('')
        : '<p class="muted">None attached.</p>') +

      '<h3>Delivery</h3>' +
      kv([
        ['Ship to', o.ship_name],
        ['Address', o.ship_street + ', ' + o.ship_city + ' ' + o.ship_pincode],
        ['Phone', o.ship_phone]
      ]) +

      '<h3>Your decision</h3>' +
      '<p><a class="btn ok" href="' + approveUrl + '">Approve order</a>' +
      '&nbsp;&nbsp;<a class="btn no" href="' + rejectUrl + '">Reject order</a></p>' +
      '<div class="quiet">These links are unique to you and to this order. ' +
      'They expire in ' + APPROVAL_DAYS + ' days and stop working once a decision is recorded. ' +
      'No approval code is needed.</div>'
    );

    send(email, 'Order Approval Request: ' + orderId, html);
  });
}

/* ---------------------------------------------------------- decision mails */

function sendDecisionEmail(o, status, reason) {
  var lines = orderLines(o.order_id);
  var approved = status === 'Approved';

  var html = page(
    '<h2>Order ' + esc(o.order_id) + ' was ' + (approved ? 'approved' : 'rejected') + '</h2>' +
    (approved
      ? '<div class="quiet">Your order has been approved and passed to the CompanyStore.IO ' +
        'team. You will receive dispatch details once it ships.</div>'
      : '<div class="note"><b>Reason:</b> ' + esc(reason || 'No reason recorded.') +
        '<br><br>Rejected orders cannot be edited. Please raise a new order.</div>') +
    '<h3>Order details</h3>' +
    kv([
      ['Order ID', o.order_id], ['Department', o.lob],
      ['Event date', fmtDate(o.event_date)],
      ['Decided by', o.decided_by], ['Decided at', fmtDate(o.decided_at) || now()],
      ['Order value', inr(o.grand_total)]
    ]) +
    '<h3>Items</h3>' + lineTable(lines) +
    '<p style="margin-top:24px"><a class="btn ok" href="' +
      prop('SITE_URL', '') + '/status.html?id=' + encodeURIComponent(o.order_id) +
      '">View order status</a></p>'
  );

  send(o.requester_email, 'Order ' + o.order_id + ' ' + status, html);

  // Keep the CompanyStore.IO side informed without another manual step.
  send(prop('SENDER_ALIAS', 'rsm@companystore.io'),
    '[' + status + '] ' + o.order_id + ' - ' + o.requester_name, html);
}

function sendClosureEmail(o) {
  var html = page(
    '<h2>Order ' + esc(o.order_id) + ' has shipped</h2>' +
    '<div class="quiet">Your order is on its way.</div>' +
    '<h3>Dispatch details</h3>' +
    kv([
      ['Courier', o.courier || 'To be confirmed'],
      ['Tracking number', o.tracking_no || 'To be confirmed'],
      ['Ship to', o.ship_name + ', ' + o.ship_city]
    ]) +
    (o.tracking_url
      ? '<p><a class="btn ok" href="' + esc(o.tracking_url) + '">Track shipment</a></p>'
      : '')
  );
  send(o.requester_email, 'Order ' + o.order_id + ' dispatched', html);
}

function sendResetEmail(email, name, token) {
  var link = prop('SITE_URL', '') + '/reset.html?token=' + encodeURIComponent(token);
  var html = page(
    '<h2>Reset your password</h2>' +
    '<p>Hello ' + esc(name || '') + ',</p>' +
    '<p>Use the button below to set a new password for the RSM Business Store. ' +
    'The link is valid for ' + RESET_MINUTES + ' minutes and can be used once.</p>' +
    '<p><a class="btn ok" href="' + link + '">Set a new password</a></p>' +
    '<div class="quiet">If you did not request this, ignore this email. ' +
    'Your current password still works.</div>'
  );
  send(email, 'Reset your RSM Business Store password', html);
}
