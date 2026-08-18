/**
 * Credentials, sessions and signed approval tokens.
 *
 * KNOWN LIMITATION, stated deliberately: this is salted SHA-256 with a
 * server-side pepper, not bcrypt or Argon2. Apps Script has no native bcrypt and
 * a real PBKDF2 iteration count will not finish inside the 6 minute execution
 * limit. Proportionate for ~30 internal users on an internal catalogue; it is on
 * the hardening list for the production move to Cloudways.
 */

function sha256(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function hmac(s) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(s, prop('PEPPER')));
}

function hashPassword(password, salt) {
  return sha256(salt + '|' + password + '|' + prop('PEPPER'));
}

function randomToken(bytes) {
  var out = [];
  for (var i = 0; i < (bytes || 16); i++) out.push(Math.floor(Math.random() * 256));
  return Utilities.base64EncodeWebSafe(out).replace(/=+$/, '');
}

/* Constant-time-ish compare. Not perfect in JS, but avoids the trivial
   early-exit leak of ===. */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------------------------- sessions */

function issueSession(email) {
  var exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  var body = email + '|' + exp;
  return Utilities.base64EncodeWebSafe(body) + '.' + hmac(body);
}

function readSession(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var body;
  try {
    body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) { return null; }
  if (!safeEqual(parts[1], hmac(body))) return null;
  var bits = body.split('|');
  if (Number(bits[1]) < Date.now()) return null;
  return { email: bits[0] };
}

function requireSession(req) {
  var s = readSession(req.session);
  if (!s) throw new Error('Your session has expired. Please sign in again.');
  var u = findUser(s.email);
  if (!u || String(u.active).toUpperCase() === 'FALSE') {
    throw new Error('This account is no longer active.');
  }
  return u;
}

function requireAdmin(req) {
  if (!req.admin_pass || !safeEqual(req.admin_pass, prop('ADMIN_PASS'))) {
    throw new Error('Admin password is incorrect.');
  }
  return true;
}

/* ------------------------------------------------------------------ users */

function findUser(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  var rows = readTab(SHEETS.USERS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email).trim().toLowerCase() === email) return rows[i];
  }
  return null;
}

/* Sheets coerces numeric-looking cells to numbers, so phone and PIN come back
   as 9812345678 rather than "9812345678". Cast them, or a leading zero is
   silently dropped on the way to the checkout form. */
function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v));
  return String(v);
}

function publicUser(u) {
  return {
    email: str(u.email), full_name: str(u.full_name), lob: str(u.lob),
    default_ship_name: str(u.default_ship_name),
    default_ship_phone: str(u.default_ship_phone),
    default_ship_street: str(u.default_ship_street),
    default_ship_city: str(u.default_ship_city),
    default_ship_pincode: str(u.default_ship_pincode),
    must_reset: String(u.must_reset).toUpperCase() === 'TRUE'
  };
}

function fnLogin(req) {
  var email = String(req.email || '').trim().toLowerCase();
  var u = findUser(email);

  // Same message whether the account is missing or the password is wrong, so
  // this endpoint cannot be used to enumerate RSM staff.
  var GENERIC = 'Email or password is incorrect.';
  if (!u) throw new Error(GENERIC);
  if (String(u.active).toUpperCase() === 'FALSE') throw new Error(GENERIC);

  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new Error('Too many failed attempts. Try again after ' + u.locked_until + '.');
  }

  if (!safeEqual(hashPassword(req.password || '', u.salt), u.password_hash)) {
    var fails = Number(u.failed_attempts || 0) + 1;
    var patch = { failed_attempts: fails };
    if (fails >= MAX_FAILED_LOGINS) {
      patch.locked_until = Utilities.formatDate(
        new Date(Date.now() + LOCKOUT_MINUTES * 60000), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
      patch.failed_attempts = 0;
    }
    withLock(function () { updateRow(SHEETS.USERS, u._row, patch); });
    audit(email, 'login_failed', 'user', email, null, { attempt: fails });
    throw new Error(GENERIC);
  }

  withLock(function () {
    updateRow(SHEETS.USERS, u._row,
      { failed_attempts: 0, locked_until: '', last_login: now() });
  });
  audit(email, 'login', 'user', email, null, null);

  return { ok: true, session: issueSession(email), user: publicUser(u) };
}

/* ------------------------------------------------------------ password reset */

