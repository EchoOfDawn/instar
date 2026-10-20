// safe-git-allow: test file — drives real git (bare remote + clones) in
//   per-test tmpdirs to exercise the release push path; cleanup is the tmpdir.

/**
 * Tests for scripts/lib/release-local-steps.mjs — the post-publish decisions of
 * scripts/release-local.mjs, against real git repos:
 *   - a push refused by a hook (remote did not move) fails at once, no rebase;
 *   - a push rejected because main moved rebases and retries, tag follows;
 *   - commit and tag go up atomically (a refused tag leaves main untouched);
 *   - every gate base ref that exists is refreshed, and a stale one that
 *     cannot be refreshed is a failure;
 *   - a non-zero `npm publish` is resolved against the registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  refreshGateBaseRefs,
  pushReleaseAtomically,
  pushTagThenMain,
  publishedStateAfterFailure,
  isReleaseCutCommit,
  otpRequirement,
  ciRunState,
  ciGateAction,
  activePublishRuns,
  ACTIVE_RUN_STATUSES,
  dirtyToolFilesOnly,
} from '../../scripts/lib/release-local-steps.mjs';

type R = { status: number; stdout: string; stderr: string };

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 't';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 't@t';
  return env;
}
const ENV = cleanEnv();

function runner(cwd: string, calls: string[][] = []) {
  return (cmd: string, args: string[]): R => {
    calls.push([cmd, ...args]);
    const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf-8' });
    return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

describe('release-local push + ref refresh (real git)', () => {
  let tmp: string;
  let bare: string;
  let clone: string;
  let other: string;
  const g = (cwd: string, ...args: string[]) => {
    const r = runner(cwd)('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-local-steps-'));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');
    other = path.join(tmp, 'other');
    g(tmp, 'init', '--bare', '--initial-branch=main', bare);
    g(tmp, 'clone', '-q', bare, clone);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) + '\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'base');
    g(clone, 'push', '-q', 'origin', 'HEAD:main');
    g(tmp, 'clone', '-q', bare, other);
    // The release commit, made locally and not yet pushed.
    fs.writeFileSync(path.join(clone, 'version.txt'), '1.0.1\n');
    g(clone, 'add', '-A');
    g(clone, 'commit', '-qm', 'chore: release v1.0.1 [skip ci]');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('pushes commit and tag together on the first attempt', () => {
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 1 });
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
  });

  it('a hook refusal (remote did not move) fails at once with the hook output — no rebase, no retry', () => {
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\necho "HOOK SAYS NO" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const calls: string[][] = [];
    const res = pushReleaseAtomically({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.reason).toContain('did not move');
    expect(res.output).toContain('HOOK SAYS NO');
    expect(calls.filter((c) => c[1] === 'push')).toHaveLength(1);
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
  });

  /** Another publisher's release cut lands on main (no code). */
  function otherReleaseCut() {
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.5' }, null, 2) + '\n');
    fs.mkdirSync(path.join(other, 'upgrades'), { recursive: true });
    fs.writeFileSync(path.join(other, 'upgrades', '1.0.5.md'), '# notes\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'chore: release v1.0.5 [skip ci]');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
  }
  /** A code merge lands on main. */
  function otherCodeMerge() {
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'concurrent merge');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
  }

  it('main moved by a CODE commit: refuses to rebase — the tag would cover code npm never got', () => {
    otherCodeMerge();
    const before = g(bare, 'rev-parse', 'main');
    const calls: string[][] = [];
    const res = pushReleaseAtomically({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('main-moved-with-code');
    expect(res.attempts).toBe(1);
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
    expect(runner(bare)('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/v1.0.1']).status).not.toBe(0);
  });

  it('main moved ONLY by another release cut: rebases and retries; the tag follows the rebased commit', () => {
    otherReleaseCut();
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    const head = g(clone, 'rev-parse', 'HEAD');
    expect(g(bare, 'rev-parse', 'main')).toBe(head);
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(head);
    expect(g(bare, 'log', '-1', '--format=%s', 'main^')).toBe('chore: release v1.0.5 [skip ci]');
  });

  it('isReleaseCutCommit: a real cut yes; a code commit, a merge and a root commit no', () => {
    otherReleaseCut();
    g(clone, 'fetch', '-q', 'origin', 'main');
    expect(isReleaseCutCommit(runner(clone), 'origin/main')).toBe(true);
    expect(isReleaseCutCommit(runner(clone), 'HEAD')).toBe(false); // version.txt is not a cut
    expect(isReleaseCutCommit(runner(clone), 'HEAD~1')).toBe(false); // root commit
    g(clone, 'merge', '-q', '--no-edit', 'origin/main');
    expect(isReleaseCutCommit(runner(clone), 'HEAD')).toBe(false); // merge commit
  });

  it('--keep-tag-on-published resume: tag stays on the published commit, main gets the rebased release commit', () => {
    otherCodeMerge();
    g(clone, 'tag', 'v1.0.1');
    const published = g(clone, 'rev-parse', 'HEAD');
    const res = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(g(bare, 'rev-parse', 'v1.0.1^{commit}')).toBe(published);
    const main = g(bare, 'rev-parse', 'main');
    expect(main).not.toBe(published);
    expect(g(bare, 'log', '-1', '--format=%s', 'main')).toBe('chore: release v1.0.1 [skip ci]');
    expect(g(bare, 'log', '-1', '--format=%s', 'main^')).toBe('concurrent merge');
  });

  it('--keep-tag-on-published: a hook refusal on the main push still stops at once', () => {
    g(clone, 'tag', 'v1.0.1');
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    // Refuse only the main push (the tag push goes first and is allowed).
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read l lsha r rsha; do case "$r" in refs/heads/main) echo "HOOK SAYS NO" >&2; exit 1;; esac; done\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    const calls: string[][] = [];
    const res = pushTagThenMain({ run: runner(clone, calls), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('did not move');
    expect(res.output).toContain('HOOK SAYS NO');
    expect(calls.some((c) => c[1] === 'rebase')).toBe(false);
  });

  it('--keep-tag-on-published refuses when the local tag is not on HEAD', () => {
    g(clone, 'tag', 'v1.0.1', 'HEAD~1');
    const res = pushTagThenMain({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('not on HEAD');
  });

  it('is atomic: when the tag is refused, main is not updated either', () => {
    // Someone already holds v1.0.1 on the remote, on a different commit.
    g(other, 'tag', 'v1.0.1');
    g(other, 'push', '-q', 'origin', 'v1.0.1');
    const before = g(bare, 'rev-parse', 'main');
    const res = pushReleaseAtomically({ run: runner(clone), remote: 'origin', version: '1.0.1' });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(g(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('refreshes every existing gate base ref and skips ones that do not exist', () => {
    fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'moved');
    g(other, 'push', '-q', 'origin', 'HEAD:main');
    const res = refreshGateBaseRefs(runner(clone));
    expect(res).toMatchObject({ ok: true, refreshed: ['origin/main'], failed: [] });
    expect(g(clone, 'rev-parse', 'origin/main')).toBe(g(bare, 'rev-parse', 'main'));
  });

  it('fetches each gate base ref from ITS OWN remote, not from the release remote', () => {
    // upstream points at the real remote; JKHeadley does not exist. If every
    // ref were fetched from origin, JKHeadley/main would "refresh" fine.
    g(clone, 'remote', 'add', 'upstream', bare);
    g(clone, 'fetch', '-q', 'upstream', 'main');
    const calls: string[][] = [];
    const res = refreshGateBaseRefs(runner(clone, calls));
    expect(res.refreshed).toEqual(['origin/main', 'upstream/main']);
    const fetches = calls.filter((c) => c[1] === 'fetch').map((c) => c.slice(2).filter((x) => x !== '--quiet').join(' '));
    expect(fetches).toEqual(['origin main', 'upstream main']);
  });

  it('fails when a stale preferred base ref exists but cannot be refreshed', () => {
    // pickRef prefers JKHeadley/main over origin/main. A stale one that cannot
    // be fetched would be diffed against, so it must be a failure.
    g(clone, 'remote', 'add', 'JKHeadley', path.join(tmp, 'does-not-exist.git'));
    g(clone, 'update-ref', 'refs/remotes/JKHeadley/main', g(clone, 'rev-parse', 'HEAD~1'));
    const res = refreshGateBaseRefs(runner(clone));
    expect(res.ok).toBe(false);
    expect(res.failed.map((f) => f.ref)).toEqual(['JKHeadley/main']);
    expect(res.refreshed).toEqual(['origin/main']);
  });
});

describe('publishedStateAfterFailure', () => {
  const fake = (r: R) => () => r;
  it('published when the registry returns the version', () => {
    expect(publishedStateAfterFailure({ run: fake({ status: 0, stdout: '1.2.3\n', stderr: '' }), name: 'x', version: '1.2.3' })).toBe('published');
  });
  it('absent on E404', () => {
    expect(publishedStateAfterFailure({ run: fake({ status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 No match found for version 1.2.3' }), name: 'x', version: '1.2.3' })).toBe('absent');
  });
  it('unknown on a network or auth error — never treated as absent', () => {
    expect(publishedStateAfterFailure({ run: fake({ status: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }), name: 'x', version: '1.2.3' })).toBe('unknown');
    expect(publishedStateAfterFailure({ run: fake({ status: 0, stdout: '1.2.2', stderr: '' }), name: 'x', version: '1.2.3' })).toBe('unknown');
  });
  it('asks the registry for exactly name@version', () => {
    const calls: string[][] = [];
    publishedStateAfterFailure({
      run: (c: string, a: string[]) => { calls.push([c, ...a]); return { status: 0, stdout: '1.2.3', stderr: '' }; },
      name: 'instar', version: '1.2.3', npmArgs: ['--userconfig', '/x'],
    });
    expect(calls).toEqual([['npm', 'view', 'instar@1.2.3', 'version', '--userconfig', '/x']]);
  });
});

describe('otpRequirement (preflight, before anything is mutated)', () => {
  it('reads the account 2FA mode', () => {
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-and-writes', pending: false } }))).toBe('required');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-only', pending: false } }))).toBe('not-required');
    expect(otpRequirement(JSON.stringify({ tfa: false }))).toBe('not-required');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'auth-and-writes', pending: true } }))).toBe('not-required');
  });
  it('anything it cannot read is unknown, never not-required', () => {
    expect(otpRequirement(null)).toBe('unknown');
    expect(otpRequirement('not json')).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ error: { code: 'E403' } }))).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ name: 'x' }))).toBe('unknown');
    expect(otpRequirement(JSON.stringify({ tfa: { mode: 'something-new' } }))).toBe('unknown');
  });
});

