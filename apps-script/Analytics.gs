/**
 * Store analytics: what sold, what did not, and what people did on the site.
 *
 * Two halves, and they are not equally old:
 *
 *   Orders are history. Every order ever placed through this store is in the
 *   Orders and OrderLines tabs, so best sellers, approval rates and turnaround
 *   are correct from the first time this page is opened.
 *
 *   Traffic is not. Nothing was recording page views or clicks before this
 *   file existed, so those counts start at zero on the day it ships and fill
 *   up from there. The page says so rather than showing a flat line and
 *   letting someone conclude nobody visits.
 *
 * The dashboard password lives in Script Property ANALYTICS_PASS. It is never
 * in this repository, which is public. Set it with setAnalyticsPass().
 */

var EVENT_CAP = 60000;      // rows kept in Events; older ones are trimmed
var TRACK_MAX_LEN = 300;    // longest string accepted in any event field

/* ------------------------------------------------------------------ intake */

/**
 * Record one storefront event. Deliberately forgiving: analytics must never
 * break the shop, so anything unparseable is dropped rather than thrown back
 * at the browser.
 */
function fnTrack(req) {
  try {
    var name = clip(req.event);
    if (!name) return { ok: true, skipped: true };

    appendRow(SHEETS.EVENTS, {
      ts: now(),
      session_id: clip(req.session),
      visitor_id: clip(req.visitor),
      is_new: req.is_new ? 1 : '',
      referrer: clip(req.ref),
      title: clip(req.title),
      device: deviceOf(req.ua),
      event: name,
      path: clip(req.path),
      sku: clip(req.sku),
      query: clip(req.query),
      qty: Number(req.qty) || '',
      value: Number(req.value) || '',
      user_email: clip(req.user_email),
      user_agent: clip((req.ua || '').slice(0, 180))
    });
    return { ok: true };
  } catch (err) {
    console.log('track failed: ' + err.message);
    return { ok: true, skipped: true };
  }
}

/* Coarse device split, the same three buckets GA reports. Parsing a user
   agent is never exact; this is deliberately blunt rather than pretending. */
function deviceOf(ua) {
  var s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk/i.test(s)) return 'Tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(s)) return 'Mobile';
  return 'Desktop';
}

function clip(v) {
  return String(v === undefined || v === null ? '' : v).slice(0, TRACK_MAX_LEN);
}

/** Keep the Events tab from growing without bound. */
function trimEvents() {
  var sh = sheet(SHEETS.EVENTS);
  var extra = sh.getLastRow() - 1 - EVENT_CAP;
  if (extra > 0) sh.deleteRows(2, extra);
  return extra > 0 ? extra : 0;
}

/* -------------------------------------------------------------------- auth */

function requireAnalytics(req) {
  var want = prop('ANALYTICS_PASS');
  if (!want) throw new Error('Analytics password is not set. Run setAnalyticsPass() once.');
  if (String(req.pass || '') !== want) throw new Error('Wrong password.');
}

/** Run once from the editor, with the password as the argument. */
function setAnalyticsPass(pass) {
  if (!pass) throw new Error('Pass the password as an argument.');
  PropertiesService.getScriptProperties().setProperty('ANALYTICS_PASS', String(pass));
  return 'ANALYTICS_PASS set.';
}

/** Same thing over the API, so the console can set it without an editor visit. */
function fnAdminSetAnalyticsPass(req) {
  requireAdmin(req);
  var p = String(req.new_pass || '');
  if (p.length < 8) throw new Error('Use at least 8 characters.');
  PropertiesService.getScriptProperties().setProperty('ANALYTICS_PASS', p);
  audit('admin', 'analytics_pass_set', 'config', 'ANALYTICS_PASS', null, null);
  return { ok: true };
}

/* --------------------------------------------------------------- reporting */