function fnResetRequest(req) {
  var email = String(req.email || '').trim().toLowerCase();
  var u = findUser(email);

  // Always answer ok, whether or not the account exists.
  if (u && String(u.active).toUpperCase() !== 'FALSE') {
    var exp = Date.now() + RESET_MINUTES * 60000;
    // Binding the current hash into the token makes it single use: the moment
    // the password changes, any outstanding link stops verifying.
    var body = email + '|' + exp + '|' + u.password_hash;
    var token = Utilities.base64EncodeWebSafe(email + '|' + exp) + '.' + hmac(body);
    sendResetEmail(email, u.full_name, token);
    audit(email, 'reset_requested', 'user', email, null, null);
  }
  return { ok: true };
}

function fnResetConfirm(req) {
  var parts = String(req.token || '').split('.');
  if (parts.length !== 2) throw new Error('That reset link is not valid.');

  var body;
  try {
    body = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (err) { throw new Error('That reset link is not valid.'); }

  var bits = body.split('|');
  var email = bits[0], exp = Number(bits[1]);
  if (exp < Date.now()) throw new Error('That reset link has expired. Request a new one.');

  var u = findUser(email);
  if (!u) throw new Error('That reset link is not valid.');
  if (!safeEqual(parts[1], hmac(email + '|' + exp + '|' + u.password_hash))) {
    throw new Error('That reset link has already been used.');
  }

  var pw = String(req.password || '');
  if (pw.length < 10) throw new Error('Choose a password of at least 10 characters.');

  var salt = randomToken(12);
  withLock(function () {
    updateRow(SHEETS.USERS, u._row, {
      salt: salt, password_hash: hashPassword(pw, salt),
      must_reset: 'FALSE', failed_attempts: 0, locked_until: ''
    });
  });
  audit(email, 'reset_completed', 'user', email, null, null);
  return { ok: true };
}

/* ----------------------------------------------------- approval link tokens */

/* One link per approver per order: signed, expiring, and attributable. This is
   what replaces the shared MASTER_APPROVAL_CODE in the old system. */
function approvalToken(orderId, approverEmail, exp) {
  return hmac(orderId + '|' + approverEmail + '|' + exp);
}

function verifyApprovalToken(orderId, approverEmail, exp, sig) {
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, approvalToken(orderId, approverEmail, exp));
}

/**
 * Pack the whole approval link payload into ONE opaque query parameter.
 *
 * This is not cosmetic. MailApp sends the body quoted-printable and does not
 * escape "=" as "=3D", so any "=" followed by two hex digits is swallowed by
 * the recipient's mail client. "&exp=1788264540427" arrived as "&exp" + 0x17,
 * which broke every approve and reject link. One parameter, prefixed "v1."
 * so the two characters after "=" are never both hex, avoids the whole class
 * of problem.
 */
function packApproval(orderId, approverEmail, exp, act) {
  var payload = [orderId, approverEmail, exp, act,
    approvalToken(orderId, approverEmail, exp)].join('|');
  return 'v1.' + Utilities.base64EncodeWebSafe(payload).replace(/=+$/, '');
}

/** Returns {orderId, who, exp, act} if the token is intact, else null. */
function unpackApproval(t) {
  t = String(t || '');
  if (t.indexOf('v1.') !== 0) return null;
  var body = t.slice(3);
  var pad = body.length % 4;
  if (pad) body += new Array(5 - pad).join('=');
  var raw;
  try {
    raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString();
  } catch (err) { return null; }

  var bits = raw.split('|');
  if (bits.length !== 5) return null;
  var orderId = bits[0], who = bits[1], exp = bits[2], act = bits[3], sig = bits[4];
  if (!verifyApprovalToken(orderId, who, exp, sig)) return null;
  return { orderId: orderId, who: who, exp: exp, act: act === 'reject' ? 'reject' : 'approve' };
}

/* ------------------------------------------------------------------ admin */

/** Run manually from the editor to issue or reset a user's password. */
function setUserPassword(email, plainPassword) {
  var u = findUser(email);
  if (!u) throw new Error('No user row for ' + email);
  var salt = randomToken(12);
  updateRow(SHEETS.USERS, u._row, {
    salt: salt, password_hash: hashPassword(plainPassword, salt),
    failed_attempts: 0, locked_until: ''
  });
  console.log('Password set for ' + email);
}