describe('ciRunState (publish.yml runs for the merge being released)', () => {
  it('queued or in-progress runs are active', () => {
    expect(ciRunState(JSON.stringify([{ databaseId: 1, status: 'queued' }, { databaseId: 2, status: 'completed' }]))).toEqual({ state: 'active', ids: [1] });
    expect(ciRunState(JSON.stringify([{ databaseId: 3, status: 'in_progress' }]))).toEqual({ state: 'active', ids: [3] });
  });
  it('only completed runs (or none) are clear', () => {
    expect(ciRunState('[]')).toEqual({ state: 'clear', ids: [] });
    expect(ciRunState(JSON.stringify([{ databaseId: 2, status: 'completed' }]))).toEqual({ state: 'clear', ids: [] });
  });
  it('a failed or unreadable gh query is unknown, never clear', () => {
    expect(ciRunState(null).state).toBe('unknown');
    expect(ciRunState('gh: not logged in').state).toBe('unknown');
    expect(ciRunState('{}').state).toBe('unknown');
  });
});

describe('activePublishRuns (ANY publish.yml run, not just this commit)', () => {
  const gh = (answers: Record<string, R>) => {
    const calls: string[][] = [];
    const run = (c: string, a: string[]): R => {
      calls.push([c, ...a]);
      const status = a[a.indexOf('--status') + 1];
      return answers[status] ?? { status: 0, stdout: '[]', stderr: '' };
    };
    return { run, calls };
  };

  it('a run queued for a DIFFERENT (earlier) merge is active — it would publish main when it gets a runner', () => {
    const { run, calls } = gh({
      queued: { status: 0, stdout: JSON.stringify([{ databaseId: 77, status: 'queued', headSha: 'aaaaaaa-earlier-merge' }]), stderr: '' },
    });
    expect(activePublishRuns(run, 'o/r')).toEqual({ state: 'active', ids: [77] });
    // never filtered to one commit
    expect(calls.every((c) => !c.includes('--commit'))).toBe(true);
    // one query per active status
    expect(calls.map((c) => c[c.indexOf('--status') + 1])).toEqual(ACTIVE_RUN_STATUSES);
    expect(calls.every((c) => c.includes('--workflow') && c.includes('publish.yml') && c.includes('o/r'))).toBe(true);
  });

  it('an in-progress run for another sha is active too', () => {
    const { run } = gh({ in_progress: { status: 0, stdout: JSON.stringify([{ databaseId: 5, status: 'in_progress', headSha: 'bbb' }]), stderr: '' } });
    expect(activePublishRuns(run, 'o/r').state).toBe('active');
  });

  it('all empty → clear; ANY failed or unreadable query → unknown (never clear)', () => {
    expect(activePublishRuns(gh({}).run, 'o/r')).toEqual({ state: 'clear', ids: [] });
    expect(activePublishRuns(gh({ waiting: { status: 1, stdout: '', stderr: 'HTTP 502' } }).run, 'o/r').state).toBe('unknown');
    expect(activePublishRuns(gh({ requested: { status: 0, stdout: 'not json', stderr: '' } }).run, 'o/r').state).toBe('unknown');
    expect(activePublishRuns(gh({}).run, null as unknown as string).state).toBe('unknown');
  });
});

