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
  ['blocked', 'Blocked'],
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
    // The Rejected column carries the editor for the criteria that fill it.
    const head = key === 'rejected'
      ? `<span class="hleft">${label}<button class="colcrit" title="View and edit rejection criteria">criteria</button></span>`
      : label;
    return `<div class="col"><h2>${head}<span>${jobs.length}</span></h2>${
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

  // The gear stays quiet unless something it owns is actually unset.
  $('#settingsDot').hidden = !!d.secrets?.openai && !!d.gmailConnected;

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

// Statuses a block can still save you from. Past these the application is gone
// and the button would be a lie, so it is not offered.
const BLOCKABLE = ['new', 'discovered', 'enriched', 'scored', 'tailored', 'approved',
                   'awaiting_review', 'awaiting_answers', 'outbox', 'applying'];

async function openDrawer(id) {
  const { job, events } = await (await fetch(`/api/job?id=${id}`)).json();

  // The veto. It is the one destructive-feeling action in the drawer, so it sits
  // at the top where it can be found in a hurry rather than buried under the JD.
  const actions = job.status === 'blocked'
    ? `<button class="unblock" data-block="unblock">Unblock — put it back in "${esc(job.blocked_from || 'tailored')}"</button>`
    : job.status === 'rejected'
      ? `<button class="unblock" data-block="unreject">Un-reject — put it back in the pipeline</button>`
      : BLOCKABLE.includes(job.status)
        ? `<button class="block" data-block="block">Block this application</button>
           <button class="block quiet" data-block="block-company">Block ${esc(job.company) || 'this company'}</button>`
        : '';

  $('#drawerBody').innerHTML = `
    <h2>${esc(job.title)}</h2>
    <div class="sub">${esc(job.company)} · ${esc(job.location) || '—'}</div>
    ${actions ? `<div class="acts" data-id="${job.id}" data-company="${esc(job.company)}">${actions}</div>` : ''}
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

// Blocking from the drawer. Company blocks are asked about first — one click
// there retires every open posting from them, which is not obvious from a button.
document.addEventListener('click', async e => {
  const btn = e.target.closest('#drawerBody .acts button[data-block]');
  if (!btn) return;
  const row = btn.closest('.acts');
  const action = btn.dataset.block;
  const company = row.dataset.company;

  if (action === 'block-company' &&
      !confirm(`Block ${company}?\n\nEvery open application to them is pulled, held email drafts are cancelled, and their future postings are filtered out at discovery.`)) return;

  const r = await (await fetch('/api/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: row.dataset.id, action, company }),
  })).json();

  if (r.error) return addEvent({ ts: new Date().toISOString(), stage: 'control', level: 'warn', message: r.error });
  openDrawer(row.dataset.id);
  refreshBoard(); refreshOutbox(); refreshSearches();
});

// Search terms — what discovery actually looks for. Editing here beats editing
// config.js because a term that returns nothing still costs a pageview off the
// daily cap every run, so the hit count next to each one is the point.
async function refreshSearches() {
  const { searches, blocked } = await (await fetch('/api/searches')).json();
  $('#seCount').textContent = searches.filter(s => s.enabled).length || '';

  $('#searches').innerHTML = searches.map(s => `
    <div class="se${s.enabled ? '' : ' off'}" data-id="${s.id}">
      <input type="checkbox" data-act="toggle"${s.enabled ? ' checked' : ''} title="${s.enabled ? 'Searched every run' : 'Paused'}">
      <div class="k">
        <div class="kw">${esc(s.keywords)}</div>
        <div class="lo">${esc(s.location)}${s.remote ? ' · remote' : ''} · ${s.found} found</div>
      </div>
      <span class="tier t${esc(s.tier)}">${esc(s.tier)}</span>
      <button data-act="delete" title="Remove">×</button>
    </div>`).join('') || '<div class="empty">No search terms — discovery has nothing to look for.</div>';

  $('#blocked').innerHTML = blocked.length
    ? `<div class="blk">${blocked.map(b => `
        <span class="bc" data-company="${esc(b.company)}">${esc(b.company)} <button title="Unblock">×</button></span>`).join('')}</div>`
    : '';
}

