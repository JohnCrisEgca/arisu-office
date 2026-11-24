// Agents beyond posts, notes + search, the daily briefing, invoicing, settings, and the system check.
import { HttpError, str, toCents, peso, isDate } from './util.js';
import { FbError, recentPostStats } from './facebook.js';
import { decrypt } from './secrets.js';
import { runChecks } from './doctor.js';

export function registerExtras({ cfg, db, ai, route, audit, userActor, agentActor, clientFor, takeAiQuota, withJob, aiGuard, withNotes }) {
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.timezone });
  const scopeSql = (user, col = 'client_id') => (user.role === 'client' ? ` AND ${col} = ${Number(user.client_id)}` : '');

  // ================= agents that produce advice or drafts =================
  const textFromDraftOrTopic = (b, c) => {
    if (b.draft_id !== undefined && b.draft_id !== '' && b.draft_id !== null) {
      const d = db.prepare('SELECT content FROM drafts WHERE id = ? AND client_id = ?').get(Number(b.draft_id), c.id);
      if (!d) throw new HttpError(404, 'Draft not found.');
      return d.content;
    }
    return str(b.topic, { max: 500, min: 3, field: 'Topic or draft' });
  };

  const DEFS = {
    planner: { job: 'plan', label: 'Ina (planner)', input: (b) => {
      const month = String(b.month || '');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Month must look like 2026-12.');
      return { month, goal: str(b.goal ?? '', { max: 200, field: 'Goal' }), perWeek: Math.min(Math.max(parseInt(b.per_week ?? 3, 10) || 3, 1), 7) };
    } },
    designer: { job: 'design', label: 'Ren (visual briefs)', input: (b, c) => ({ text: textFromDraftOrTopic(b, c) }) },
    video: { job: 'video', label: 'Bong (reel plans)', input: (b, c) => ({ text: textFromDraftOrTopic(b, c) }) },
    analyst: { job: 'reader', label: 'Dario (trend analyst)', input: (b) => ({ text: str(b.text, { max: 4000, min: 20, field: 'Pasted text' }) }) },
    pipeline: { job: 'pipe', label: 'Maya (follow-ups)', input: (b) => ({ text: str(b.text, { max: 3000, min: 10, field: 'Conversation or notes' }) }) },
    notes: { job: 'memo', label: 'Gio (notes)', input: (b) => ({ text: str(b.text, { max: 6000, min: 20, field: 'Raw notes' }) }) },
    onboarding: { job: 'hr', label: 'Mina (onboarding)', input: (b) => ({ text: str(b.text, { max: 3000, min: 20, field: 'Answers' }) }) },
    insights: { job: 'git', label: 'Kiko (page insights)', input: async (b, c) => {
      const page = db.prepare('SELECT * FROM fb_pages WHERE client_id = ?').get(c.id);
      if (!page) throw new HttpError(409, 'Connect this client\'s Facebook Page first.');
      let posts;
      try { posts = await recentPostStats(cfg, { pageId: page.page_id, token: decrypt(cfg.secretKey, page.token_enc) }); } catch (e) {
        if (e instanceof FbError) throw new HttpError(502, e.message);
        throw e;
      }
      if (!posts.length) throw new HttpError(409, 'Facebook returned no recent posts for this Page.');
      return { text: JSON.stringify(posts) };
    } }
  };

  route('POST', '/api/clients/:id/agents/:agent', { perm: 'drafts:generate' }, async ({ user, params, body }) => {
    const def = DEFS[params.agent];
    if (!def) throw new HttpError(404, 'Unknown agent.');
    const c = withNotes(clientFor(user, params.id));
    const input = await def.input(body, c);
    takeAiQuota(user);
    let output;
    try { output = await withJob(def.job, c.id, () => ai.runAgent(params.agent, c, input)); } catch (e) { aiGuard(e); }
    const id = db.prepare('INSERT INTO agent_outputs (client_id, agent, input, output, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, params.agent, JSON.stringify(input).slice(0, 4000), JSON.stringify(output), user.id, Date.now()).lastInsertRowid;
    audit(agentActor(def.label), `agent.${params.agent}`, c.id, `requested by ${user.email}`);
    return { output: { id: Number(id), agent: params.agent, output, created_at: Date.now() } };
  });

  route('GET', '/api/clients/:id/outputs', { perm: 'clients:read' }, ({ user, params, url }) => {
    const c = clientFor(user, params.id);
    const agent = url.searchParams.get('agent');
    const rows = agent
      ? db.prepare('SELECT * FROM agent_outputs WHERE client_id = ? AND agent = ? ORDER BY id DESC LIMIT 20').all(c.id, agent)
      : db.prepare('SELECT * FROM agent_outputs WHERE client_id = ? ORDER BY id DESC LIMIT 50').all(c.id);
    return { outputs: rows.map((r) => ({ id: r.id, agent: r.agent, output: JSON.parse(r.output), created_at: r.created_at })) };
  });

  // ================= notes (Gio) and search (Sol) =================
  route('GET', '/api/clients/:id/notes', { perm: 'clients:read' }, ({ user, params }) => {
    const c = clientFor(user, params.id);
    return { notes: db.prepare('SELECT id, title, body, pinned, created_at FROM notes WHERE client_id = ? ORDER BY pinned DESC, id DESC LIMIT 200').all(c.id).map((n) => ({ ...n, pinned: !!n.pinned })) };
  });

  route('POST', '/api/clients/:id/notes', { perm: 'notes:write' }, ({ user, params, body }) => {
    const c = clientFor(user, params.id);
    const title = str(body.title, { max: 120, min: 1, field: 'Title' });
    const text = str(body.body, { max: 4000, min: 1, field: 'Note' });
    const pinned = body.pinned ? 1 : 0;
    if (pinned && db.prepare('SELECT COUNT(*) AS n FROM notes WHERE client_id = ? AND pinned = 1').get(c.id).n >= 8) {
      throw new HttpError(409, 'You can pin at most 8 notes. Unpin one first.');
    }
    const id = db.prepare('INSERT INTO notes (client_id, title, body, pinned, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, title, text, pinned, user.id, Date.now()).lastInsertRowid;
    audit(userActor(user), 'note.created', c.id, title);
    return { note: { id: Number(id), title, body: text, pinned: !!pinned } };
  });

  const noteFor = (user, id) => {
    const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(id));
    if (!n || (user.role === 'client' && user.client_id !== n.client_id)) throw new HttpError(404, 'Note not found.');
    return n;
  };

  route('PATCH', '/api/notes/:id', { perm: 'notes:write' }, ({ user, params, body }) => {
    const n = noteFor(user, params.id);
    const pinned = body.pinned ? 1 : 0;
    if (pinned && !n.pinned && db.prepare('SELECT COUNT(*) AS c FROM notes WHERE client_id = ? AND pinned = 1').get(n.client_id).c >= 8) {
      throw new HttpError(409, 'You can pin at most 8 notes. Unpin one first.');
    }
    db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(pinned, n.id);
    audit(userActor(user), pinned ? 'note.pinned' : 'note.unpinned', n.client_id, n.title);
    return { ok: true };
  });

  route('DELETE', '/api/notes/:id', { perm: 'notes:write' }, ({ user, params }) => {
    const n = noteFor(user, params.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
    audit(userActor(user), 'note.deleted', n.client_id, n.title);
    return { ok: true };
  });

  // Sol: plain keyword search (not semantic). Uses instr() so % and _ in the query are not treated as wildcards.
  route('GET', '/api/clients/:id/search', { perm: 'clients:read' }, async ({ user, params, url }) => {
    const c = clientFor(user, params.id);
    const q = str(url.searchParams.get('q') ?? '', { max: 100, min: 2, field: 'Search' }).toLowerCase();
    const results = await withJob('index', c.id, async () => {
      const like = (cols) => cols.map((x) => `instr(lower(${x}), ?) > 0`).join(' OR ');
      const notes = db.prepare(`SELECT id, title, body, created_at FROM notes WHERE client_id = ? AND (${like(['title', 'body'])}) ORDER BY id DESC LIMIT 15`).all(c.id, q, q);
      const drafts = db.prepare(`SELECT id, kind, content, status, created_at FROM drafts WHERE client_id = ? AND (${like(['content', 'topic'])}) ORDER BY id DESC LIMIT 15`).all(c.id, q, q);
      const outs = db.prepare(`SELECT id, agent, output, created_at FROM agent_outputs WHERE client_id = ? AND (${like(['output'])}) ORDER BY id DESC LIMIT 15`).all(c.id, q);
      const snip = (s) => String(s).slice(0, 200);
      return [
        ...notes.map((n) => ({ type: 'note', id: n.id, title: n.title, snippet: snip(n.body), created_at: n.created_at })),
        ...drafts.map((d) => ({ type: d.kind, id: d.id, title: `${d.kind} (${d.status})`, snippet: snip(d.content), created_at: d.created_at })),
        ...outs.map((o) => ({ type: 'agent', id: o.id, title: `${o.agent} output`, snippet: snip(o.output), created_at: o.created_at }))
      ].sort((a, b) => b.created_at - a.created_at);
    });
    return { results };
  });

  // ================= Paco + Arisu: the daily briefing (no AI, just facts from the database) =================
  route('GET', '/api/briefing', { perm: 'clients:read' }, ({ user }) => {
    const now = Date.now(); const DAY = 24 * 3600 * 1000;
    const alerts = [];
    const sc = scopeSql(user);
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    const waiting = n(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'draft'${sc}`);
    const stale = n(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'draft' AND created_at < ?${sc}`, now - 3 * DAY);
    const unposted = n(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'approved' AND approved_at < ?${sc}`, now - DAY);
    const failed = n(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'failed'${sc}`);
    const overdue = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM invoices WHERE status IN ('sent','payment_reported') AND due_date < ?${sc}`).get(today());
    const toConfirm = user.role === 'client' ? 0 : n(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'payment_reported'`);
    if (failed) alerts.push({ level: 'bad', text: `${failed} post(s) failed to publish.`, tab: 'posts' });
    if (overdue.n) alerts.push({ level: 'bad', text: `${overdue.n} invoice(s) overdue (${peso(overdue.cents)}).`, tab: 'invoices' });
    if (stale) alerts.push({ level: 'warn', text: `${stale} draft(s) have waited more than 3 days for review.`, tab: 'posts' });
    if (unposted) alerts.push({ level: 'warn', text: `${unposted} approved post(s) are still not posted after 24 hours.`, tab: 'posts' });
    if (toConfirm) alerts.push({ level: 'warn', text: `${toConfirm} payment(s) reported by clients are waiting for you to confirm.`, tab: 'invoices' });
    if (user.role !== 'client') {
      const nopage = db.prepare('SELECT name FROM clients WHERE id NOT IN (SELECT client_id FROM fb_pages)').all();
      if (nopage.length) alerts.push({ level: 'info', text: `No Facebook Page connected for: ${nopage.map((c) => c.name).join(', ')}.`, tab: 'clients' });
      const quiet = db.prepare('SELECT name FROM clients WHERE id NOT IN (SELECT client_id FROM drafts WHERE created_at > ?)').all(now - 7 * DAY);
      if (quiet.length) alerts.push({ level: 'info', text: `No new drafts in 7 days for: ${quiet.map((c) => c.name).join(', ')}.`, tab: 'posts' });
    }
    if (waiting && !stale) alerts.push({ level: 'info', text: `${waiting} draft(s) are ready for review.`, tab: 'posts' });
    return { alerts, counts: { waiting, stale, unposted, failed, overdue: overdue.n } };
  });

  // ================= settings used on invoices =================
  const SETTING_KEYS = { business_name: 120, business_address: 300, payment_instructions: 800, invoice_footer: 400 };
  const settings = () => Object.fromEntries(Object.keys(SETTING_KEYS).map((k) => [k, db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? '']));

  route('GET', '/api/settings', { perm: 'invoices:manage' }, () => ({ settings: settings() }));
  route('PUT', '/api/settings', { perm: 'settings:write' }, ({ user, body }) => {
    for (const [k, max] of Object.entries(SETTING_KEYS)) {
      if (k in body) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, str(body[k], { max, field: k }));
      }
    }
    audit(userActor(user), 'settings.updated', null, Object.keys(body).filter((k) => k in SETTING_KEYS).join(', '));
    return { settings: settings() };
  });

  // ================= invoices (Teo). The software does all the math; the AI never touches an amount. =================
  const itemsOf = (id) => db.prepare('SELECT id, description, qty, unit_cents FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id)
    .map((i) => ({ ...i, line_cents: i.qty * i.unit_cents }));

  function invoiceView(inv, withItems = true) {
    const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(inv.client_id);
    const overdue = ['sent', 'payment_reported'].includes(inv.status) && inv.due_date < today();
    return {
      id: inv.id, number: inv.number, client_id: inv.client_id, client_name: client?.name ?? '', status: inv.status,
      display_status: overdue ? 'overdue' : inv.status, issue_date: inv.issue_date, due_date: inv.due_date, currency: 'PHP',
      total_cents: inv.total_cents, notes: inv.notes, payment_instructions: inv.payment_instructions, payment_ref: inv.payment_ref,
      sent_at: inv.sent_at, paid_at: inv.paid_at, created_at: inv.created_at,
      ...(withItems ? { items: itemsOf(inv.id), biller: settings() } : {})
    };
  }

  // Client users see only invoices that were actually sent to them (never drafts or voids).
  function invoiceFor(user, id) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(id));
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (user.role === 'client' && (user.client_id !== inv.client_id || !['sent', 'payment_reported', 'paid'].includes(inv.status))) {
      throw new HttpError(404, 'Invoice not found.');
    }
    return inv;
  }

  function parseItems(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) throw new HttpError(400, 'Add 1 to 30 line items.');
    let total = 0;
    const items = raw.map((r, i) => {
      const description = str(r?.description, { max: 200, min: 1, field: `Item ${i + 1} description` });
      const qty = Number(r?.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new HttpError(400, `Item ${i + 1} quantity must be a whole number from 1 to 1000.`);
      const unit = toCents(r?.unit_price, `Item ${i + 1} price`);
      total += qty * unit;
      return { description, qty, unit };
    });
    if (total <= 0) throw new HttpError(400, 'The invoice total must be more than zero.');
    if (total > 100_000_000_00) throw new HttpError(400, 'The invoice total is too large.');
    return { items, total };
  }

  function writeItems(invoiceId, items) {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    const ins = db.prepare('INSERT INTO invoice_items (invoice_id, description, qty, unit_cents) VALUES (?,?,?,?)');
    for (const it of items) ins.run(invoiceId, it.description, it.qty, it.unit);
  }

  route('GET', '/api/invoices', { perm: 'invoices:read' }, ({ user, url }) => {
    const where = []; const args = [];
    if (user.role === 'client') { where.push('client_id = ?', "status IN ('sent','payment_reported','paid')"); args.push(user.client_id); }
    else if (url.searchParams.get('client_id')) { where.push('client_id = ?'); args.push(Number(url.searchParams.get('client_id'))); }
    const rows = db.prepare(`SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
    return { invoices: rows.map((r) => invoiceView(r, false)) };
  });

  route('GET', '/api/invoices/:id', { perm: 'invoices:read' }, ({ user, params }) => ({ invoice: invoiceView(invoiceFor(user, params.id)) }));

  route('POST', '/api/invoices', { perm: 'invoices:manage' }, ({ user, body }) => {
    const c = clientFor(user, body.client_id);
    const due = String(body.due_date || '');
    if (!isDate(due)) throw new HttpError(400, 'Due date must look like 2026-12-15.');
    const { items, total } = parseItems(body.items);
    const year = today().slice(0, 4);
    const seq = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?').get(`INV-${year}-%`).n + 1;
    const number = `INV-${year}-${String(seq).padStart(4, '0')}`;
    const now = Date.now();
    const instructions = 'payment_instructions' in body ? str(body.payment_instructions, { max: 800, field: 'Payment instructions' }) : settings().payment_instructions;
    const id = db.prepare(`INSERT INTO invoices (client_id, number, status, due_date, notes, payment_instructions, total_cents, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c.id, number, 'draft', due, str(body.notes ?? '', { max: 600, field: 'Notes' }), instructions, total, user.id, now, now).lastInsertRowid;
    writeItems(id, items);
    audit(userActor(user), 'invoice.created', c.id, `${number} ${peso(total)}`);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id)) };
  });

  route('PATCH', '/api/invoices/:id', { perm: 'invoices:manage' }, ({ user, params, body }) => {
    const inv = invoiceFor(user, params.id);
    if (inv.status !== 'draft') throw new HttpError(409, 'Only draft invoices can be edited. Void it and make a new one.');
    const due = 'due_date' in body ? String(body.due_date) : inv.due_date;
    if (!isDate(due)) throw new HttpError(400, 'Due date must look like 2026-12-15.');
    let total = inv.total_cents;
    if ('items' in body) { const p = parseItems(body.items); total = p.total; writeItems(inv.id, p.items); }
    db.prepare('UPDATE invoices SET due_date=?, notes=?, payment_instructions=?, total_cents=?, updated_at=? WHERE id=?').run(
      due, 'notes' in body ? str(body.notes, { max: 600, field: 'Notes' }) : inv.notes,
      'payment_instructions' in body ? str(body.payment_instructions, { max: 800, field: 'Payment instructions' }) : inv.payment_instructions,
      total, Date.now(), inv.id);
    audit(userActor(user), 'invoice.edited', inv.client_id, inv.number);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)) };
  });

  // The app does not email anything. "Send" means a person is giving it to the client now (the client then sees it here).
  route('POST', '/api/invoices/:id/send', { perm: 'invoices:manage' }, ({ user, params }) => {
    const inv = invoiceFor(user, params.id);
    if (inv.status !== 'draft') throw new HttpError(409, `This invoice is already ${inv.status}.`);
    if (inv.total_cents <= 0) throw new HttpError(409, 'The invoice total must be more than zero.');
    db.prepare('UPDATE invoices SET status=?, issue_date=?, sent_at=?, updated_at=? WHERE id=?').run('sent', today(), Date.now(), Date.now(), inv.id);
    audit(userActor(user), 'invoice.sent', inv.client_id, `${inv.number} ${peso(inv.total_cents)}`);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)) };
  });

  route('POST', '/api/invoices/:id/report-payment', { perm: 'invoices:report' }, ({ user, params, body }) => {
    const inv = invoiceFor(user, params.id);
    if (inv.status !== 'sent') throw new HttpError(409, 'Payment can only be reported on a sent invoice.');
    const ref = str(body.reference, { max: 200, min: 3, field: 'Payment reference' });
    db.prepare('UPDATE invoices SET status=?, payment_ref=?, updated_at=? WHERE id=?').run('payment_reported', ref, Date.now(), inv.id);
    audit(userActor(user), 'invoice.payment_reported', inv.client_id, `${inv.number} ref ${ref}`);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)) };
  });

  // Only a person on the team can confirm money was received. The AI can never mark anything paid.
  route('POST', '/api/invoices/:id/mark-paid', { perm: 'invoices:manage' }, ({ user, params, body }) => {
    const inv = invoiceFor(user, params.id);
    if (!['sent', 'payment_reported'].includes(inv.status)) throw new HttpError(409, `A ${inv.status} invoice cannot be marked paid.`);
    const ref = 'reference' in body ? str(body.reference, { max: 200, field: 'Reference' }) : inv.payment_ref;
    db.prepare('UPDATE invoices SET status=?, payment_ref=?, paid_at=?, paid_confirmed_by=?, updated_at=? WHERE id=?').run('paid', ref, Date.now(), user.id, Date.now(), inv.id);
    audit(userActor(user), 'invoice.paid', inv.client_id, `${inv.number} ${peso(inv.total_cents)} ref ${ref}`);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)) };
  });

  route('POST', '/api/invoices/:id/void', { perm: 'invoices:manage' }, ({ user, params }) => {
    const inv = invoiceFor(user, params.id);
    if (inv.status === 'paid') throw new HttpError(409, 'A paid invoice cannot be voided.');
    if (inv.status === 'void') throw new HttpError(409, 'Already void.');
    db.prepare('UPDATE invoices SET status=?, updated_at=? WHERE id=?').run('void', Date.now(), inv.id);
    audit(userActor(user), 'invoice.voided', inv.client_id, inv.number);
    return { invoice: invoiceView(db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id)) };
  });

  // Teo drafts the wording of a reminder. Every fact in it comes from the database; a person sends it.
  route('POST', '/api/invoices/:id/reminder', { perm: 'invoices:manage' }, async ({ user, params, body }) => {
    const inv = invoiceFor(user, params.id);
    if (inv.status !== 'sent') throw new HttpError(409, 'Reminders are for invoices that were sent and are not paid yet.');
    const c = withNotes(clientFor(user, inv.client_id));
    const tone = body.tone === 'firm' ? 'firm but polite' : 'friendly';
    const daysOverdue = Math.max(0, Math.round((Date.parse(today()) - Date.parse(inv.due_date)) / 86_400_000));
    takeAiQuota(user);
    let out;
    try {
      out = await withJob('books', c.id, () => ai.runAgent('reminder', c, {
        tone, biller: settings().business_name || 'the business', clientName: c.name, number: inv.number,
        total: peso(inv.total_cents), dueDate: inv.due_date, daysOverdue
      }));
    } catch (e) { aiGuard(e); }
    db.prepare('INSERT INTO agent_outputs (client_id, agent, input, output, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, 'reminder', inv.number, JSON.stringify(out), user.id, Date.now());
    audit(agentActor('Teo (bookkeeper)'), 'agent.reminder_drafted', c.id, `${inv.number}, requested by ${user.email}`);
    return { message: out.message };
  });

  // ================= Ben: system check against the real services =================
  route('POST', '/api/admin/system-check', { perm: 'admin:models' }, async ({ user }) => {
    const results = await withJob('tests', null, () => runChecks({ cfg, db, ai }));
    audit(agentActor('Ben (tester)'), 'agent.system_check', null, `${results.filter((r) => r.status === 'fail').length} failed, requested by ${user.email}`);
    return { results };
  });
}
