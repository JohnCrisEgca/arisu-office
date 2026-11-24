import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeGcash } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependencies). Real environment variables always win.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// 32-byte key used to encrypt Facebook page tokens at rest.
function loadSecret(dataDir, env) {
  if (env.APP_SECRET) return crypto.createHash('sha256').update(env.APP_SECRET).digest();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

export function buildConfig(env = process.env, overrides = {}) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const isProd = env.NODE_ENV === 'production';
  const cfg = {
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    dataDir,
    dbPath: path.join(dataDir, 'arisu.db'),
    isProd,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
    trustProxy: env.TRUST_PROXY === 'true',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiBase: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.OPENAI_MODEL || '',
    reviewModel: env.OPENAI_REVIEW_MODEL || env.OPENAI_MODEL || '',
    aiDailyLimit: Number(env.AI_DAILY_LIMIT || 40),
    fbEnabled: env.FB_PUBLISH_ENABLED === 'true',
    graphBase: (env.FB_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, ''),
    graphVersion: env.FB_GRAPH_VERSION || '',
    setupToken: env.SETUP_TOKEN || '',
    timezone: env.TIMEZONE || 'Asia/Manila',
    // Optional defaults for the invoice GCash block, so the number lives in the host's settings and not in git.
    gcashName: String(env.GCASH_NAME || '').trim().slice(0, 120),
    gcashNumber: normalizeGcash(env.GCASH_NUMBER) || '',
    sessionTtlMs: 7 * 24 * 3600 * 1000,
    ...overrides
  };
  cfg.secretKey = overrides.secretKey ?? loadSecret(cfg.dataDir, env);
  return cfg;
}

export { loadDotEnv };