document.addEventListener('submit', async e => {
  const form = e.target.closest('#searchAdd');
  if (!form) return;
  e.preventDefault();
  const r = await (await fetch('/api/searches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'add',
      keywords: form.elements.keywords.value.trim(),
      location: form.elements.location.value.trim(),
      tier: form.elements.tier.value,
      remote: form.elements.remote.checked,
    }),
  })).json();
  if (r.error) return setMsg('#searchMsg', r.error, 'err');
  setMsg('#searchMsg', 'Added — it runs on the next discovery.', 'ok');
  form.elements.keywords.value = '';
  refreshSearches();
});

document.addEventListener('click', async e => {
  const bc = e.target.closest('#blocked .bc button');
  if (bc) {
    await fetch('/api/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unblock-company', company: bc.closest('.bc').dataset.company }),
    });
    return refreshSearches();
  }

  const el = e.target.closest('#searches .se [data-act]');
  if (!el) return;
  const row = el.closest('.se');
  const act = el.dataset.act;
  if (act === 'delete' && !confirm(`Remove "${row.querySelector('.kw').textContent}" from discovery?`)) return;

  await fetch('/api/searches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: act, id: row.dataset.id, enabled: act === 'toggle' ? el.checked : undefined }),
  });
  refreshSearches();
});

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

// Sent applications with no verdict yet. Easy Apply and the ATS boards report
// nothing back, so unless this gets clicked there is no outcome data at all —
// and without outcome data the fit threshold stays a number someone guessed.
const OUTCOME_LABELS = {
  no_response: 'No response',
  rejected: 'Rejected',
  screen: 'Screen',
  interview: 'Interview',
  offer: 'Offer',
};

async function refreshSent() {
  const { pending, states, summary, timeoutDays } = await (await fetch('/api/sent')).json();
  $('#sentWrap').hidden = pending.length === 0 && summary.labelled === 0;
  $('#snCount').textContent = pending.length || '';
  if ($('#sentWrap').hidden) return;

  const rate = summary.labelled
    ? `${Math.round((summary.responses / summary.labelled) * 100)}%`
    : '—';
  $('#sentSummary').innerHTML =
    `<b>${summary.labelled}</b>/${summary.submitted} labelled · <b>${summary.responses}</b> responses · ` +
    `${rate} response rate${summary.labelled < 40 ? ' <span style="color:var(--warn)">(too few to read into)</span>' : ''}`;

  $('#sent').innerHTML = pending.map(p => `
    <div class="sn" data-id="${p.id}">
      <div class="h">
        <div class="ti">${esc(p.title)}</div>
        <div class="ag${p.age_days >= timeoutDays - 10 ? ' stale' : ''}">${p.age_days}d</div>
      </div>
      <div class="co">${esc(p.company)} · ${esc((p.channel || '').replace('_', ' '))} · fit ${p.fit_score ?? '—'}</div>
      <div class="outs">${states.map(s =>
        `<button data-state="${s}">${OUTCOME_LABELS[s]}</button>`).join('')}</div>
    </div>`).join('') || '<div class="empty">Every sent application has a verdict.</div>';
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('.sn .outs button');
  if (!btn) return;
  const row = btn.closest('.sn');
  const r = await (await fetch('/api/outcome', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: row.dataset.id, state: btn.dataset.state }),
  })).json();
  if (r.error) return addEvent({ ts: new Date().toISOString(), stage: 'outcome', level: 'warn', message: r.error });
  refreshSent();
  refreshCalibration();
});

