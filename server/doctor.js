// Ben (Automation Tester): checks that the real services work with the real keys.
// Used by the owner's "Run system check" button and by `npm run doctor`. Never prints keys or tokens.
import { loadAgreement } from './agreement.js';
import { decrypt } from './secrets.js';
import { graphGet } from './facebook.js';

export async function runChecks({ cfg, db, ai }) {
  const out = [];
  const add = (name, status, detail) => out.push({ name, status, detail });

  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    add('Database', r.integrity_check === 'ok' ? 'pass' : 'fail', r.integrity_check === 'ok' ? 'Integrity check passed.' : String(r.integrity_check));
  } catch (e) { add('Database', 'fail', e.message); }

  try { add('Agreement', 'pass', `Version ${loadAgreement().version}`); } catch (e) { add('Agreement', 'fail', e.message); }
  add('Encryption key', cfg.secretKey?.length === 32 ? 'pass' : 'fail', cfg.secretKey?.length === 32 ? '32-byte key loaded.' : 'Missing or wrong size.');

  // OpenAI
  if (!cfg.openaiKey) add('OpenAI key', 'fail', 'OPENAI_API_KEY is not set.');
  else if (!cfg.model) add('OpenAI model', 'fail', 'OPENAI_MODEL is not set.');
  else {
    try {
      const models = await ai.listModels();
      add('OpenAI key', 'pass', `Accepted. ${models.length} GPT models visible.`);
      add('OpenAI model', models.includes(cfg.model) ? 'pass' : 'fail',
        models.includes(cfg.model) ? `${cfg.model} is available.` : `${cfg.model} is not available to this key. Pick one from the list.`);
      const review = cfg.reviewModel || cfg.model;
      if (review !== cfg.model) add('OpenAI review model', models.includes(review) ? 'pass' : 'fail', review);
    } catch (e) { add('OpenAI key', 'fail', e.message); }
    try { add('OpenAI test request', (await ai.ping()) ? 'pass' : 'warn', 'A tiny test request was answered.'); } catch (e) { add('OpenAI test request', 'fail', e.message); }
  }

  // Facebook
  add('Facebook publishing', 'info', cfg.fbEnabled ? 'ON. Approved posts can be published.' : 'OFF. Approved posts are posted by hand.');
  const pages = db.prepare('SELECT p.*, c.name AS client_name FROM fb_pages p JOIN clients c ON c.id = p.client_id').all();
  if (!pages.length) add('Facebook Pages', 'skip', 'No Page is connected yet.');
  for (const p of pages) {
    try {
      const body = await graphGet(cfg, encodeURIComponent(p.page_id), { fields: 'id,name' }, decrypt(cfg.secretKey, p.token_enc));
      add(`Facebook Page: ${p.client_name}`, String(body.id) === String(p.page_id) ? 'pass' : 'warn', `Token works for "${body.name ?? p.page_name}".`);
    } catch (e) { add(`Facebook Page: ${p.client_name}`, 'fail', e.message); }
  }

  // Deployment hygiene
  if (cfg.host !== '127.0.0.1') {
    add('HTTPS cookies', cfg.cookieSecure ? 'pass' : 'warn', cfg.cookieSecure ? 'Secure cookies are on.' : 'Set NODE_ENV=production (or COOKIE_SECURE=true) when serving over HTTPS.');
    add('Setup token', cfg.setupToken ? 'pass' : 'warn', cfg.setupToken ? 'Set.' : 'Set SETUP_TOKEN so nobody else can claim the owner account first.');
  }
  return out;
}
