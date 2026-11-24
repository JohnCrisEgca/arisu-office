// Arisu Office front-end. No inline scripts/styles (strict CSP), and all text is inserted with textContent,
// so nothing the AI or a user writes can ever run as code in the browser.

import { viewStudio } from './studio.js';
import { viewInvoices } from './invoices.js';

const root = document.getElementById('app');
const state = { user: null, clients: [], clientId: null, tab: 'office', filter: 'draft' };
let cleanup = () => {};

// ---------- tiny helpers ----------
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value') deferredValue = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['checked', 'disabled', 'readOnly'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'x-requested-with': 'arisu', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

function toast(msg, isErr = false) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: isErr ? 'alert' : 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), isErr ? 7000 : 3500);
}

// Run an action on a button: disable while working, show errors, bounce to login/agreement when the server says so.
async function run(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try { return await fn(); } catch (e) {
    if (e.status === 401 || ['agreement_required', 'password_change_required'].includes(e.data?.code)) return boot();
    const issues = e.data?.issues?.length ? ' ' + e.data.issues.join(' ') : '';
    toast(e.message + issues, true);
  } finally {
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '');
const isStaff = () => state.user.role !== 'client';
const mount = (...nodes) => { cleanup(); cleanup = () => {}; root.replaceChildren(...nodes); };
const field = (label, input) => h('label', {}, label, input);

const ctx = {
  h, api, run, toast, fmt, field, state, isStaff,
  redraw: () => screenMain(),
  reloadClients: () => loadClients(),
  goPosts: (topic) => { state.prefill = topic; state.tab = 'posts'; screenMain(); }
};

// ---------- boot ----------
async function boot() {
  try {
    state.user = (await api('GET', '/api/me')).user;
  } catch {
    state.user = null;
    const health = await api('GET', '/api/health').catch(() => ({}));
    return health.needs_setup ? screenSetup() : screenLogin();
  }
  if (state.user.must_change_password) return screenPassword();
  if (!state.user.agreement.accepted) return screenAgreement();
  await loadClients();
  screenMain();
}

async function loadClients() {
  state.clients = (await api('GET', '/api/clients')).clients;
  if (state.user.role === 'client') state.clientId = state.user.client_id;
  else if (!state.clients.some((c) => c.id === state.clientId)) state.clientId = state.clients[0]?.id ?? null;
}

// ---------- auth screens ----------
function brandCard(title, ...kids) {
  return h('div', { class: 'center' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, 'ARISU ', h('span', {}, 'OFFICE')), h('h3', {}, title), ...kids));
}

function screenLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Log in');
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); run(btn, async () => { await api('POST', '/api/login', { email: email.value, password: pw.value }); await boot(); }); } },
    field('Email', email), field('Password', pw), btn);
  mount(brandCard('Log in', form));
}

function screenSetup() {
  const f = { name: h('input', { autocomplete: 'name', required: true }), email: h('input', { type: 'email', autocomplete: 'username', required: true }),
    pw: h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), tok: h('input', { autocomplete: 'off' }) };
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Create owner account');
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); run(btn, async () => {
    await api('POST', '/api/setup', { name: f.name.value, email: f.email.value, password: f.pw.value, setup_token: f.tok.value });
    await boot();
  }); } }, field('Your name', f.name), field('Email', f.email), field('Password (10+ characters)', f.pw),
  field('Setup token (only if your server has one)', f.tok), btn);
  mount(brandCard('First-time setup', h('p', { class: 'muted' }, 'This creates the owner account. Do this right after you deploy, before anyone else can.'), form));
}

function screenPassword() {
  const f = { cur: h('input', { type: 'password', autocomplete: 'current-password', required: true }),
    pw: h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true }),
    pw2: h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true }) };
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save new password');
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault();
    if (f.pw.value !== f.pw2.value) return toast('The new passwords do not match.', true);
    run(btn, async () => { await api('POST', '/api/me/password', { current: f.cur.value, password: f.pw.value }); toast('Password changed.'); await boot(); });
  } }, field('Temporary password', f.cur), field('New password (10+ characters)', f.pw), field('Repeat new password', f.pw2), btn);
  mount(brandCard('Choose your own password', form));
}

async function screenAgreement() {
  const { version, text } = await api('GET', '/api/agreement');
  const box = h('input', { type: 'checkbox', id: 'agree' });
  const btn = h('button', { class: 'btn', disabled: true }, 'Accept and continue');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });
  btn.addEventListener('click', () => run(btn, async () => { await api('POST', '/api/agreement/accept', { version }); await boot(); }));
  const card = brandCard('AI Use and Approval Agreement',
    h('div', { class: 'agreement-text', tabindex: 0 }, text),
    h('label', { class: 'check' }, box, 'I have read this. I understand the AI only prepares drafts and nothing is published until a person approves it.'),
    h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: logout }, 'Log out'), btn));
  card.classList.add('wide');
  mount(card);
}