function fnAnalytics(req) {
  requireAnalytics(req);
  var days = Math.min(730, Math.max(7, Math.floor(Number(req.days) || 90)));
  var since = new Date();
  since.setDate(since.getDate() - days);

  var orders = readTab(SHEETS.ORDERS);
  var lines = readTab(SHEETS.LINES);
  var products = readTab(SHEETS.PRODUCTS);
  var events = readTab(SHEETS.EVENTS);

  var inRange = orders.filter(function (o) {
    var d = parseTs(o.created_at);
    return d && d >= since;
  });
  var idsInRange = {};
  inRange.forEach(function (o) { idsInRange[String(o.order_id)] = 1; });
  var linesInRange = lines.filter(function (l) { return idsInRange[String(l.order_id)]; });

  return {
    ok: true,
    days: days,
    generated_at: now(),
    orders: orderStats(inRange),
    approval: approvalStats(inRange),
    products: productStats(linesInRange, products, orders, lines),
    demand: demandStats(inRange),
    trend: trendStats(inRange, events, since),
    traffic: trafficStats(events, since),
    audience: audienceStats(events, since),
    tracking_since: firstEventDate(events)
  };
}

function orderStats(orders) {
  var byStatus = {}, value = 0;
  orders.forEach(function (o) {
    var s = String(o.status || 'Unknown');
    byStatus[s] = (byStatus[s] || 0) + 1;
    value += Number(o.grand_total) || 0;
  });
  return {
    count: orders.length,
    value: round2(value),
    average: orders.length ? round2(value / orders.length) : 0,
    by_status: byStatus
  };
}

function approvalStats(orders) {
  var decided = orders.filter(function (o) { return o.decided_at; });
  var approved = decided.filter(function (o) { return isApproved(o.status); });
  var rejected = decided.filter(function (o) { return /reject/i.test(String(o.status)); });

  var toDecide = [], toClose = [];
  orders.forEach(function (o) {
    var made = parseTs(o.created_at), dec = parseTs(o.decided_at), shut = parseTs(o.closed_at);
    if (made && dec) toDecide.push((dec - made) / 3600000);
    if (dec && shut) toClose.push((shut - dec) / 86400000);
  });

  var pending = orders.filter(function (o) { return !o.decided_at; });
  var stale = pending.filter(function (o) {
    var made = parseTs(o.created_at);
    return made && (new Date() - made) / 86400000 > 3;
  });

  return {
    submitted: orders.length,
    decided: decided.length,
    approved: approved.length,
    rejected: rejected.length,
    awaiting: pending.length,
    awaiting_over_3_days: stale.length,
    approval_rate: decided.length ? round2(approved.length / decided.length * 100) : null,
    median_hours_to_decision: median(toDecide),
    median_days_to_close: median(toClose)
  };
}

function productStats(linesInRange, products, allOrders, allLines) {
  var units = {}, value = {}, names = {};
  linesInRange.forEach(function (l) {
    var sku = String(l.parent_sku || '').trim();
    if (!sku) return;
    units[sku] = (units[sku] || 0) + (Number(l.qty) || 0);
    value[sku] = (value[sku] || 0) + (Number(l.line_total) || 0);
    names[sku] = l.product_name || sku;
  });

  var rows = Object.keys(units).map(function (sku) {
    return { sku: sku, name: names[sku], units: units[sku], value: round2(value[sku]) };
  });

  // "never ordered" is judged against the whole order history, not the window:
  // a product that last sold a year ago is a slow mover, not a new arrival.
  var everOrdered = {};
  allLines.forEach(function (l) { everOrdered[String(l.parent_sku || '').trim()] = 1; });
  var never = products
    .filter(function (p) {
      return String(p.active).toUpperCase() !== 'FALSE' && !everOrdered[String(p.sku).trim()];
    })
    .map(function (p) {
      return { sku: String(p.sku), name: String(p.name), category: String(p.category),
               moq: Number(p.moq) || 0 };
    });

  return {
    top_by_units: rows.slice().sort(function (a, b) { return b.units - a.units; }).slice(0, 12),
    top_by_value: rows.slice().sort(function (a, b) { return b.value - a.value; }).slice(0, 12),
    slowest: rows.slice().sort(function (a, b) { return a.units - b.units; }).slice(0, 12),
    never_ordered: never.slice(0, 60),
    never_ordered_total: never.length,
    ordered_distinct: rows.length,
    catalogue_size: products.filter(function (p) {
      return String(p.active).toUpperCase() !== 'FALSE';
    }).length
  };
}

