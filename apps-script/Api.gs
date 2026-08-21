/**
 * HTTP surface.
 *
 * doPost  - JSON API for the static site.
 * doGet   - the approver's decision page, reached from the approval email.
 *
 * IMPORTANT: Apps Script cannot answer a CORS preflight OPTIONS request, so the
 * browser must POST with Content-Type text/plain. Do not "fix" the frontend to
 * send application/json; every write will start failing.
 */

/* Built lazily, not as a top-level var. Apps Script evaluates files in
   alphabetical order, so Api.gs runs before Auth.gs and Orders.gs have
   declared their handlers: a top-level map would capture undefined. */
function routes() {
  return {
    login: fnLogin,
    resetRequest: fnResetRequest,
    resetConfirm: fnResetConfirm,
    submitOrder: fnSubmitOrder,
    getOrder: fnGetOrder,
    closeOrder: fnCloseOrder,
    adminList: fnAdminList,
    adminOrder: fnAdminOrder,
    adminResend: fnAdminResend,
    adminUpgrade: fnAdminUpgrade,
    adminCatalog: fnAdminCatalog,
    adminSaveProduct: fnAdminSaveProduct,
    adminDeleteProduct: fnAdminDeleteProduct,
    adminToggle: fnAdminToggle,
    adminAutoRelate: fnAdminAutoRelate,
    adminSetAnalyticsPass: fnAdminSetAnalyticsPass,
    track: fnTrack,
    analytics: fnAnalytics,
    adminUploadImage: fnAdminUploadImage,
    adminSaveBanner: fnAdminSaveBanner,
    adminDeleteBanner: fnAdminDeleteBanner,
    adminSaveSettings: fnAdminSaveSettings,
    adminPublish: fnAdminPublish
  };
}

/* Admin-gated schema migration, so a column or tab can be added without an
   editor visit. Creates structure only; it never touches order data. */
function fnAdminUpgrade(req) {
  requireAdmin(req);
  var done = upgradeSchema();
  audit('admin', 'schema_upgrade', 'sheet', prop('SHEET_ID'), null, { steps: done });
  return { ok: true, steps: done, events_header: Object.keys(headerIndex(SHEETS.EVENTS)) };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Malformed request.' });
  }

  try {
    if (!safeEqual(req.token || '', prop('API_TOKEN'))) {
      return json({ ok: false, error: 'Unauthorised.' });
    }
    var handler = routes()[req.fn];
    if (!handler) return json({ ok: false, error: 'Unknown function: ' + req.fn });
    return json(handler(req));
  } catch (err) {
    console.error(req.fn + ': ' + err.message);
    return json({ ok: false, error: err.message });
  }
}

/* ------------------------------------------------------- approver decision */

