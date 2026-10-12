/**
 * pairing.js — the Verified Pairing panel on the dashboard's Threadline tab
 * (docs/specs/secure-a2a-verified-pairing.md §3.6, Mobile-Complete operator action).
 *
 * The operator's surface for the 12-word check: list pairings; for a pending one,
 * enter the dashboard PIN to see THIS side's 12 words, then type the 12 words the
 * OTHER side shows and confirm (the server compares all 12 in order; any difference
 * is a denial). A denied pairing can be cleared with the PIN. The PIN is typed at
 * action time, sent once, and never stored (no localStorage, no module state).
 *
 * Same shape as mandates.js: pure renderers + createController({ doc, els, fetchImpl }).
 */

const REFRESH_MS = 30_000;
const WORD_COUNT = 12;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATE_LABEL = {
  'pending-verification': 'Waiting for you to compare the words',
  'mutual-verified': 'Verified',
  'identity-verified': 'Verified on another of my machines',
  'verification-failed': 'Words did not match — blocked',
};

/** One pairing card. Primary action first; the fingerprint is support metadata. */
export function renderPairing(p) {
  const fp = esc(p.peerFp);
  const name = esc(p.peerName || 'Unknown agent');
  const state = p.state;
  const label = esc(STATE_LABEL[state] || state || 'Unknown');
  let actions = '';
  if (state === 'pending-verification') {
    const inputs = Array.from({ length: WORD_COUNT }, (_, i) =>
      `<label class="pair-word"><span>${i + 1}</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-their-word="${fp}" data-idx="${i}" aria-label="Their word ${i + 1}" /></label>`).join('');
    actions = `
      <div class="pair-step">
        <div class="pair-step-title">1. See the words on this side</div>
        <div class="pair-row"><input type="password" class="mnd-pin" data-show-pin="${fp}" placeholder="Your PIN" autocomplete="off" />
        <button class="mnd-btn mnd-btn-primary" data-show-words="${fp}">Show my words</button></div>
        <ol class="pair-own-words" data-own-words="${fp}"></ol>
      </div>
      <div class="pair-step">
        <div class="pair-step-title">2. Type the 12 words the OTHER agent's operator sees</div>
        <div class="pair-words">${inputs}</div>
        <div class="pair-row"><input type="password" class="mnd-pin" data-confirm-pin="${fp}" placeholder="Your PIN" autocomplete="off" />
        <button class="mnd-btn mnd-btn-primary" data-confirm="${fp}">Confirm they match</button></div>
        <div class="mnd-hint">Compare over a call or in person, not through the agents. Any wrong word blocks this pairing.</div>
        <button class="mnd-btn mnd-btn-quiet mnd-btn-danger" data-deny="${fp}">They don't match</button>
      </div>`;
  } else if (state === 'verification-failed') {
    actions = `
      <div class="pair-step">
        <div class="mnd-hint">Clear this only once you know why the words were different.</div>
        <div class="pair-row"><input type="password" class="mnd-pin" data-clear-pin="${fp}" placeholder="Your PIN" autocomplete="off" />
        <button class="mnd-btn mnd-btn-quiet" data-clear="${fp}">Clear and start again</button></div>
      </div>`;
  }
  return `<div class="pair-card" data-pairing="${fp}">
    <div class="pair-head"><strong>${name}</strong> <span class="pair-state pair-state-${esc(state)}">${label}</span></div>
    ${actions}
    <div class="pair-meta">Agent ${fp.slice(0, 12)}…</div>
  </div>`;
}

export function renderPairings(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="mnd-hint">No pairings yet. An agent starts one with <code>threadline_pair</code> start.</div>';
  }
  return list.map(renderPairing).join('');
}

/** Words typed into the 12 inputs for one pairing, in order. */
export function collectTypedWords(root, fp) {
  const inputs = Array.from(root.querySelectorAll(`[data-their-word="${fp}"]`));
  inputs.sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx));
  return inputs.map((i) => String(i.value || '').trim().toLowerCase());
}