function demandStats(orders) {
  var lob = {}, who = {}, approver = {};
  orders.forEach(function (o) {
    var v = Number(o.grand_total) || 0;
    bump(lob, String(o.lob || 'Unspecified'), v);
    bump(who, String(o.requester_email || 'Unknown'), v);
    if (o.decided_by) bump(approver, String(o.decided_by), v);
  });
  return {
    by_lob: topOf(lob, 12),
    top_requesters: topOf(who, 10),
    by_approver: topOf(approver, 10)
  };
}

function bump(map, key, value) {
  if (!map[key]) map[key] = { key: key, count: 0, value: 0 };
  map[key].count++;
  map[key].value += value;
}

function topOf(map, n) {
  return Object.keys(map).map(function (k) {
    return { key: k, count: map[k].count, value: round2(map[k].value) };
  }).sort(function (a, b) { return b.value - a.value; }).slice(0, n);
}

/** Weekly buckets, oldest first, with no gaps so the line is honest. */
function trendStats(orders, events, since) {
  var weeks = {}, cursor = new Date(since), end = new Date();
  cursor = weekStart(cursor);
  while (cursor <= end) {
    weeks[fmtDay(cursor)] = { week: fmtDay(cursor), orders: 0, value: 0, sessions: 0 };
    cursor.setDate(cursor.getDate() + 7);
  }

  orders.forEach(function (o) {
    var d = parseTs(o.created_at);
    if (!d) return;
    var k = fmtDay(weekStart(d));
    if (weeks[k]) {
      weeks[k].orders++;
      weeks[k].value += Number(o.grand_total) || 0;
    }
  });

  var seen = {};
  events.forEach(function (e) {
    var d = parseTs(e.ts);
    if (!d || d < since) return;
    var k = fmtDay(weekStart(d)), s = String(e.session_id || '');
    if (!weeks[k] || !s) return;
    var mark = k + '|' + s;
    if (seen[mark]) return;
    seen[mark] = 1;
    weeks[k].sessions++;
  });

  return Object.keys(weeks).sort().map(function (k) {
    weeks[k].value = round2(weeks[k].value);
    return weeks[k];
  });
}