async function logout() {
  await api('POST', '/api/logout', {}).catch(() => {});
  boot();
}

// ---------- main shell ----------
function screenMain() {
  const tabs = [['office', 'Office'], ['posts', 'Posts'], ['studio', 'Studio'], ['invoices', 'Invoices']];
  if (isStaff()) tabs.push(['clients', 'Clients']);
  if (state.user.role === 'owner') tabs.push(['team', 'Team & AI']);
  if (isStaff()) tabs.push(['activity', 'Activity']);
  if (!tabs.some(([k]) => k === state.tab)) state.tab = 'office';

  const content = h('main');
  const nav = h('nav', { class: 'tabs' }, tabs.map(([k, label]) => h('button', {
    class: k === state.tab ? 'on' : '', onclick: () => { state.tab = k; screenMain(); }
  }, label)));
  mount(
    h('header', { class: 'top' }, h('div', { class: 'brand' }, 'ARISU ', h('span', {}, 'OFFICE')), nav,
      h('div', { class: 'who' }, `${state.user.name} · ${state.user.role}`, h('button', { class: 'btn ghost', onclick: logout }, 'Log out'))),
    content);
  const views = {
    office: viewOffice, posts: viewPosts, clients: viewClients, activity: viewActivity,
    studio: (c) => viewStudio(ctx, c), invoices: (c) => viewInvoices(ctx, c),
    team: async (c) => { await viewTeam(c); await teamExtras(c); }
  };
  views[state.tab](content).catch?.((e) => { if (e.status === 401) boot(); else toast(e.message, true); });
}

// ---------- Office floor ----------
const ROOMS = {
  command: { label: 'Command Deck', x: 0.10, y: 0.12, w: 0.36, h: 0.30, color: '#a48bff' },
  research: { label: 'Research Lab', x: 0.60, y: 0.14, w: 0.36, h: 0.30, color: '#3dd6c6' },
  content: { label: 'Content Studio', x: 0.12, y: 0.60, w: 0.36, h: 0.28, color: '#ff6fa3' },
  ops: { label: 'Ops Room', x: 0.58, y: 0.60, w: 0.36, h: 0.28, color: '#ffc857' },
  brain: { label: 'Shared Brain', x: 0.40, y: 0.44, w: 0.20, h: 0.13, color: '#7ad7ff' }
};

