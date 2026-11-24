// Invoices. The server computes every total; this page only shows them. Money is whole centavos.
const peso = (c) => '₱' + (c / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CHIP = { draft: 'chip', sent: 'chip teal', payment_reported: 'chip warn', paid: 'chip ok', void: 'chip', overdue: 'chip bad' };
const LABEL = { draft: 'draft', sent: 'sent', payment_reported: 'payment reported', paid: 'paid', void: 'void', overdue: 'overdue' };

export async function viewInvoices(ctx, content) {
  const { h, api, run, toast, field, state, isStaff, fmt } = ctx;
  const listBox = h('div', { class: 'stack' });

  async function refresh() {
    const { invoices } = await api('GET', '/api/invoices');
    listBox.replaceChildren(h('section', { class: 'card scroll' }, h('h2', {}, isStaff() ? 'All invoices' : 'Your invoices'),
      invoices.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Number', isStaff() ? 'Client' : null, 'Total', 'Due', 'Status', ''].filter(Boolean).map((t) => h('th', {}, t)))),
        h('tbody', {}, invoices.map((i) => h('tr', {}, h('td', {}, i.number), isStaff() ? h('td', {}, i.client_name) : null, h('td', {}, peso(i.total_cents)), h('td', {}, i.due_date),
          h('td', {}, h('span', { class: CHIP[i.display_status] }, LABEL[i.display_status])),
          h('td', {}, h('button', { class: 'btn ghost', onclick: () => open(i.id) }, 'Open')))))) : h('p', { class: 'muted' }, 'No invoices yet.')));
  }

  async function open(id) {
    const { invoice: inv } = await api('GET', `/api/invoices/${id}`);
    const b = inv.biller;
    const act = (label, cls, fn, confirmText) => {
      const el = h('button', { class: 'btn ' + cls }, label);
      el.addEventListener('click', () => run(el, async () => { if (confirmText && !confirm(confirmText)) return; await fn(); }));
      return el;
    };
    const reminderBox = h('div', { class: 'stack' });
    const tone = h('select', {}, h('option', { value: 'friendly' }, 'Friendly'), h('option', { value: 'firm' }, 'Firm but polite'));
    const post = (path, body = {}) => api('POST', `/api/invoices/${inv.id}/${path}`, body);
    const buttons = [];
    if (isStaff()) {
      if (inv.status === 'draft') buttons.push(act('Mark as sent', 'good', async () => { await post('send'); toast('Marked as sent. The client can now see it.'); await open(inv.id); }, 'Mark this invoice as sent? After this it cannot be edited.'));
      if (['sent', 'payment_reported'].includes(inv.status)) buttons.push(act('Confirm payment received', 'good', async () => {
        const ref = prompt('Payment reference (optional):', inv.payment_ref || '') ?? null;
        if (ref === null) return;
        await post('mark-paid', { reference: ref }); toast('Marked as paid.'); await open(inv.id);
      }));
      if (inv.status !== 'paid' && inv.status !== 'void') buttons.push(act('Void', 'bad', async () => { await post('void'); await open(inv.id); }, 'Void this invoice? This cannot be undone.'));
      if (inv.status === 'sent') {
        buttons.push(tone, act('Draft a reminder (Teo)', 'ghost', async () => {
          const r = await post('reminder', { tone: tone.value });
          reminderBox.replaceChildren(h('div', { class: 'callout' }, h('b', {}, 'Draft only. You send it yourself.'), h('p', {}, r.message)),
            h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(r.message); toast('Copied.'); } catch { toast('Could not copy.', true); } } }, 'Copy'));
        }));
      }
    } else if (inv.status === 'sent') {
      buttons.push(act('I have paid this', 'good', async () => {
        const ref = prompt('Payment reference (for example the GCash or bank reference number):');
        if (!ref) return;
        await post('report-payment', { reference: ref }); toast('Thanks. The team will confirm it.'); await open(inv.id);
      }));
    }
    buttons.push(h('button', { class: 'btn ghost', onclick: () => window.print() }, 'Print / Save as PDF'));

    content.replaceChildren(h('div', { class: 'row noprint' }, h('button', { class: 'btn ghost', onclick: () => ctx.redraw() }, '← All invoices')),
      h('section', { class: 'card invoice-sheet stack' },
        h('div', { class: 'row between' }, h('div', {}, h('h3', {}, b.business_name || 'Invoice'), h('p', { class: 'small muted pre' }, b.business_address || '')),
          h('div', { class: 'right' }, h('h3', {}, 'INVOICE'), h('div', {}, inv.number), h('span', { class: CHIP[inv.display_status] }, LABEL[inv.display_status]))),
        h('div', { class: 'row between' }, h('div', {}, h('b', {}, 'Billed to'), h('div', {}, inv.client_name)),
          h('div', { class: 'right small' }, h('div', {}, `Issued: ${inv.issue_date ?? 'not yet'}`), h('div', {}, `Due: ${inv.due_date}`))),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Description', 'Qty', 'Unit price', 'Amount'].map((t) => h('th', {}, t)))),
          h('tbody', {}, inv.items.map((i) => h('tr', {}, h('td', {}, i.description), h('td', {}, String(i.qty)), h('td', {}, peso(i.unit_cents)), h('td', {}, peso(i.line_cents)))),
            h('tr', {}, h('td', { colspan: '3', class: 'right' }, h('b', {}, 'Total')), h('td', {}, h('b', {}, peso(inv.total_cents))))))),
        inv.payment_instructions ? h('div', {}, h('b', {}, 'How to pay'), h('p', { class: 'pre' }, inv.payment_instructions)) : null,
        inv.payment_ref ? h('p', { class: 'small' }, `Payment reference: ${inv.payment_ref}${inv.paid_at ? ` · confirmed ${fmt(inv.paid_at)}` : ' (waiting for the team to confirm)'}`) : null,
        inv.notes ? h('p', { class: 'pre' }, inv.notes) : null,
        b.invoice_footer ? h('p', { class: 'small muted pre' }, b.invoice_footer) : null),
      h('div', { class: 'row noprint' }, ...buttons), reminderBox);
  }

  // ----- new invoice form (team only) -----
  const parts = [];
  if (isStaff()) {
    const clientSel = h('select', {}, state.clients.map((c) => h('option', { value: c.id }, c.name)));
    clientSel.value = String(state.clientId ?? state.clients[0]?.id ?? '');
    const due = h('input', { type: 'date', value: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) });
    const notes = h('textarea', { maxlength: 600, placeholder: 'Notes shown on the invoice (optional)' });
    const instr = h('textarea', { maxlength: 800, placeholder: 'How to pay (GCash number, bank details…)' });
    api('GET', '/api/settings').then((s) => { if (!instr.value) instr.value = s.settings.payment_instructions || ''; }).catch(() => {});
    const rows = h('div', { class: 'stack' });
    const addRow = (d = '', q = '1', p = '') => {
      const row = h('div', { class: 'row item-row' }, h('input', { class: 'grow', placeholder: 'Description', maxlength: 200, value: d }),
        h('input', { class: 'qty', inputmode: 'numeric', placeholder: 'Qty', value: q }), h('input', { class: 'price', inputmode: 'decimal', placeholder: 'Price ₱', value: p }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => row.remove() }, 'Remove'));
      rows.append(row);
    };
    addRow();
    const create = h('button', { class: 'btn' }, 'Create draft invoice');
    create.addEventListener('click', () => run(create, async () => {
      const items = [...rows.children].map((r) => { const [d, q, p] = r.querySelectorAll('input'); return { description: d.value, qty: Number(q.value), unit_price: p.value }; });
      const { invoice } = await api('POST', '/api/invoices', { client_id: Number(clientSel.value), due_date: due.value, items, notes: notes.value, payment_instructions: instr.value });
      toast(`Draft ${invoice.number} created.`); await open(invoice.id);
    }));
    parts.push(h('section', { class: 'card stack noprint' }, h('h2', {}, 'New invoice'),
      h('p', { class: 'small muted' }, 'You type the prices; the software adds them up. The AI never touches an amount. A sent invoice cannot be edited (void it and make a new one).'),
      field('Client', clientSel), field('Due date', due), h('div', { class: 'stack' }, h('b', { class: 'small' }, 'Line items'), rows,
        h('button', { class: 'btn ghost', type: 'button', onclick: () => addRow() }, 'Add a line')), field('Notes', notes), field('How to pay', instr), create));
  }
  content.append(...parts, listBox);
  await refresh();
}