describe('ACTIVE_RUN_STATUSES are values the installed gh accepts', () => {
  let ghOk = false;
  try { execFileSync('gh', ['--version'], { stdio: 'ignore' }); ghOk = true; } catch { ghOk = false; }
  it.skipIf(!ghOk)('gh run list accepts every status we query (an invalid one fails every query)', () => {
    const help = spawnSync('gh', ['run', 'list', '--status', 'definitely-not-a-status'], { encoding: 'utf-8' });
    const m = /valid values are \{([^}]+)\}/.exec(`${help.stderr}${help.stdout}`);
    expect(m, 'gh did not print its valid --status values').not.toBeNull();
    const valid = m![1].split('|');
    for (const st of ACTIVE_RUN_STATUSES) expect(valid).toContain(st);
  });
});

describe('npm publish cannot hang on web auth with stdin closed (installed npm)', () => {
  // Echo #2224 round 2 item 3: auth-type web prints a URL and polls. Verify,
  // against the npm actually installed here, that its otplease rethrows EOTP
  // at once when stdin is not a TTY — even for a web-OTP challenge.
  let npmDir: string | null = null;
  try {
    const npmBin = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf-8' }).trim();
    const real = fs.realpathSync(npmBin);
    const dir = path.resolve(path.dirname(real), '..');
    if (fs.existsSync(path.join(dir, 'lib', 'utils', 'auth.js'))) npmDir = dir;
  } catch { npmDir = null; }

  it.skipIf(!npmDir)('otplease rethrows a web-OTP EOTP immediately when stdin is not a TTY', () => {
    const script = `
      const { otplease } = require(${JSON.stringify(path.join(npmDir ?? '', 'lib', 'utils', 'auth.js'))});
      const t0 = Date.now();
      otplease({ config: { get: () => 'web' } }, {}, async () => {
        const e = new Error('otp'); e.code = 'EOTP';
        e.body = { authUrl: 'https://example.invalid/auth', doneUrl: 'https://example.invalid/done' };
        throw e;
      }).then(() => { console.log('RESOLVED'); process.exit(3); },
              (e) => { console.log('REJECTED ' + e.code + ' ' + (Date.now() - t0)); process.exit(0); });
      setTimeout(() => { console.log('HUNG'); process.exit(4); }, 5000);
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    expect(r.stdout).toMatch(/^REJECTED EOTP \d+/m);
    expect(r.status).toBe(0);
  });
});

describe('dirtyToolFilesOnly (--dry-run --allow-dirty-tool-files)', () => {
  it('accepts only the tool\'s own files', () => {
    expect(dirtyToolFilesOnly(' M scripts/release-local.mjs\n?? scripts/lib/release-local-steps.mjs\n M CONTRIBUTING.md\n').ok).toBe(true);
  });
  it('parses real porcelain, including a first line whose leading space was trimmed', () => {
    // The real dry run hit this: the script trims git status output, so
    // ' M CONTRIBUTING.md' arrived as 'M CONTRIBUTING.md' and was misread as 'ONTRIBUTING.md'.
    const trimmed = ' M CONTRIBUTING.md\n M scripts/lint-no-direct-destructive.js\n?? scripts/release-local.mjs'.trim();
    const v = dirtyToolFilesOnly(trimmed);
    expect(v.paths).toEqual(['CONTRIBUTING.md', 'scripts/lint-no-direct-destructive.js', 'scripts/release-local.mjs']);
    expect(v.ok).toBe(true);
  });
  it('refuses anything else — notably package.json and upgrades/, which the dry run restores from HEAD', () => {
    const a = dirtyToolFilesOnly(' M scripts/release-local.mjs\n M package.json\n');
    expect(a.ok).toBe(false);
    expect(a.others).toEqual(['package.json']);
    expect(dirtyToolFilesOnly('?? upgrades/next/x.md\n').ok).toBe(false);
    expect(dirtyToolFilesOnly(' M src/core/x.ts\n').ok).toBe(false);
    expect(dirtyToolFilesOnly('R  scripts/release-local.mjs -> scripts/other.mjs\n').ok).toBe(false);
    expect(dirtyToolFilesOnly('').ok).toBe(false);
  });
});

describe('ciGateAction', () => {
  it('a real run stops on active and on unknown; only an explicit override proceeds unverified', () => {
    expect(ciGateAction({ state: 'clear', dryRun: false, allowUnverified: false })).toBe('proceed');
    expect(ciGateAction({ state: 'active', dryRun: false, allowUnverified: false })).toBe('stop');
    expect(ciGateAction({ state: 'active', dryRun: false, allowUnverified: true })).toBe('stop');
    expect(ciGateAction({ state: 'unknown', dryRun: false, allowUnverified: false })).toBe('stop');
    expect(ciGateAction({ state: 'unknown', dryRun: false, allowUnverified: true })).toBe('proceed-unverified');
  });
  it('a dry run warns instead of stopping', () => {
    expect(ciGateAction({ state: 'active', dryRun: true, allowUnverified: false })).toBe('warn');
    expect(ciGateAction({ state: 'unknown', dryRun: true, allowUnverified: false })).toBe('warn');
  });
});

describe('release-local.mjs wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release-local.mjs'), 'utf-8');
  it('uses the atomic push, refreshes gate refs before publishing, and resolves a failed publish against npm', () => {
    expect(src).toContain('pushReleaseAtomically({');
    expect(src).toContain('publishedStateAfterFailure({');
    const firstRefresh = src.indexOf('refreshGateBaseRefs(quietRun)');
    const publish = src.indexOf("run('npm', ['publish'");
    expect(firstRefresh).toBeGreaterThan(-1);
    expect(firstRefresh).toBeLessThan(publish);
  });
  it('checks publish.yml runs in preflight AND just before publish, and an unknown answer stops a real run', () => {
    const preflight = src.indexOf("checkCiRuns(slug, 'preflight')");
    const again = src.indexOf("checkCiRuns(SLUG, 'just before publish')");
    const npmCi = src.indexOf("must('npm', ['ci'");
    const publish = src.indexOf("run('npm', ['publish'");
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(npmCi);
    expect(again).toBeGreaterThan(npmCi);
    expect(again).toBeLessThan(publish);
    const fn = src.slice(src.indexOf('function checkCiRuns('), src.indexOf('// ── push-only resume'));
    expect(fn).toContain('ciGateAction({ state: verdict.state, dryRun: opts.dryRun, allowUnverified: opts.allowUnverifiedCi })');
    expect(fn.trim().endsWith('fail(what);\n}') || /fail\(what\);\s*\}\s*$/.test(fn)).toBe(true);
  });
  it('decides the OTP question before anything is mutated, and publish can never wait on a prompt', () => {
    const otp = src.indexOf('otpRequirement(');
    const npmCi = src.indexOf("must('npm', ['ci'");
    expect(otp).toBeGreaterThan(-1);
    expect(otp).toBeLessThan(npmCi);
    expect(src).toMatch(/run\('npm', \['publish'[^\n]*\{ noStdin: true, quiet: true, timeoutMs: PUBLISH_TIMEOUT_MS \}/);
    expect(src).toMatch(/const PUBLISH_TIMEOUT_MS = \d+ \* 60 \* 1000;/);
    expect(src).toMatch(/timeout: timeoutMs,/);
  });
  it('passes a CAPTURING runner to the push logic (it reads rev-parse output)', () => {
    expect(src).toContain('pushReleaseAtomically({ run: quietRun,');
    expect(src).not.toMatch(/pushReleaseAtomically\(\{ run(,| ,|: run,)/);
  });
  it('a dry run exercises the npm auth + OTP preflight (warns where a real run stops)', () => {
    const block = src.slice(src.indexOf("step('Preflight: npm auth (npm whoami)')") - 400, src.indexOf('// ── 1-2. install + build'));
    expect(block).not.toMatch(/if \(!opts\.dryRun\) \{\s*step\('Preflight: npm auth/);
    expect(block).toContain("const stopOrWarn = (msg) => { if (opts.dryRun) console.log(");
    expect(block.match(/stopOrWarn\(/g)?.length).toBe(2);
  });
  it('a [skip ci] HEAD does not stop the release — the fragment check decides', () => {
    const pre = src.slice(src.indexOf("if (subject.includes('[skip ci]')) {"), src.indexOf('START_SHA = head;'));
    expect(pre).not.toContain('stopCleanly(');
    expect(pre).not.toContain('fail(');
  });
  it('--keep-tag-on-published prints the reachable-tags note', () => {
    const flow = src.slice(src.indexOf('if (opts.pushOnly) {'), src.indexOf('// ── 0. preflight'));
    expect(flow).toMatch(/if \(opts\.keepTagOnPublished\) \{\s*console\.log\(`\\nNOTE: tag v\$\{version\} is on the published commit, which is NOT in main's history/);
    expect(flow).toContain('release-skip-annotate.mjs');
  });
  it('the dirty-tree preflight tolerates tool files only with the flag, and fails otherwise', () => {
    expect(src).toContain('if (opts.allowDirtyToolFiles && check.ok) {');
    expect(src).toMatch(/if \(opts\.allowDirtyToolFiles && !opts\.dryRun\) \{[^\n]*process\.exit\(2\)/);
  });
  it('--push-only lands only a version already on npm, and never publishes', () => {
    const flow = src.slice(src.indexOf('if (opts.pushOnly) {'), src.indexOf('// ── 0. preflight'));
    expect(flow).toContain('publishedStateAfterFailure(');
    expect(flow.indexOf('publishedStateAfterFailure(')).toBeLessThan(flow.indexOf('push({'));
    expect(flow).not.toContain("'publish'");
    expect(flow).toContain('process.exit(0)');
  });
  it('argument guards', () => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'release-local.mjs');
    const a = spawnSync(process.execPath, [script, '--keep-tag-on-published'], { encoding: 'utf-8' });
    expect(a.status).toBe(2);
    const b = spawnSync(process.execPath, [script, '--push-only', '--dry-run'], { encoding: 'utf-8' });
    expect(b.status).toBe(2);
    const c = spawnSync(process.execPath, [script, '--allow-dirty-tool-files'], { encoding: 'utf-8' });
    expect(c.status).toBe(2);
    expect(c.stderr).toContain('--dry-run only');
  });
  it('an UNKNOWN publish state stops without restoring the tree or claiming nothing was published', () => {
    const failFn = src.slice(src.indexOf('function fail('), src.indexOf('function stopCleanly('));
    const unknownBranch = failFn.slice(failFn.indexOf('if (publishUnknown)'), failFn.indexOf('} else if (published)'));
    expect(unknownBranch).toContain('UNKNOWN');
    expect(unknownBranch).not.toContain('restoreTree');
    expect(unknownBranch).not.toContain('Nothing was published');
    expect(src).toMatch(/state === 'published'[\s\S]*?published = true/);
  });
});
