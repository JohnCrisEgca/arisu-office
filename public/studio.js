// Studio: the agents that give advice or write drafts. Everything shown here is text for a person to read and act on.
// All text is inserted with textContent (via h()), so AI output can never run as code.

function toText(v, indent = '') {
  if (Array.isArray(v)) return v.map((x) => `${indent}- ${typeof x === 'object' ? toText(x, indent + '  ').trimStart() : x}`).join('\n');
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, x]) => x !== '' && x != null && !(Array.isArray(x) && !x.length))
      .map(([k, x]) => `${indent}${k.replace(/_/g, ' ')}: ${typeof x === 'object' ? '\n' + toText(x, indent + '  ') : x}`).join('\n');
  }
  return String(v);
}

export async function viewStudio(ctx, content) {
  const { h, api, run, toast, field, state, isStaff } = ctx;
  if (!state.clients.length) {
    content.append(h('section', { class: 'card' }, h('p', {}, isStaff() ? 'Add a client first (Clients tab).' : 'No business is linked to your account yet.')));
    return;
  }
  const client = state.clients.find((c) => c.id === state.clientId) ?? state.clients[0];
  const picker = isStaff() ? h('select', { onchange: (e) => { state.clientId = Number(e.target.value); ctx.redraw(); }, value: client.id },
    state.clients.map((c) => h('option', { value: c.id }, c.name))) : null;

  const renderValue = (v) => {
    if (Array.isArray(v)) return h('ul', { class: 'plain' }, v.map((x) => h('li', {}, typeof x === 'object' ? renderValue(x) : String(x))));
    if (v && typeof v === 'object') {
      return h('div', { class: 'kv' }, Object.entries(v).filter(([, x]) => x !== '' && x != null && !(Array.isArray(x) && !x.length))
        .map(([k, x]) => h('div', {}, h('b', {}, k.replace(/_/g, ' ') + ': '), typeof x === 'object' ? renderValue(x) : String(x))));
    }
    return h('span', {}, String(v));
  };

  const copyBtn = (obj) => h('button', { class: 'btn ghost', onclick: async () => {
    try { await navigator.clipboard.writeText(toText(obj)); toast('Copied.'); } catch { toast('Could not copy.', true); }
  } }, 'Copy');

  // One agent card: inputs + a Run button + a result area.
  function agentCard({ title, who, help, inputs, buttons, extra }) {
    const result = h('div', { class: 'stack' });
    const show = (out, actions = []) => result.replaceChildren(h('div', { class: 'callout' }, renderValue(out)), h('div', { class: 'row' }, copyBtn(out), ...actions));
    const btns = buttons.map((b) => {
      const el = h('button', { class: 'btn' + (b.ghost ? ' ghost' : '') }, b.label);
      el.addEventListener('click', () => run(el, async () => {
        const r = await api('POST', `/api/clients/${client.id}/agents/${b.agent}`, b.body());
        show(r.output.output, b.actions ? b.actions(r.output.output) : []);
      }));
      return el;
    });
    return h('section', { class: 'card stack' }, h('div', {}, h('h2', { style: { margin: 0 } }, title), h('span', { class: 'chip teal' }, who)),
      h('p', { class: 'small muted' }, help), ...inputs, h('div', { class: 'row' }, ...btns), extra ?? null, result);
  }

  // ----- Ina: planner -----
  const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7) });
  const planGoal = h('input', { maxlength: 200, placeholder: 'Optional goal' });
  const perWeek = h('select', { value: '3' }, [1, 2, 3, 4, 5, 6, 7].map((n) => h('option', { value: String(n) }, `${n} per week`)));
  const planner = agentCard({
    title: 'Plan the month', who: 'Ina · Planner', help: 'A month of post topics. Pick one to start a draft.',
    inputs: [field('Month', month), field('Goal', planGoal), field('How often', perWeek)],
    buttons: [{ label: 'Plan the month', agent: 'planner', body: () => ({ month: month.value, goal: planGoal.value, per_week: Number(perWeek.value) }),
      actions: (o) => o.items.slice(0, 40).map((i) => h('button', { class: 'btn ghost', onclick: () => ctx.goPosts(i.topic) }, `Draft: ${i.topic.slice(0, 40)}`)) }]
  });

  // ----- Ren + Bong: visual and reel briefs -----
  const source = h('select', {}, h('option', { value: '' }, 'Or type a topic below…'));
  const topic = h('input', { maxlength: 500, placeholder: 'Topic, if not using a draft' });
  api('GET', `/api/drafts?client_id=${client.id}`).then(({ drafts }) => {
    for (const d of drafts.filter((x) => x.kind === 'post').slice(0, 20)) source.append(h('option', { value: String(d.id) }, d.content.slice(0, 60)));
  }).catch(() => {});
  const srcBody = () => (source.value ? { draft_id: Number(source.value) } : { topic: topic.value });
  const visuals = agentCard({
    title: 'Visual and Reel briefs', who: 'Ren · Visual briefs  ·  Bong · Reel plans',
    help: 'They describe what to photograph, design, or film. They cannot make images or edit video.',
    inputs: [field('Use an existing draft', source), field('Topic', topic)],
    buttons: [{ label: 'Visual brief', agent: 'designer', body: srcBody }, { label: 'Reel plan', agent: 'video', body: srcBody, ghost: true }]
  });

  // ----- Dario: analyst -----
  const analystText = h('textarea', { maxlength: 4000, placeholder: 'Paste competitor posts, reviews, or an article (no private data).' });
  const analyst = agentCard({
    title: 'Analyse pasted text', who: 'Dario · Trend analyst', help: 'It reads only what you paste. It does not browse the web.',
    inputs: [field('Text', analystText)], buttons: [{ label: 'Analyse', agent: 'analyst', body: () => ({ text: analystText.value }) }]
  });

  // ----- Maya: follow-ups -----
  const leadText = h('textarea', { maxlength: 3000, placeholder: 'Paste the conversation or your notes about the lead or proposal.' });
  const pipeline = agentCard({
    title: 'Follow-up message', who: 'Maya · Sales pipeline', help: 'Drafts one polite follow-up. You send it yourself.',
    inputs: [field('Conversation or notes', leadText)], buttons: [{ label: 'Draft follow-up', agent: 'pipeline', body: () => ({ text: leadText.value }) }]
  });

  // ----- Kiko: insights -----
  const insights = agentCard({
    title: 'Page performance', who: 'Kiko · Page insights',
    help: 'Reads the last posts on the connected Page (likes, comments, shares) and says what to try next. Needs the pages_read_engagement permission on the token.',
    inputs: [], buttons: [{ label: 'Read my Page', agent: 'insights', body: () => ({}) }]
  });

  // ----- Mina: onboarding (staff can apply the result) -----
  const answers = h('textarea', { maxlength: 3000, placeholder: 'What the business sells, who the customers are, how they talk, things they never say, languages used…' });
  const onboarding = agentCard({
    title: 'Onboard this client', who: 'Mina · Onboarding guide',
    help: 'Proposes a brand profile from the answers. It changes nothing until you press Apply.',
    inputs: [field('Answers from the client', answers)],
    buttons: [{ label: 'Propose a profile', agent: 'onboarding', body: () => ({ text: answers.value }),
      actions: (o) => (isStaff() ? [h('button', { class: 'btn good', onclick: (e) => run(e.target, async () => {
        if (!confirm('Replace this client\'s language, voice, audience and "never say" list with this proposal?')) return;
        await api('PATCH', `/api/clients/${client.id}`, { name: client.name, language: o.language || client.language, brand_voice: o.brand_voice, audience: o.audience, do_not_say: o.do_not_say, require_client_approval: client.require_client_approval });
        toast('Profile applied.'); await ctx.reloadClients(); ctx.redraw();
      }) }, 'Apply to client profile')] : [])
    }]
  });

  // ----- Gio + Sol: notes and search -----
  const noteList = h('div', { class: 'stack' });
  const nTitle = h('input', { maxlength: 120, placeholder: 'Title' });
  const nBody = h('textarea', { maxlength: 4000, placeholder: 'Note (no private data)' });
  const nPin = h('input', { type: 'checkbox' });
  const raw = h('textarea', { maxlength: 6000, placeholder: 'Paste messy meeting notes or a chat and let Gio tidy them.' });
  const searchBox = h('input', { placeholder: 'Search notes, drafts and agent output (keyword search)', maxlength: 100 });
  const searchOut = h('div', { class: 'stack' });

  async function loadNotes() {
    const { notes } = await api('GET', `/api/clients/${client.id}/notes`);
    noteList.replaceChildren(...(notes.length ? notes.map((n) => h('div', { class: 'callout' },
      h('div', { class: 'row' }, h('b', {}, n.title), n.pinned ? h('span', { class: 'chip accent' }, 'sent to AI as background') : null),
      h('p', { class: 'small' }, n.body),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: (e) => run(e.target, async () => { await api('PATCH', `/api/notes/${n.id}`, { pinned: !n.pinned }); await loadNotes(); }) }, n.pinned ? 'Unpin' : 'Pin'),
        h('button', { class: 'btn bad', onclick: (e) => run(e.target, async () => { if (confirm('Delete this note?')) { await api('DELETE', `/api/notes/${n.id}`); await loadNotes(); } }) }, 'Delete')))) : [h('p', { class: 'muted small' }, 'No notes yet.')]));
  }
  const addNote = h('button', { class: 'btn' }, 'Save note');
  addNote.addEventListener('click', () => run(addNote, async () => {
    await api('POST', `/api/clients/${client.id}/notes`, { title: nTitle.value, body: nBody.value, pinned: nPin.checked });
    nTitle.value = ''; nBody.value = ''; nPin.checked = false; await loadNotes();
  }));
  const doSearch = h('button', { class: 'btn ghost' }, 'Search');
  doSearch.addEventListener('click', () => run(doSearch, async () => {
    const { results } = await api('GET', `/api/clients/${client.id}/search?q=${encodeURIComponent(searchBox.value)}`);
    searchOut.replaceChildren(...(results.length ? results.map((r) => h('div', { class: 'callout' }, h('b', {}, `${r.type}: ${r.title}`), h('p', { class: 'small' }, r.snippet))) : [h('p', { class: 'muted small' }, 'Nothing found.')]));
  }));
  const tidy = agentCard({
    title: 'Notes and search', who: 'Gio · Note keeper  ·  Sol · Search',
    help: 'Pinned notes (max 8) are sent to the AI as background for this business. Search is keyword search across notes, drafts and agent output.',
    inputs: [field('Raw notes to tidy', raw)],
    buttons: [{ label: 'Tidy with Gio', agent: 'notes', body: () => ({ text: raw.value }),
      actions: (o) => [h('button', { class: 'btn good', onclick: (e) => run(e.target, async () => {
        await api('POST', `/api/clients/${client.id}/notes`, { title: o.title || 'Notes', body: toText({ summary: o.summary, decisions: o.decisions, todos: o.todos }).slice(0, 4000) });
        toast('Saved as a note.'); await loadNotes();
      }) }, 'Save as note')] }],
    extra: h('div', { class: 'stack' }, h('h2', {}, 'Add a note yourself'), nTitle, nBody, h('label', { class: 'check' }, nPin, 'Send to the AI as background (pin)'), addNote,
      h('h2', {}, 'Search'), h('div', { class: 'row' }, searchBox, doSearch), searchOut, h('h2', {}, 'Notes'), noteList)
  });

  content.append(h('section', { class: 'card row' }, h('h2', { style: { margin: 0 } }, 'Client'), picker ?? h('b', {}, client.name)),
    h('div', { class: 'cols' }, planner, visuals, analyst, pipeline, insights, onboarding), tidy);
  await loadNotes();
}
