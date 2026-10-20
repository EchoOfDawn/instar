/**
 * release-local-steps — the post-publish decisions of scripts/release-local.mjs,
 * extracted so they can be tested against real git repos.
 *
 * Every function takes a `run(cmd, args)` that returns { status, stdout, stderr }
 * (the caller decides whether output is echoed), so tests drive real git in a
 * scratch dir and the script drives it in the repo.
 */

import { classifyReleaseCut } from '../release-cut-diff.mjs';

/** The remotes whose `<remote>/main` pre-push-gate.js's pickRef may choose, in its order. */
export const GATE_BASE_REMOTES = ['JKHeadley', 'origin', 'upstream'];

/**
 * Refresh every `<remote>/main` ref the pre-push gate could diff against, so
 * the gate never compares the release commit to a stale base. Each ref is
 * fetched from ITS OWN remote (`git fetch JKHeadley main` for JKHeadley/main),
 * never from the release's --remote. A ref that does
 * not exist locally is skipped (pickRef will not pick it). A ref that exists
 * but cannot be fetched is a failure: pickRef would still pick it, stale.
 * @returns {{ ok: boolean, refreshed: string[], failed: Array<{ref: string, detail: string}> }}
 */
export function refreshGateBaseRefs(run) {
  const refreshed = [];
  const failed = [];
  for (const remote of GATE_BASE_REMOTES) {
    const ref = `${remote}/main`;
    if (run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]).status !== 0) continue;
    const f = run('git', ['fetch', '--quiet', remote, 'main']);
    if (f.status === 0) refreshed.push(ref);
    else failed.push({ ref, detail: (f.stderr || f.stdout || '').trim().split('\n').pop() || `exit ${f.status}` });
  }
  return { ok: failed.length === 0, refreshed, failed };
}

function revParse(run, ref) {
  const r = run('git', ['rev-parse', '--verify', '--quiet', ref]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Is commit `sha` (vs its first parent) a release cut — only version fields,
 * one added versioned guide, deleted fragments? A merge, a root commit or any
 * read failure is NOT a cut.
 */
export function isReleaseCutCommit(run, sha) {
  const parents = run('git', ['rev-list', '--parents', '-n', '1', sha]);
  if (parents.status !== 0) return false;
  const ids = parents.stdout.trim().split(/\s+/);
  if (ids.length !== 2) return false; // root or merge
  const parent = ids[1];
  const d = run('git', ['diff', '--name-status', '--no-renames', parent, sha]);
  if (d.status !== 0) return false;
  const entries = d.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status.trim(), path: rest.join('\t').trim() };
  });
  const read = (rev) => (p) => {
    const r = run('git', ['show', `${rev}:${p}`]);
    return r.status === 0 ? r.stdout : null;
  };
  return classifyReleaseCut({ entries, readBase: read(parent), readHead: read(sha) }).isCut;
}

/**
 * The commits on `<remote>/main` that HEAD does not have, and whether every one
 * is a release cut. A release cut carries no code, so rebasing over it keeps
 * the published tree; anything else would put code npm never got under the tag.
 */
export function incomingCommits(run, remote) {
  const r = run('git', ['rev-list', '--reverse', `HEAD..refs/remotes/${remote}/main`]);
  if (r.status !== 0) return { ok: false, commits: [], nonCut: [] };
  const commits = r.stdout.split('\n').filter(Boolean);
  const nonCut = commits.filter((c) => !isReleaseCutCommit(run, c));
  return { ok: true, commits, nonCut };
}

/**
 * Push the release commit and its tag in ONE atomic push, with publish.yml's
 * rebase-retry loop — but only retry when the remote really moved. A refused
 * push whose remote main did not move was refused by a hook (or a permission),
 * and rebasing cannot fix that, so it fails at once with the push output.
 *
 * @param {{ run: Function, remote: string, version: string, maxAttempts?: number, log?: Function }} o
 * @returns {{ ok: boolean, attempts: number, reason?: string, output?: string }}
 */
