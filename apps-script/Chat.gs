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
    if (opts.items) rows.splice(4, 0, ['Items', String(opts.items)]);

    var widgets = rows.map(function (r) {
      return { decoratedText: { topLabel: r[0], text: chatEsc(r[1]), wrapText: true } };
    });

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

/** Escape the characters Chat treats as formatting. */
function chatEsc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[*_~`]/g, '');
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