function html(inner, title) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><base target="_top"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' + CSS +
    'input,textarea{width:100%;padding:10px 12px;border:1px solid #DCE5EE;' +
    'border-radius:8px;font-family:inherit;font-size:15px;box-sizing:border-box}' +
    'textarea{min-height:110px}' +
    'button{border:0;padding:13px 30px;border-radius:8px;color:#fff;font-weight:700;' +
    'font-size:15px;cursor:pointer;font-family:inherit}' +
    'button:disabled{background:#9AA6B8}' +
    '</style></head><body><div class="wrap"><div class="bar"></div>' +
    inner + '</div></body></html>')
    .setTitle(title || 'Order approval')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGet(e) {
  var p = e.parameter || {};

  /* Health check. Also the quickest way to prove the deployment is serving
     JSON, since everything else on this path returns HTML. */
  if (p.fn === 'ping') {
    try {
      return json({
        ok: true, ts: now(),
        products: readTab(SHEETS.PRODUCTS).length,
        tiers: readTab(SHEETS.TIERS).length,
        approvers: activeApprovers().length,
        orders: readTab(SHEETS.ORDERS).length
      });
    } catch (err) {
      return json({ ok: false, error: err.message });
    }
  }

  /* Feeds the Department and Approver dropdowns on checkout. */
  if (p.fn === 'meta') {
    try {
      var deps = readTab(SHEETS.DEPARTMENTS)
        .filter(function (d) { return String(d.active).toUpperCase() !== 'FALSE'; })
        .map(function (d) {
          return { lob: String(d.lob).trim(), approver: String(d.approver_name || '').trim() };
        });
      return json({ ok: true, departments: deps });
    } catch (err) {
      return json({ ok: false, error: err.message });
    }
  }

  /* One packed parameter, see packApproval() for why. Falls back to the old
     four-parameter form so links already in someone's inbox keep working. */
  var d = unpackApproval(p.t);
  var orderId = d ? d.orderId : (p.orderId || '');
  var who = d ? d.who : (p.who || '');
  var act = d ? d.act : (p.act === 'reject' ? 'reject' : 'approve');
  var exp = d ? d.exp : p.exp;
  var sig = d ? approvalToken(orderId, who, exp) : (p.sig || '');

  if (!verifyApprovalToken(orderId, who, exp, sig)) {
    return html('<h2>This link is not valid</h2>' +
      '<div class="note">It may have expired, or it may have been altered. ' +
      'Ask CompanyStore.IO to resend the approval email for ' + esc(orderId) + '.</div>',
      'Link not valid');
  }

  var o = findOrderRow(orderId);
  if (!o) return html('<h2>Order not found</h2>', 'Not found');

  if (o.status !== 'Pending Approval') {
    return html('<h2>Already decided</h2>' +
      '<div class="quiet">' + esc(orderId) + ' was already <b>' + esc(o.status) + '</b>' +
      (o.decided_by ? ' by ' + esc(o.decided_by) : '') +
      (o.decided_at ? ' on ' + esc(o.decided_at) : '') + '. No further change is possible.</div>',
      'Already decided');
  }

  var lines = orderLines(orderId);
  var args = "'" + act + "','" + orderId + "','" + who + "','" + exp + "','" + sig + "'";

  return html(
    '<h2>' + (act === 'approve' ? 'Approve' : 'Reject') + ' order ' + esc(orderId) + '</h2>' +
    '<p class="muted">Signed in as ' + esc(who) + '</p>' +
    kv([
      ['Requested by', o.requester_name],
      ['Department', o.lob],
      ['Approver', o.lob_approver || 'Not stated'],
      ['Event date', fmtDate(o.event_date)],
      ['Order value', inr(o.grand_total)]
    ]) +
    '<h3>Items</h3>' + lineTable(lines) +
    '<h3>Confirm</h3>' +
    (act === 'reject'
      ? '<p><label>Reason for rejection, shared with the requester</label>' +
        '<textarea id="reason" placeholder="Why this order is being rejected"></textarea></p>'
      : '') +
    '<p><button id="go" class="' + (act === 'approve' ? 'ok' : 'no') + '" ' +
    'style="background:' + (act === 'approve' ? '#2E9E4F' : '#D93025') + '">' +
    (act === 'approve' ? 'Confirm approval' : 'Confirm rejection') + '</button></p>' +
    '<div class="quiet">No approval code is required. This link identifies you.</div>' +
    '<script>' +
    'document.getElementById("go").onclick=function(){' +
    'var b=this;b.disabled=true;b.textContent="Recording\\u2026";' +
    'var r=document.getElementById("reason");' +
    'google.script.run.withSuccessHandler(function(h){document.open();document.write(h);document.close();})' +
    '.withFailureHandler(function(err){b.disabled=false;b.textContent="Try again";alert(err.message);})' +
    '.submitDecision(' + args + ', r?r.value:"");};' +
    '</script>',
    (act === 'approve' ? 'Approve' : 'Reject') + ' ' + orderId);
}

/** Called from the decision page via google.script.run. Returns full HTML. */
function submitDecision(act, orderId, who, exp, sig, reason) {
  if (!verifyApprovalToken(orderId, who, exp, sig)) {
    return html('<h2>This link is not valid</h2>', 'Invalid').getContent();
  }
  if (act === 'reject' && !String(reason || '').trim()) {
    throw new Error('A rejection reason is required.');
  }

  var res = applyDecision(orderId, act, who, reason);

  if (res.already) {
    return html('<h2>Already decided</h2>' +
      '<div class="quiet">' + esc(orderId) + ' was already <b>' + esc(res.status) + '</b>.</div>',
      'Already decided').getContent();
  }

  try {
    sendDecisionEmail(res.order, res.status, reason);
  } catch (err) {
    console.error('decision mail failed for ' + orderId + ': ' + err.message);
  }

  return html(
    '<h2>Order ' + esc(res.status.toLowerCase()) + '</h2>' +
    '<div class="' + (res.status === 'Approved' ? 'quiet' : 'note') + '">' +
    esc(orderId) + ' has been recorded as <b>' + esc(res.status) + '</b>' +
    ' against your address, ' + esc(who) + '.' +
    (reason ? '<br><br><b>Reason:</b> ' + esc(reason) : '') +
    '<br><br>The requester has been notified by email.</div>' +
    '<p class="muted">You can close this window.</p>',
    'Recorded').getContent();
}