// Parked questions. Answering one here releases every application waiting on it,
// and every future application that hits the same question.
async function refreshParked() {
  const { queue, profileFields, skillSuggestions = [] } = await (await fetch('/api/parked')).json();
  const el = $('#parked');
  $('#pqCount').textContent = queue.length || '';
  $('#pfCount').textContent = profileFields.length || '';
  $('#ksCount').textContent = skillSuggestions.length || '';

  // Skills a job wanted that aren't confirmed yet. Confirm (optionally with years)
  // to make them usable in future tailoring, or dismiss to stop being asked.
  $('#skillSuggestions').innerHTML = skillSuggestions.length
    ? skillSuggestions.map(s => `<div class="pq">
        <div class="q">${esc(s.display)}</div>
        <div class="why">asked for by ${s.job_count} job${s.job_count === 1 ? '' : 's'}</div>
        <form class="skill-form" data-skill="${esc(s.display)}" style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input name="years" type="number" min="0" step="1" placeholder="years (optional)" autocomplete="off" style="width:120px">
          <button type="submit">I have this</button>
          <button type="button" class="skill-dismiss" data-skill="${esc(s.display)}">Dismiss</button>
        </form>
      </div>`).join('')
    : '<div class="empty">No unconfirmed skills to review.</div>';

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

  // Skill suggestion: "I have this", with an optional years value.
  if (form.classList.contains('skill-form')) {
    const years = form.elements.years.value.trim();
    const r = await (await fetch('/api/skill-suggestion', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: form.dataset.skill, action: 'confirm', years: years || null }),
    })).json();
    addEvent({ ts: new Date().toISOString(), stage: 'profile', message: r.error || `Confirmed skill "${form.dataset.skill}"` });
    refreshParked(); refreshBoard();
    return;
  }

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

// Dismiss a skill suggestion — hides it for good, never added to the resume.
document.addEventListener('click', async e => {
  const btn = e.target.closest('.skill-dismiss');
  if (!btn) return;
  await fetch('/api/skill-suggestion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill: btn.dataset.skill, action: 'dismiss' }),
  });
  addEvent({ ts: new Date().toISOString(), stage: 'profile', message: `Dismissed skill "${btn.dataset.skill}"` });
  refreshParked();
});

// Calibration. Everything here is computed from a small number of real events,
// so the panel is built to resist over-reading: the verdict comes first in
// words, every percentage carries its interval, and a bucket too small to mean
// anything says "too few" rather than showing a confident 0%.
const pct = x => x == null ? '—' : `${(x * 100).toFixed(0)}%`;
const ci = row => row.rate == null ? '' : `${pct(row.low)}–${pct(row.high)}`;

function cbTable(title, rows, { note = '' } = {}) {
  if (!rows.length) return '';
  return `<div class="cb-sec"><h5>${esc(title)}</h5><table>${rows.map(r => `
    <tr>
      <td class="k">${esc(r.label ?? r.key)}</td>
      <td class="n">n=${r.n}</td>
      ${r.suppressed
        ? `<td class="sup" colspan="2">too few to read</td>`
        : `<td class="r">${pct(r.rate)}</td><td class="ci">${ci(r)}</td>`}
    </tr>`).join('')}</table>${note ? `<div style="color:var(--faint);margin-top:5px">${note}</div>` : ''}</div>`;
}

