/* eslint-env browser */
/**
 * public/settings.js — the control room.
 *
 * A single modal with five tabs that covers everything the server can be
 * configured with, from the browser:
 *
 *   Environment  every key in lib/settings.js SCHEMA, validated and written
 *                straight back to the .env file
 *   Tokens       personal access keys (minted, shown once, revocable)
 *   Sessions     every device signed in to this account, revocable one by one
 *   Security     MFA enrolment, CSRF state, the audit trail
 *   Database     table inventory and what the last boot had to migrate
 *
 * It authenticates with the HttpOnly session cookie, so nothing here needs the
 * access token in JS, and it attaches the CSRF double-submit header on every
 * unsafe verb exactly the way lib/token.js expects it.
 */

(() => {
  'use strict';

  /* ================= styles ================= */

  const CSS = `
  .cf-gear {
    display: inline-flex; align-items: center; gap: 7px;
    background: var(--surface-2); color: var(--muted);
    border: 1px solid var(--line); border-radius: 999px;
    padding: 7px 13px; font: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: .15s;
  }
  .cf-gear:hover { color: var(--text); border-color: var(--accent); background: #1a2030; }
  .cf-gear .spin { display: inline-block; }
  .cf-gear:hover .spin { transform: rotate(35deg); transition: transform .35s; }

  .cf-backdrop {
    position: fixed; inset: 0; z-index: 90;
    background: rgba(4,6,10,.72); backdrop-filter: blur(6px);
    display: flex; align-items: stretch; justify-content: center;
    padding: 26px 18px; overflow: auto;
  }
  .cf-panel {
    width: min(1180px, 100%); background: var(--surface);
    border: 1px solid var(--line); border-radius: 18px;
    box-shadow: var(--shadow); display: flex; flex-direction: column;
    max-height: calc(100vh - 52px); overflow: hidden;
  }
  .cf-head {
    display: flex; align-items: center; gap: 14px;
    padding: 16px 20px; border-bottom: 1px solid var(--line); background: var(--surface-2);
  }
  .cf-head h2 { font-size: 15px; font-weight: 680; letter-spacing: .2px; }
  .cf-head p { font-size: 12px; color: var(--muted); }
  .cf-head .grow { flex: 1; }
  .grow { flex: 1; }
  .cf-x {
    background: transparent; border: 1px solid var(--line); color: var(--muted);
    width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 15px;
  }
  .cf-x:hover { color: var(--text); border-color: var(--crit); }

  .cf-tabs { display: flex; gap: 2px; padding: 10px 16px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .cf-tabs button {
    background: transparent; border: 0; border-bottom: 2px solid transparent;
    color: var(--muted); font: inherit; font-size: 13px; font-weight: 600;
    padding: 9px 13px; cursor: pointer;
  }
  .cf-tabs button:hover { color: var(--text); }
  .cf-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }

  .cf-body { padding: 20px; overflow: auto; flex: 1; }
  .cf-foot {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 13px 20px; border-top: 1px solid var(--line); background: var(--surface-2);
    font-size: 12.5px; color: var(--muted);
  }
  .cf-foot .grow { flex: 1; }

  .cf-sect { margin-bottom: 22px; }
  .cf-sect > h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .1em; color: var(--accent); margin-bottom: 3px; }
  .cf-sect > p { font-size: 12.5px; color: var(--muted); margin-bottom: 11px; }

  .cf-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .cf-field {
    background: var(--surface-2); border: 1px solid var(--line);
    border-radius: 11px; padding: 11px 13px; display: flex; flex-direction: column; gap: 7px;
  }
  .cf-field.dirty { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(91,140,255,.25); }
  .cf-field .lab { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 620; }
  .cf-field .lab code { font: 500 10.5px/1.4 var(--mono); color: var(--faint); }
  .cf-field .lab .grow { flex: 1; }
  .cf-field input[type=text], .cf-field input[type=number], .cf-field input[type=password],
  .cf-field select, .cf-field textarea, .cf-input {
    width: 100%; background: #0d1016; color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; font: 500 13px/1.4 var(--mono);
  }
  .cf-field input:focus, .cf-field select:focus, .cf-input:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(91,140,255,.16);
  }
  .cf-field .hint { font-size: 11.5px; color: var(--faint); }
  .cf-field .row { display: flex; gap: 6px; align-items: center; }
  .cf-field .row input { flex: 1; }

  .cf-tag {
    font: 600 9.5px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em;
    padding: 3px 6px; border-radius: 5px; border: 1px solid var(--line); color: var(--faint);
  }
  .cf-tag.file { color: var(--ok); border-color: rgba(52,211,153,.4); }
  .cf-tag.default { color: var(--faint); }
  .cf-tag.restart { color: var(--warn); border-color: rgba(251,191,36,.4); }
  .cf-tag.drift { color: var(--crit); border-color: rgba(248,113,113,.5); }
  .cf-tag.ok { color: var(--ok); border-color: rgba(52,211,153,.4); }
  .cf-tag.warn { color: var(--warn); border-color: rgba(251,191,36,.4); }
  .cf-tag.crit { color: var(--crit); border-color: rgba(248,113,113,.5); }
  .cf-tag.now { color: var(--accent); border-color: rgba(91,140,255,.5); }

  /* ---- AI console ---- */
  .cf-ai-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); margin-bottom: 6px; }
  .cf-provider {
    background: var(--surface-2); border: 1px solid var(--line); border-radius: 11px; padding: 14px;
  }
  .cf-provider.active { border-color: rgba(52,211,153,.4); box-shadow: 0 0 0 1px rgba(52,211,153,.12); }
  .cf-provider.inactive { opacity: .68; }
  .cf-provider .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .cf-provider .head b { font-size: 14px; }
  .cf-provider .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--line-soft); }
  .cf-provider .kv:last-of-type { border-bottom: 0; }
  .cf-provider .kv span:first-child { color: var(--faint); flex: none; }
  .cf-provider .kv span:last-child { font-family: var(--mono); text-align: right; word-break: break-all; }
  .cf-provider .acts { display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap; }
  .cf-chain { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .cf-model-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  .cf-model-table th {
    text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--faint); font-weight: 650; padding: 0 8px 6px 0; white-space: nowrap;
    border-bottom: 1px solid var(--line);
  }
  .cf-model-table td { padding: 7px 8px 7px 0; border-bottom: 1px solid var(--line-soft); font-family: var(--mono); }
  .cf-model-table .cf-num { text-align: right; }
  .cf-model-table tr:last-child td { border-bottom: 0; }
  .cf-model-table tr.dead td { opacity: .5; }
  .cf-model-table td.name { font-family: var(--sans); }
  .cf-model-table td.pick { text-align: right; white-space: nowrap; }
  .cf-model-table td.pick button { padding: 3px 8px; font-size: 11px; }
  .cf-plan { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .cf-planbox { background: var(--surface-2); border: 1px solid var(--line); border-radius: 11px; padding: 13px; }
  .cf-planbox .line { font-size: 12px; color: var(--muted); margin-bottom: 6px; }

  .cf-switch { position: relative; width: 42px; height: 24px; flex: none; }
  .cf-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .cf-switch i {
    position: absolute; inset: 0; background: #0d1016; border: 1px solid var(--line);
    border-radius: 999px; transition: .18s; pointer-events: none;
  }
  .cf-switch i::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    background: var(--faint); border-radius: 50%; transition: .18s;
  }
  .cf-switch input:checked + i { background: rgba(91,140,255,.22); border-color: var(--accent); }
  .cf-switch input:checked + i::after { left: 21px; background: var(--accent); }

  .cf-btn {
    background: var(--accent); color: #06090f; border: 0; border-radius: 8px;
    padding: 8px 15px; font: 650 12.5px var(--sans); cursor: pointer; transition: .15s;
  }
  .cf-btn:hover { filter: brightness(1.1); }
  .cf-btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }
  .cf-btn.ghost { background: var(--surface-2); color: var(--text); border: 1px solid var(--line); }
  .cf-btn.ghost:hover { border-color: var(--accent); }
  .cf-btn.danger { background: transparent; color: var(--crit); border: 1px solid rgba(248,113,113,.45); }
  .cf-btn.danger:hover { background: rgba(248,113,113,.1); }
  .cf-btn.sm { padding: 5px 10px; font-size: 11.5px; }

  .cf-note {
    border: 1px solid var(--line); border-left: 3px solid var(--accent);
    background: rgba(91,140,255,.06); border-radius: 9px;
    padding: 10px 13px; font-size: 12.5px; color: var(--muted); margin-bottom: 16px;
  }
  .cf-note.warn { border-left-color: var(--warn); background: rgba(251,191,36,.07); }
  .cf-note.danger { border-left-color: var(--crit); background: rgba(248,113,113,.07); }

  .cf-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .cf-table th {
    text-align: left; font: 600 10.5px/1.4 var(--sans); text-transform: uppercase;
    letter-spacing: .07em; color: var(--faint); padding: 7px 10px; border-bottom: 1px solid var(--line);
  }
  .cf-table td { padding: 8px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  .cf-table tr:last-child td { border-bottom: 0; }
  .cf-table code, .cf-mono { font: 500 11.5px/1.4 var(--mono); color: var(--muted); }
  .cf-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .cf-scroll { overflow: auto; border: 1px solid var(--line); border-radius: 11px; }

  .cf-kv { display: grid; grid-template-columns: 190px 1fr; gap: 6px 14px; font-size: 12.5px; }
  .cf-kv dt { color: var(--faint); }
  .cf-kv dd { margin: 0; font: 500 12.5px var(--mono); color: var(--text); word-break: break-all; }

  .cf-secret-out {
    background: #0d1016; border: 1px dashed var(--ok); border-radius: 10px;
    padding: 12px 14px; font: 600 13px/1.6 var(--mono); color: var(--ok);
    word-break: break-all; margin: 10px 0;
  }
  .cf-chips { display: flex; gap: 7px; flex-wrap: wrap; margin: 10px 0; }
  .cf-chip {
    border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px;
    font-size: 12px; cursor: pointer; background: var(--surface-2); color: var(--muted);
  }
  .cf-chip[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: rgba(91,140,255,.14); }
  .cf-stack { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
  .cf-loading { padding: 34px; text-align: center; color: var(--faint); font-size: 13px; }
  .cf-empty { padding: 22px; text-align: center; color: var(--faint); font-size: 12.5px; }
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ================= helpers ================= */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const num = (n) => Number(n || 0).toLocaleString('en-IN');

  const ago = (value) => {
    if (!value) return '—';
    const then = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
    if (Number.isNaN(then.getTime())) return '—';
    const s = Math.max(0, (Date.now() - then.getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const inDays = (seconds) => {
    const d = Math.round((Number(seconds) || 0) / 86400);
    return d >= 30 ? `${Math.round(d / 30)} mo` : `${d} d`;
  };

  const state = {
    open: false,
    tab: 'env',
    session: null,
    csrf: null,
    system: null,
    settings: null,
    dirty: new Map(),
    reveal: new Set(),
    lastError: null,
  };

  /**
   * Every request goes out with the session cookie, and unsafe verbs carry the
   * CSRF token the server handed us at /api/auth/session.
   */
  async function call(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const method = (opts.method || 'GET').toUpperCase();
    if (state.csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['x-csrf-token'] = state.csrf;
    }

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }

    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function flash(message, kind = '') {
    const el = $('#cf-flash');
    if (!el) return;
    el.className = `cf-note ${kind}`;
    el.style.display = message ? 'block' : 'none';
    el.innerHTML = message ? esc(message) : '';
  }

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  };

  /* ================= shell ================= */

  const TABS = [
    { id: 'env', label: 'Environment', accountOnly: true },
    { id: 'ai', label: 'AI providers', accountOnly: true },
    { id: 'tokens', label: 'Tokens', accountOnly: false },
    { id: 'sessions', label: 'Sessions', accountOnly: false },
    { id: 'security', label: 'Security', accountOnly: false },
    { id: 'data', label: 'Database', accountOnly: true },
  ];

  function shell() {
    const backdrop = document.createElement('div');
    backdrop.className = 'cf-backdrop';
    backdrop.id = 'cf-backdrop';
    backdrop.innerHTML = `
      <div class="cf-panel" role="dialog" aria-modal="true" aria-label="CampusFlow control room">
        <div class="cf-head">
          <div>
            <h2>Control room</h2>
            <p id="cf-subtitle">Environment, credentials and data</p>
          </div>
          <div class="grow"></div>
          <button class="cf-x" id="cf-close" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <div class="cf-tabs" id="cf-tabs" role="tablist"></div>
        <div style="padding:16px 20px 0"><div class="cf-note" id="cf-flash" style="display:none;margin:0"></div></div>
        <div class="cf-body" id="cf-body"><div class="cf-loading">loading…</div></div>
        <div class="cf-foot" id="cf-foot"></div>
      </div>`;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('#cf-close', backdrop).addEventListener('click', close);
    return backdrop;
  }

  function renderTabs() {
    const isAccountant = state.session?.user?.role === 'ACCOUNTANT';
    $('#cf-tabs').innerHTML = TABS
      .filter((t) => isAccountant || !t.accountOnly)
      .map((t) => `<button type="button" role="tab" data-tab="${t.id}"
        aria-selected="${state.tab === t.id}">${t.label}</button>`)
      .join('');

    $$('#cf-tabs button').forEach((b) => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      renderTabs();
      loadTab();
    }));
  }

  function renderFoot() {
    const foot = $('#cf-foot');
    const changes = state.dirty.size;

    if (state.tab === 'env' && state.settings) {
      foot.innerHTML = `
        <span>${changes
          ? `<b style="color:var(--accent)">${changes}</b> unsaved change${changes === 1 ? '' : 's'}`
          : 'No unsaved changes'}</span>
        <span class="grow"></span>
        <button class="cf-btn ghost sm" id="cf-raw">View .env</button>
        <button class="cf-btn ghost sm" id="cf-discard" ${changes ? '' : 'disabled'}>Discard</button>
        <button class="cf-btn" id="cf-save" ${changes ? '' : 'disabled'}>Save to .env</button>`;

      const save = $('#cf-save');
      if (save) save.addEventListener('click', saveEnv);
      const discard = $('#cf-discard');
      if (discard) discard.addEventListener('click', () => { state.dirty.clear(); loadTab(); });
      $('#cf-raw').addEventListener('click', showRawEnv);
      return;
    }

    if (state.tab === 'ai') {
      foot.innerHTML = `
        <span>${changes
          ? `<b style="color:var(--accent)">${changes}</b> unsaved change${changes === 1 ? '' : 's'}`
          : 'Routing keys apply on save'}</span>
        <span class="grow"></span>
        <button class="cf-btn ghost sm" id="cf-discard" ${changes ? '' : 'disabled'}>Discard</button>
        <button class="cf-btn" id="cf-save" ${changes ? '' : 'disabled'}>Apply</button>`;
      const save = $('#cf-save');
      if (save) save.addEventListener('click', saveEnv);
      const discard = $('#cf-discard');
      if (discard) discard.addEventListener('click', () => { state.dirty.clear(); renderAi(); });
      return;
    }

    foot.innerHTML = `<span id="cf-foot-note"></span><span class="grow"></span>`;
  }

  /* ================= tab: environment ================= */

  function fieldMarkup(item) {
    const value = state.dirty.has(item.key) ? state.dirty.get(item.key) : item.value;
    const dirty = state.dirty.has(item.key) ? ' dirty' : '';
    const tags = [
      `<span class="cf-tag ${item.source}">${item.source}</span>`,
      item.restart ? '<span class="cf-tag restart" title="Read at boot — needs a restart">restart</span>' : '',
      item.drift ? '<span class="cf-tag drift" title="Ambient variable overrides the file">override</span>' : '',
      item.type === 'secret' && item.configured ? '<span class="cf-tag ok">set</span>' : '',
    ].join('');

    let control;
    if (item.type === 'bool') {
      control = `<label class="cf-switch"><input type="checkbox" data-key="${esc(item.key)}"
        ${String(value) === 'true' ? 'checked' : ''}><i></i></label>`;
    } else if (item.type === 'enum') {
      control = `<select data-key="${esc(item.key)}">${(item.options || []).map((o) =>
        `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (item.type === 'secret') {
      const shown = state.reveal.has(item.key);
      control = `<div class="row">
        <input type="${shown ? 'text' : 'password'}" data-key="${esc(item.key)}"
          value="${esc(state.dirty.get(item.key) || '')}"
          placeholder="${esc(item.configured ? item.display + ' — type to replace' : 'not set')}">
        <button class="cf-btn ghost sm" data-act="reveal" data-key="${esc(item.key)}">${shown ? 'Hide' : 'Show'}</button>
        ${item.configured ? `<button class="cf-btn danger sm" data-act="clear" data-key="${esc(item.key)}">Clear</button>` : ''}
      </div>`;
    } else {
      control = `<input type="${item.type === 'int' || item.type === 'float' ? 'number' : 'text'}"
        data-key="${esc(item.key)}" value="${esc(value)}" ${item.min !== null ? `min="${item.min}"` : ''}
        ${item.max !== null ? `max="${item.max}"` : ''}>`;
    }

    return `<div class="cf-field${dirty}" data-field="${esc(item.key)}">
      <div class="lab"><span>${esc(item.label)}</span><span class="grow"></span>${tags}</div>
      ${control}
      <code style="font:500 10px/1.4 var(--mono);color:var(--faint)">${esc(item.key)}</code>
      ${item.hint ? `<div class="hint">${esc(item.hint)}</div>` : ''}
    </div>`;
  }

  async function renderEnv() {
    const data = await call('/api/settings');
    state.settings = data;

    const banner = `
      <div class="cf-note">
        <b>${esc(data.file.path)}</b> — ${data.file.keys} keys, ${num(data.file.bytes)} bytes.
        Secrets are masked here and never sent to the browser; leave the field blank to keep the current value.
        Values are validated against the schema in <code>lib/settings.js</code> before anything is written.
      </div>
      ${data.unknown.length ? `<div class="cf-note warn">${data.unknown.length} key(s) in the file are not in the schema and are preserved verbatim: ${data.unknown.map(esc).join(', ')}</div>` : ''}
      ${data.restartRequired ? '<div class="cf-note warn">The file and the running process disagree on at least one boot-time value. Restart to settle it.</div>' : ''}`;

    const sections = data.sections.map((s) => `
      <section class="cf-sect">
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.blurb)}</p>
        <div class="cf-grid">${s.items.map(fieldMarkup).join('')}</div>
      </section>`).join('');

    $('#cf-body').innerHTML = banner + sections;
    renderFoot();
  }

  /* ================= tab: AI providers ================= */

  const ORDER_OPTIONS = [
    ['auto', 'Auto — fastest healthy provider first'],
    ['gemini-first', 'Gemini first, Zen as fallback'],
    ['zen-first', 'OpenCode Zen first, Gemini as fallback'],
    ['gemini-only', 'Gemini only'],
    ['zen-only', 'OpenCode Zen only'],
  ];

  const ORDER_KEY = 'AI_PROVIDER_ORDER';
  const CHAIN_KEY = 'AI_MODEL_CHAIN';


  function kv(label, value) {
    return `<div class="kv"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  }

  function providerCard(p) {
    const cat = p.catalogue || {};
    const chains = p.chains || {};

    const transports = Array.isArray(p.transports) && p.transports.length
      ? `<div style="margin-top:9px"><div class="cf-tag default" style="margin-bottom:5px">transports</div>
         <div class="cf-chain">${p.transports.map((t) => `<span class="cf-tag now">${esc(t)}</span>`).join('')}</div></div>`
      : '';

    const dead = (p.deadModels || []).length
      ? `<div style="margin-top:9px"><div class="cf-tag crit" style="margin-bottom:5px">quarantined (${p.deadModels.length})</div>
         <div class="cf-chain">${p.deadModels.map((m) => `<span class="cf-tag crit">${esc(m)}</span>`).join('')}</div></div>`
      : '';

    const cooldown = p.cooldown
      ? `<div class="cf-note warn" style="margin:9px 0 0">Cooling down until ${esc(new Date(p.cooldown.until).toLocaleTimeString())} — ${esc(p.cooldown.reason || 'recent failure')}</div>`
      : '';

    return `<div class="cf-provider ${p.active ? 'active' : 'inactive'}">
      <div class="head">
        <b>${esc(p.label)}</b>
        <span class="cf-tag ${p.active ? 'ok' : 'default'}">${p.active ? 'in rotation' : 'idle'}</span>
        <span class="grow"></span>
        <code style="font:500 10.5px/1.4 var(--mono);color:var(--faint)">${esc(p.id)}</code>
      </div>
      ${kv('key', p.key || 'not set')}
      ${kv('endpoint', p.endpoint)}
      ${kv('catalogue', cat.discovered
        ? cat.count + ' model' + (cat.count === 1 ? '' : 's') + ' · ' + ago(cat.discoveredAt)
        : cat.ok ? 'seed list only' : 'discovery failed' + (cat.error ? ' — ' + cat.error : ''))}
      ${kv('dead models', (p.deadModels || []).length)}
      <div style="margin-top:10px">
        <div class="cf-tag default">fast chain</div>
        <div class="cf-chain">${(chains.fast || []).length
          ? chains.fast.map((m) => `<span class="cf-tag now">${esc(m)}</span>`).join('')
          : '<span class="faint" style="font-size:11.5px">empty</span>'}</div>
        <div class="cf-tag default" style="margin-top:8px">deep chain</div>
        <div class="cf-chain">${(chains.deep || []).length
          ? chains.deep.map((m) => `<span class="cf-tag now">${esc(m)}</span>`).join('')
          : '<span class="faint" style="font-size:11.5px">empty</span>'}</div>
      </div>
      ${transports}${dead}${cooldown}
      <div class="acts">
        <button class="cf-btn sm" data-ai-act="probe" data-provider="${esc(p.id)}">Probe key</button>
        <button class="cf-btn ghost sm" data-ai-act="refresh">Refresh catalogues</button>
        <button class="cf-btn ghost sm" data-ai-act="only" data-provider="${esc(p.id)}"
          ${p.active ? '' : 'disabled'}>Use only</button>
      </div>
      <div class="cf-probe-out" data-probe="${esc(p.id)}"></div>
    </div>`;
  }

  function modelTable(r) {
    const models = r.models || [];
    if (!models.length) {
      return '<div class="cf-note">No models discovered. Paste a key in Environment, then refresh the catalogues.</div>';
    }

    const pinned = new Set(r.pinned || []);
    return `<table class="cf-model-table">
      <thead><tr><th>Model</th><th>Provider</th><th class="cf-num">Fast</th><th class="cf-num">Deep</th>
        <th>Route</th><th class="pick">Pin first</th></tr></thead>
      <tbody>${models.slice(0, 60).map((m) => {
        const id = `${m.provider}:${m.model}`;
        return `<tr class="${m.dead ? 'dead' : ''}">
          <td class="name">${esc(m.model)}${m.free ? ' <span class="cf-tag ok">free</span>' : ''}${m.dead ? ' <span class="cf-tag crit">down</span>' : ''}</td>
          <td>${esc(m.provider)}</td>
          <td class="cf-num">${m.fast ?? '—'}</td>
          <td class="cf-num">${m.deep ?? '—'}</td>
          <td>${esc(m.route)}</td>
          <td class="pick"><button class="cf-btn ghost sm" data-ai-act="pin" data-model="${esc(id)}"
            ${m.dead ? 'disabled' : ''}>${pinned.has(id) ? 'unpin' : 'pin'}</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>${models.length > 60 ? `<div class="faint" style="font-size:11.5px;margin-top:6px">showing top 60 of ${models.length}</div>` : ''}`;
  }

  async function renderAi() {
    const [r, env] = await Promise.all([
      call('/api/ai/providers'),
      // The chain field is restart-flagged, so the running process keeps serving
      // the old value and the provider report cannot be the source of truth for
      // it. Read what was actually written to .env, and compare against the live
      // value so "saved but not yet live" is visible rather than looking lost.
      call('/api/settings'),
    ]);

    const envItem = (key) => env.sections.flatMap((s) => s.items).find((i) => i.key === key) || null;
    // Refresh the cached schema from this same response. Without it the AI tab
    // keeps comparing against whatever the panel showed when it was opened, so
    // after a save the *next* change back to that earlier value is mistaken for
    // "unchanged" and Apply stays disabled — a value you can only set once per
    // page load.
    state.settings = env;
    const chainItem = envItem(CHAIN_KEY);
    const savedChain = chainItem
      ? String(chainItem.fileValue ?? chainItem.value ?? '')
      : '';
    const liveChain = (r.pinned || []).join(',');
    const chainPending = savedChain !== liveChain;

    const order = r.order || 'auto';
    const orderValue = state.dirty.has(ORDER_KEY) ? state.dirty.get(ORDER_KEY) : order;

    const planLine = (label, list) => `<div>
      <div class="cf-tag default">${esc(label)}</div>
      <div class="cf-chain">${(list || []).map((m) => `<span class="cf-tag now">${esc(m)}</span>`).join('')
        || '<span class="faint" style="font-size:11.5px">empty</span>'}</div></div>`;

    const chainValue = state.dirty.has(CHAIN_KEY) ? state.dirty.get(CHAIN_KEY) : savedChain;

    $('#cf-body').innerHTML = `
      ${r.providers.length ? '' : `<div class="cf-note warn">No provider key is set. Every AI feature is running the
        deterministic offline analysis — set <code>GEMINI_API_KEY</code> or <code>OPENCODE_ZEN_API_KEY</code> in Environment to go live.</div>`}
      ${(r.notes || []).map((n) => `<div class="cf-note">${esc(n)}</div>`).join('')}

      <section class="cf-sect">
        <h3>Routing order</h3>
        <p>Which provider answers first. Changes apply to the running process immediately — no restart.</p>
        <div class="cf-field" data-field="${ORDER_KEY}">
          <div class="lab"><span>Provider order</span><span class="grow"></span>
            <span class="cf-tag ${orderValue === order ? 'ok' : 'now'}">${orderValue === order ? 'active' : 'unsaved'}</span></div>
          <select data-key="${ORDER_KEY}">${ORDER_OPTIONS.map(([v, label]) =>
            `<option value="${esc(v)}" ${v === orderValue ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
          <div class="hint">Primary is <b>${esc(r.primary)}</b>. Timeout ${num(r.timeoutMs)}ms, cache TTL ${num(r.cacheTtlMs)}ms.</div>
        </div>
      </section>

      <section class="cf-sect">
        <h3>Live plan</h3>
        <p>What the router will actually call, in order, when an analysis runs.</p>
        <div class="cf-plan">
          <div class="cf-planbox"><div class="line">Fast tier — dashboards and chips</div>${planLine('order', r.plan?.fast)}</div>
          <div class="cf-planbox"><div class="line">Deep tier — diagnosis and forecasts</div>${planLine('order', r.plan?.deep)}</div>
        </div>
      </section>

      ${r.providers.length ? `<section class="cf-sect">
        <h3>Providers</h3>
        <p>Each configured key, its discovered catalogue, and the ranked chains it feeds the router.</p>
        <div class="cf-ai-cards">${r.providers.map(providerCard).join('')}</div>
      </section>` : ''}

      <section class="cf-sect">
        <h3>Model browser</h3>
        <p>Ranked by tier score. Pinning a model puts it at the head of the chain for its provider and overrides the ranking.</p>
        <div class="cf-field" data-field="${CHAIN_KEY}" style="margin-bottom:12px">
          <div class="lab"><span>Pinned chain</span><span class="grow"></span>
            ${chainPending
              ? '<span class="cf-tag warn" title="Saved to .env — the running process still uses the previous chain">restart to apply</span>'
              : `<span class="cf-tag ${savedChain ? 'ok' : 'default'}">${savedChain ? 'pinned' : 'auto'}</span>`}</div>
          <input type="text" data-key="${CHAIN_KEY}" value="${esc(chainValue)}"
            placeholder="zen:model-a,gemini:model-b — blank means let the ranking decide">
          <div class="hint">Comma-separated <code>provider:model</code> pairs. Written to .env; a restart makes it live
            ${chainItem?.drift ? ' — <b>this differs from what the process is running</b>' : ''}.</div>
        </div>
        ${modelTable(r)}
      </section>`;

    renderFoot();
  }

  async function onAiAction(e) {
    const btn = e.target.closest('[data-ai-act]');
    if (!btn) return;
    const act = btn.dataset.aiAct;
    const provider = btn.dataset.provider;

    if (act === 'refresh') {
      btn.disabled = true;
      btn.textContent = 'Discovering…';
      try {
        await call('/api/ai/providers?refresh=1');
        flash('Catalogues re-discovered from both providers.', 'ok');
        await renderAi();
      } catch (err) {
        flash(err.message, 'danger');
        btn.disabled = false;
        btn.textContent = 'Refresh catalogues';
      }
      return;
    }

    if (act === 'only') {
      const key = provider === 'zen' ? 'zen-only' : 'gemini-only';
      await saveSettings([{ key: ORDER_KEY, value: key }]);
      return;
    }

    if (act === 'probe') {
      const out = $(`.cf-probe-out[data-probe="${provider}"]`);
      btn.disabled = true;
      btn.textContent = 'Probing…';
      if (out) out.innerHTML = '<div class="cf-note" style="margin:9px 0 0">Sending one tiny request…</div>';
      try {
        const res = await call('/api/ai/probe', {
          method: 'POST',
          body: { provider },
        });
        // The endpoint returns { probes: [{model, ok, latencyMs, error}] }, one
        // entry per model it actually tried — not a single top-level result.
        const tried = res.probes || [];
        const worked = tried.filter((p) => p.ok);
        const failed = tried.filter((p) => !p.ok).slice(0, 3);
        // Provider errors arrive as raw JSON envelopes. An operator wants the
        // reason, not a wall of payload, so pull out the message and cap it.
        const reason = (err) => {
          const s = String(err || 'failed');
          const m = s.match(/"message"\s*:\s*"([^"]+)"/);
          const text = m ? m[1] : s.replace(/\s+/g, ' ');
          return text.length > 90 ? `${text.slice(0, 90)}…` : text;
        };
        const verdict = worked.length
          ? `<b>${worked.length} of ${tried.length}</b> models answered. Best: ${esc(worked[0].model)}`
            + ` in ${num(worked[0].latencyMs)}ms${worked[0].route ? ` via ${esc(worked[0].route)}` : ''}`
          : `Nothing answered${tried.length ? '' : ' — no models in the catalogue'}.`;
        const faults = failed
          .map((p) => `<br><span class="faint">${esc(p.model)}: ${esc(reason(p.error))}</span>`)
          .join('');

        if (out) {
          out.innerHTML = `<div class="cf-note ${worked.length ? 'ok' : 'danger'}" style="margin:9px 0 0">
            ${verdict}${faults}</div>`;
        }
        flash(worked.length
          ? `${provider} key works — ${worked.length}/${tried.length} models answered.`
          : `${provider} key did not answer.`, worked.length ? 'ok' : 'danger');
      } catch (err) {
        if (out) out.innerHTML = `<div class="cf-note danger" style="margin:9px 0 0">${esc(err.message)}</div>`;
        flash(`${provider} probe failed: ${err.message}`, 'danger');
      }
      btn.disabled = false;
      btn.textContent = 'Probe key';
      return;
    }

    if (act === 'pin') {
      const id = btn.dataset.model;
      // Start from what the field actually holds right now, so a hand-typed
      // chain or an earlier pin is never silently dropped by this click.
      const field = $('[data-key="AI_MODEL_CHAIN"]');
      const base = field && field.value.trim()
        ? field.value.split(',').map((s) => s.trim()).filter(Boolean)
        : [...(state.aiPinned || [])];
      const pinned = new Set(base);
      if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
      state.aiPinned = [...pinned];
      const value = state.aiPinned.join(',');
      state.dirty.set(CHAIN_KEY, value);
      if (field) field.value = value;
      await saveSettings([{ key: CHAIN_KEY, value }]);
    }
  }

  function onEnvInput(e) {
    const key = e.target.dataset.key;
    if (!key) return;
    // The AI tab has no loaded schema for its two routing keys, so track the
    // raw control value instead of looking it up in the environment items.
    const item = state.settings?.sections.flatMap((s) => s.items).find((i) => i.key === key);

    let value;
    if (item && item.type === 'bool') value = String(e.target.checked);
    else value = e.target.value;

    if (item) {
      const original = state.dirty.has(key) ? undefined : item.value;
      const base = original === undefined ? state.dirty.get(key) : item.value;
      if (String(base) === String(value)) state.dirty.delete(key);
      else state.dirty.set(key, value);
    } else {
      state.dirty.set(key, value);
    }

    e.target.closest('.cf-field')?.classList.toggle('dirty', state.dirty.has(key));
    renderFoot();
  }

  async function onEnvAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.act === 'reveal') {
      if (state.reveal.has(key)) state.reveal.delete(key);
      else state.reveal.add(key);
      loadTab();
    } else if (btn.dataset.act === 'clear') {
      state.dirty.set(key, '');
      loadTab();
    }
  }

  async function saveEnv() {
    const updates = [...state.dirty.entries()].map(([key, value]) => ({ key, value }));
    if (!updates.length) return;
    const btn = $('#cf-save');
    btn.disabled = true;
    try {
      const result = await call('/api/settings', { method: 'PUT', body: { updates } });
      state.dirty.clear();
      // loadTab() clears the flash as it starts, so the confirmation is written
      // after it — otherwise a successful save reports nothing at all.
      await loadTab();
      flash(`${result.message} Applied: ${result.applied.join(', ')}`, result.restartRequired ? 'warn' : 'ok');
    } catch (err) {
      flash(err.message, 'danger');
      btn.disabled = false;
    }
  }

  async function saveSettings(updates) {
    try {
      const result = await call('/api/settings', { method: 'PUT', body: { updates } });
      state.dirty.clear();
      await renderAi();
      flash(`${result.message} Applied: ${result.applied.join(', ')}`, result.restartRequired ? 'warn' : 'ok');
    } catch (err) {
      flash(err.message, 'danger');
    }
  }

  async function showRawEnv() {
    try {
      const data = await call('/api/settings/raw');
      flash('');
      $('#cf-body').innerHTML = `
        <div class="cf-note warn">This is the literal contents of <b>${esc(data.path)}</b> — including secrets. Treat it like a password.</div>
        <textarea class="cf-input" style="min-height:420px;font:500 12px/1.6 var(--mono);white-space:pre" readonly>${esc(data.text)}</textarea>
        <div class="cf-stack" style="margin-top:12px">
          <button class="cf-btn" id="cf-copy-raw">Copy to clipboard</button>
          <button class="cf-btn ghost" id="cf-back">Back to editor</button>
        </div>`;
      $('#cf-copy-raw').addEventListener('click', async () => {
        await copy(data.text);
        flash('Copied.', '');
      });
      $('#cf-back').addEventListener('click', loadTab);
      $('#cf-foot').innerHTML = '<span class="grow"></span>';
    } catch (err) {
      flash(err.message, 'danger');
    }
  }

  /* ================= tab: tokens ================= */

  /**
   * The one-and-only display of a freshly minted key. Kept as a function so
   * the reveal survives the list re-render that follows creation — rendering
   * the table again must not blank the value the user has not copied yet.
   */
  function keyReveal(result) {
    return `
      <div class="cf-note warn">${esc(result.warning)}</div>
      <div class="cf-secret-out">${esc(result.key.key)}</div>
      <div class="cf-stack">
        <button class="cf-btn" id="cf-key-copy">Copy key</button>
        <code>scopes: ${esc(result.key.scopes.join(', '))} · expires: ${result.key.expiresAt ? esc(result.key.expiresAt) : 'never'}</code>
      </div>`;
  }

  async function renderTokens(issued = null) {
    const data = await call('/api/auth/api-keys');
    const prefix = data.prefix;

    const rows = data.keys.length ? data.keys.map((k) => `
      <tr>
        <td><b>${esc(k.name)}</b><br><code>${esc(k.prefix)}…</code></td>
        <td>${k.scopes.map((s) => `<span class="cf-tag">${esc(s)}</span>`).join(' ')}</td>
        <td>${esc(ago(k.createdAt))}</td>
        <td>${k.lastUsedAt ? esc(ago(k.lastUsedAt)) : '<span style="color:var(--faint)">never</span>'}</td>
        <td>${k.expiresAt ? esc(ago(k.expiresAt)) : 'never'}</td>
        <td><span class="cf-tag ${k.status === 'active' ? 'ok' : 'crit'}">${esc(k.status)}</span></td>
        <td class="num"><button class="cf-btn danger sm" data-revoke="${esc(k.id)}">Revoke</button></td>
      </tr>`).join('')
      : `<tr><td colspan="7" class="cf-empty">No personal access keys yet.</td></tr>`;

    $('#cf-body').innerHTML = `
      <div class="cf-note">
        An access token proves who you are but cannot be withdrawn. An <b>API key</b> can: create one, hand it to a
        script or a CI job, and revoke it the moment it leaks. Keys begin <code>${esc(prefix)}_</code>,
        are stored only as a SHA-256 digest, and the full value is shown exactly once — at creation.
      </div>

      <section class="cf-sect">
        <h3>Create a key</h3>
        <p>Grant the narrowest scope that does the job.</p>
        <div class="cf-field">
          <div class="lab"><span>Name</span></div>
          <input class="cf-input" type="text" id="cf-key-name" placeholder="e.g. nightly-reconciliation">
          <div class="chips" id="cf-key-scopes">
            ${data.scopes.map((s, i) => `<button type="button" class="cf-chip" data-scope="${esc(s)}"
              aria-pressed="${i < 2}">${esc(s)}</button>`).join('')}
          </div>
          <div class="cf-stack">
            <select class="cf-input" id="cf-key-ttl" style="max-width:220px">
              <option value="0">Never expires</option>
              <option value="604800">7 days</option>
              <option value="2592000">30 days</option>
              <option value="7776000">90 days</option>
            </select>
            <button class="cf-btn" id="cf-key-create">Create key</button>
          </div>
        </div>
        <div id="cf-key-out">${issued ? keyReveal(issued) : ''}</div>
      </section>

      <section class="cf-sect">
        <h3>Your keys</h3>
        <div class="cf-scroll">
          <table class="cf-table">
            <thead><tr><th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;

    $$('#cf-key-scopes .cf-chip').forEach((chip) => chip.addEventListener('click', () => {
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
    }));

    $('#cf-key-create').addEventListener('click', async () => {
      const name = $('#cf-key-name').value.trim();
      if (!name) return flash('Give the key a name so you can recognise it later.', 'warn');
      const scopes = $$('#cf-key-scopes .cf-chip[aria-pressed="true"]').map((c) => c.dataset.scope);
      const btn = $('#cf-key-create');
      btn.disabled = true;
      try {
        const result = await call('/api/auth/api-keys', {
          method: 'POST',
          body: { name, scopes, ttlSeconds: Number($('#cf-key-ttl').value) },
        });
        await renderTokens(result);
        $('#cf-key-copy').addEventListener('click', async () => {
          await copy(result.key.key);
          flash('Key copied. It will not be shown again.', '');
        });
      } catch (err) {
        flash(err.message, 'danger');
        btn.disabled = false;
      }
    });

    $$('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await call(`/api/auth/api-keys/${btn.dataset.revoke}`, { method: 'DELETE' });
        flash('Key revoked. Anything still using it fails on the next request.', '');
        await renderTokens();
      } catch (err) {
        flash(err.message, 'danger');
      }
    }));

    renderFoot();
    $('#cf-foot').innerHTML = '<span>Send it as <code>Authorization: Bearer &lt;key&gt;</code> — it works on every authenticated route.</span><span class="grow"></span>';
  }

  /* ================= tab: sessions ================= */

  async function renderSessions() {
    const data = await call('/api/auth/sessions');
    const s = state.session;

    const rows = data.sessions.length ? data.sessions.map((x) => `
      <tr>
        <td>${esc((x.userAgent || 'unknown device').slice(0, 58))}
          ${x.current ? '<span class="cf-tag now">this device</span>' : ''}</td>
        <td><code>${esc(x.ip || '—')}</code></td>
        <td>${esc(ago(x.createdAt))}</td>
        <td>${esc(ago(x.lastSeenAt))}</td>
        <td>${esc(ago(x.expiresAt))}</td>
        <td class="num">${x.current ? '' : `<button class="cf-btn danger sm" data-revoke="${esc(x.id)}">Revoke</button>`}</td>
      </tr>`).join('')
      : `<tr><td colspan="6" class="cf-empty">No live sessions.</td></tr>`;

    $('#cf-body').innerHTML = `
      <div class="cf-note">
        Signed in as <b>${esc(s?.user?.name || '')}</b> (${esc(s?.user?.role || '')}) via
        <b>${esc(s?.via || '')}</b> over the <b>${esc(s?.transport || '')}</b> transport.
        Access tokens last ${inDays(state.system?.security?.token?.ttlSeconds ?? 28800)};
        the refresh cookie behind them lasts ${inDays(state.system?.security?.token?.refreshTtlSeconds ?? 1209600)}.
      </div>

      <div class="cf-stack" style="margin-bottom:16px">
        <button class="cf-btn ghost" id="cf-revoke-others">Sign out other devices</button>
        <button class="cf-btn danger" id="cf-logout-all">Sign out everywhere</button>
      </div>

      <section class="cf-sect">
        <h3>Active sessions</h3>
        <div class="cf-scroll">
          <table class="cf-table">
            <thead><tr><th>Device</th><th>IP</th><th>Started</th><th>Last seen</th><th>Expires</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>

      <section class="cf-sect">
        <h3>How this session is held</h3>
        <dl class="cf-kv">
          <dt>Access token</dt><dd>aes-256-gcm · ${esc(state.system?.security?.token?.ttlSeconds ?? '—')}s · issuer ${esc(state.system?.security?.token?.issuer ?? '—')}</dd>
          <dt>Cookies</dt><dd>${esc(s?.cookies?.session || '—')} (session) · ${esc(s?.cookies?.refresh || '—')} (refresh) · HttpOnly · SameSite=${esc(state.system?.security?.token?.cookieSameSite ?? '—')}${state.system?.security?.token?.cookieSecure ? ' · Secure' : ''}</dd>
          <dt>CSRF</dt><dd>${state.system?.security?.csrf?.enabled ? `double-submit via <code>${esc(state.system.security.csrf.header)}</code>` : 'disabled'}</dd>
          <dt>Session id</dt><dd>${esc(s?.sessionId || '—')}</dd>
          <dt>Expires</dt><dd>${esc(ago(s?.expiresAt))}</dd>
        </dl>
      </section>`;

    $$('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await call(`/api/auth/sessions/${btn.dataset.revoke}`, { method: 'DELETE' });
        flash('Session revoked.', '');
        await renderSessions();
      } catch (err) {
        flash(err.message, 'danger');
      }
    }));

    $('#cf-revoke-others').addEventListener('click', async () => {
      try {
        const r = await call('/api/auth/sessions/revoke-others', { method: 'POST' });
        flash(`${r.revoked} other session(s) signed out.`, '');
        await renderSessions();
      } catch (err) { flash(err.message, 'danger'); }
    });

    $('#cf-logout-all').addEventListener('click', async () => {
      try {
        await call('/api/auth/logout-all', { method: 'POST' });
        close();
        document.dispatchEvent(new CustomEvent('cf:signed-out'));
      } catch (err) { flash(err.message, 'danger'); }
    });

    renderFoot();
  }

  /* ================= tab: security ================= */

  async function renderSecurity() {
    const [mfa, audit] = await Promise.all([
      call('/api/auth/mfa'),
      call('/api/auth/audit?limit=40'),
    ]);
    const sys = state.system;
    const cfg = sys?.auth?.config || {};
    const tok = sys?.security?.token || {};

    const events = audit.events.length ? audit.events.map((e) => `
      <tr>
        <td><code>${esc(ago(e.at))}</code></td>
        <td>${esc(e.action)}</td>
        <td>${esc(e.actor || '—')}</td>
        <td><span class="cf-tag ${e.outcome === 'ok' ? 'ok' : (e.outcome === 'denied' ? 'crit' : 'warn')}">${esc(e.outcome)}</span></td>
        <td><code>${esc(e.target || e.ip || '—')}</code></td>
      </tr>`).join('')
      : `<tr><td colspan="5" class="cf-empty">No security events recorded yet.</td></tr>`;

    $('#cf-body').innerHTML = `
      <section class="cf-sect">
        <h3>Multi-factor authentication</h3>
        <p>A second factor on top of the password, checked with a TOTP from any authenticator app.</p>
        <div class="cf-field">
          <div class="lab">
            <span>Status</span><span class="grow"></span>
            <span class="cf-tag ${mfa.enabled ? 'ok' : 'warn'}">${mfa.enabled ? 'enabled' : (mfa.enrolled ? 'pending confirmation' : 'off')}</span>
            ${mfa.requiredByPolicy ? '<span class="cf-tag crit">required by policy</span>' : ''}
          </div>
          <div class="hint">${mfa.digits} digits · ${mfa.stepSeconds}s step · SHA-1 HMAC (RFC 6238) · issuer ${esc(mfa.issuer || 'CampusFlow')}</div>
          <div class="cf-stack">
            ${mfa.enabled
              ? '<button class="cf-btn danger" id="cf-mfa-off">Turn MFA off</button>'
              : '<button class="cf-btn" id="cf-mfa-on">Set up MFA</button>'}
          </div>
          <div id="cf-mfa-out"></div>
        </div>
      </section>

      <section class="cf-sect">
        <h3>Posture</h3>
        <dl class="cf-kv">
          <dt>Password hashing</dt><dd>scrypt N=${(sys?.security?.password?.N) ?? 16384} r=${(sys?.security?.password?.r) ?? 8} p=${(sys?.security?.password?.p) ?? 1}, per-user salt</dd>
          <dt>Token signing</dt><dd>${esc(tok.algo || 'aes-256-gcm')} · TTL ${esc(tok.ttlSeconds)}s · refresh ${esc(tok.refreshTtlSeconds)}s</dd>
          <dt>Lockout</dt><dd>${esc(cfg.maxAttempts)} failures → ${Math.round((cfg.lockoutMs || 0) / 60000)} min lock</dd>
          <dt>Rate limit</dt><dd>${esc(sys?.security?.rateLimit?.max)} requests / ${Math.round((sys?.security?.rateLimit?.windowMs || 0) / 1000)}s · login ${esc(sys?.security?.rateLimit?.loginMax)}</dd>
          <dt>CSRF</dt><dd>${sys?.security?.csrf?.enabled ? `double-submit, header <code>${esc(sys.security.csrf.header)}</code>` : 'disabled'}</dd>
          <dt>One-click login</dt><dd>${cfg.oneClickLogin ? 'enabled (demo)' : 'disabled'}</dd>
          <dt>CORS</dt><dd>${esc(sys?.security?.cors || '—')}</dd>
          <dt>Live state</dt><dd>${esc(sys?.auth?.sessions)} sessions · ${esc(sys?.auth?.apiKeys)} keys · ${esc(sys?.auth?.mfaEnabled)} MFA accounts · ${esc(sys?.auth?.lockedAccounts)} locked</dd>
        </dl>
        <div class="cf-stack" style="margin-top:12px">
          <button class="cf-btn danger" id="cf-rotate">Rotate signing secret</button>
          <span class="hint" style="color:var(--faint)">Mints a new TOKEN_SECRET, writes it to the .env file and kills every session. Needs a restart to load.</span>
        </div>
      </section>

      <section class="cf-sect">
        <h3>Audit trail</h3>
        <p>Every sign-in, refresh, key, session and settings change, newest first.</p>
        <div class="cf-scroll">
          <table class="cf-table">
            <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Outcome</th><th>Target</th></tr></thead>
            <tbody>${events}</tbody>
          </table>
        </div>
      </section>`;

    const on = $('#cf-mfa-on');
    if (on) on.addEventListener('click', async () => {
      try {
        const r = await call('/api/auth/mfa/enrol', { method: 'POST' });
        $('#cf-mfa-out').innerHTML = `
          <div class="cf-note warn">Add this secret to your authenticator app, then type the code it shows. MFA stays off until you confirm.</div>
          <div class="cf-secret-out">${esc(r.secret)}</div>
          <div class="cf-stack">
            <input class="cf-input" id="cf-mfa-code" style="max-width:150px" placeholder="123456" inputmode="numeric">
            <button class="cf-btn" id="cf-mfa-confirm">Confirm</button>
            <button class="cf-btn ghost" id="cf-mfa-cancel">Cancel</button>
          </div>`;
        $('#cf-mfa-confirm').addEventListener('click', async () => {
          try {
            await call('/api/auth/mfa/confirm', { method: 'POST', body: { code: $('#cf-mfa-code').value } });
            flash('MFA enabled. Recovery codes were issued at enrolment.', '');
            await renderSecurity();
          } catch (err) { flash(err.message, 'danger'); }
        });
        $('#cf-mfa-cancel').addEventListener('click', () => call('/api/auth/mfa', { method: 'DELETE' }).then(renderSecurity));
      } catch (err) { flash(err.message, 'danger'); }
    });

    const off = $('#cf-mfa-off');
    if (off) off.addEventListener('click', async () => {
      try {
        await call('/api/auth/mfa', { method: 'DELETE' });
        flash('MFA turned off.', '');
        await renderSecurity();
      } catch (err) { flash(err.message, 'danger'); }
    });

    $('#cf-rotate').addEventListener('click', async () => {
      if (!window.confirm('Rotate the signing secret? Every session and token stops working immediately.')) return;
      try {
        const r = await call('/api/settings/rotate-secret', { method: 'POST' });
        flash(r.message, 'warn');
        close();
        setTimeout(() => window.location.reload(), 1600);
      } catch (err) { flash(err.message, 'danger'); }
    });

    renderFoot();
  }

  /* ================= tab: database ================= */

  async function renderData() {
    const sys = state.system;
    const db = sys.database;

    const rows = db.tables.map((t) => `
      <tr>
        <td><b>${esc(t.table)}</b></td>
        <td class="num">${esc(t.columns)}</td>
        <td class="num">${num(t.rows)}</td>
        <td>${t.rows === 0 ? '<span style="color:var(--faint)">empty</span>' : ''}</td>
      </tr>`).join('');

    const m = db.migration;
    $('#cf-body').innerHTML = `
      <div class="cf-note">
        <b>${esc(db.path)}</b> — ${num(db.sizeBytes)} bytes, ${db.totals.tables} tables, ${num(db.totals.rows)} rows.
        SQLite in WAL mode with foreign keys on. Schema lives in <code>lib/schema.js</code> and migrates itself on boot.
      </div>

      <section class="cf-sect">
        <h3>Last migration</h3>
        <dl class="cf-kv">
          <dt>When</dt><dd>${esc(m.at)}</dd>
          <dt>Tables created</dt><dd>${m.created.length ? m.created.map(esc).join(', ') : 'none — already current'}</dd>
          <dt>Columns added</dt><dd>${m.added.length ? m.added.map(esc).join(', ') : 'none'}</dd>
          <dt>Indexes</dt><dd>${esc(m.indexes)} ensured</dd>
        </dl>
      </section>

      <section class="cf-sect">
        <h3>Inventory</h3>
        <div class="cf-scroll">
          <table class="cf-table">
            <thead><tr><th>Table</th><th class="num">Columns</th><th class="num">Rows</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>

      <section class="cf-sect">
        <h3>Runtime</h3>
        <dl class="cf-kv">
          <dt>Node</dt><dd>${esc(sys.runtime.node)} on ${esc(sys.runtime.platform)}</dd>
          <dt>PID / uptime</dt><dd>${esc(sys.runtime.pid)} · ${Math.round(sys.runtime.uptimeSeconds)}s</dd>
          <dt>Booted</dt><dd>${esc(ago(sys.runtime.bootedAt))}</dd>
          <dt>Env file</dt><dd>${esc(sys.runtime.envFile)}</dd>
          <dt>AI provider</dt><dd>${esc(sys.ai.provider)}</dd>
        </dl>
      </section>

      <section class="cf-sect">
        <h3>Rebuild the dataset</h3>
        <p>The seeder is deterministic: the same 100 students, the same numbers, every time.</p>
        <div class="cf-stack"><code>npm run seed -- --force</code></div>
      </section>`;

    renderFoot();
  }

  /* ================= open / close ================= */

  const LOADERS = {
    env: renderEnv,
    ai: renderAi,
    tokens: renderTokens,
    sessions: renderSessions,
    security: renderSecurity,
    data: renderData,
  };

  async function loadTab() {
    flash('');
    const body = $('#cf-body');
    body.innerHTML = '<div class="cf-loading">loading…</div>';
    try {
      // The session is resolved before the tabs are drawn, because the role it
      // reports is what decides which tabs exist. Drawing first would flash the
      // reduced set and then leave it that way.
      if (!state.session) {
        state.session = await call('/api/auth/session');
        state.csrf = state.session.csrfToken;
        $('#cf-subtitle').textContent =
          `${state.session.user.name} · ${state.session.user.role} · ${state.session.via}`;
      }
      renderTabs();
      // The session decides the tabs, so a non-accountant opening on the default
      // would land on Environment — a section they cannot read. Fall back to
      // the first tab they are actually allowed to see.
      if (!TABS.some((t) => t.id === state.tab && (state.session.user.role === 'ACCOUNTANT' || !t.accountOnly))) {
        state.tab = TABS.find((t) => state.session.user.role === 'ACCOUNTANT' || !t.accountOnly).id;
        renderTabs();
      }
      if (!state.system && (state.tab === 'sessions' || state.tab === 'security' || state.tab === 'data')) {
        state.system = await call('/api/system');
      }
      await LOADERS[state.tab]();
    } catch (err) {
      body.innerHTML = `<div class="cf-note danger">${esc(err.message)}
        ${err.status === 403 ? '<br>This section is limited to the accountant account.' : ''}</div>`;
      renderFoot();
    }
  }

  async function open(tab) {
    if (state.open) return;
    state.open = true;
    state.system = null;
    // Re-read the session on every open. The dashboard's role switcher is a
    // demo login, so the role behind these tabs can change while the panel is
    // closed and a cached session would render the wrong set of sections.
    state.session = null;
    state.tab = tab || 'env';
    shell();
    document.body.style.overflow = 'hidden';
    await loadTab();
  }

  function close() {
    const backdrop = $('#cf-backdrop');
    if (backdrop) backdrop.remove();
    document.body.style.overflow = '';
    state.open = false;
    state.dirty.clear();
    state.reveal.clear();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) close();
  });

  // Delegated handlers for the environment editor, re-bound on every render.
  // The AI tab reuses the same controls for the two routing keys, so the same
  // dirty-tracking path serves both without a second implementation.
  const AI_KEYS = [ORDER_KEY, CHAIN_KEY];
  const tracksField = (tab, key) => (tab === 'env' || (tab === 'ai' && AI_KEYS.includes(key)));

  document.addEventListener('input', (e) => {
    if (state.open && e.target.dataset && e.target.dataset.key
        && tracksField(state.tab, e.target.dataset.key)) onEnvInput(e);
  });
  document.addEventListener('change', (e) => {
    if (state.open && e.target.dataset && e.target.dataset.key
        && tracksField(state.tab, e.target.dataset.key)) onEnvInput(e);
  });
  document.addEventListener('click', (e) => {
    if (state.open && state.tab === 'env' && e.target.closest && e.target.closest('[data-act]')) onEnvAction(e);
  });
  document.addEventListener('click', (e) => {
    if (state.open && state.tab === 'ai' && e.target.closest && e.target.closest('[data-ai-act]')) onAiAction(e);
  });

  /* ================= gear button ================= */

  function mount() {
    const host = $('.top-right');
    if (!host || $('#cf-gear-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cf-gear';
    btn.id = 'cf-gear-btn';
    btn.type = 'button';
    btn.title = 'Control room — environment, tokens, sessions, database';
    btn.innerHTML = '<span class="spin">⚙</span> Control room';
    btn.addEventListener('click', () => open('env'));
    host.appendChild(btn);
  }

  window.CampusControl = { open, close, isOpen: () => state.open };
  window.CampusFlash = flash;
  document.addEventListener('cf:refresh-user', () => { state.session = null; state.system = null; });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
