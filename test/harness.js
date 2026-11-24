import http from 'node:http';
import { createApp } from '../server/app.js';
import { buildConfig } from '../server/config.js';
import { loadAgreement } from '../server/agreement.js';

export const PW = 'correct-horse-battery';
export const TOKEN = 'EAAB-super-secret-page-token-123456';

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const readText = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };

// Canned answers per agent role, standing in for OpenAI.
const ANSWERS = {
  'content-planner': { items: [{ date_hint: 'Week 1 Tue', theme: 'Fresh bread', format: 'photo', topic: 'Show the morning batch' }] },
  'visual-brief-writer': { visual_idea: 'Close-up of steam rising', text_overlay: 'Fresh at 6am', alt_text: 'Bread on a tray', format: 'photo', notes: '' },
  'reel-scriptwriter': { hook: 'Wait for the crack', shots: [{ scene: '1', show: 'Crust', say: 'Hear that?' }], caption: 'Warm.', length_seconds: 20, cta: 'Visit us' },
  'trend-analyst': { summary: 'Rivals post videos', patterns: ['Short clips'], opportunities: ['Show the baker'], risks: [] },
  'sales-followup-writer': { message: 'Hi po, checking in on the proposal.', next_step: 'Call Friday', needs_human: false, reason: '' },
  'billing-reminder-writer': { message: 'Hello po, a friendly reminder about your invoice.' },
  'note-keeper': { title: 'Kickoff', summary: 'Agreed on weekly posts', decisions: ['3 posts a week'], todos: ['Send logo'] },
  'onboarding-guide': { language: 'Taglish', brand_voice: 'Warm and funny', audience: 'Neighbours', do_not_say: 'cheapest, guaranteed', questions: ['What are your opening hours?'] },
  'page-insights-reader': { summary: 'Photo posts did best', best: ['Morning photo'], improve: ['Post later'], next_ideas: ['Behind the oven'] },
  'system-check': { ok: true }
};

export async function startHarness(overrides = {}) {
  const calls = { openai: [], graph: [] };
  const state = { graphPosts: [{ created_time: '2026-11-20T01:00:00+0000', message: 'Fresh pandesal!', likes: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } }] };

  const openai = await listen(async (req, res) => {
    const raw = await readText(req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-test-1' }, { id: 'o9-mini' }] }));
    const body = JSON.parse(raw);
    calls.openai.push(body);
    const role = /ROLE: ([\w-]+)/.exec(body.instructions)[1];
    let out = ANSWERS[role] ?? { ideas: [] };
    if (role === 'copywriter') {
      const n = Number(/Write (\d+) different/.exec(body.input)[1]);
      out = { posts: Array.from({ length: n }, (_, i) => ({ text: `Fresh bread every morning, batch ${i + 1}!`, why: 'Habit', best_time: 'Tue 7am' })) };
    } else if (role === 'quality-reviewer') {
      out = { results: [...body.input.matchAll(/#(\d+): /g)].map((m) => ({ index: Number(m[1]), verdict: 'pass', issues: [] })) };
    }
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }));
  });

  const graph = await listen(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      calls.graph.push({ method: 'GET', path: url.pathname, query: url.searchParams });
      if (url.searchParams.get('access_token') !== TOKEN) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: `Bad token ${url.searchParams.get('access_token')}` } })); }
      if (url.pathname.endsWith('/posts')) return res.end(JSON.stringify({ data: state.graphPosts }));
      return res.end(JSON.stringify({ id: url.pathname.split('/')[1], name: 'Pandesal Hub Page' }));
    }
    const params = new URLSearchParams(await readText(req));
    calls.graph.push({ method: 'POST', path: url.pathname, params });
    res.end(JSON.stringify({ id: '999_' + calls.graph.length }));
  });

  const cfg = buildConfig({}, {
    dbPath: ':memory:', secretKey: Buffer.alloc(32, 9), openaiKey: 'test-key', model: 'gpt-test-1',
    openaiBase: `http://127.0.0.1:${openai.address().port}/v1`, graphBase: `http://127.0.0.1:${graph.address().port}`,
    fbEnabled: false, aiDailyLimit: 1000, timezone: 'Asia/Manila', ...overrides
  });
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const makeClient = () => {
    let cookie = '';
    return async (method, path, body) => {
      const headers = { 'x-requested-with': 'arisu' };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie');
      if (sc) { cookie = sc.split(';')[0]; if (cookie.endsWith('=')) cookie = ''; }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text };
    };
  };

  const agree = loadAgreement().version;
  async function setupOwner() {
    const owner = makeClient();
    await owner('POST', '/api/setup', { email: 'boss@arisu.test', name: 'Boss', password: PW });
    await owner('POST', '/api/agreement/accept', { version: agree });
    return owner;
  }
  async function addUser(owner, { email, name, role, client_id }) {
    await owner('POST', '/api/users', { email, name, role, client_id, password: 'temp-password-1' });
    const c = makeClient();
    await c('POST', '/api/login', { email, password: 'temp-password-1' });
    await c('POST', '/api/me/password', { current: 'temp-password-1', password: PW });
    await c('POST', '/api/agreement/accept', { version: agree });
    return c;
  }

  return { base, cfg, app, calls, state, makeClient, setupOwner, addUser, async stop() { await app.close(); openai.close(); graph.close(); } };
}