async function refreshCalibration() {
  const c = await (await fetch('/api/calibration')).json();
  $('#cbCount').textContent = c.labelled ? `${c.labelled} labelled` : '';

  const sweep = c.sweep.filter(s => s.sent > 0);
  const sweepHtml = !c.ready || !sweep.length ? '' : `
    <div class="cb-sec"><h5>Threshold sweep</h5><table>
      <tr><td class="k">threshold</td><td class="n">sent</td><td class="r">rate</td><td class="ci">missed</td></tr>
      ${sweep.map(s => `<tr${s.threshold === c.threshold ? ' class="cb-cur"' : ''}>
        <td class="k">${s.threshold}${s.threshold === c.threshold ? ' ←' : ''}</td>
        <td class="n">${s.sent}</td>
        <td class="r">${pct(s.rate)}</td>
        <td class="ci ${s.missed ? 'cb-miss' : ''}">${s.missed}</td>
      </tr>`).join('')}
    </table>
    <div style="color:var(--faint);margin-top:5px">
      "missed" counts replies from applications that scored <em>below</em> that threshold —
      the expensive error, and the one a thin pipeline never reveals.
    </div></div>`;

  $('#calibration').innerHTML = `
    <div class="cb-verdict${c.ready ? '' : ' thin'}">${esc(c.verdict)}</div>
    <div class="cb-set">
      <span class="lbl">Fit threshold</span>
      <input id="thVal" type="number" min="0" max="100" value="${c.threshold}">
      <button id="thSave">Set</button>
      <span class="lbl">default ${c.defaultThreshold}</span>
    </div>
    ${c.awaiting ? `<div class="cb-warn">${c.awaiting} sent application(s) still have no verdict. Mark them in the Sent panel — an unlabelled application is quietly excluded from every rate above.</div>` : ''}
    ${c.sweepCensored && c.labelled ? `<div class="cb-warn">No audit samples yet. Until some below-threshold jobs are applied to, "missed" is structurally zero and the sweep can only ever argue for raising the threshold.</div>` : ''}
    ${cbTable('By fit score', c.buckets)}
    ${cbTable('By channel', c.byChannel)}
    ${cbTable('By tier', c.byTier)}
    ${cbTable('By ATS vendor', c.byVendor)}
    ${cbTable('By search term', c.bySearch.slice(0, 8))}
    ${c.audit.n ? `<div class="cb-sec"><h5>Audit sample (below threshold, kept out of the headline)</h5>
      <table><tr><td class="k">deliberately applied</td><td class="n">n=${c.audit.n}</td>
      <td class="r">${pct(c.audit.rate)}</td><td class="ci">${ci(c.audit)}</td></tr></table></div>` : ''}
    ${c.parked.length ? `<div class="cb-sec"><h5>Profile gaps costing the most volume</h5><table>${
      c.parked.map(p => `<tr><td class="k">${esc(p.question)}</td><td class="n">${p.blocked}</td></tr>`).join('')
    }</table></div>` : ''}
    ${c.timing.n ? `<div class="cb-sec"><h5>Time to response</h5>
      <table><tr><td class="k">median ${c.timing.median}d · 90th ${c.timing.p90}d · slowest ${c.timing.max}d</td>
      <td class="n">n=${c.timing.n}</td></tr></table></div>` : ''}
    ${sweepHtml}`;
}

document.addEventListener('click', async e => {
  if (e.target.id !== 'thSave') return;
  const r = await (await fetch('/api/threshold', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: Number($('#thVal').value) }),
  })).json();
  if (r.error) return addEvent({ ts: new Date().toISOString(), stage: 'score', level: 'warn', message: r.error });
  refreshCalibration();
});

// --- Rejection criteria editor (opens from the Rejected column) --------------

function critChip(group, e) {
  if (e.source === 'default' && !e.active) {
    return `<span class="crit-chip off" title="switched off — click ＋ to restore">${esc(e.label)}` +
      `<button data-crit="add" data-group="${group}" data-term="${esc(e.term)}" title="restore">＋</button></span>`;
  }
  const cls = e.source === 'custom' ? 'crit-chip custom' : 'crit-chip';
  const title = e.source === 'custom' ? 'your term — remove' : 'switch off';
  return `<span class="${cls}">${esc(e.label)}` +
    `<button data-crit="remove" data-group="${group}" data-term="${esc(e.term)}" title="${title}">×</button></span>`;
}

function critGroup(g) {
  return `<div class="crit-grp" data-group="${g.key}">
    <h4>${esc(g.label)}${g.edited ? ` <button class="crit-reset" data-crit="reset">reset to defaults</button>` : ''}</h4>
    <p>${esc(g.hint)}</p>
    <div class="crit-chips">${g.entries.map(e => critChip(g.key, e)).join('') || '<span class="crit-def">none — this gate is off</span>'}</div>
    <form class="crit-add" data-group="${g.key}">
      <input name="term" placeholder="Add a term…" autocomplete="off">
      <button type="submit">Add</button>
    </form>
  </div>`;
}

async function renderCriteria() {
  const d = await (await fetch('/api/reject-criteria')).json();
  $('#criteriaBody').innerHTML = `
    <h2>Rejection criteria</h2>
    <p class="crit-intro">The gates that move a job to <b>Rejected</b>. Edits apply on the next
      discovery and scoring run — they don't re-judge jobs already on the board.</p>
    <div class="crit-grp">
      <h4>Fit score threshold</h4>
      <p>A scored job below this number is rejected. Everything below runs <em>before</em> scoring, for free.</p>
      <div class="crit-thr">
        <input id="critThr" type="number" min="0" max="100" value="${d.threshold}">
        <button data-crit="threshold">Set</button>
        <span class="crit-def">default ${d.defaultThreshold}</span>
      </div>
    </div>
    ${d.groups.map(critGroup).join('')}`;
}

