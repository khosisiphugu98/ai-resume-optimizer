const COLUMNS = [
  ['discovered', 'Discovered'],
  ['enriched', 'Enriched'],
  ['scored', 'Scored'],
  ['tailored', 'Tailored'],
  ['applying', 'Applying'],
  ['awaiting_answers', 'Needs answers'],
  ['outbox', 'Outbox'],
  ['submitted', 'Submitted'],
  ['manual_required', 'Manual'],
  ['rejected', 'Rejected'],
];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function refreshBoard() {
  const d = await (await fetch('/api/board')).json();

  const byStatus = {};
  for (const j of d.jobs) (byStatus[j.status] ||= []).push(j);

  $('#board').innerHTML = COLUMNS.map(([key, label]) => {
    const jobs = byStatus[key] || [];
    return `<div class="col"><h2>${label}<span>${jobs.length}</span></h2>${
      jobs.slice(0, 60).map(cardHtml).join('') || '<div style="color:#56606d;font-size:11px;padding:6px 2px">—</div>'
    }</div>`;
  }).join('');

  const r = d.rates, c = d.caps;
  $('#r-easy').textContent = r.linkedin_easy; $('#c-easy').textContent = c.linkedin_easy;
  $('#r-ext').textContent = r.external_ats;   $('#c-ext').textContent = c.external_ats;
  $('#r-mail').textContent = r.email;         $('#c-mail').textContent = c.email;
  $('#r-pv').textContent = r.linkedin_pageviews; $('#c-pv').textContent = c.linkedin_pageviews;
  $('#stopPill').hidden = !d.stopped;

  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === d.mode);
}

function cardHtml(j) {
  const meta = [
    j.apply_type && j.apply_type !== 'unknown' ? j.apply_type.replace('_', ' ') : null,
    j.ats_vendor,
    j.fit_score != null ? `fit ${j.fit_score}` : null,
    j.reject_reason ? j.reject_reason.split(':')[0] : null,
  ].filter(Boolean);
  return `<div class="card t${j.tier || ''}" data-id="${j.id}">
    <div class="t">${esc(j.title) || 'Untitled'}</div>
    <div class="c">${esc(j.company) || '—'}</div>
    <div class="m">${meta.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</div>
  </div>`;
}

function addEvent(e) {
  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  const div = document.createElement('div');
  div.className = `ev ${e.level || 'info'}`;
  div.innerHTML = `<time>${new Date(e.ts).toLocaleTimeString('en-ZA', { hour12: false })}</time>
    <span class="stage">${esc(e.stage || '')}</span><span class="msg">${esc(e.message)}</span>`;
  log.appendChild(div);
  while (log.children.length > 400) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function openDrawer(id) {
  const { job, events } = await (await fetch(`/api/job?id=${id}`)).json();
  $('#drawerBody').innerHTML = `
    <h2>${esc(job.title)}</h2>
    <div class="sub">${esc(job.company)} · ${esc(job.location) || '—'}</div>
    <dl>
      <dt>Status</dt><dd>${esc(job.status)}${job.reject_reason ? ` — ${esc(job.reject_reason)}` : ''}</dd>
      <dt>Route</dt><dd>${esc(job.apply_type)}${job.apply_email ? ` → ${esc(job.apply_email)}` : ''}${job.ats_vendor ? ` (${esc(job.ats_vendor)})` : ''}</dd>
      <dt>Tier / search</dt><dd>${esc(job.tier)} · ${esc(job.search_keywords)}</dd>
      ${job.fit_score != null ? `<dt>Fit</dt><dd>${job.fit_score} — ${esc(job.fit_rationale)}</dd>` : ''}
      ${job.parked_question ? `<dt>Parked on</dt><dd>${esc(job.parked_question)}</dd>` : ''}
      <dt>Link</dt><dd><a href="${esc(job.url)}" target="_blank" rel="noopener">Open on LinkedIn</a></dd>
      <dt>Timeline</dt><dd>${events.map(e => `${new Date(e.ts).toLocaleTimeString('en-ZA', { hour12: false })} · ${esc(e.message)}`).join('<br>') || '—'}</dd>
      <dt>Job description</dt><dd><pre>${esc(job.jd_text) || 'not fetched yet'}</pre></dd>
    </dl>`;
  $('#drawer').classList.add('open');
}

// Parked questions. Answering one here releases every application waiting on it,
// and every future application that hits the same question.
async function refreshParked() {
  const { queue, profileGaps } = await (await fetch('/api/parked')).json();
  const el = $('#parked');
  $('#pqCount').textContent = queue.length || '';

  const gaps = profileGaps.length
    ? `<div class="gap">${profileGaps.length} unconfirmed profile field(s) — these park applications until confirmed:<br>${
        profileGaps.slice(0, 6).map(esc).join('<br>')}${profileGaps.length > 6 ? `<br>…and ${profileGaps.length - 6} more` : ''}</div>`
    : '';

  const items = queue.map(q => {
    const input = q.options?.length
      ? `<select name="value">${q.options.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
      : `<input name="value" placeholder="your answer" autocomplete="off">`;
    return `<div class="pq">
      <div class="q">${esc(q.question_raw)}</div>
      <div class="why">${esc(q.reason || '')}</div>
      <div class="blocking">blocking ${q.blocking} application${q.blocking === 1 ? '' : 's'} · ${esc(q.companies || '')}</div>
      <form data-q="${esc(q.question_raw)}" data-type="${esc(q.field_type || 'text')}" style="margin-top:6px">
        ${input}<button type="submit">Save</button>
      </form>
    </div>`;
  }).join('');

  el.innerHTML = gaps + (items || (profileGaps.length ? '' : '<div class="empty">Nothing waiting on you.</div>'));
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('.pq form');
  if (!form) return;
  e.preventDefault();
  const value = form.elements.value.value.trim();
  if (!value) return;
  const r = await (await fetch('/api/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: form.dataset.q, value, fieldType: form.dataset.type }),
  })).json();
  addEvent({ ts: new Date().toISOString(), stage: 'answer', message: `Saved — released ${r.released} application(s)` });
  refreshParked(); refreshBoard();
});

// Live browser frames.
const canvas = $('#live'), cctx = canvas.getContext('2d');
let liveTimer;
function connectLive() {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onmessage = ev => {
    const img = new Image();
    img.onload = () => {
      canvas.hidden = false; $('#liveOff').hidden = true;
      canvas.width = img.width; canvas.height = img.height;
      cctx.drawImage(img, 0, 0);
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { canvas.hidden = true; $('#liveOff').hidden = false; }, 8000);
    };
    img.src = 'data:image/jpeg;base64,' + ev.data;
  };
  ws.onclose = () => setTimeout(connectLive, 2000);
}

const es = new EventSource('/api/stream');
es.onmessage = m => {
  const e = JSON.parse(m.data);
  if (e.type === 'board') { refreshBoard(); refreshParked(); }
  else if (e.type === 'event') { addEvent(e); refreshBoard(); refreshParked(); }
};

document.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card) openDrawer(card.dataset.id);
  if (e.target.id === 'close') $('#drawer').classList.remove('open');
  const mode = e.target.closest('#modes button');
  if (mode) fetch('/api/mode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: mode.dataset.mode }),
  }).then(refreshBoard);
});

fetch('/api/events').then(r => r.json()).then(evs => evs.forEach(addEvent));
refreshBoard();
refreshParked();
connectLive();
setInterval(() => { refreshBoard(); refreshParked(); }, 15000);