export function createController({ doc, els, fetchImpl }) {
  let timer = null;

  async function fetchJson(url, opts) {
    const res = await fetchImpl(url, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }

  function note(msg, kind) {
    if (!els.notice) return;
    els.notice.textContent = msg;
    els.notice.className = kind === 'error' ? 'mnd-notice mnd-notice-err' : kind === 'success' ? 'mnd-notice mnd-notice-ok' : 'mnd-notice';
  }

  // A timed refresh must not wipe words or a PIN the operator is typing.
  function operatorIsTyping() {
    const inputs = els.list ? Array.from(els.list.querySelectorAll('input')) : [];
    return inputs.some((i) => i.value);
  }

  async function load(opts = {}) {
    if (opts.timed && operatorIsTyping()) return;
    try {
      const { status, body } = await fetchJson('/threadline/pairing');
      if (status === 503) { els.list.innerHTML = '<div class="mnd-hint">Verified pairing is turned off on this agent.</div>'; return; }
      if (status !== 200) { note(`Could not load pairings: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
      els.list.innerHTML = renderPairings(body?.pairings ?? []);
    } catch (e) {
      note(`Could not reach the agent: ${e?.message ?? e}`, 'error');
    }
  }

  async function post(url, payload) {
    return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }

  async function onClick(ev) {
    const t = ev.target;
    if (!t || !t.dataset) return;
    const root = els.list;
    const take = (attr, fp) => { const el = root.querySelector(`[${attr}="${fp}"]`); const v = el ? el.value : ''; if (el) el.value = ''; return v; };
    try {
      if (t.dataset.showWords) {
        const fp = t.dataset.showWords;
        const pin = take('data-show-pin', fp);
        if (!pin) { note('Enter your PIN to see the words.', 'error'); return; }
        const res = await fetchImpl(`/threadline/pairing/${fp}`, { headers: { 'X-Dashboard-Pin': pin } });
        const body = await res.json().catch(() => null);
        const words = body?.pairing?.sasWords;
        if (!Array.isArray(words)) { note(res.status === 200 ? 'The PIN was not accepted, or this pairing is no longer waiting.' : `Refused: ${body?.error ?? `HTTP ${res.status}`}`, 'error'); return; }
        const ol = root.querySelector(`[data-own-words="${fp}"]`);
        if (ol) ol.innerHTML = words.map((w) => `<li>${esc(w)}</li>`).join('');
        note('These are the words on this side. Read them to the other operator and type theirs below.', 'info');
      } else if (t.dataset.confirm) {
        const fp = t.dataset.confirm;
        const words = collectTypedWords(root, fp);
        const pin = take('data-confirm-pin', fp);
        if (words.some((w) => !w)) { note(`Type all ${WORD_COUNT} of the other side's words first.`, 'error'); return; }
        if (!pin) { note('Enter your PIN to confirm.', 'error'); return; }
        const { status, body } = await post(`/threadline/pairing/${fp}/verify`, { words, pin });
        if (status !== 200) { note(`Not confirmed — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
        note(body?.state === 'mutual-verified' ? 'Verified. Every word matched.' : 'The words did not match. This pairing is now blocked.', body?.state === 'mutual-verified' ? 'success' : 'error');
        await load();
      } else if (t.dataset.deny) {
        const fp = t.dataset.deny;
        const pin = take('data-confirm-pin', fp);
        if (!pin) { note('Enter your PIN (in the field above) to record that the words did not match.', 'error'); return; }
        const { status, body } = await post(`/threadline/pairing/${fp}/verify`, { match: false, pin });
        if (status !== 200) { note(`Not recorded — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
        note('Recorded: the words did not match. This pairing is blocked.', 'success');
        await load();
      } else if (t.dataset.clear) {
        const fp = t.dataset.clear;
        const pin = take('data-clear-pin', fp);
        if (!pin) { note('Enter your PIN to clear this pairing.', 'error'); return; }
        const { status, body } = await post(`/threadline/pairing/${fp}/start`, { clearFailed: true, pin });
        if (status !== 200) { note(`Not cleared — the server refused: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
        note('Cleared. Compare the words again.', 'success');
        await load();
      }
    } catch (e) {
      note(`Could not reach the agent: ${e?.message ?? e}`, 'error');
    }
  }

  return {
    start() {
      if (els.list && !els.list.__pairWired) { els.list.addEventListener('click', onClick); els.list.__pairWired = true; }
      load();
      if (!timer) timer = setInterval(() => load({ timed: true }), REFRESH_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    load,
    onClick,
  };
}