// All 18 agents are connected. Each one does real work and never acts on its own: a person reads, approves, or sends.
const AGENTS = [
  { id: 'lead', name: 'Arisu', role: 'Chief of Staff', room: 'command', color: '#ff8a3d', wired: true, job: 'Coordinates the team and shows the daily briefing. Shows as working whenever any agent is running.' },
  { id: 'plan', name: 'Ina', role: 'Planner', room: 'command', color: '#7ad7ff', wired: true, job: 'Plans a month of post topics (Studio tab).' },
  { id: 'risk', name: 'Paco', role: 'Risk Watcher', room: 'command', color: '#ff6fa3', wired: true, job: 'Watches for stale drafts, unposted approvals, failed posts and overdue invoices (briefing above). Uses facts from the database, not AI.' },
  { id: 'hr', name: 'Mina', role: 'Onboarding Guide', room: 'command', color: '#5fdc8a', wired: true, job: 'Proposes a brand profile for a new client. A person applies it (Studio tab).' },
  { id: 'scout', name: 'Pilar', role: 'Content Strategist', room: 'research', color: '#3dd6c6', wired: true, job: 'Suggests post ideas (Posts tab, "Get ideas").' },
  { id: 'reader', name: 'Dario', role: 'Trend Analyst', room: 'research', color: '#5fdc8a', wired: true, job: 'Analyses competitor posts or articles you paste in (Studio tab). Does not browse the web.' },
  { id: 'git', name: 'Kiko', role: 'Page Insights', room: 'research', color: '#7ad7ff', wired: true, job: 'Reads recent Page post counts and says what to try next (Studio tab).' },
  { id: 'script', name: 'Lia', role: 'Copywriter', room: 'content', color: '#ff6fa3', wired: true, job: 'Writes Facebook post drafts in the client\'s voice and language.' },
  { id: 'design', name: 'Ren', role: 'Visual Briefs', room: 'content', color: '#5fdc8a', wired: true, job: 'Describes the photo or graphic to go with a post. Cannot make images.' },
  { id: 'video', name: 'Bong', role: 'Reel Planner', room: 'content', color: '#7ad7ff', wired: true, job: 'Writes a Reel plan to film. Cannot edit video.' },
  { id: 'social', name: 'Ysa', role: 'Publisher', room: 'content', color: '#3dd6c6', wired: true, job: 'Publishes to Facebook, only the exact text a person approved.' },
  { id: 'qa', name: 'Nela', role: 'Quality Reviewer', room: 'ops', color: '#ff6fa3', wired: true, job: 'Reviews every draft for risky claims before a person sees it.' },
  { id: 'support', name: 'Rey', role: 'Comment Replies', room: 'ops', color: '#ff8a3d', wired: true, job: 'Drafts replies to comments. A person posts them; the system never sends replies.' },
  { id: 'books', name: 'Teo', role: 'Bookkeeper', room: 'ops', color: '#ffc857', wired: true, job: 'Runs invoicing. The software does all the math; Teo only drafts reminder wording. A person confirms every payment.' },
  { id: 'pipe', name: 'Maya', role: 'Sales Follow-ups', room: 'ops', color: '#a48bff', wired: true, job: 'Drafts a follow-up message for a lead. You send it yourself (Studio tab).' },
  { id: 'tests', name: 'Ben', role: 'System Tester', room: 'ops', color: '#ffc857', wired: true, job: 'Checks your real OpenAI key, model and Facebook tokens (Team & AI tab).' },
  { id: 'memo', name: 'Gio', role: 'Note Keeper', room: 'brain', color: '#ffc857', wired: true, job: 'Tidies raw notes. Pinned notes become background for the AI (Studio tab).' },
  { id: 'index', name: 'Sol', role: 'Search', room: 'brain', color: '#a48bff', wired: true, job: 'Keyword search across notes, drafts and agent output (Studio tab).' }
];

function statusOf(a, live) {
  if (!a.wired) return { label: 'Not connected yet', color: '#6b7191' };
  const s = live?.[a.id]?.status;
  return s === 'working' ? { label: 'Working now', color: '#3dd6c6' } : { label: 'Ready', color: '#5fdc8a' };
}