export function pushReleaseAtomically({ run, remote, version, maxAttempts = 5, log = () => {} }) {
  const tag = `v${version}`;
  const tagHere = () => {
    run('git', ['tag', '-d', tag]); // absent on the first pass; harmless
    const t = run('git', ['tag', tag]);
    return t.status === 0;
  };
  if (!tagHere()) return { ok: false, attempts: 0, reason: `could not create tag ${tag}` };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = revParse(run, `refs/remotes/${remote}/main`);
    const p = run('git', ['push', '--atomic', remote, 'HEAD:main', tag]);
    if (p.status === 0) return { ok: true, attempts: attempt };
    const output = `${p.stdout || ''}${p.stderr || ''}`.trim();

    const f = run('git', ['fetch', '--quiet', remote, 'main']);
    if (f.status !== 0) {
      return { ok: false, attempts: attempt, reason: `push refused and ${remote} could not be fetched to tell why`, output };
    }
    const after = revParse(run, `refs/remotes/${remote}/main`);
    if (after === before) {
      return {
        ok: false,
        attempts: attempt,
        reason: `push refused but ${remote}/main did not move (${(after || 'none').slice(0, 10)}) — a hook or permission refused it; rebasing would not help`,
        output,
      };
    }
    // Main moved. Rebasing is only safe over commits that carry no code (other
    // release cuts): the tag must point at the tree npm actually got.
    const incoming = incomingCommits(run, remote);
    if (!incoming.ok || incoming.nonCut.length > 0) {
      return {
        ok: false,
        attempts: attempt,
        code: 'main-moved-with-code',
        reason: `${remote}/main moved by ${incoming.commits.length} commit(s), ${incoming.ok ? incoming.nonCut.length : 'unknown number'} of them not release cuts ` +
          `(${incoming.nonCut.slice(0, 5).map((c) => c.slice(0, 10)).join(', ')}). Rebasing would put v${version} on a tree with code npm never got, so this stops.`,
        output,
      };
    }
    log(`push rejected — ${remote}/main moved ${String(before).slice(0, 10)} → ${String(after).slice(0, 10)} by release cut(s) only; rebasing and retrying (attempt ${attempt})`);
    if (run('git', ['rebase', `${remote}/main`]).status !== 0) {
      run('git', ['rebase', '--abort']);
      return { ok: false, attempts: attempt, reason: 'the release commit could not be rebased cleanly onto main (conflict) — aborted rather than force-pushing', output };
    }
    if (!tagHere()) return { ok: false, attempts: attempt, reason: `could not move tag ${tag} onto the rebased commit` };
  }
  return { ok: false, attempts: maxAttempts, reason: `could not push the release commit after ${maxAttempts} rebase-retries` };
}

/**
 * After `npm publish` exits non-zero, decide whether the version is on npm
 * anyway (a timeout after the upload, a failing postpublish, a flaky network).
 * @param {{ run: Function, name: string, version: string, npmArgs?: string[] }} o
 * @returns {'published'|'absent'|'unknown'}
 */
export function publishedStateAfterFailure({ run, name, version, npmArgs = [] }) {
  const r = run('npm', ['view', `${name}@${version}`, 'version', ...npmArgs]);
  const out = (r.stdout || '').trim();
  if (r.status === 0 && out === version) return 'published';
  // npm view prints nothing and exits 0 for a version that does not exist (in
  // some npm versions), or exits non-zero with E404. Anything else — a network
  // error, an auth error — is not evidence of absence.
  if (r.status === 0 && out === '') return 'absent';
  if (r.status !== 0 && /E404|404 Not Found|is not in this registry/i.test(`${r.stderr || ''}${r.stdout || ''}`)) return 'absent';
  return 'unknown';
}

