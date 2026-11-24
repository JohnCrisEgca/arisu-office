import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import * as auth from './auth.js';
import { can, ROLES } from './permissions.js';
import { createAi, AiError } from './ai.js';
import { publishToPage, FbError } from './facebook.js';
import { encrypt, decrypt } from './secrets.js';
import { localChecks } from './checks.js';
import { loadAgreement } from './agreement.js';
import { ROOT } from './config.js';
import { HttpError, str } from './util.js';
import { registerExtras } from './extras.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const ai = createAi(cfg);
  const limiter = new auth.LoginLimiter(5, 15 * 60 * 1000);
  const routes = [];

  // ---------- helpers ----------
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, opts, handler });
  };

  const audit = (actor, action, clientId, detail = '') => {
    db.prepare('INSERT INTO audit (ts, actor_type, actor_id, actor_label, action, client_id, detail) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), actor.type, actor.id ?? null, actor.label ?? '', action, clientId ?? null, String(detail).slice(0, 500));
  };
  const userActor = (u) => ({ type: 'user', id: u.id, label: `${u.name} (${u.role})` });
  const agentActor = (name) => ({ type: 'agent', id: null, label: name });

  const agreement = loadAgreement();
  const needsAgreement = (u) => u.agreement_version !== agreement.version;

  const me = (u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id,
    must_change_password: !!u.must_change_password,
    agreement: { accepted: !needsAgreement(u), version: agreement.version },
    ai_configured: Boolean(cfg.openaiKey && cfg.model),
    fb_publish_enabled: cfg.fbEnabled
  });

  const clientView = (c) => ({ ...c, require_client_approval: !!c.require_client_approval });

  // A client user may only touch their own client. Other clients look like they do not exist.
  function clientFor(user, id) {
    const cid = Number(id);
    const c = Number.isInteger(cid) ? db.prepare('SELECT * FROM clients WHERE id = ?').get(cid) : null;
    if (!c || (user.role === 'client' && user.client_id !== c.id)) throw new HttpError(404, 'Client not found.');
    return c;
  }
  // Pinned notes are sent to the AI as background about the business.
  const withNotes = (c) => ({ ...c, pinned_notes: db.prepare('SELECT title, body FROM notes WHERE client_id = ? AND pinned = 1 ORDER BY id DESC LIMIT 8').all(c.id) });

  function draftFor(user, id) {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(id));
    if (!d || (user.role === 'client' && user.client_id !== d.client_id)) throw new HttpError(404, 'Draft not found.');
    return d;
  }

  function draftView(d, client) {
    return {
      id: d.id, client_id: d.client_id, kind: d.kind, content: d.content, topic: d.topic, source_text: d.source_text,
      rationale: d.rationale, best_time: d.best_time, review_verdict: d.review_verdict,
      review_notes: JSON.parse(d.review_notes || '[]'),
      local_issues: ['draft', 'approved'].includes(d.status) ? localChecks(d.content, client) : [],
      status: d.status, model: d.model, created_at: d.created_at, updated_at: d.updated_at,
      scheduled_at: d.scheduled_at, approved_by: d.approved_by, approved_at: d.approved_at,
      published_at: d.published_at, fb_post_id: d.fb_post_id, error: d.error
    };
  }

  function takeAiQuota(user) {
    const day = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO usage (day, user_id, n) VALUES (?,?,0) ON CONFLICT(day, user_id) DO NOTHING').run(day, user.id);
    const row = db.prepare('SELECT n FROM usage WHERE day = ? AND user_id = ?').get(day, user.id);
    if (row.n >= cfg.aiDailyLimit) throw new HttpError(429, `Daily AI limit reached (${cfg.aiDailyLimit} requests).`);
    db.prepare('UPDATE usage SET n = n + 1 WHERE day = ? AND user_id = ?').run(day, user.id);
  }

  async function withJob(agent, clientId, fn) {
    const id = db.prepare('INSERT INTO jobs (agent, client_id, status, started_at) VALUES (?,?,?,?)')
      .run(agent, clientId ?? null, 'running', Date.now()).lastInsertRowid;
    try {
      const out = await fn();
      db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('done', Date.now(), id);
      return out;
    } catch (e) {
      db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('failed', Date.now(), id);
      throw e;
    }
  }

  const aiGuard = (e) => {
    if (e instanceof AiError) throw new HttpError(e.status, e.message);
    throw e;
  };

  function startSession(res, user) {
    const token = auth.createSession(db, user.id, cfg.sessionTtlMs);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: cfg.cookieSecure, maxAgeSec: cfg.sessionTtlMs / 1000 }));
  }

  // ---------- public routes ----------
  route('GET', '/api/health', { auth: false }, () => ({
    ok: true, needs_setup: db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0
  }));

  route('POST', '/api/setup', { auth: false }, async ({ body, res, ip }) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) throw new HttpError(403, 'Setup is already done.');
    if (cfg.setupToken) {
      const a = Buffer.from(String(body.setup_token || '')); const b = Buffer.from(cfg.setupToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Wrong setup token.');
    }
    const email = str(body.email, { max: 254, min: 3, field: 'Email' }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
    const name = str(body.name, { max: 80, min: 1, field: 'Name' });
    const problem = auth.passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const id = db.prepare('INSERT INTO users (email, name, pw_hash, role, created_at) VALUES (?,?,?,?,?)')
      .run(email, name, await auth.hashPassword(body.password), 'owner', Date.now()).lastInsertRowid;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    audit(userActor(user), 'setup.owner_created', null, `ip ${ip}`);
    startSession(res, user);
    return { user: me(user) };
  });

  route('POST', '/api/login', { auth: false }, async ({ body, res, ip }) => {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(body.password || '').slice(0, 200);
    const key = `${email}|${ip}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    let ok = false;
    if (u) ok = await auth.verifyPassword(password, u.pw_hash); else await auth.dummyVerify(password);
    if (!ok || u.disabled) {
      limiter.fail(key);
      audit({ type: 'system', label: 'login' }, 'login.failed', null, `${email} ip ${ip}`);
      throw new HttpError(401, 'Wrong email or password.');
    }
    limiter.clear(key);
    startSession(res, u);
    audit(userActor(u), 'login.ok', u.client_id, `ip ${ip}`);
    return { user: me(u) };
  });

  // ---------- session routes (no agreement needed yet) ----------
  const early = { agreementExempt: true, passwordExempt: true };

  route('POST', '/api/logout', { ...early }, ({ res, token, user }) => {
    auth.destroySession(db, token);
    res.setHeader('Set-Cookie', auth.sessionCookie('', { secure: cfg.cookieSecure, maxAgeSec: 0 }));
    audit(userActor(user), 'logout', user.client_id);
    return { ok: true };
  });

  route('GET', '/api/me', { ...early }, ({ user }) => ({ user: me(user) }));

  route('POST', '/api/me/password', { agreementExempt: true, passwordExempt: true }, async ({ user, body, token }) => {
    if (!(await auth.verifyPassword(String(body.current || ''), user.pw_hash))) throw new HttpError(403, 'Current password is wrong.');
    const problem = auth.passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET pw_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(await auth.hashPassword(body.password), user.id);
    auth.destroyUserSessions(db, user.id, token); // log out every other device
    audit(userActor(user), 'password.changed', user.client_id);
    return { ok: true };
  });

  route('GET', '/api/agreement', { agreementExempt: true }, () => ({ version: agreement.version, text: agreement.text }));

  route('POST', '/api/agreement/accept', { agreementExempt: true }, ({ user, body }) => {
    if (body.version !== agreement.version) throw new HttpError(409, 'The agreement changed. Reload and read it again.');
    db.prepare('UPDATE users SET agreement_version = ?, agreement_at = ? WHERE id = ?').run(agreement.version, Date.now(), user.id);
    audit(userActor(user), 'agreement.accepted', user.client_id, `version ${agreement.version}`);
    return { ok: true };
  });

  // ---------- users (owner) ----------
  const userRow = (u) => ({
    id: u.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id,
    disabled: !!u.disabled, agreement_accepted: u.agreement_version === agreement.version
  });

  route('GET', '/api/users', { perm: 'users:manage' }, () => ({
    users: db.prepare('SELECT * FROM users ORDER BY id').all().map(userRow)
  }));

  route('POST', '/api/users', { perm: 'users:manage' }, async ({ user, body }) => {
    const email = str(body.email, { max: 254, min: 3, field: 'Email' }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
    const name = str(body.name, { max: 80, min: 1, field: 'Name' });
    if (!ROLES.includes(body.role) || body.role === 'owner') throw new HttpError(400, 'Role must be manager or client.');
    let clientId = null;
    if (body.role === 'client') {
      clientId = clientFor(user, body.client_id).id;
    }
    const problem = auth.passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account.');
    const id = db.prepare('INSERT INTO users (email, name, pw_hash, role, client_id, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(email, name, await auth.hashPassword(body.password), body.role, clientId, Date.now()).lastInsertRowid;
    audit(userActor(user), 'user.created', clientId, `${email} as ${body.role}`);
    return { user: userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  route('PATCH', '/api/users/:id', { perm: 'users:manage' }, ({ user, params, body }) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === user.id) throw new HttpError(400, 'You cannot change your own account here.');
    if (target.role === 'owner') throw new HttpError(400, 'The owner account cannot be changed here.');
    if (typeof body.disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, target.id);
      if (body.disabled) auth.destroyUserSessions(db, target.id);
      audit(userActor(user), body.disabled ? 'user.disabled' : 'user.enabled', target.client_id, target.email);
    }
    return { user: userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) };
  });

  // ---------- clients ----------
  const clientFields = (b) => ({
    name: str(b.name, { max: 120, min: 1, field: 'Name' }),
    language: str(b.language || 'English', { max: 40, min: 1, field: 'Language' }),
    brand_voice: str(b.brand_voice ?? '', { max: 1500, field: 'Brand voice' }),
    audience: str(b.audience ?? '', { max: 600, field: 'Audience' }),
    do_not_say: str(b.do_not_say ?? '', { max: 800, field: 'Never say' }),
    require_client_approval: b.require_client_approval ? 1 : 0
  });

  route('GET', '/api/clients', { perm: 'clients:read' }, ({ user }) => {
    const rows = user.role === 'client'
      ? db.prepare('SELECT * FROM clients WHERE id = ?').all(user.client_id)
      : db.prepare('SELECT * FROM clients ORDER BY name').all();
    const pages = db.prepare('SELECT client_id, page_id, page_name FROM fb_pages').all();
    return { clients: rows.map((c) => ({ ...clientView(c), page: pages.find((p) => p.client_id === c.id) ?? null })) };
  });

  route('POST', '/api/clients', { perm: 'clients:write' }, ({ user, body }) => {
    const f = clientFields(body);
    const id = db.prepare('INSERT INTO clients (name, language, brand_voice, audience, do_not_say, require_client_approval, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(f.name, f.language, f.brand_voice, f.audience, f.do_not_say, f.require_client_approval, Date.now()).lastInsertRowid;
    audit(userActor(user), 'client.created', Number(id), f.name);
    return { client: clientView(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)) };
  });

  route('PATCH', '/api/clients/:id', { perm: 'clients:write' }, ({ user, params, body }) => {
    const c = clientFor(user, params.id);
    const f = clientFields({ ...c, ...body });
    db.prepare('UPDATE clients SET name=?, language=?, brand_voice=?, audience=?, do_not_say=?, require_client_approval=? WHERE id=?')
      .run(f.name, f.language, f.brand_voice, f.audience, f.do_not_say, f.require_client_approval, c.id);
    audit(userActor(user), 'client.updated', c.id, f.name);
    return { client: clientView(db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id)) };
  });

  route('PUT', '/api/clients/:id/page', { perm: 'pages:connect' }, ({ user, params, body }) => {
    const c = clientFor(user, params.id);
    const pageId = str(body.page_id, { max: 30, min: 5, field: 'Page ID' });
    if (!/^\d+$/.test(pageId)) throw new HttpError(400, 'Page ID must be digits only.');
    const pageName = str(body.page_name, { max: 120, min: 1, field: 'Page name' });
    const token = str(body.access_token, { max: 1500, min: 20, field: 'Access token' });
    db.prepare(`INSERT INTO fb_pages (client_id, page_id, page_name, token_enc, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET page_id=excluded.page_id, page_name=excluded.page_name, token_enc=excluded.token_enc`)
      .run(c.id, pageId, pageName, encrypt(cfg.secretKey, token), Date.now());
    audit(userActor(user), 'page.connected', c.id, `${pageName} (${pageId})`); // the token is never logged
    return { page: { page_id: pageId, page_name: pageName } };
  });

  // ---------- AI agents ----------
  route('POST', '/api/clients/:id/ideas', { perm: 'drafts:generate' }, async ({ user, params, body }) => {
    const c = withNotes(clientFor(user, params.id));
    takeAiQuota(user);
    try {
      const ideas = await withJob('scout', c.id, () => ai.ideas(c, { goal: str(body.goal ?? '', { max: 300, field: 'Goal' }) }));
      audit(agentActor('Pilar (ideas)'), 'agent.ideas', c.id, `${ideas.length} ideas, requested by ${user.email}`);
      return { ideas };
    } catch (e) { aiGuard(e); }
  });

  route('POST', '/api/clients/:id/generate', { perm: 'drafts:generate' }, async ({ user, params, body }) => {
    const c = withNotes(clientFor(user, params.id));
    const topic = str(body.topic, { max: 500, min: 3, field: 'Topic' });
    const goal = str(body.goal ?? '', { max: 200, field: 'Goal' });
    const count = Math.min(Math.max(parseInt(body.count ?? 3, 10) || 3, 1), 5);
    takeAiQuota(user);
    let posts; let reviews;
    try {
      posts = await withJob('script', c.id, () => ai.writePosts(c, { topic, count, goal }));
      if (!posts.length) throw new HttpError(502, 'The AI did not produce any posts. Please try again.');
      takeAiQuota(user); // the review is a second AI request
      reviews = await withJob('qa', c.id, () => ai.reviewPosts(c, posts.map((p) => p.text)));
    } catch (e) { aiGuard(e); }
    const now = Date.now();
    const insert = db.prepare(`INSERT INTO drafts (client_id, kind, content, topic, rationale, best_time, review_verdict, review_notes, status, model, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ids = posts.map((p, i) => insert.run(c.id, 'post', p.text, topic, p.why, p.best_time,
      reviews[i].verdict, JSON.stringify(reviews[i].issues), 'draft', cfg.model, user.id, now, now).lastInsertRowid);
    audit(agentActor('Lia (copywriter)'), 'agent.drafted', c.id, `${ids.length} drafts on "${topic}", requested by ${user.email}`);
    audit(agentActor('Nela (reviewer)'), 'agent.reviewed', c.id, reviews.map((r) => r.verdict).join(','));
    const rows = ids.map((id) => draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(id), c));
    return { drafts: rows };
  });

  route('POST', '/api/clients/:id/replies', { perm: 'drafts:generate' }, async ({ user, params, body }) => {
    const c = withNotes(clientFor(user, params.id));
    const comment = str(body.comment, { max: 1000, min: 1, field: 'Comment' });
    takeAiQuota(user);
    let r;
    try { r = await withJob('support', c.id, () => ai.draftReply(c, { comment })); } catch (e) { aiGuard(e); }
    const now = Date.now();
    const notes = r.needs_human ? [`Needs a person's judgement: ${r.reason || 'sensitive comment'}`] : [];
    const id = db.prepare(`INSERT INTO drafts (client_id, kind, content, source_text, review_verdict, review_notes, status, model, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, 'reply', r.reply, comment, r.needs_human ? 'revise' : 'pass',
      JSON.stringify(notes), 'draft', cfg.model, user.id, now, now).lastInsertRowid;
    audit(agentActor('Rey (support)'), 'agent.reply_drafted', c.id, `requested by ${user.email}`);
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(id), c) };
  });

  // ---------- drafts: edit / approve / publish ----------
  route('GET', '/api/drafts', { perm: 'clients:read' }, ({ user, url }) => {
    let cid = url.searchParams.get('client_id');
    if (user.role === 'client') cid = user.client_id;
    const status = url.searchParams.get('status');
    const where = []; const args = [];
    if (cid) { where.push('client_id = ?'); args.push(Number(cid)); }
    if (status) { where.push('status = ?'); args.push(status); }
    const rows = db.prepare(`SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
    const clients = new Map(db.prepare('SELECT * FROM clients').all().map((c) => [c.id, c]));
    return { drafts: rows.map((d) => draftView(d, clients.get(d.client_id))) };
  });

  route('PATCH', '/api/drafts/:id', { perm: 'drafts:edit' }, ({ user, params, body }) => {
    const d = draftFor(user, params.id);
    const c = clientFor(user, d.client_id);
    if (['published', 'posted_manually'].includes(d.status)) throw new HttpError(409, 'This post is already out and cannot be edited.');
    let content = d.content; let status = d.status; let verdict = d.review_verdict;
    let approvedBy = d.approved_by; let approvedAt = d.approved_at; let approvedHash = d.approved_hash;
    if (typeof body.content === 'string') {
      content = str(body.content, { max: 3000, min: 1, field: 'Text' });
      if (content !== d.content) {
        // Any change to the words cancels the approval.
        status = 'draft'; verdict = 'edited'; approvedBy = approvedAt = approvedHash = null;
      }
    }
    let scheduledAt = d.scheduled_at;
    if ('scheduled_at' in body) {
      if (body.scheduled_at === null) scheduledAt = null;
      else {
        const t = Date.parse(body.scheduled_at);
        if (!Number.isFinite(t)) throw new HttpError(400, 'Invalid schedule time.');
        scheduledAt = t;
      }
    }
    db.prepare(`UPDATE drafts SET content=?, status=?, review_verdict=?, approved_by=?, approved_at=?, approved_hash=?, scheduled_at=?, error=NULL, updated_at=? WHERE id=?`)
      .run(content, status, verdict, approvedBy, approvedAt, approvedHash, scheduledAt, Date.now(), d.id);
    audit(userActor(user), content !== d.content ? 'draft.edited' : 'draft.schedule_changed', c.id, `draft ${d.id}`);
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id), c) };
  });

  route('POST', '/api/drafts/:id/approve', { perm: 'drafts:approve' }, ({ user, params, body }) => {
    const d = draftFor(user, params.id);
    const c = clientFor(user, d.client_id);
    if (d.status !== 'draft') throw new HttpError(409, `Only drafts can be approved (this one is ${d.status}).`);
    if (c.require_client_approval && user.role !== 'client') {
      throw new HttpError(403, 'This client requires their own account to approve posts.');
    }
    const issues = localChecks(d.content, c);
    if (issues.length) throw new HttpError(409, 'Fix these problems before approving.', { code: 'blocked', issues });
    if (['revise', 'block'].includes(d.review_verdict) && body.acknowledge_flags !== true) {
      throw new HttpError(409, 'The AI reviewer flagged this draft. Confirm you have read the flags.', { code: 'flags_need_acknowledgement' });
    }
    db.prepare('UPDATE drafts SET status=?, approved_by=?, approved_at=?, approved_hash=?, updated_at=? WHERE id=?')
      .run('approved', user.id, Date.now(), sha256(d.content), Date.now(), d.id);
    audit(userActor(user), 'draft.approved', c.id, `draft ${d.id}, reviewer verdict ${d.review_verdict}`);
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id), c) };
  });

  route('POST', '/api/drafts/:id/reject', { perm: 'drafts:approve' }, ({ user, params }) => {
    const d = draftFor(user, params.id);
    const c = clientFor(user, d.client_id);
    if (!['draft', 'approved', 'failed'].includes(d.status)) throw new HttpError(409, `Cannot reject a ${d.status} post.`);
    db.prepare('UPDATE drafts SET status=?, approved_by=NULL, approved_at=NULL, approved_hash=NULL, updated_at=? WHERE id=?')
      .run('rejected', Date.now(), d.id);
    audit(userActor(user), 'draft.rejected', c.id, `draft ${d.id}`);
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id), c) };
  });

  // The gate: a draft is only releasable when a person approved these exact words.
  function assertApproved(d) {
    if (!['approved', 'failed'].includes(d.status) || !d.approved_by || !d.approved_hash || sha256(d.content) !== d.approved_hash) {
      throw new HttpError(409, 'This post has not been approved. A person must approve the exact text first.');
    }
  }

  route('POST', '/api/drafts/:id/publish', { perm: 'drafts:publish' }, async ({ user, params }) => {
    const d = draftFor(user, params.id);
    const c = clientFor(user, d.client_id);
    if (d.kind !== 'post') throw new HttpError(400, 'Replies are never sent by the system. Copy the approved reply and post it yourself.');
    assertApproved(d);
    if (!cfg.fbEnabled) throw new HttpError(409, 'Facebook publishing is turned off on this server. Post it yourself, then press "Mark as posted".');
    const page = db.prepare('SELECT * FROM fb_pages WHERE client_id = ?').get(c.id);
    if (!page) throw new HttpError(409, 'No Facebook Page is connected for this client.');
    let scheduledAt = null;
    if (d.scheduled_at) {
      const ahead = d.scheduled_at - Date.now();
      if (ahead < 10 * 60 * 1000) throw new HttpError(400, 'Facebook needs scheduled posts to be at least 10 minutes ahead. Change or clear the time.');
      if (ahead > 30 * 24 * 3600 * 1000) throw new HttpError(400, 'Facebook only allows scheduling up to 30 days ahead.');
      scheduledAt = d.scheduled_at;
    }
    try {
      const fbId = await withJob('social', c.id, () => publishToPage(cfg, {
        pageId: page.page_id, token: decrypt(cfg.secretKey, page.token_enc), message: d.content, scheduledAt
      }));
      db.prepare('UPDATE drafts SET status=?, published_at=?, fb_post_id=?, error=NULL, updated_at=? WHERE id=?')
        .run('published', Date.now(), fbId, Date.now(), d.id);
      audit(userActor(user), scheduledAt ? 'draft.scheduled_on_facebook' : 'draft.published', c.id, `draft ${d.id} -> ${fbId}`);
    } catch (e) {
      if (!(e instanceof FbError)) throw e;
      db.prepare('UPDATE drafts SET status=?, error=?, updated_at=? WHERE id=?').run('failed', e.message, Date.now(), d.id);
      audit(userActor(user), 'draft.publish_failed', c.id, `draft ${d.id}: ${e.message}`);
      throw new HttpError(502, e.message);
    }
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id), c) };
  });

  route('POST', '/api/drafts/:id/mark-posted', { perm: 'drafts:publish' }, ({ user, params }) => {
    const d = draftFor(user, params.id);
    const c = clientFor(user, d.client_id);
    assertApproved(d);
    db.prepare('UPDATE drafts SET status=?, published_at=?, error=NULL, updated_at=? WHERE id=?')
      .run('posted_manually', Date.now(), Date.now(), d.id);
    audit(userActor(user), 'draft.marked_posted', c.id, `draft ${d.id}`);
    return { draft: draftView(db.prepare('SELECT * FROM drafts WHERE id = ?').get(d.id), c) };
  });

  // ---------- office floor, audit, admin ----------
  // Every agent on the floor now does real work. Each maps to the job name it records when it runs ("lead" = any job).
  const WIRED = { lead: null, scout: 'scout', script: 'script', qa: 'qa', support: 'support', social: 'social',
    plan: 'plan', design: 'design', video: 'video', reader: 'reader', pipe: 'pipe', memo: 'memo', hr: 'hr', git: 'git',
    books: 'books', index: 'index', risk: 'risk', tests: 'tests' };
  route('GET', '/api/office', { perm: 'clients:read' }, ({ user }) => {
    const since = Date.now() - 5 * 60 * 1000; // a "running" job older than 5 minutes is stale
    const scope = user.role === 'client' ? ' AND client_id = ' + Number(user.client_id) : '';
    const running = new Set(db.prepare(`SELECT agent FROM jobs WHERE status='running' AND started_at > ?${scope}`).all(since).map((r) => r.agent));
    const last = Object.fromEntries(db.prepare(`SELECT agent, MAX(finished_at) AS t FROM jobs WHERE finished_at IS NOT NULL${scope} GROUP BY agent`).all().map((r) => [r.agent, r.t]));
    const agents = {};
    for (const [floorId, jobAgent] of Object.entries(WIRED)) {
      agents[floorId] = {
        connected: true,
        status: (jobAgent ? running.has(jobAgent) : running.size > 0) ? 'working' : 'idle',
        last_run: jobAgent ? last[jobAgent] ?? null : null
      };
    }
    return { agents };
  });

  route('GET', '/api/audit', { perm: 'audit:read' }, ({ url }) => {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 300);
    return { entries: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) };
  });

  route('GET', '/api/admin/models', { perm: 'admin:models' }, async () => {
    try {
      return { configured_model: cfg.model || null, review_model: cfg.reviewModel || null, available: await ai.listModels() };
    } catch (e) { aiGuard(e); }
  });

  registerExtras({ cfg, db, ai, route, audit, userActor, agentActor, clientFor, takeAiQuota, withJob, aiGuard, withNotes });

  // ---------- request pipeline ----------
  async function readBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 100_000) throw new HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    if (!size) return {};
    if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send application/json.');
    try {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('shape');
      return b;
    } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function api(req, res, url) {
    const ip = (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    const match = routes.map((r) => ({ r, m: r.method === req.method ? url.pathname.match(r.re) : null })).find((x) => x.m);
    if (!match) throw new HttpError(404, 'Not found.');
    const { r, m } = match;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

    if (req.method !== 'GET') {
      // CSRF defence in depth: SameSite=Strict cookie + same-origin check + a header browsers will not send cross-site without CORS approval.
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.headers.host; } catch { /* invalid origin */ }
        if (!same) throw new HttpError(403, 'Cross-origin request blocked.');
      }
      if (req.headers['x-requested-with'] !== 'arisu') throw new HttpError(403, 'Missing request header.');
    }
    const body = await readBody(req);

    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    let user = null;
    if (r.opts.auth !== false) {
      user = auth.sessionUser(db, token);
      if (!user) throw new HttpError(401, 'Please log in.');
      if (user.must_change_password && !r.opts.passwordExempt) throw new HttpError(403, 'Change your password first.', { code: 'password_change_required' });
      if (needsAgreement(user) && !r.opts.agreementExempt) throw new HttpError(403, 'Accept the AI Use and Approval Agreement first.', { code: 'agreement_required' });
      if (r.opts.perm && !can(user.role, r.opts.perm)) throw new HttpError(403, 'You do not have permission to do that.');
    }
    const out = await r.handler({ req, res, url, params, body, user, token, ip });
    send(res, 200, out);
  }

  function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad path.'); }
    if (p === '/') p = '/index.html';
    const full = path.resolve(PUBLIC_DIR, '.' + p);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (res.headersSent) return res.end();
        send(res, e.status, { error: e.message, ...e.extra });
      } else {
        console.error('Unhandled error:', e?.message);
        if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });

  return { server, db, close: () => new Promise((resolve) => { server.close(() => { db.close(); resolve(); }); }) };
}