async function viewOffice(content) {
  const canvas = h('canvas', { id: 'floor', width: 1000, height: 620, 'aria-label': 'Office floor with 18 AI agents' });
  const detail = h('div', { class: 'stack' });
  const roster = h('div', { class: 'roster' });
  let live = {}; let selected = 'lead'; let raf = 0; let pulse = 0;
  const briefBody = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const briefBox = h('section', { class: 'card stack' }, h('h2', {}, 'Briefing from Arisu and Paco'), briefBody);
  api('GET', '/api/briefing').then(({ alerts }) => {
    briefBody.replaceChildren(...(alerts.length ? alerts.map((a) => h('button', { class: 'alert ' + a.level, onclick: () => { state.tab = a.tab; screenMain(); } }, a.text))
      : [h('p', { class: 'muted' }, 'All clear. Nothing needs attention right now.')]));
  }).catch(() => briefBody.replaceChildren(h('p', { class: 'muted' }, 'Briefing unavailable.')));
  const ctx = canvas.getContext('2d');
  const pos = {};
  for (const roomId of Object.keys(ROOMS)) {
    const m = AGENTS.filter((a) => a.room === roomId); const r = ROOMS[roomId];
    m.forEach((a, i) => {
      const ang = (i / m.length) * Math.PI * 2 + Math.PI; // start on the left so two-agent rooms line up horizontally
      const rx = m.length > 1 ? Math.min(canvas.width * r.w * 0.4, 22 + m.length * 13) : 0;
      const ry = m.length > 1 ? Math.min(canvas.height * r.h * 0.3, 12 + m.length * 7) : 0;
      pos[a.id] = { x: canvas.width * (r.x + r.w / 2) + Math.cos(ang) * rx, y: canvas.height * (r.y + r.h / 2 + 0.03) + Math.sin(ang) * ry };
    });
  }
  const rr = (x, y, w, hh, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };

  function draw() {
    pulse += 0.06;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const r of Object.values(ROOMS)) {
      const x = canvas.width * r.x; const y = canvas.height * r.y;
      ctx.fillStyle = '#171a27'; ctx.strokeStyle = r.color + 'aa'; ctx.lineWidth = 2;
      rr(x, y, canvas.width * r.w, canvas.height * r.h, 14); ctx.fill(); ctx.stroke();
      ctx.fillStyle = r.color; ctx.font = '700 13px system-ui, sans-serif'; ctx.fillText(r.label.toUpperCase(), x + 12, y + 20);
    }
    for (const a of AGENTS) {
      const p = pos[a.id]; const st = statusOf(a, live);
      if (a.wired && st.label === 'Working now') { ctx.beginPath(); ctx.arc(p.x, p.y, 14 + Math.sin(pulse) * 2, 0, Math.PI * 2); ctx.strokeStyle = '#3dd6c655'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.globalAlpha = a.wired ? 1 : 0.4; ctx.fillStyle = a.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = selected === a.id ? '#fff' : st.color; ctx.lineWidth = selected === a.id ? 3 : 2; ctx.stroke();
      ctx.fillStyle = a.wired ? '#e8eaf6' : '#8a90b0'; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(a.name, p.x, p.y + 25); ctx.textAlign = 'left';
    }
    raf = requestAnimationFrame(draw);
  }

  function renderSide() {
    const a = AGENTS.find((x) => x.id === selected); const st = statusOf(a, live);
    const last = live[a.id]?.last_run;
    detail.replaceChildren(...[h('h3', {}, `${a.name} · ${a.role}`),
      h('div', {}, h('span', { class: 'chip', style: { color: st.color } }, st.label)),
      h('p', { class: 'muted' }, a.wired ? a.job : 'Planned for a later version. This agent does no work yet.'),
      last ? h('p', { class: 'small muted' }, `Last run: ${fmt(last)}`) : null].filter(Boolean));
    roster.replaceChildren(...AGENTS.map((x) => {
      const s = statusOf(x, live);
      return h('button', { class: 'agent' + (x.id === selected ? ' sel' : ''), onclick: () => { selected = x.id; renderSide(); } },
        h('b', { style: { color: x.wired ? x.color : '#8a90b0' } }, x.name), h('span', {}, x.role), h('span', { style: { color: s.color } }, s.label));
    }));
  }

  async function poll() {
    try { live = (await api('GET', '/api/office')).agents; renderSide(); } catch (e) { if (e.status === 401) boot(); }
  }

  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width); const y = (e.clientY - r.top) * (canvas.height / r.height);
    let best = 20; let hit = null;
    for (const a of AGENTS) { const d = Math.hypot(pos[a.id].x - x, pos[a.id].y - y); if (d < best) { best = d; hit = a.id; } }
    if (hit) { selected = hit; renderSide(); }
  });

  content.append(briefBox, h('div', { class: 'grid2' },
    h('section', { class: 'card' }, h('h2', {}, 'Office floor'), canvas,
      h('p', { class: 'small muted' }, 'All 18 agents are connected. Teal = working right now, green = ready. Every output is for a person to read, approve, or send.'), roster),
    h('section', { class: 'card' }, h('h2', {}, 'Inspector'), detail)));
  renderSide(); draw(); await poll();
  const timer = setInterval(poll, 4000);
  cleanup = () => { cancelAnimationFrame(raf); clearInterval(timer); };
}

// ---------- Posts ----------
const FILTERS = [['draft', 'Needs review'], ['approved', 'Approved'], ['done', 'Published'], ['rejected', 'Rejected'], ['failed', 'Failed'], ['all', 'All']];
const statusChip = { draft: ['needs review', 'warn'], approved: ['approved', 'teal'], published: ['published', 'ok'], posted_manually: ['posted by hand', 'ok'], rejected: ['rejected', 'bad'], failed: ['failed', 'bad'] };
const verdictChip = { pass: ['AI review: pass', 'ok'], revise: ['AI review: revise', 'warn'], block: ['AI review: block', 'bad'], edited: ['edited by a person', 'accent'] };