/**
 * Resume path for a release whose main moved WITH code (or whenever the tag
 * must stay on the published commit): push the tag alone, pointing at the
 * commit npm was built from, then land the release commit on main, rebasing
 * over whatever moved main (the tag does NOT move). Hook refusals still stop
 * at once.
 * @returns {{ ok: boolean, attempts: number, reason?: string, output?: string }}
 */
export function pushTagThenMain({ run, remote, version, maxAttempts = 5, log = () => {} }) {
  const tag = `v${version}`;
  const head = revParse(run, 'HEAD');
  const tagged = revParse(run, `refs/tags/${tag}^{commit}`);
  if (!tagged) return { ok: false, attempts: 0, reason: `local tag ${tag} does not exist` };
  if (tagged !== head) return { ok: false, attempts: 0, reason: `local tag ${tag} is not on HEAD — run this from the published release commit` };
  const t = run('git', ['push', remote, `refs/tags/${tag}`]);
  if (t.status !== 0) {
    return { ok: false, attempts: 0, reason: `could not push tag ${tag}`, output: `${t.stdout || ''}${t.stderr || ''}`.trim() };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = revParse(run, `refs/remotes/${remote}/main`);
    const p = run('git', ['push', remote, 'HEAD:main']);
    if (p.status === 0) return { ok: true, attempts: attempt };
    const output = `${p.stdout || ''}${p.stderr || ''}`.trim();
    if (run('git', ['fetch', '--quiet', remote, 'main']).status !== 0) {
      return { ok: false, attempts: attempt, reason: `push refused and ${remote} could not be fetched to tell why`, output };
    }
    const after = revParse(run, `refs/remotes/${remote}/main`);
    if (after === before) {
      return { ok: false, attempts: attempt, reason: `push refused but ${remote}/main did not move — a hook or permission refused it`, output };
    }
    log(`main moved; rebasing the release commit (tag ${tag} stays on the published commit) (attempt ${attempt})`);
    if (run('git', ['rebase', `${remote}/main`]).status !== 0) {
      run('git', ['rebase', '--abort']);
      return { ok: false, attempts: attempt, reason: 'the release commit could not be rebased cleanly onto main (conflict) — aborted rather than force-pushing', output };
    }
  }
  return { ok: false, attempts: maxAttempts, reason: `could not push the release commit after ${maxAttempts} rebase-retries` };
}

/**
 * Would `npm publish` need a one-time password? Decided BEFORE anything is
 * mutated. `profileJson` is the stdout of `npm profile get --json` (null when
 * that command failed — granular tokens often cannot read the profile).
 * @returns {'not-required'|'required'|'unknown'}
 */
export function otpRequirement(profileJson) {
  if (profileJson == null) return 'unknown';
  let p;
  try { p = JSON.parse(profileJson); } catch { return 'unknown'; }
  if (!p || typeof p !== 'object' || p.error) return 'unknown';
  if (!('tfa' in p)) return 'unknown';
  const tfa = p.tfa;
  if (!tfa || tfa.pending) return 'not-required';
  if (tfa.mode === 'auth-only') return 'not-required';
  if (tfa.mode === 'auth-and-writes') return 'required';
  return 'unknown';
}

/**
 * Parse one `gh run list --json databaseId,status,headSha` answer.
 * `listJson` is null when gh failed or is missing.
 * @returns {{ state: 'clear'|'active'|'unknown', ids: number[] }}
 */
export function ciRunState(listJson) {
  if (listJson == null) return { state: 'unknown', ids: [] };
  let runs;
  try { runs = JSON.parse(listJson); } catch { return { state: 'unknown', ids: [] }; }
  if (!Array.isArray(runs)) return { state: 'unknown', ids: [] };
  const active = runs.filter((r) => r && r.status !== 'completed');
  return active.length ? { state: 'active', ids: active.map((r) => r.databaseId) } : { state: 'clear', ids: [] };
}

