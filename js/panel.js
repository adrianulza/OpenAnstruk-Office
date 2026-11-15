// panel.js: the Producer desk. Only loaded when the office runs on your PC (node server/server.mjs).
// Chat with Pak Prod, turn the agreed proposal into a run, approve checkpoints, upload recordings,
// resume or cancel runs, read every file the team wrote, and see what it all cost.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
  const r = await fetch(`api/${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const type = r.headers.get('content-type') || '';
  const body = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.error || body || `HTTP ${r.status}`);
  return body;
};
const STATUS = { ok: ['ready', '#205c34', '#dff5e3'], partial: ['partial', '#6b5108', '#fff2cc'], blocked: ['blocked', '#8a2a1f', '#ffe3e0'], rejected: ['rejected', '#8a2a1f', '#ffe3e0'], over_budget: ['over budget', '#8a2a1f', '#ffe3e0'], error: ['error', '#8a2a1f', '#ffe3e0'], cancelled: ['cancelled', '#555', '#eee'], parked: ['waiting for you', '#6b5108', '#fff2cc'], waiting: ['waiting for you', '#6b5108', '#fff2cc'], running: ['running', '#1d4f86', '#dcebfb'] };
const badge = (s) => { const [t, fg, bg] = STATUS[s] || [s, '#333', '#eee']; return `<span class="badge" style="color:${fg};background:${bg}">${esc(t)}</span>`; };
const APPROVAL_FILES = { brief: ['brief.md'], script: ['naskah.md', 'script.json', 'critic.md', 'atensi.md', 'fakta.md'], final: ['qa.md', 'animasi.md', 'caption-ig.md', 'publish.json'], plan: ['brief.md'], kit: ['animasi.md', 'critic.md'] };
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const CSS = `
#deskBtn{position:relative}#deskBtn .dot{position:absolute;top:-4px;right:-4px;background:#d9534f;color:#fff;border-radius:99px;font-size:10px;padding:1px 5px;display:none}
#desk{position:fixed;top:76px;right:14px;bottom:14px;width:min(440px,calc(100vw - 28px));background:rgba(255,250,243,.98);border:2px solid #f0dcc4;border-radius:18px;box-shadow:0 6px 0 rgba(240,220,196,.8);display:none;flex-direction:column;z-index:8;font-size:13px}
#desk.open{display:flex}
@media(max-width:800px){#desk{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}}
#desk header{display:flex;gap:6px;align-items:center;padding:10px 12px;border-bottom:2px dashed #f0dcc4}
#desk header b{flex:1;font-size:15px}
#desk .tabs button.on{background:#ff8a5b;color:#fff}
#desk .body{flex:1;overflow:auto;padding:10px 12px}
#desk .info{font-size:11px;color:#8a7f99;margin-bottom:6px}
#desk .msgs{display:flex;flex-direction:column;gap:8px}
#desk .msg{padding:8px 10px;border-radius:14px;white-space:pre-wrap;line-height:1.35;max-width:92%}
#desk .msg.user{align-self:flex-end;background:#ffe1d3}
#desk .msg.assistant{align-self:flex-start;background:#fff;border:2px solid #f0dcc4}
#desk .msg pre{white-space:pre-wrap;background:#2b2340;color:#fff7ec;padding:6px;border-radius:8px;font-size:11px}
#desk .msg small{display:block;color:#8a7f99;margin-top:4px}
#desk .composer{display:flex;gap:6px;padding:10px 12px;border-top:2px dashed #f0dcc4}
#desk textarea,#desk input,#desk select{font:inherit;border:2px solid #f0dcc4;border-radius:10px;padding:6px 8px;background:#fff;box-sizing:border-box}
#desk .composer textarea{flex:1;resize:none;height:58px}
#desk .card{background:#fff;border:2px solid #f0dcc4;border-radius:14px;padding:10px;margin:8px 0}
#desk .card h3{margin:0 0 6px;font-size:14px}
#desk label{display:block;font-size:12px;color:#5a4f6a;margin:6px 0 2px}
#desk .card input,#desk .card select,#desk .card textarea{width:100%}
#desk .row{display:flex;gap:8px}#desk .row>*{flex:1}
#desk .checks label{display:inline-flex;gap:4px;align-items:center;margin-right:10px}
#desk .checks input{width:auto}
#desk .err{color:#c0392b;font-weight:700;margin-top:6px;white-space:pre-wrap}
#desk .badge{font-size:11px;font-weight:700;border-radius:99px;padding:2px 8px}
#desk .runItem{cursor:pointer}#desk .runItem:hover{border-color:#ff8a5b}
#desk .files button{font-size:11px;padding:3px 8px;margin:2px}
#desk .actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#desk .muted{color:#8a7f99;font-size:12px}
#desk table{width:100%;border-collapse:collapse;font-size:12px}#desk td{padding:3px 4px;border-bottom:1px dashed #f0dcc4}
#viewer{position:fixed;inset:6vh 6vw;background:#fffaf3;border:2px solid #f0dcc4;border-radius:18px;z-index:20;display:none;flex-direction:column}
#viewer.open{display:flex}#viewer header{display:flex;padding:10px 14px;border-bottom:2px dashed #f0dcc4;gap:8px;align-items:center}#viewer header b{flex:1}
#viewer pre{flex:1;overflow:auto;margin:0;padding:14px;white-space:pre-wrap;font-size:12px}
`;

export function initPanel({ server, office }) {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  const btn = document.createElement('button');
  btn.id = 'deskBtn'; btn.className = 'primary'; btn.innerHTML = '💬 Producer desk<span class="dot" id="deskDot">!</span>';
  document.getElementById('controls').insertBefore(btn, document.getElementById('tplBtn'));
  document.body.insertAdjacentHTML('beforeend', `
    <div id="desk"><header><b>🧢 Pak Prod's desk</b>
      <span class="tabs"><button data-tab="chat" class="on">Chat</button><button data-tab="runs">Runs</button><button data-tab="costs">Costs</button></span>
      <button id="deskClose" title="Close">✕</button></header>
      <div class="body" id="deskBody"></div><div id="deskFoot"></div></div>
    <div id="viewer"><header><b id="viewerTitle"></b><button id="viewerClose">✕</button></header><pre id="viewerText"></pre></div>`);
  const $ = (id) => document.getElementById(id);
  const desk = $('desk');
  let lastSig = '', tab = 'chat', chat = null, proposal = null, showForm = false, sending = false, chatErr = '', runSel = null, runsCache = [], formErr = '', timer = null;

  btn.onclick = () => toggle(!desk.classList.contains('open'));
  $('deskClose').onclick = () => toggle(false);
  $('viewerClose').onclick = () => $('viewer').classList.remove('open');
  desk.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  function toggle(open) { desk.classList.toggle('open', open); if (open) render(); }
  function setTab(t) { tab = t; desk.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); render(); }

  // Template Board "Send to Producer desk"
  const takeDraft = () => {
    const raw = localStorage.getItem('office.draft');
    if (!raw) return;
    localStorage.removeItem('office.draft');
    try { proposal = { ...JSON.parse(raw) }; showForm = true; toggle(true); setTab('chat'); } catch { /* ignore */ }
  };
  addEventListener('storage', (e) => { if (e.key === 'office.draft' && e.newValue) takeDraft(); });
  takeDraft();

  // the office tells us when a run needs you
  addEventListener('office:event', (e) => {
    const ev = e.detail;
    if (['approval', 'waiting_human', 'parked'].includes(ev.type)) { $('deskDot').style.display = 'block'; runSel = ev.run; if (desk.classList.contains('open') && tab === 'runs') render(); }
    if (['decision', 'run_end'].includes(ev.type) || (ev.type === 'done' && ['ulza', 'aina'].includes(ev.agent))) { $('deskDot').style.display = 'none'; if (desk.classList.contains('open') && tab === 'runs') render(); }
  });

  // ---------- chat ----------
  function renderChat() {
    const msgs = chat?.messages || [];
    const info = `Chat engine: <b>${esc(server.chat)}</b> · pipeline: <b>${esc(server.engine)}</b> · billing: ${esc(server.billing)}`;
    $('deskBody').dataset.view = 'chat';
    $('deskBody').innerHTML = `<div class="info">${info}</div>
      <div class="row" style="margin-bottom:8px"><select id="chatPick"><option value="">New conversation</option></select><button id="newRun">New run without chat</button></div>
      ${msgs.length ? '' : `<div class="card"><h3>Tell Pak Prod what reel you want</h3><div class="muted">For example: "Reel buat 20 Nov soal gempa kecil tapi merusak, sudut Cianjur 2022". He asks what he needs, checks the schedule, and proposes a run you can edit and start. Nothing runs until you press Start.</div></div>`}
      <div class="msgs">${msgs.map((m) => `<div class="msg ${m.role}">${fmt(m.text)}${m.usd ? `<small>$${m.usd.toFixed(3)}</small>` : ''}</div>`).join('')}
      ${sending ? '<div class="msg assistant">Pak Prod is thinking…</div>' : ''}</div>
      ${chatErr ? `<div class="err">${esc(chatErr)}</div>` : ''}
      ${showForm || proposal ? formHtml() : ''}`;
    $('deskFoot').innerHTML = `<div class="composer"><textarea id="chatIn" placeholder="Message Pak Prod (Enter to send, Shift+Enter for a new line)" ${sending ? 'disabled' : ''}></textarea><button class="primary" id="chatSend" ${sending ? 'disabled' : ''}>Send</button></div>`;
    $('chatSend').onclick = send;
    $('chatIn').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('newRun').onclick = () => { showForm = true; proposal = proposal || {}; render(); };
    api('chat').then((list) => {
      const sel = $('chatPick'); if (!sel) return;
      sel.innerHTML = '<option value="">New conversation</option>' + list.slice(0, 20).map((c) => `<option value="${esc(c.id)}" ${chat?.id === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('');
      sel.onchange = async () => { chatErr = ''; if (!sel.value) { chat = null; proposal = null; showForm = false; } else { chat = await api(`chat/${sel.value}`); proposal = chat.proposal || null; } render(); };
    }).catch(() => {});
    if (showForm || proposal) bindForm();
    const body = $('deskBody'); body.scrollTop = body.scrollHeight;
  }
  const fmt = (t) => esc(t).replace(/```(?:json)?\n?([\s\S]*?)```/g, '<pre>$1</pre>');

  async function send() {
    const inp = $('chatIn'); const text = inp.value.trim();
    if (!text || sending) return;
    sending = true; chatErr = '';
    chat = chat || { messages: [] };
    chat.messages = [...chat.messages, { role: 'user', text }];
    const prod = office.agents.producer; const before = prod.thought;
    prod.thought = 'Ngobrol dengan Ulza'; prod.setIcon('think');
    render();
    try {
      const r = await api('chat', { method: 'POST', body: JSON.stringify({ id: chat.id, message: text }) });
      chat = r.chat;
      if (r.proposal) { proposal = r.proposal; showForm = true; }
    } catch (e) { chatErr = e.message; chat.messages = chat.messages.slice(0, -1); setTimeout(() => { const i = $('chatIn'); if (i) i.value = text; }, 0); }
    prod.thought = before; prod.setIcon('idle');
    sending = false; render();
  }

  function formHtml() {
    const p = proposal || {};
    const k = p.kreator || 'openanstruk';
    const tpls = server.templates.filter((t) => !t.kreator || t.kreator.includes(k));
    const appr = p.approve || ['script', 'final'];
    return `<div class="card" id="runForm"><h3>${chat?.proposal ? 'Pak Prod proposes' : 'New run'}</h3>
      <div class="row"><div><label>Kreator</label><select id="fKreator"><option value="openanstruk" ${k === 'openanstruk' ? 'selected' : ''}>OpenAnstruk</option><option value="aina" ${k === 'aina' ? 'selected' : ''}>Aina</option></select></div>
      <div><label>Slot</label><input id="fSlot" type="date" value="${esc(p.slot || tomorrow())}"></div></div>
      <label>Topic</label><input id="fTopic" maxlength="120" value="${esc(p.topic || '')}" placeholder="Gempa kecil tapi merusak">
      <label>Template (ready only)</label><select id="fTpl">${tpls.map((t) => `<option value="${esc(t.id)}" ${t.id === p.template ? 'selected' : ''}>${esc(t.name)} · ~$${t.estUSD}</option>`).join('')}</select>
      ${p.template && !tpls.some((t) => t.id === p.template) ? `<div class="muted">"${esc(p.template)}" is not ready for ${esc(k)}. Adapting it is a separate phase 1 run (CLI: --phase 1).</div>` : ''}
      <label>Brief notes for the team</label><textarea id="fNotes" rows="3">${esc(p.notes || '')}</textarea>
      <label>Stop and ask me before</label><div class="checks">
        ${['brief', 'script', 'final'].map((a) => `<label><input type="checkbox" class="fAppr" value="${a}" ${appr.includes(a) ? 'checked' : ''}> ${a}</label>`).join('')}</div>
      <div class="row"><div><label>Engine</label><select id="fEngine">
        ${[...new Set([server.engine, 'dry'])].map((e) => `<option value="${e}">${e === 'dry' ? 'dry (simulated, free)' : e === 'claude-cli' ? 'claude-cli (real agents)' : 'api (text only)'}</option>`).join('')}</select></div>
        <div><label>Budget cap ($)</label><input id="fCap" type="number" min="0.5" max="20" step="0.5" value="${esc(p.cap || server.guard.phase2.cap)}"></div></div>
      ${formErr ? `<div class="err">${esc(formErr)}</div>` : ''}
      <div class="actions"><button class="primary" id="fStart">▶ Start run</button><button id="fCancel">Discard</button></div></div>`;
  }
  function bindForm() {
    $('fKreator').onchange = () => { proposal = { ...readForm(), template: '' }; render(); };
    $('fCancel').onclick = () => { proposal = null; showForm = false; formErr = ''; render(); };
    $('fStart').onclick = async () => {
      const cfg = readForm();
      formErr = '';
      try {
        const r = await api('runs', { method: 'POST', body: JSON.stringify(cfg) });
        proposal = null; showForm = false; runSel = r.run;
        setTab('runs');
      } catch (e) { formErr = e.message; proposal = cfg; render(); }
    };
  }
  function readForm() {
    return {
      kreator: $('fKreator').value, slot: $('fSlot').value, topic: $('fTopic').value.trim(), template: $('fTpl').value,
      notes: $('fNotes').value.trim(), approve: [...document.querySelectorAll('.fAppr:checked')].map((x) => x.value),
      engine: $('fEngine').value, cap: Number($('fCap').value) || undefined,
    };
  }

  // ---------- runs ----------
  async function renderRuns(force = true) {
    $('deskFoot').innerHTML = '';
    let list = [];
    try { list = await api('runs'); } catch (e) { $('deskBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    runsCache = list;
    if (tab !== 'runs') return;
    if (!runSel && list[0]) runSel = list[0].run;
    let detail = '', st = null;
    if (runSel) {
      try { st = await api(`runs/${encodeURIComponent(runSel)}`); detail = runDetail(st); } catch (e) { detail = `<div class="err">${esc(e.message)}</div>`; }
    }
    if (tab !== 'runs') return;
    const sig = JSON.stringify([list, st && { ...st, updatedAt: 0, elapsed: 0 }]);
    if (!force && sig === lastSig && $('deskBody').dataset.view === 'runs') return;   // nothing changed: keep the DOM (and your clicks)
    lastSig = sig; $('deskBody').dataset.view = 'runs';
    const keep = $('deskBody').scrollTop;
    const noteVal = $('apNote')?.value || '';
    $('deskBody').innerHTML = `${detail}<h3 style="margin:12px 0 4px">All runs</h3>
      ${list.map((r) => `<div class="card runItem" data-run="${esc(r.run)}"><div class="row"><b>${esc(r.run)}</b><span style="text-align:right">${badge(r.status)}</span></div>
        <div class="muted">${esc(r.topic)} · ${esc(r.template)} · ${esc(r.engine)} · $${(r.spent || 0).toFixed(2)} / $${r.cap}</div></div>`).join('') || '<div class="muted">No runs yet. Start one from the Chat tab.</div>'}`;
    $('deskBody').scrollTop = keep;
    if ($('apNote')) $('apNote').value = noteVal;
    document.querySelectorAll('.runItem').forEach((el) => (el.onclick = () => { runSel = el.dataset.run; renderRuns(); }));
    bindDetail();
  }
  function runDetail(st) {
    const c = st.config, w = st.waiting;
    const canResume = ['parked', 'blocked', 'error', 'over_budget', 'partial', 'cancelled', 'rejected'].includes(st.status) && !st.active;
    const canCancel = st.active || ['parked', 'waiting'].includes(st.status);
    let waitHtml = '';
    if (w?.kind === 'approval') {
      const files = (APPROVAL_FILES[w.name] || []).filter((f) => st.files.includes(f));
      waitHtml = `<div class="card" style="border-color:#f1d27a"><h3>⏳ Your OK is needed: ${esc(w.name)}</h3>
        <div class="files">Read first: ${files.map((f) => `<button data-file="${esc(f)}">${esc(f)}</button>`).join('') || '<span class="muted">no files yet</span>'}</div>
        <label>Note for the team (required when you reject)</label><textarea id="apNote" rows="2" style="width:100%"></textarea>
        <div class="actions"><button class="primary" id="apOk">✓ Approve</button><button id="apNo">✗ Reject and send back</button></div></div>`;
    } else if (w?.kind === 'human') {
      waitHtml = `<div class="card" style="border-color:#f1d27a"><h3>🎙️ Waiting for ${esc(w.who === 'aina' ? 'Aina' : 'Ulza')}'s recording</h3>
        <div class="muted">Upload the file here, or save it in <code>${esc(w.dir || '')}</code>. The run continues by itself when the file is there.</div>
        <input type="file" id="upFile" accept="${w.name === 'footage' ? 'video/*,audio/*' : 'audio/*'}" style="margin-top:6px;width:100%">
        <div class="actions"><button class="primary" id="upGo">Upload</button><button id="upCheck">I saved it, check now</button></div><div id="upMsg" class="muted"></div></div>`;
    }
    return `<div class="card"><div class="row"><h3>${esc(st.run)}</h3><span style="text-align:right">${badge(st.status)}</span></div>
      <div class="muted">${esc(c.topic)} · slot ${esc(c.slot)} · ${esc(c.kreator)} · ${esc(c.template)} · ${esc(c.engine)}</div>
      <div style="margin:6px 0"><b>$${(st.spent || 0).toFixed(3)}</b> of $${c.cap}${st.reason ? ` · <span class="err" style="display:inline">${esc(st.reason)}</span>` : ''}</div>
      ${waitHtml}
      <div class="files"><span class="muted">Files:</span> ${st.files.map((f) => `<button data-file="${esc(f)}">${esc(f)}</button>`).join('') || '<span class="muted">none yet</span>'}</div>
      <div class="actions">
        <a href="?log=${encodeURIComponent(`runs/${st.run}/events.jsonl`)}&replay=1" target="_blank"><button>▶ Replay</button></a>
        ${canResume ? `<button class="primary" id="rResume">Resume</button>${st.status === 'partial' && c.engine === 'api' ? '<button id="rResumeCli">Resume with claude-cli</button>' : ''}` : ''}
        ${canCancel ? '<button id="rCancel">Cancel run</button>' : ''}
      </div><div id="rMsg" class="err"></div></div>`;
  }
  function bindDetail() {
    const run = runSel;
    document.querySelectorAll('[data-file]').forEach((b) => (b.onclick = async () => {
      try { const t = await api(`runs/${encodeURIComponent(run)}/file?name=${encodeURIComponent(b.dataset.file)}`); $('viewerTitle').textContent = `${run} / ${b.dataset.file}`; $('viewerText').textContent = t; $('viewer').classList.add('open'); }
      catch (e) { alert(e.message); }
    }));
    const act = (id, fn) => { const el = $(id); if (el) el.onclick = async () => { try { await fn(); setTimeout(renderRuns, 400); } catch (e) { $('rMsg').textContent = e.message; } }; };
    act('rResume', () => api(`runs/${encodeURIComponent(run)}/resume`, { method: 'POST', body: '{}' }));
    act('rResumeCli', () => api(`runs/${encodeURIComponent(run)}/resume`, { method: 'POST', body: JSON.stringify({ engine: 'claude-cli' }) }));
    act('rCancel', () => { if (!confirm(`Cancel ${run}?`)) throw new Error('Not cancelled'); return api(`runs/${encodeURIComponent(run)}/cancel`, { method: 'POST', body: '{}' }); });
    act('apOk', () => api(`runs/${encodeURIComponent(run)}/approve`, { method: 'POST', body: JSON.stringify({ name: currentWaiting(), decision: 'approve', note: $('apNote').value }) }));
    act('apNo', () => {
      const note = $('apNote').value.trim();
      if (!note) throw new Error('Write what should change, so the team knows what to fix.');
      return api(`runs/${encodeURIComponent(run)}/approve`, { method: 'POST', body: JSON.stringify({ name: currentWaiting(), decision: 'reject', note }) });
    });
    act('upCheck', () => api(`runs/${encodeURIComponent(run)}/resume`, { method: 'POST', body: '{}' }).catch((e) => { if (!/still going/.test(e.message)) throw e; }));
    const up = $('upGo');
    if (up) up.onclick = async () => {
      const f = $('upFile').files[0];
      if (!f) { $('upMsg').textContent = 'Choose a file first.'; return; }
      const st = runsCache.find((r) => r.run === run);
      $('upMsg').textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`;
      try {
        const r = await fetch(`api/runs/${encodeURIComponent(run)}/upload?kind=${encodeURIComponent(st?.waiting?.name || 'voice')}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
        const j = await r.json(); if (!r.ok) throw new Error(j.error);
        $('upMsg').textContent = `Saved ${j.saved}. The run continues.`;
        setTimeout(renderRuns, 1500);
      } catch (e) { $('upMsg').textContent = e.message; }
    };
  }
  const currentWaiting = () => runsCache.find((r) => r.run === runSel)?.waiting?.name;

  // ---------- costs ----------
  async function renderCosts() {
    $('deskFoot').innerHTML = '';
    let l;
    try { l = await api('ledger'); } catch (e) { $('deskBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const money = (v) => `$${(v || 0).toFixed(2)}`;
    $('deskBody').dataset.view = 'costs';
    $('deskBody').innerHTML = `<div class="info">Real spend only (dry runs are free and not counted). With a Claude subscription these are API-equivalent amounts; your real limit is the plan's usage allowance.</div>
      <div class="row"><div class="card"><div class="muted">Today</div><b>${money(l.today)}</b></div><div class="card"><div class="muted">7 days</div><b>${money(l.week)}</b></div><div class="card"><div class="muted">30 days</div><b>${money(l.month)}</b></div></div>
      <div class="muted">All time ${money(l.all)} · chats ${money(l.chats)} · ${l.runs} real runs · ${l.dryRuns} dry runs</div>
      <h3 style="margin:12px 0 4px">Recent</h3><table>${l.recent.map((e) => `<tr><td>${esc(e.at.slice(0, 16).replace('T', ' '))}</td><td>${esc(e.kind === 'chat' ? 'chat' : e.run)}</td><td>${e.status ? badge(e.status) : ''}</td><td>${esc(e.engine)}</td><td style="text-align:right">${money(e.usd)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet</td></tr>'}</table>`;
  }

  function render() {
    if (!desk.classList.contains('open')) return;
    if (tab === 'chat') renderChat();
    else if (tab === 'runs') renderRuns();
    else renderCosts();
  }
  clearInterval(timer);
  timer = setInterval(() => {
    if (!desk.classList.contains('open') || tab !== 'runs') return;
    if (document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
    renderRuns(false);
  }, 3000);
}