async function viewPosts(content) {
  if (!state.clients.length) {
    content.append(h('section', { class: 'card' }, h('p', {}, isStaff() ? 'Add a client first (Clients tab).' : 'No business is linked to your account yet. Ask the office to link one.')));
    return;
  }
  const picker = isStaff() ? h('select', { onchange: (e) => { state.clientId = Number(e.target.value); screenMain(); }, value: state.clientId },
    state.clients.map((c) => h('option', { value: c.id }, c.name))) : null;
  const client = state.clients.find((c) => c.id === state.clientId);
  const list = h('div', { class: 'stack' });

  // make posts
  const topic = h('input', { placeholder: 'e.g. New morning batch of pandesal', maxlength: 500 });
  if (state.prefill) { topic.value = state.prefill; state.prefill = null; }
  const goal = h('input', { placeholder: 'Optional goal, e.g. more walk-ins on weekdays', maxlength: 200 });
  const count = h('select', { value: '3' }, [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n) }, `${n} post${n > 1 ? 's' : ''}`)));
  const ideasBox = h('div', { class: 'stack' });
  const writeBtn = h('button', { class: 'btn' }, 'Write drafts');
  writeBtn.addEventListener('click', () => run(writeBtn, async () => {
    const r = await api('POST', `/api/clients/${client.id}/generate`, { topic: topic.value, goal: goal.value, count: Number(count.value) });
    toast(`${r.drafts.length} draft(s) ready for your review.`); state.filter = 'draft'; await refresh();
  }));
  const ideasBtn = h('button', { class: 'btn ghost' }, 'Get ideas');
  ideasBtn.addEventListener('click', () => run(ideasBtn, async () => {
    const { ideas } = await api('POST', `/api/clients/${client.id}/ideas`, { goal: goal.value });
    ideasBox.replaceChildren(...ideas.map((i) => h('div', { class: 'callout' }, h('b', {}, i.title), ` (${i.format}) `, i.angle, ' ',
      h('button', { class: 'btn ghost', onclick: () => { topic.value = i.title; topic.focus(); } }, 'Use as topic'))));
  }));

  // reply drafter
  const comment = h('textarea', { placeholder: 'Paste a public comment from your Facebook page', maxlength: 1000 });
  const replyBtn = h('button', { class: 'btn ghost' }, 'Draft a reply');
  replyBtn.addEventListener('click', () => run(replyBtn, async () => {
    await api('POST', `/api/clients/${client.id}/replies`, { comment: comment.value });
    comment.value = ''; toast('Reply draft ready. The system never sends replies; you post it yourself.'); state.filter = 'draft'; await refresh();
  }));

  const filters = h('div', { class: 'filters' });

  async function refresh() {
    filters.replaceChildren(...FILTERS.map(([k, label]) => h('button', { class: k === state.filter ? 'on' : '', onclick: () => { state.filter = k; refresh(); } }, label)));
    const { drafts } = await api('GET', `/api/drafts?client_id=${client.id}`);
    const pick = drafts.filter((d) => state.filter === 'all' || (state.filter === 'done' ? ['published', 'posted_manually'].includes(d.status) : d.status === state.filter));
    list.replaceChildren(...(pick.length ? pick.map((d) => draftCard(d, client, refresh)) : [h('div', { class: 'card muted' }, 'Nothing here yet.')]));
  }

  content.append(
    h('section', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Client'), picker ?? h('b', {}, client.name),
        client.page ? h('span', { class: 'chip ok' }, `Page: ${client.page.page_name}`) : h('span', { class: 'chip warn' }, 'No Facebook Page connected'),
        client.require_client_approval ? h('span', { class: 'chip accent' }, 'Client must approve') : null),
      !state.user.ai_configured ? h('div', { class: 'callout warn' }, 'AI is not configured on this server yet (OPENAI_API_KEY and OPENAI_MODEL). You can still review existing drafts.') : null),
    h('div', { class: 'cols' },
      h('section', { class: 'card stack' }, h('h2', {}, 'Write posts'), field('Topic', topic), field('Goal', goal), field('How many', count), h('div', { class: 'row' }, writeBtn, ideasBtn), ideasBox),
      h('section', { class: 'card stack' }, h('h2', {}, 'Reply to a comment'), field('Comment', comment), replyBtn,
        h('p', { class: 'small muted' }, 'Replies are drafts only. Approve, copy, and post them yourself.'))),
    h('section', { class: 'stack' }, h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Drafts'), filters), list));
  await refresh();
}