function trafficStats(events, since) {
  var recent = events.filter(function (e) {
    var d = parseTs(e.ts);
    return d && d >= since;
  });

  var counts = {}, sessions = {}, productViews = {}, searches = {}, empty = {};
  recent.forEach(function (e) {
    var name = String(e.event || '');
    counts[name] = (counts[name] || 0) + 1;
    if (e.session_id) sessions[String(e.session_id)] = 1;
    if (name === 'product_view' && e.sku) {
      productViews[String(e.sku)] = (productViews[String(e.sku)] || 0) + 1;
    }
    if (name === 'search' && e.query) {
      searches[String(e.query)] = (searches[String(e.query)] || 0) + 1;
    }
    if (name === 'search_empty' && e.query) {
      empty[String(e.query)] = (empty[String(e.query)] || 0) + 1;
    }
  });

  var views = counts.page_view || 0;
  var carts = counts.add_to_cart || 0;
  var checkouts = counts.checkout_start || 0;
  var submits = counts.order_submit || 0;

  return {
    events: recent.length,
    page_views: views,
    sessions: Object.keys(sessions).length,
    clicks: counts.click || 0,
    product_views: counts.product_view || 0,
    add_to_cart: carts,
    kit_generated: counts.kit_generate || 0,
    kit_added: counts.kit_add || 0,
    checkout_start: checkouts,
    order_submit: submits,
    funnel: [
      { step: 'Sessions', n: Object.keys(sessions).length },
      { step: 'Product views', n: counts.product_view || 0 },
      { step: 'Added to cart', n: carts },
      { step: 'Reached checkout', n: checkouts },
      { step: 'Submitted', n: submits }
    ],
    top_viewed: Object.keys(productViews).map(function (k) {
      return { key: k, count: productViews[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 12),
    top_searches: Object.keys(searches).map(function (k) {
      return { key: k, count: searches[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 12),
    searches_with_nothing: Object.keys(empty).map(function (k) {
      return { key: k, count: empty[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 12)
  };
}

/**
 * The audience figures Google Analytics reports, computed from the same event
 * rows: users, new users, session length, bounce rate, per-page detail, device
 * split and where the visit came from.
 *
 * City is deliberately absent. GA derives it from the visitor's IP address,
 * and Apps Script is never given the caller's IP, so there is no honest way to
 * produce it here. Better a missing panel than an invented one.
 */
function audienceStats(events, since) {
  var recent = events.filter(function (e) {
    var d = parseTs(e.ts);
    return d && d >= since;
  });

  var sessions = {}, visitors = {}, newVisitors = {}, devices = {}, sources = {}, pages = {};

  recent.forEach(function (e) {
    var sid = String(e.session_id || ''), vid = String(e.visitor_id || '');
    var d = parseTs(e.ts);
    if (!sid || !d) return;

    if (!sessions[sid]) {
      sessions[sid] = { first: d, last: d, views: 0, visitor: vid, device: e.device || 'Desktop',
                        source: sourceOf(e.referrer) };
    }
    var s = sessions[sid];
    if (d < s.first) s.first = d;
    if (d > s.last) s.last = d;
    if (String(e.event) === 'page_view') s.views++;
    if (e.referrer) s.source = sourceOf(e.referrer);

    if (vid) {
      visitors[vid] = 1;
      if (e.is_new) newVisitors[vid] = 1;
    }

    var path = String(e.path || 'index.html');
    if (!pages[path]) {
      pages[path] = { page: path, title: String(e.title || path), views: 0,
                      events: 0, sessions: {}, bounced: 0 };
    }
    pages[path].events++;
    if (String(e.event) === 'page_view') pages[path].views++;
    if (e.title) pages[path].title = String(e.title);
    pages[path].sessions[sid] = 1;
  });

  var ids = Object.keys(sessions);
  var durations = [], bounced = 0;
  ids.forEach(function (sid) {
    var s = sessions[sid];
    durations.push((s.last - s.first) / 1000);
    // one page view and nothing else is the definition of a bounce
    if (s.views <= 1) bounced++;
    devices[s.device] = (devices[s.device] || 0) + 1;
    sources[s.source] = (sources[s.source] || 0) + 1;
  });

  // a page is "bounced on" when the session that saw it saw nothing else
  ids.forEach(function (sid) {
    var s = sessions[sid];
    if (s.views > 1) return;
    Object.keys(pages).forEach(function (p) {
      if (pages[p].sessions[sid]) pages[p].bounced++;
    });
  });

  var pageRows = Object.keys(pages).map(function (p) {
    var row = pages[p];
    var n = Object.keys(row.sessions).length;
    return { page: p, title: row.title, views: row.views, events: row.events,
             sessions: n, bounce_rate: n ? round2(row.bounced / n * 100) : 0 };
  }).sort(function (a, b) { return b.views - a.views; }).slice(0, 10);

  return {
    users: Object.keys(visitors).length,
    new_users: Object.keys(newVisitors).length,
    returning_users: Math.max(0, Object.keys(visitors).length - Object.keys(newVisitors).length),
    sessions: ids.length,
    avg_session_seconds: durations.length
      ? Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length)
      : 0,
    bounce_rate: ids.length ? round2(bounced / ids.length * 100) : 0,
    pages: pageRows,
    devices: Object.keys(devices).map(function (k) {
      return { key: k, count: devices[k],
               share: round2(devices[k] / ids.length * 100) };
    }).sort(function (a, b) { return b.count - a.count; }),
    sources: Object.keys(sources).map(function (k) {
      return { key: k, count: sources[k] };
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 10)
  };
}

/** "(direct) / none" or the referring host, which is all a referrer gives us. */
function sourceOf(ref) {
  var s = String(ref || '').trim();
  if (!s) return '(direct) / none';
  var m = s.match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].replace(/^www\./, '') + ' / referral' : '(direct) / none';
}

function firstEventDate(events) {
  for (var i = 0; i < events.length; i++) {
    var d = parseTs(events[i].ts);
    if (d) return fmtDay(d);
  }
  return '';
}

/* ----------------------------------------------------------------- helpers */

function isApproved(status) {
  return /approve|closed|shipped/i.test(String(status));
}

/** Sheets hands back either a Date or the 'yyyy-MM-dd HH:mm:ss' string. */
function parseTs(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v).trim();
  if (!s) return null;
  var d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function weekStart(d) {
  var c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));   // Monday
  return c;
}

function fmtDay(d) {
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}

function median(list) {
  if (!list.length) return null;
  var s = list.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