/**
 * Every not-yet-finished state `gh run list --status` accepts (gh 2.64:
 * queued|in_progress|requested|waiting|action_required are the unfinished
 * ones; `pending` is NOT accepted and made every query fail — caught by the
 * first real dry run, which correctly read that failure as UNKNOWN).
 * `action_required` is a run waiting for approval, which can still publish.
 */
export const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'action_required'];

/**
 * Is ANY publish.yml run on the repo queued or in progress — for ANY commit?
 * publish.yml checks out `ref: main` (not its triggering sha) and waits in
 * `concurrency: publish` without cancelling, so a run queued for an EARLIER
 * merge publishes whatever main is when it gets a runner. That races a local
 * release on the same version. So no `--commit` filter. One query per active
 * status (so an old queued run is never pushed out of a recent-runs page); any
 * query that fails or is unreadable makes the whole answer unknown.
 * @returns {{ state: 'clear'|'active'|'unknown', ids: number[] }}
 */
export function activePublishRuns(run, slug) {
  if (!slug) return { state: 'unknown', ids: [] };
  const ids = [];
  for (const status of ACTIVE_RUN_STATUSES) {
    const r = run('gh', ['run', 'list', '-R', slug, '--workflow', 'publish.yml', '--status', status, '--limit', '100', '--json', 'databaseId,status,headSha']);
    const v = ciRunState(r.status === 0 ? r.stdout : null);
    if (v.state === 'unknown') return { state: 'unknown', ids: [] };
    ids.push(...v.ids);
  }
  return ids.length ? { state: 'active', ids: [...new Set(ids)] } : { state: 'clear', ids: [] };
}

/**
 * What the release does with a publish.yml-run verdict.
 *   clear → 'proceed'. active → 'stop' (a dry run only 'warn's).
 *   unknown → 'stop' unless --allow-unverified-ci ('proceed-unverified');
 *   a dry run 'warn's. Unknown is never treated as clear.
 * @param {{ state: 'clear'|'active'|'unknown', dryRun: boolean, allowUnverified: boolean }} o
 * @returns {'proceed'|'warn'|'stop'|'proceed-unverified'}
 */
export function ciGateAction({ state, dryRun, allowUnverified }) {
  if (state === 'clear') return 'proceed';
  if (dryRun) return 'warn';
  if (state === 'active') return 'stop';
  return allowUnverified ? 'proceed-unverified' : 'stop';
}

/**
 * The tool's own files — the only paths `--dry-run --allow-dirty-tool-files`
 * tolerates as uncommitted. Deliberately EXCLUDES package.json,
 * package-lock.json and upgrades/: the dry run edits and then restores those
 * from HEAD, which would silently discard an uncommitted edit there.
 */
export const TOOL_OWN_FILES = [
  'scripts/release-local.mjs',
  'scripts/lib/release-local-steps.mjs',
  'tests/unit/release-local-steps.test.ts',
  'tests/unit/release-local-parity.test.ts',
  'scripts/lint-no-direct-destructive.js',
  'CONTRIBUTING.md',
  'docs/specs/local-release.md',
  'docs/specs/local-release.eli16.md',
];

/**
 * Given `git status --porcelain` output, are the ONLY dirty paths the tool's own?
 * @returns {{ ok: boolean, paths: string[], others: string[] }}
 */
export function dirtyToolFilesOnly(porcelain) {
  // `XY <path>`; tolerate a caller that trimmed the output, which turns the
  // first line's ` M path` into `M path`.
  const paths = String(porcelain || '').split('\n').filter((l) => l.trim()).map((l) => {
    const m = /^[ MADRCUT?!]{2} (.+)$/.exec(l) || /^[MADRCUT?!] (.+)$/.exec(l);
    return (m ? m[1] : l).trim().replace(/^"|"$/g, '');
  });
  const flat = paths.flatMap((p) => (p.includes(' -> ') ? p.split(' -> ') : [p]));
  const others = flat.filter((p) => !TOOL_OWN_FILES.includes(p));
  return { ok: flat.length > 0 && others.length === 0, paths: flat, others };
}