function draftCard(d, client, refresh) {
  const locked = ['published', 'posted_manually'].includes(d.status);
  const ta = h('textarea', { readOnly: locked, maxlength: 3000, 'aria-label': 'Post text' }, d.content);
  ta.value = d.content;
  const dirty = () => ta.value !== d.content;
  const [stLabel, stCls] = statusChip[d.status] ?? [d.status, ''];
  const vc = verdictChip[d.review_verdict];

  const save = h('button', { class: 'btn ghost', disabled: true }, 'Save edits');
  const approve = h('button', { class: 'btn good' }, 'Approve');
  const reject = h('button', { class: 'btn bad' }, 'Reject');
  const publish = h('button', { class: 'btn' }, 'Publish to Facebook');
  const posted = h('button', { class: 'btn ghost' }, d.kind === 'reply' ? 'I posted this reply' : 'Mark as posted by hand');
  const copy = h('button', { class: 'btn ghost' }, 'Copy text');

  const sync = () => { save.disabled = !dirty(); approve.disabled = dirty(); };
  ta.addEventListener('input', sync);
  sync();

  save.addEventListener('click', () => run(save, async () => { await api('PATCH', `/api/drafts/${d.id}`, { content: ta.value }); toast(d.status === 'approved' ? 'Saved. The approval was cancelled; approve again.' : 'Saved.'); await refresh(); }));
  approve.addEventListener('click', () => run(approve, async () => {
    const flagged = ['revise', 'block'].includes(d.review_verdict);
    if (flagged && !confirm(`The AI reviewer flagged this draft:\n\n- ${d.review_notes.join('\n- ') || 'see notes'}\n\nApprove it anyway? You are responsible for what gets posted.`)) return;
    await api('POST', `/api/drafts/${d.id}/approve`, { acknowledge_flags: flagged });
    toast('Approved. It is recorded under your name.'); await refresh();
  }));
  reject.addEventListener('click', () => run(reject, async () => { await api('POST', `/api/drafts/${d.id}/reject`, {}); await refresh(); }));
  publish.addEventListener('click', () => run(publish, async () => {
    const when = d.scheduled_at ? `schedule it for ${fmt(d.scheduled_at)}` : 'publish it NOW';
    if (!confirm(`This will ${when} on "${client.page?.page_name ?? 'the Facebook Page'}" with exactly the approved text. Continue?`)) return;
    await api('POST', `/api/drafts/${d.id}/publish`, {}); toast('Sent to Facebook.'); await refresh();
  }));
  posted.addEventListener('click', () => run(posted, async () => { await api('POST', `/api/drafts/${d.id}/mark-posted`, {}); await refresh(); }));
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(d.content); toast('Copied.'); } catch { toast('Could not copy. Select the text and copy it.', true); } });

  const when = d.kind === 'post' && ['draft', 'approved', 'failed'].includes(d.status) ? h('label', {}, 'Schedule on Facebook (optional, at least 10 minutes ahead)',
    h('input', { type: 'datetime-local', value: d.scheduled_at ? new Date(d.scheduled_at - new Date(d.scheduled_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '',
      onchange: (e) => run(null, async () => { await api('PATCH', `/api/drafts/${d.id}`, { scheduled_at: e.target.value ? new Date(e.target.value).toISOString() : null }); await refresh(); }) })) : null;

  const buttons = [];
  if (d.status === 'draft') buttons.push(save, approve, reject);
  if (d.status === 'approved') buttons.push(save, state.user.fb_publish_enabled && d.kind === 'post' ? publish : null, posted, copy, reject);
  if (d.status === 'failed') buttons.push(save, state.user.fb_publish_enabled && d.kind === 'post' ? publish : null, posted, reject);
  if (d.status === 'rejected') buttons.push(save);
  if (locked) buttons.push(copy);

  return h('article', { class: 'card draft' },
    h('div', { class: 'meta' }, h('span', { class: 'chip' }, d.kind), h('span', { class: 'chip ' + stCls }, stLabel),
      vc ? h('span', { class: 'chip ' + vc[1] }, vc[0]) : null,
      d.best_time ? h('span', { class: 'small muted' }, `Suggested time: ${d.best_time}`) : null,
      h('span', { class: 'small muted' }, fmt(d.created_at))),
    d.kind === 'reply' ? h('div', { class: 'quote' }, `Comment: ${d.source_text}`) : (d.rationale ? h('p', { class: 'small muted' }, `Why: ${d.rationale}`) : null),
    ta,
    d.local_issues.length ? h('ul', { class: 'issues bad' }, d.local_issues.map((i) => h('li', {}, i))) : null,
    d.review_notes.length ? h('ul', { class: 'issues warn' }, d.review_notes.map((i) => h('li', {}, i))) : null,
    d.status === 'approved' ? h('div', { class: 'callout' }, `Approved ${fmt(d.approved_at)}. Editing the text cancels the approval.`) : null,
    d.error ? h('div', { class: 'callout bad' }, `Facebook error: ${d.error}`) : null,
    d.status === 'published' ? h('div', { class: 'callout' }, `Published ${fmt(d.published_at)} (Facebook id ${d.fb_post_id}).`) : null,
    when, h('div', { class: 'row' }, buttons));
}

// ---------- Clients ----------
async function viewClients(content) {
  const make = (c) => {
    const f = {
      name: h('input', { value: c?.name ?? '', required: true, maxlength: 120 }),
      language: h('input', { value: c?.language ?? 'English', maxlength: 40 }),
      voice: h('textarea', { maxlength: 1500, placeholder: 'How should the brand sound? Examples of good and bad posts help.' }, c?.brand_voice ?? ''),
      audience: h('textarea', { maxlength: 600 }, c?.audience ?? ''),
      never: h('textarea', { maxlength: 800, placeholder: 'One per line or comma-separated. Posts containing these cannot be approved.' }, c?.do_not_say ?? ''),
      req: h('input', { type: 'checkbox', checked: !!c?.require_client_approval })
    };
    f.voice.value = c?.brand_voice ?? ''; f.audience.value = c?.audience ?? ''; f.never.value = c?.do_not_say ?? '';
    const btn = h('button', { class: 'btn' }, c ? 'Save client' : 'Add client');
    btn.addEventListener('click', () => run(btn, async () => {
      const body = { name: f.name.value, language: f.language.value, brand_voice: f.voice.value, audience: f.audience.value, do_not_say: f.never.value, require_client_approval: f.req.checked };
      if (c) await api('PATCH', `/api/clients/${c.id}`, body); else await api('POST', '/api/clients', body);
      toast('Saved.'); await loadClients(); screenMain();
    }));

    const pageBits = c ? (() => {
      const p = { id: h('input', { inputmode: 'numeric', placeholder: 'Facebook Page ID (digits)', value: c.page?.page_id ?? '' }), name: h('input', { placeholder: 'Page name', value: c.page?.page_name ?? '' }),
        tok: h('input', { type: 'password', autocomplete: 'off', placeholder: 'Page access token (stored encrypted, never shown again)' }) };
      const pb = h('button', { class: 'btn ghost' }, c.page ? 'Replace Facebook Page' : 'Connect Facebook Page');
      pb.addEventListener('click', () => run(pb, async () => {
        await api('PUT', `/api/clients/${c.id}/page`, { page_id: p.id.value, page_name: p.name.value, access_token: p.tok.value });
        p.tok.value = ''; toast('Page connected.'); await loadClients(); screenMain();
      }));
      return h('div', { class: 'stack' }, h('h2', {}, 'Facebook Page'),
        h('p', { class: 'small muted' }, 'Needs a Page access token from a Meta app that is allowed to post to this Page. Publishing stays off until the server sets FB_PUBLISH_ENABLED=true.'),
        p.id, p.name, p.tok, pb);
    })() : null;

    return h('section', { class: 'card stack' }, h('h2', {}, c ? c.name : 'Add a client'),
      field('Business name', f.name), field('Language (e.g. English, Filipino, Taglish)', f.language), field('Brand voice', f.voice), field('Audience', f.audience), field('Never say', f.never),
      h('label', { class: 'check' }, f.req, 'Only this client\'s own account may approve their posts'), btn, pageBits);
  };
  content.append(h('div', { class: 'cols' }, make(null), ...state.clients.map(make)));
}

// ---------- Team & AI (owner) ----------
async function viewTeam(content) {
  const { users } = await api('GET', '/api/users');
  const f = { email: h('input', { type: 'email', required: true }), name: h('input', { required: true }),
    role: h('select', {}, h('option', { value: 'manager' }, 'Manager (agency staff)'), h('option', { value: 'client' }, 'Client (business owner)')),
    client: h('select', {}, state.clients.map((c) => h('option', { value: c.id }, c.name))), pw: h('input', { type: 'text', autocomplete: 'off', minlength: 10 }) };
  const clientField = field('Which business?', f.client);
  const sync = () => { clientField.hidden = f.role.value !== 'client'; };
  f.role.addEventListener('change', sync); sync();
  const add = h('button', { class: 'btn' }, 'Create account');
  add.addEventListener('click', () => run(add, async () => {
    await api('POST', '/api/users', { email: f.email.value, name: f.name.value, role: f.role.value, client_id: f.role.value === 'client' ? Number(f.client.value) : undefined, password: f.pw.value });
    toast('Account created. Tell them the temporary password; they must change it at first login.'); screenMain();
  }));

  const models = h('div', { class: 'stack' });
  const check = h('button', { class: 'btn ghost' }, 'Check which AI models my key can use');
  check.addEventListener('click', () => run(check, async () => {
    const r = await api('GET', '/api/admin/models');
    models.replaceChildren(h('p', {}, `Configured model: ${r.configured_model ?? 'none'} · Reviewer: ${r.review_model ?? 'same'}`),
      h('div', { class: 'callout' }, r.available.length ? r.available.join(', ') : 'No GPT models returned for this key.'),
      r.configured_model && !r.available.includes(r.configured_model) ? h('div', { class: 'callout bad' }, 'Your configured model is not in this list. Fix OPENAI_MODEL.') : null);
  }));

  content.append(h('div', { class: 'cols' },
    h('section', { class: 'card stack' }, h('h2', {}, 'Create an account'), field('Email', f.email), field('Name', f.name), field('Role', f.role), clientField,
      field('Temporary password (10+ characters)', f.pw), add),
    h('section', { class: 'card stack' }, h('h2', {}, 'AI settings'),
      h('p', { class: 'small muted' }, 'The API key lives only in the server environment. It is never sent to this page.'), check, models)),
  h('section', { class: 'card scroll' }, h('h2', {}, 'People'), h('table', {},
    h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Business', 'Agreement', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, users.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.role),
      h('td', {}, state.clients.find((c) => c.id === u.client_id)?.name ?? ''), h('td', {}, u.agreement_accepted ? 'accepted' : 'pending'),
      h('td', {}, u.disabled ? 'disabled' : 'active'),
      h('td', {}, u.role === 'owner' ? '' : h('button', { class: 'btn ghost', onclick: (e) => run(e.target, async () => { await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }); screenMain(); }) }, u.disabled ? 'Enable' : 'Disable'))))))));
}

