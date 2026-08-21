/**
 * Google Chat notifications for the order lifecycle.
 *
 * Three moments reach the group: an order is submitted for approval, an
 * approver accepts it, an approver rejects it. Closure already emails the
 * requester with tracking and is not chatter the group needs.
 *
 * The webhook URL is a credential. Anyone holding it can post into the space,
 * so it lives in Script Property CHAT_WEBHOOK and never in this repository,
 * which is public. Set it with setChatWebhook() or fnAdminSetChatWebhook.
 *
 * Nothing here is allowed to break an order. Every call is wrapped: if Chat is
 * down, or the webhook is wrong, or nobody has configured one, the order still
 * saves and the approval email still goes out. A failure is logged, not thrown.
 */

function chatWebhook() {
  return prop('CHAT_WEBHOOK', '');
}

/** Run once from the editor with the webhook URL as the argument. */
function setChatWebhook(url) {
  if (!/^https:\/\/chat\.googleapis\.com\//.test(String(url || ''))) {
    throw new Error('That does not look like a Google Chat webhook URL.');
  }
  PropertiesService.getScriptProperties().setProperty('CHAT_WEBHOOK', String(url));
  return 'CHAT_WEBHOOK set.';
}

/** Same, over the admin API, so no editor visit is needed. */
function fnAdminSetChatWebhook(req) {
  requireAdmin(req);
  var url = String(req.webhook || '');
  if (url && !/^https:\/\/chat\.googleapis\.com\//.test(url)) {
    throw new Error('That does not look like a Google Chat webhook URL.');
  }
  PropertiesService.getScriptProperties().setProperty('CHAT_WEBHOOK', url);
  audit('admin', url ? 'chat_webhook_set' : 'chat_webhook_cleared',
    'config', 'CHAT_WEBHOOK', null, null);
  return { ok: true, configured: !!url };
}

/* ------------------------------------------------------------------ send */

function postToChat(payload) {
  var url = chatWebhook();
  if (!url) return false;                       // not configured, nothing to do
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Chat returned HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
  }
  return true;
}

/**
 * Announce one order event.
 *
 * `kind` is 'submitted', 'approved' or 'rejected'. `o` is an order row as read
 * from the Orders tab, so this works from both the approval page and the API.
 */
function notifyChat(kind, o, opts) {
  try {
    if (!chatWebhook()) return false;
    opts = opts || {};

    var head = {
      submitted: { icon: '🟡', title: 'Approval requested', },
      approved: { icon: '🟢', title: 'Order approved' },
      rejected: { icon: '🔴', title: 'Order rejected' }
    }[kind];
    if (!head) return false;

    var id = String(o.order_id || '');
    var rows = [
      ['Requester', str(o.requester_name) + (o.requester_email ? ' · ' + o.requester_email : '')],
      ['Department', str(o.lob) || '—'],
      ['Approver', str(o.lob_approver) || '—'],
      ['Event date', fmtDate(o.event_date)],
      ['Order value', inr(o.grand_total)]
    ];

    if (kind === 'approved' || kind === 'rejected') {
      rows.push(['Decided by', str(o.decided_by) || '—']);
    }
    if (kind === 'rejected') {
      rows.push(['Reason', str(o.rejection_reason) || 'No reason given']);
    }
    var widgets = rows.map(function (r) {
      return { decoratedText: { topLabel: r[0], text: chatEsc(r[1]), wrapText: true } };
    });

    // What was actually ordered. Without this the room has a value and no idea
    // what it bought, which is the first thing anyone asks.
    var basket = basketLines(id);
    if (basket.text) {
      widgets.splice(4, 0, {
        decoratedText: { topLabel: basket.label, text: basket.text, wrapText: true }
      });
    }

    var link = prop('SITE_URL', '') + '/status.html?id=' + encodeURIComponent(id);
    if (prop('SITE_URL', '')) {
      widgets.push({
        buttonList: { buttons: [{ text: 'View order', onClick: { openLink: { url: link } } }] }
      });
    }

    return postToChat({
      // the plain text is what a phone notification and the space list show
      text: head.icon + ' *' + head.title + '* · ' + id + ' · ' + inr(o.grand_total),
      cardsV2: [{
        cardId: kind + '-' + id,
        card: {
          header: {
            title: id,
            subtitle: head.title + (o.lob ? ' · ' + str(o.lob) : '')
          },
          sections: [{ widgets: widgets }]
        }
      }]
    });
  } catch (err) {
    // an order must never fail because a chat message did
    console.log('notifyChat(' + kind + ') failed: ' + err.message);
    return false;
  }
}

/**
 * One line per product: name, total quantity and what that came to.
 *
 * Sizes are rolled up into the parent, the same way the price band is decided,
 * so a shirt ordered across five sizes reads as one row rather than five. The
 * list is capped: a long order should not push the value off a phone screen.
 */
function basketLines(orderId) {
  var lines = orderLines(orderId);
  if (!lines.length) return { label: '', text: '' };

  var order = [], by = {};
  lines.forEach(function (l) {
    var sku = String(l.parent_sku || '').trim();
    if (!by[sku]) {
      by[sku] = { name: String(l.product_name || sku), qty: 0, value: 0 };
      order.push(sku);
    }
    by[sku].qty += Number(l.qty) || 0;
    by[sku].value += Number(l.line_total) || 0;
  });

  var MAX = 8;
  var shown = order.slice(0, MAX).map(function (sku) {
    var p = by[sku];
    return chatEsc(p.name) + ' — ' + p.qty + ' × ' + inr(p.value / (p.qty || 1)) +
      ' = ' + inr(p.value);
  });
  if (order.length > MAX) {
    shown.push('and ' + (order.length - MAX) + ' more product' +
      (order.length - MAX === 1 ? '' : 's'));
  }

  var units = lines.reduce(function (a, l) { return a + (Number(l.qty) || 0); }, 0);
  return {
    label: order.length + (order.length === 1 ? ' product · ' : ' products · ') +
      units + ' units',
    text: shown.join('<br>')
  };
}

/** Escape the characters Chat treats as formatting. */
function chatEsc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[*_~`]/g, '');
}

/**
 * Re-send the notification for a real order, without changing the order.
 * The point is to exercise the same code path a live order takes, so what
 * lands in the group is what the group will actually get.
 */
function fnAdminTestChat(req) {
  requireAdmin(req);
  var o = findOrderRow(String(req.order_id || ''));
  if (!o) throw new Error('Order ' + req.order_id + ' not found.');
  var kind = ['submitted', 'approved', 'rejected'].indexOf(String(req.kind)) >= 0
    ? String(req.kind) : 'submitted';
  return { ok: true, sent: notifyChat(kind, o) };
}

/** Post a sample of each of the three messages, to prove the wiring. */
function testChatWebhook() {
  if (!chatWebhook()) throw new Error('CHAT_WEBHOOK is not set.');
  var sample = {
    order_id: 'RSMB-TEST', requester_name: 'Test Requester',
    requester_email: 'test@rsmus.com', lob: 'Consulting',
    lob_approver: 'Balasundaram Nagarajan', event_date: '2026-09-30',
    grand_total: 12345.67, decided_by: 'approver@rsmus.com',
    rejection_reason: 'Budget not available this quarter'
  };
  ['submitted', 'approved', 'rejected'].forEach(function (k) {
    notifyChat(k, sample, { items: 3 });
  });
  return 'Three test messages sent.';
}
