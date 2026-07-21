const COLUMNS = [
  ['discovered', 'Discovered'],
  ['enriched', 'Enriched'],
  ['scored', 'Scored'],
  ['tailored', 'Tailored'],
  ['applying', 'Applying'],
  ['awaiting_answers', 'Needs answers'],
  ['awaiting_review', 'Review'],
  ['approved', 'Approved'],
  ['outbox', 'Outbox'],
  ['submitted', 'Submitted'],
  ['manual_required', 'Manual'],
  ['tailor_failed', 'Tailor failed'],
  ['apply_failed', 'Apply failed'],
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

  // One stage at a time — every browser stage shares the single Chrome profile,
  // and two LinkedIn sessions on one account is how accounts get flagged.
  const busy = !!d.running;
  for (const b of document.querySelectorAll('#controls button[data-run]')) {
    b.disabled = busy || (d.stopped && b.dataset.run !== 'check');
  }
  $('#runState').textContent = busy ? `running: ${d.running}…` : 'idle';
  $('#runState').classList.toggle('idle', !busy);
  $('#killswitch').classList.toggle('on', !!d.stopped);
  $('#killswitch').textContent = d.stopped ? 'Resume' : 'Stop everything';

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
      ${job.resume_path ? `<dt>Tailored resume</dt><dd><a href="/api/resume?id=${job.id}" target="_blank" rel="noopener">${esc(job.resume_path.split('/').pop())}</a></dd>` : ''}
      <dt>Link</dt><dd><a href="${esc(job.url)}" target="_blank" rel="noopener">Open on LinkedIn</a></dd>
      <dt>Timeline</dt><dd>${events.map(e => `${new Date(e.ts).toLocaleTimeString('en-ZA', { hour12: false })} · ${esc(e.message)}`).join('<br>') || '—'}</dd>
      <dt>Job description</dt><dd><pre>${esc(job.jd_text) || 'not fetched yet'}</pre></dd>
    </dl>`;
  $('#drawer').classList.add('open');
}

// Review queue — everything the bot filled, before it is sent. Each row shows
// which tier produced the value, so a suspect answer is obvious at a glance.
async function refreshReview() {
  const items = await (await fetch('/api/review')).json();
  $('#reviewWrap').hidden = items.length === 0;
  $('#rvCount').textContent = items.length || '';
  if (!items.length) return;

  $('#review').innerHTML = items.map(({ job, filled, screenshots, steps }) => `
    <div class="rv" data-id="${job.id}">
      <h4>${esc(job.title)}</h4>
      <div class="co">${esc(job.company)} · ${esc(job.location) || '—'} · fit ${job.fit_score ?? '—'} · ${steps} step${steps === 1 ? '' : 's'}</div>
      <table>${filled.map(f => `<tr>
        <td class="q">${esc(f.question)}</td>
        <td class="v">${esc(f.value)}</td>
        <td class="t"><span class="tier ${f.probable ? 'probable' : esc((f.tier || '').split('-')[0])}">${esc(f.probable ? 'probable' : f.tier)}</span></td>
      </tr>`).join('') || '<tr><td class="q">No fields on this application</td></tr>'}</table>
      <div class="shots">${screenshots.map(s => `<img src="/api/shot?p=${encodeURIComponent(s)}" alt="step">`).join('')}</div>
      <div class="acts">
        <button class="ok" data-act="approve">Approve &amp; submit</button>
        <button class="no" data-act="skip">Skip</button>
        ${job.resume_path ? `<a href="/api/resume?id=${job.id}" target="_blank" rel="noopener" style="align-self:center;font-size:11px">resume</a>` : ''}
      </div>
    </div>`).join('');
}

document.addEventListener('click', async e => {
  const img = e.target.closest('.rv .shots img');
  if (img) { $('#lightbox img').src = img.src; $('#lightbox').classList.add('on'); return; }
  if (e.target.id === 'lightbox' || e.target.closest('#lightbox')) { $('#lightbox').classList.remove('on'); return; }

  const btn = e.target.closest('.rv .acts button');
  if (!btn) return;
  const id = btn.closest('.rv').dataset.id;
  await fetch('/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action: btn.dataset.act }),
  });
  refreshReview(); refreshBoard();
});

// Outbox. Drafts send themselves when the hold expires — cancelling is the
// action, not sending. Email is the one channel that cannot be undone.
async function refreshOutbox() {
  const { drafts, gmailConnected, holdMinutes } = await (await fetch('/api/outbox')).json();
  $('#outboxWrap').hidden = drafts.length === 0;
  $('#obCount').textContent = drafts.length || '';
  if (!drafts.length) return;

  const warn = gmailConnected ? '' :
    `<div class="warnbar">Gmail not connected — these will not send. Drafts are in artifacts/emails/. Run <b>npm run gmail:auth</b></div>`;

  $('#outbox').innerHTML = warn + drafts.map(d => {
    const secs = Math.max(0, Math.round((new Date(d.send_after) - Date.now()) / 1000));
    const mins = Math.floor(secs / 60);
    // Report the real countdown either way — claiming "hold elapsed" while
    // minutes remain would misrepresent how long there is to cancel.
    const when = secs > 0
      ? `sends in ${mins}m ${String(secs % 60).padStart(2, '0')}s`
      : (gmailConnected ? 'sending now' : 'due — held, Gmail not connected');
    return `<div class="ob" data-id="${d.id}">
      <div class="subj">${esc(d.subject)}</div>
      <div class="to">to ${esc(d.to_addr)} · ${esc(d.company)} · ${(d.attachments || []).length} attachment(s)</div>
      <div class="cd">${when}</div>
      <pre>${esc(d.body)}</pre>
      <div class="acts">
        <button class="cancel" data-act="cancel">Cancel</button>
        <button class="now" data-act="send">Send now</button>
      </div>
    </div>`;
  }).join('');
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('.ob .acts button');
  if (!btn) return;
  const id = btn.closest('.ob').dataset.id;
  await fetch('/api/outbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action: btn.dataset.act }),
  });
  refreshOutbox(); refreshBoard();
});

// Parked questions. Answering one here releases every application waiting on it,
// and every future application that hits the same question.
async function refreshParked() {
  const { queue, profileFields } = await (await fetch('/api/parked')).json();
  const el = $('#parked');
  $('#pqCount').textContent = queue.length || '';
  $('#pfCount').textContent = profileFields.length || '';

  // Unconfirmed profile fields, editable in place. A confirmed value stops the
  // resolver parking on it.
  $('#profile').innerHTML = profileFields.length
    ? profileFields.map(f => {
        const input = f.type === 'bool'
          ? `<select name="value"><option value="true"${f.value === 'true' ? ' selected' : ''}>Yes</option><option value="false"${f.value !== 'true' ? ' selected' : ''}>No</option></select>`
          : `<input name="value" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(f.value)}" autocomplete="off">`;
        return `<div class="pq">
          <div class="q">${esc(f.label)}</div>
          <div class="why">${esc(f.path)} — suggested, not yet confirmed</div>
          <form data-path="${esc(f.path)}" style="margin-top:6px">${input}<button type="submit">Confirm</button></form>
        </div>`;
      }).join('')
    : '<div class="empty">Profile fully confirmed.</div>';

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

  el.innerHTML = items || '<div class="empty">Nothing waiting on you.</div>';
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('.pq form');
  if (!form) return;
  e.preventDefault();
  const value = form.elements.value.value.trim();
  if (!value) return;

  if (form.dataset.path) {
    const r = await (await fetch('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: form.dataset.path, value }),
    })).json();
    addEvent({ ts: new Date().toISOString(), stage: 'profile', message: r.error || `Confirmed ${form.dataset.path} — ${r.remaining} left` });
  } else {
    const r = await (await fetch('/api/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: form.dataset.q, value, fieldType: form.dataset.type }),
    })).json();
    addEvent({ ts: new Date().toISOString(), stage: 'answer', message: `Saved — released ${r.released} application(s)` });
  }
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
  if (e.type === 'board') { refreshBoard(); refreshParked(); refreshReview(); refreshOutbox(); }
  else if (e.type === 'event') { addEvent(e); refreshBoard(); refreshParked(); refreshReview(); refreshOutbox(); }
};

document.addEventListener('click', async e => {
  const run = e.target.closest('#controls button[data-run]');
  if (run) {
    const r = await (await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: run.dataset.run }),
    })).json();
    if (r.error) addEvent({ ts: new Date().toISOString(), stage: 'control', level: 'warn', message: r.error });
    refreshBoard();
    return;
  }

  if (e.target.id === 'killswitch') {
    const on = e.target.textContent !== 'Resume';
    await fetch('/api/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    refreshBoard();
    return;
  }

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
refreshReview();
refreshOutbox();
connectLive();
setInterval(() => { refreshBoard(); refreshParked(); refreshReview(); }, 15000);
// Faster tick so the countdown on a pending send stays honest.
setInterval(refreshOutbox, 5000);