// ---------- Activity ----------
async function viewActivity(content) {
  const { entries } = await api('GET', '/api/audit?limit=150');
  content.append(h('section', { class: 'card scroll' }, h('h2', {}, 'Activity log (people and AI agents)'), h('table', {},
    h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Details'].map((t) => h('th', {}, t)))),
    h('tbody', {}, entries.map((e) => h('tr', {}, h('td', {}, fmt(e.ts)), h('td', {}, e.actor_label || e.actor_type), h('td', {}, e.action), h('td', {}, e.detail)))))));
}

boot();

// ---------- Team & AI extras (owner): invoice details and the live system check ----------
async function teamExtras(content) {
  const { settings } = await api('GET', '/api/settings');
  const f = {
    business_name: h('input', { maxlength: 120, value: settings.business_name }),
    business_address: h('textarea', { maxlength: 300 }, settings.business_address),
    payment_instructions: h('textarea', { maxlength: 800, placeholder: 'GCash number, bank name and account…' }, settings.payment_instructions),
    invoice_footer: h('textarea', { maxlength: 400 }, settings.invoice_footer),
    gcash_name: h('input', { maxlength: 120, value: settings.gcash_name, placeholder: 'Name exactly as shown in GCash' }),
    gcash_number: h('input', { maxlength: 30, inputmode: 'tel', value: settings.gcash_number, placeholder: '09171234567' })
  };
  for (const k of ['business_address', 'payment_instructions', 'invoice_footer']) f[k].value = settings[k];
  const save = h('button', { class: 'btn' }, 'Save invoice details');
  save.addEventListener('click', () => run(save, async () => {
    await api('PUT', '/api/settings', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
    toast('Saved.');
  }));

  const out = h('div', { class: 'stack' });
  const check = h('button', { class: 'btn' }, 'Run system check (Ben)');
  check.addEventListener('click', () => run(check, async () => {
    const { results } = await api('POST', '/api/admin/system-check', {});
    const cls = { pass: 'ok', fail: 'bad', warn: 'warn', info: '', skip: '' };
    out.replaceChildren(h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, results.map((r) =>
      h('tr', {}, h('td', {}, h('span', { class: 'chip ' + (cls[r.status] ?? '') }, r.status)), h('td', {}, r.name), h('td', {}, r.detail)))))));
  }));

  content.append(h('div', { class: 'cols' },
    h('section', { class: 'card stack' }, h('h2', {}, 'Invoice details'),
      h('p', { class: 'small muted' }, 'Shown on every invoice. These are billing statements, not BIR official receipts. Ask your accountant what you need.'),
      field('Business name', f.business_name), field('Address', f.business_address),
      h('p', { class: 'small muted' }, 'GCash: shown on every invoice. Double-check the number. A wrong digit sends your clients\' money to someone else.'),
      field('GCash account name', f.gcash_name), field('GCash number', f.gcash_number),
      field('Other ways to pay (optional)', f.payment_instructions), field('Footer', f.invoice_footer), save),
    h('section', { class: 'card stack' }, h('h2', {}, 'System check'),
      h('p', { class: 'small muted' }, 'Tests your real OpenAI key, model and every connected Facebook Page token. Uses a few tokens of OpenAI credit. Never shows a key.'), check, out)));
}