async function postCriteria(payload) {
  const r = await (await fetch('/api/reject-criteria', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })).json();
  if (r.error) {
    addEvent({ ts: new Date().toISOString(), stage: 'score', level: 'warn', message: r.error });
    return;
  }
  renderCriteria();
}

document.addEventListener('click', e => {
  if (e.target.closest('.colcrit')) { renderCriteria(); $('#criteria').classList.add('open'); return; }
  if (e.target.id === 'criteriaClose') { $('#criteria').classList.remove('open'); return; }

  const btn = e.target.closest('#criteriaBody [data-crit]');
  if (!btn) return;
  const action = btn.dataset.crit;
  if (action === 'threshold') return void postCriteria({ action, value: Number($('#critThr').value) });
  const group = btn.dataset.group || btn.closest('.crit-grp')?.dataset.group;
  if (action === 'reset') return void postCriteria({ action, group });
  postCriteria({ action, group, term: btn.dataset.term });
});

document.addEventListener('submit', e => {
  const f = e.target.closest('.crit-add');
  if (!f) return;
  e.preventDefault();
  const term = f.term.value.trim();
  if (term) postCriteria({ action: 'add', group: f.dataset.group, term });
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

// ---------------------------------------------------------------------------
// Settings drawer. Everything that is set up once and then forgotten.
// ---------------------------------------------------------------------------

function setMsg(where, text, cls = '') {
  const el = $(where);
  if (el) { el.textContent = text; el.className = `msg ${cls}`; }
}

async function renderSettings() {
  const s = await (await fetch('/api/settings')).json();

  const badge = (on, onText, offText) =>
    `<span class="state ${on ? 'on' : 'off'}">${on ? onText : offText}</span>`;

  $('#settingsBody').innerHTML = `
    <h2>Settings</h2>

    <div class="set">
      <h4>OpenAI ${badge(s.openai.openai, `connected ${esc(s.openai.openaiHint || '')}`, 'not set')}</h4>
      <p>Used to score how well each posting fits you, and to draft answers to
         application questions. Without it, scoring falls back to keyword matching,
         which is not a fit judgement — jobs are held rather than ranked.</p>
      <input id="openaiKey" type="password" placeholder="sk-..." autocomplete="off">
      <div class="row">
        <button class="primary" id="openaiSave">Save key</button>
        ${s.openai.openai ? '<button class="quiet" id="openaiClear">Remove</button>' : ''}
      </div>
      <div class="note">Stored in <code>apply-bot/profile/secrets.json</code>, chmod 600, gitignored.
        Sent only to OpenAI.</div>
      <div id="openaiMsg" class="msg"></div>
    </div>

    <div class="set">
      <h4>Gmail ${badge(s.gmail.connected, s.gmail.address ? `as ${esc(s.gmail.address)}` : 'connected', s.gmail.hasCredentials ? 'not connected' : 'not set up')}</h4>
      <p>Some postings ask you to email your CV rather than apply on a site.
         Without this, those are still drafted — they just wait in the outbox
         instead of sending.</p>
      ${s.gmail.connected ? `
        <div class="row"><button class="quiet" id="gmailDisconnect">Disconnect</button></div>
      ` : s.gmail.hasCredentials ? `
        <div class="row"><button class="primary" id="gmailConnect">Connect Gmail</button></div>
        <div class="note">Opens Google's consent screen in a new tab.</div>
      ` : `
        <ol>
          <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a Google Cloud project</a></li>
          <li>Enable the <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a></li>
          <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a> → Create OAuth client ID → <b>Desktop app</b></li>
          <li>Add <code>${esc(s.gmail.redirect)}</code> as an authorised redirect URI</li>
          <li>Download the JSON and paste it below</li>
        </ol>
        <textarea id="gmailCreds" placeholder='{"installed":{"client_id":"...","client_secret":"..."}}'></textarea>
        <div class="row"><button class="primary" id="gmailSaveCreds">Save credentials</button></div>
      `}
      <div id="gmailMsg" class="msg"></div>
    </div>

    <div class="set">
      <h4>Profile ${badge(s.profile.exists && !s.profile.unconfirmed,
        'fully confirmed', s.profile.exists ? `${s.profile.unconfirmed} unconfirmed` : 'missing')}</h4>
      <p>Your facts — the answers applications ask for. Unconfirmed fields are
         invisible to the bot on purpose, so it parks rather than guesses.
         Confirm them in the panel on the right, or edit
         <code>profile/master-profile.json</code>.</p>
    </div>

    <div class="set">
      <h4>Daily caps</h4>
      <p>Per-channel limits, reset at midnight. Only Easy Apply carries LinkedIn
         risk. Edit in <code>src/config.js</code>.</p>
      <div class="note">
        Easy Apply ${s.caps.linkedin_easy} · External ${s.caps.external_ats} ·
        Email ${s.caps.email} · LinkedIn pageviews ${s.caps.linkedin_pageviews}
      </div>
    </div>`;
}

async function openSettings() {
  await renderSettings();
  $('#settings').classList.add('open');
}

document.addEventListener('click', async e => {
  const id = e.target.id;

  if (id === 'settingsBtn' || e.target.closest('#settingsBtn')) return openSettings();
  if (id === 'settingsClose') return $('#settings').classList.remove('open');

  if (id === 'openaiSave') {
    const key = $('#openaiKey').value.trim();
    if (!key) return setMsg('#openaiMsg', 'Paste a key first.', 'err');
    if (!key.startsWith('sk-')) return setMsg('#openaiMsg', 'OpenAI keys start with "sk-".', 'err');
    await fetch('/api/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    await renderSettings();
    setMsg('#openaiMsg', 'Saved. Run "3 · Score fit" again to rank the held jobs.', 'ok');
    refreshBoard();
    return;
  }

  if (id === 'openaiClear') {
    await fetch('/api/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: '' }),
    });
    await renderSettings();
    setMsg('#openaiMsg', 'Key removed.', 'ok');
    refreshBoard();
    return;
  }

  if (id === 'gmailSaveCreds') {
    const credentials = $('#gmailCreds').value.trim();
    if (!credentials) return setMsg('#gmailMsg', 'Paste the JSON you downloaded.', 'err');
    const r = await (await fetch('/api/gmail', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'credentials', credentials }),
    })).json();
    if (r.error) return setMsg('#gmailMsg', r.error, 'err');
    await renderSettings();
    setMsg('#gmailMsg', 'Saved. Now click Connect Gmail.', 'ok');
    return;
  }

  if (id === 'gmailConnect') {
    const r = await (await fetch('/api/gmail', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'connect' }),
    })).json();
    if (r.error) return setMsg('#gmailMsg', r.error, 'err');
    window.open(r.consentUrl, '_blank', 'noopener');
    setMsg('#gmailMsg', 'Grant access in the tab that opened, then come back.', 'ok');
    // The token lands on a local callback, so poll until it shows up.
    for (let i = 0; i < 100; i++) {
      await new Promise(t => setTimeout(t, 3000));
      const s = await (await fetch('/api/settings')).json();
      if (s.gmail.connected) { await renderSettings(); setMsg('#gmailMsg', 'Connected.', 'ok'); refreshBoard(); return; }
    }
    return;
  }

  if (id === 'gmailDisconnect') {
    await fetch('/api/gmail', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disconnect' }),
    });
    await renderSettings();
    setMsg('#gmailMsg', 'Disconnected. Emails will be drafted but not sent.', 'ok');
    refreshBoard();
  }
});

const es = new EventSource('/api/stream');
es.onmessage = m => {
  const e = JSON.parse(m.data);
  if (e.type === 'board') { refreshBoard(); refreshParked(); refreshReview(); refreshOutbox(); refreshSent(); }
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
refreshSearches();
refreshSent();
refreshCalibration();
connectLive();
setInterval(() => { refreshBoard(); refreshParked(); refreshReview(); refreshSent(); }, 15000);
// Calibration moves only when an outcome is marked, and it is the most expensive
// query on the page. Once a minute is more than enough.
setInterval(refreshCalibration, 60000);
// Faster tick so the countdown on a pending send stays honest.
setInterval(refreshOutbox, 5000);
