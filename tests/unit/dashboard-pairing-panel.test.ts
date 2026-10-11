/**
 * Dashboard Verified Pairing panel (docs/specs/secure-a2a-verified-pairing.md §3.6).
 * Pure renderers + the controller against a fake fetch, in a real jsdom DOM.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
// @ts-expect-error — plain JS dashboard module
import { renderPairing, renderPairings, collectTypedWords, createController } from '../../dashboard/pairing.js';

const FP = 'ab'.repeat(16);
const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];

function setup(state = 'pending-verification', reply: (url: string, opts: any) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const dom = new JSDOM('<div id="list"></div><div id="notice"></div>');
  const doc = dom.window.document;
  const els = { list: doc.getElementById('list')!, notice: doc.getElementById('notice')! };
  const calls: Array<{ url: string; opts: any }> = [];
  const fetchImpl = async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    if (url === '/threadline/pairing' && !opts.method) {
      return { status: 200, json: async () => ({ pairings: [{ peerFp: FP, peerName: 'scout', state }] }) };
    }
    const r = reply(url, opts);
    return { status: r.status, json: async () => r.body };
  };
  const c = createController({ doc, els, fetchImpl });
  return { doc, els, calls, c };
}

const click = (c: any, el: any) => c.onClick({ target: el });

describe('pairing panel — rendering', () => {
  it('a pending pairing leads with the actions: show words, 12 inputs, confirm; fingerprint only as metadata', () => {
    const html = renderPairing({ peerFp: FP, peerName: 'scout', state: 'pending-verification' });
    expect(html).toContain('Show my words');
    expect((html.match(/data-their-word=/g) || []).length).toBe(12);
    expect(html).toContain('Confirm they match');
    expect(html.indexOf('Show my words')).toBeLessThan(html.indexOf('pair-meta'));
    expect(html).not.toContain(FP + '<'); // never the full fingerprint as headline text
  });

  it('a denied pairing offers only a PIN-gated clear; a verified one offers nothing', () => {
    expect(renderPairing({ peerFp: FP, state: 'verification-failed' })).toContain('Clear and start again');
    const ok = renderPairing({ peerFp: FP, state: 'mutual-verified' });
    expect(ok).toContain('Verified');
    expect(ok).not.toContain('<button');
  });

  it('escapes peer-supplied names', () => {
    expect(renderPairing({ peerFp: FP, peerName: '<img src=x onerror=1>', state: 'mutual-verified' })).not.toContain('<img');
    expect(renderPairings([])).toContain('No pairings yet');
  });
});

describe('pairing panel — controller', () => {
  it('shows this side\'s words using the PIN in a header (a GET cannot carry a body), then clears the PIN field', async () => {
    const { els, calls, c } = setup('pending-verification', () => ({ status: 200, body: { pairing: { sasWords: WORDS } } }));
    await c.load();
    const pin = els.list.querySelector(`[data-show-pin="${FP}"]`) as any;
    pin.value = '1234';
    await click(c, els.list.querySelector(`[data-show-words="${FP}"]`));
    const call = calls.find((x) => x.url === `/threadline/pairing/${FP}`)!;
    expect(call.opts.headers['X-Dashboard-Pin']).toBe('1234');
    expect(call.opts.body).toBeUndefined();
    expect(pin.value).toBe('');
    expect(els.list.querySelectorAll(`[data-own-words="${FP}"] li`).length).toBe(12);
  });

  it('confirm sends the 12 typed words (trimmed, lowercased, in order) with the PIN', async () => {
    const { els, calls, c } = setup('pending-verification', () => ({ status: 200, body: { state: 'mutual-verified' } }));
    await c.load();
    const inputs = Array.from(els.list.querySelectorAll(`[data-their-word="${FP}"]`)) as any[];
    inputs.forEach((i, k) => { i.value = ` ${WORDS[k].toUpperCase()} `; });
    (els.list.querySelector(`[data-confirm-pin="${FP}"]`) as any).value = '1234';
    await click(c, els.list.querySelector(`[data-confirm="${FP}"]`));
    const call = calls.find((x) => x.url === `/threadline/pairing/${FP}/verify`)!;
    expect(JSON.parse(call.opts.body)).toEqual({ words: WORDS, pin: '1234' });
    expect(els.notice.textContent).toContain('Every word matched');
  });

  it('refuses to send with a missing word or no PIN', async () => {
    const { els, calls, c } = setup();
    await c.load();
    (els.list.querySelector(`[data-confirm-pin="${FP}"]`) as any).value = '1234';
    await click(c, els.list.querySelector(`[data-confirm="${FP}"]`));
    expect(calls.some((x) => x.url.endsWith('/verify'))).toBe(false);
    expect(els.notice.className).toContain('mnd-notice-err');
    expect(collectTypedWords(els.list, FP)).toHaveLength(12);
  });

  it('a timed refresh does not wipe words the operator is typing', async () => {
    const { els, c } = setup();
    await c.load();
    const first = els.list.querySelector(`[data-their-word="${FP}"]`) as any;
    first.value = 'abandon';
    await c.load({ timed: true });
    expect((els.list.querySelector(`[data-their-word="${FP}"]`) as any).value).toBe('abandon');
  });

  it('clear posts clearFailed with the PIN to the start route', async () => {
    const { els, calls, c } = setup('verification-failed', () => ({ status: 200, body: { outcome: 'started' } }));
    await c.load();
    (els.list.querySelector(`[data-clear-pin="${FP}"]`) as any).value = '1234';
    await click(c, els.list.querySelector(`[data-clear="${FP}"]`));
    const call = calls.find((x) => x.url === `/threadline/pairing/${FP}/start`)!;
    expect(JSON.parse(call.opts.body)).toEqual({ clearFailed: true, pin: '1234' });
  });
});

describe('pairing panel — page wiring', () => {
  it('index.html has the card and loads the module on the Threadline tab', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../dashboard/index.html'), 'utf-8');
    expect(html).toContain('id="pairList"');
    expect(html).toContain("import('/dashboard/pairing.js')");
    expect(html).toMatch(/startPairingPanel\(\)/);
  });
});
