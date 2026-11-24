import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const KEYLEN = 64;
export const COOKIE = 'arisu_sid';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(h, 'base64');
    const got = await scrypt(password, Buffer.from(s, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// Run a hash even for unknown emails so response time does not reveal which emails exist.
let dummy;
export async function dummyVerify(password) {
  dummy ??= await hashPassword('timing-equalizer');
  await verifyPassword(password, dummy);
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (/^(.)\1+$/.test(pw)) return 'Password is too simple.';
  return null;
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), userId, now, now + ttlMs);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).get(sha(token));
  if (!row || row.session_expires < Date.now() || row.disabled) return null;
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function destroyUserSessions(db, userId, exceptToken) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure, maxAgeSec }) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

// Counts failed attempts only; a success clears the counter.
export class LoginLimiter {
  constructor(max = 5, windowMs = 15 * 60 * 1000) {
    this.max = max; this.windowMs = windowMs; this.map = new Map();
  }
  blocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (Date.now() - e.first > this.windowMs) { this.map.delete(key); return false; }
    return e.count >= this.max;
  }
  fail(key) {
    const e = this.map.get(key);
    if (!e || Date.now() - e.first > this.windowMs) this.map.set(key, { count: 1, first: Date.now() });
    else e.count++;
  }
  clear(key) { this.map.delete(key); }
}
