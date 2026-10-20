#!/usr/bin/env node
/**
 * release-local — run the publish job of .github/workflows/publish.yml on this
 * machine, in the same order, with the same scripts, failing closed at every
 * step.
 *
 * Why: GitHub's runners have been starved for days at a time, and a merged
 * change does not reach anyone until publish.yml gets a runner. Releasing from
 * a workstation is the default when CI is starved (Justin, 2026-10-20). This
 * script is that path as one command, so a local release is the same release
 * CI would have made rather than a hand-run approximation of it.
 *
 * Usage:
 *   npm run release:local -- [--dry-run] [--userconfig <path>] [--remote <name>]
 *   node scripts/release-local.mjs --dry-run
 *
 *   --dry-run          every step up to (not including) npm publish, the
 *                      commit and the push; reports the version it would
 *                      publish, then restores the tree.
 *   --userconfig PATH  npm config file holding the publish auth (passed to
 *                      npm as --userconfig). Without it npm uses your normal
 *                      config. This script never reads or prints a token.
 *   --remote NAME      git remote for main (default: origin).
 *
 * Steps, mirroring publish.yml's `publish` job one for one:
 *   0. preflight: clean tree, HEAD == <remote>/main after a fetch (a --dry-run
 *      only warns, so a branch can be rehearsed), HEAD is not
 *      a [skip ci] commit (the job's `if:`), npm auth works (real run only)
 *   1. npm ci (dev deps included)        2. npm run build
 *   3. assemble-next-md                  4. NEXT.md content check (skip rules)
 *      4b. on skip: release-skip-annotate (signal only), then stop
 *   5. resolve-release-tier (skip / error exactly as CI)
 *   6. resolve-publish-version + npm version
 *   7. rename NEXT.md, delete consumed upgrades/next/*.md
 *   8. check-upgrade-guide
 *   9. prepublishOnly's gates, run up front so --dry-run covers them:
 *      verify-codex-stage-b-release-evidence + check-contract-evidence
 *  10. npm publish --access public   (NOT --provenance: that needs CI's OIDC)
 *  11. post-publish-smoke
 *  12. commit "chore: release vX [skip ci]" WITH hooks, push to main with
 *      publish.yml's rebase-retry loop, then tag vX and push the tag.
 *
 * Before publish, any failure restores package.json, package-lock.json and
 * upgrades/ to HEAD (the tree was required clean at the start, so only this
 * script's own edits are undone). After publish, nothing is undone: the
 * version is on npm and the release commit has to land.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dryRun: false, userconfig: null, remote: 'origin' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--userconfig') opts.userconfig = argv[++i];
  else if (a.startsWith('--userconfig=')) opts.userconfig = a.slice('--userconfig='.length);
  else if (a === '--remote') opts.remote = argv[++i];
  else if (a.startsWith('--remote=')) opts.remote = a.slice('--remote='.length);
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node scripts/release-local.mjs [--dry-run] [--userconfig <npmrc path>] [--remote <name>]');
    process.exit(0);
  } else {
    console.error(`release-local: unknown argument ${a}`);
    process.exit(2);
  }
}
if (opts.userconfig !== null) {
  if (!opts.userconfig) { console.error('release-local: --userconfig needs a path'); process.exit(2); }
  opts.userconfig = path.resolve(opts.userconfig);
  if (!fs.existsSync(opts.userconfig)) { console.error(`release-local: --userconfig file not found: ${opts.userconfig}`); process.exit(2); }
}
if (!opts.remote) { console.error('release-local: --remote needs a name'); process.exit(2); }
const npmAuthArgs = opts.userconfig ? ['--userconfig', opts.userconfig] : [];

// ── helpers ───────────────────────────────────────────────────────────
let stepNo = 0;
let touchedTree = false; // set once this script edits tracked files
let published = false;
let START_SHA = null; // origin/main when the release began (the merge being shipped)
let SLUG = null;      // owner/repo of the remote, for the gh hint

function step(title) {
  stepNo += 1;
  console.log(`\n── [${stepNo}] ${title}`);
}

/** Run a command. stdio inherited unless capture; returns {status, stdout, stderr}. */
function run(cmd, args, { capture = false, env = process.env, quiet = false } = {}) {
  if (!quiet) console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: 1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function must(cmd, args, o = {}) {
  const r = run(cmd, args, o);
  if (r.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited ${r.status}${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
  return r;
}

function restoreTree() {
  if (!touchedTree) return;
  console.log('\nRestoring package.json, package-lock.json and upgrades/ to HEAD (this script\'s own edits only; the tree was clean at the start).');
  run('git', ['checkout', 'HEAD', '--', 'package.json', 'package-lock.json', 'upgrades'], { quiet: true });
  // Untracked files under upgrades/ can only be ours (NEXT.md, <version>.md):
  // the preflight refused to start with any untracked file present.
  run('git', ['clean', '-fq', '--', 'upgrades'], { quiet: true });
  touchedTree = false;
}

function fail(msg) {
  console.error(`\n✗ release-local FAILED: ${msg}`);
  if (published) {
    console.error('  The version IS on npm. Nothing was undone. Land the release commit (package.json,');
    console.error('  package-lock.json, upgrades/) on main by hand, the way step 12 would have.');
  } else {
    restoreTree();
    console.error('  Nothing was published.');
  }
  process.exit(1);
}

function stopCleanly(msg) {
  console.log(`\n■ ${msg}`);
  restoreTree();
  process.exit(0);
}

function readPkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
}

function repoSlug(remote) {
  const url = run('git', ['remote', 'get-url', remote], { capture: true, quiet: true }).stdout.trim();
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  return { url, slug: m ? m[1] : null };
}

// ── 0. preflight ──────────────────────────────────────────────────────
console.log(`release-local${opts.dryRun ? ' (DRY RUN — no publish, no commit, no push)' : ''}`);
console.log(`node ${process.version} (publish.yml uses node 20); repo ${ROOT}`);

step('Preflight: clean tree on an up-to-date main');
{
  const top = must('git', ['rev-parse', '--show-toplevel'], { capture: true, quiet: true }).stdout.trim();
  if (fs.realpathSync(top) !== fs.realpathSync(ROOT)) fail(`run this from the repo that contains it (git top-level is ${top})`);
  const dirty = must('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true, quiet: true }).stdout.trim();
  if (dirty) fail(`the working tree is not clean:\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  must('git', ['fetch', '--quiet', opts.remote, 'main']);
  const head = must('git', ['rev-parse', 'HEAD'], { capture: true, quiet: true }).stdout.trim();
  const remoteMain = must('git', ['rev-parse', `${opts.remote}/main`], { capture: true, quiet: true }).stdout.trim();
  if (head !== remoteMain && opts.dryRun) {
    // A dry run publishes nothing, so it may rehearse a branch (e.g. a PR that
    // changes the release path). A real run may not.
    console.log(`WARNING: HEAD (${head.slice(0, 10)}) is not ${opts.remote}/main (${remoteMain.slice(0, 10)}). ` +
      'Allowed for --dry-run only; a real release refuses this.');
  } else if (head !== remoteMain) {
    fail(`HEAD (${head.slice(0, 10)}) is not ${opts.remote}/main (${remoteMain.slice(0, 10)}). ` +
      `A release is cut from main exactly as it is on the remote: git checkout --detach ${opts.remote}/main`);
  }
  const { url, slug } = repoSlug(opts.remote);
  console.log(`HEAD = ${opts.remote}/main = ${head.slice(0, 10)} (${url})`);
  // The job's `if: !contains(head_commit.message, '[skip ci]')`.
  const subject = must('git', ['log', '-1', '--format=%B', 'HEAD'], { capture: true, quiet: true }).stdout;
  if (subject.includes('[skip ci]')) {
    stopCleanly('HEAD is a [skip ci] commit (normally the last release cut) — publish.yml would not run for it. Nothing to release.');
  }
  START_SHA = head;
  SLUG = slug;
}

if (!opts.dryRun) {
  step('Preflight: npm auth (npm whoami)');
  const who = run('npm', ['whoami', ...npmAuthArgs], { capture: true });
  if (who.status !== 0) fail('npm is not authenticated for publishing. Log in (npm login) or pass --userconfig <npmrc with the publish token>.');
  console.log(`npm user: ${who.stdout.trim()}`);
}

// ── 1-2. install + build ──────────────────────────────────────────────
step('npm ci (dev dependencies included)');
// publish.yml runs a plain `npm ci` on a runner where dev deps install by
// default. A workstation may carry NODE_ENV=production / omit=dev, which makes a
// plain `npm ci` skip tsc and friends — so force the CI-equivalent install.
must('npm', ['ci', '--include=dev'], { env: { ...process.env, NODE_ENV: 'development' } });

step('npm run build');
must('npm', ['run', 'build']);

// ── 3-4. release notes ────────────────────────────────────────────────
step('Assemble release-note fragments (scripts/assemble-next-md.mjs)');
touchedTree = true;
must('node', ['scripts/assemble-next-md.mjs']);

step('Check if NEXT.md has content to publish');
{
  const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
  let skipReason = null;
  if (!fs.existsSync(nextPath)) {
    skipReason = 'No NEXT.md found — nothing to publish';
  } else {
    const content = fs.readFileSync(nextPath, 'utf-8');
    if (content.includes('[Feature name]') && content.includes('[Capability]')) {
      skipReason = 'NEXT.md is still a template — nothing to publish';
    } else if (content.split('\n').some((line) => /<!--[ \t\v\f\r]*auto-draft-unreviewed/.test(line))) {
      skipReason = 'NEXT.md still has auto-draft-unreviewed markers — awaiting human review, not publishing';
    }
  }
  if (skipReason) {
    console.log(skipReason);
    step('Loud-skip annotation (scripts/release-skip-annotate.mjs — signal only)');
    run('git', ['fetch', '--quiet', '--tags', opts.remote, 'main']);
    run('node', ['scripts/release-skip-annotate.mjs']);
    stopCleanly(`Publish skipped: ${skipReason}`);
  }
  console.log('NEXT.md has content — proceeding');
}

// ── 5. release-tier gate ──────────────────────────────────────────────
step('Release-tier gate (scripts/resolve-release-tier.mjs)');
function npmPublishedVersion() {
  const r = run('npm', ['view', 'instar', 'version'], { capture: true });
  const v = r.stdout.trim();
  // publish.yml falls back to "0.0.0" when `npm view` fails. Locally that would
  // resolve the version from package.json alone, so fail closed instead.
  if (r.status !== 0 || !SEMVER.test(v)) fail(`could not read the published instar version from npm (npm view exited ${r.status}: ${r.stderr.trim().split('\n').pop() || v})`);
  return v;
}
{
  const npmVersion = npmPublishedVersion();
  const localVersion = readPkgVersion();
  console.log(`npm has:      ${npmVersion}\npackage.json: ${localVersion}`);
  const r = run('node', ['scripts/resolve-release-tier.mjs', localVersion, npmVersion], { capture: true });
  const decision = r.stdout.trim();
  const reason = r.stderr.trim();
  console.log(`tier reason: ${reason}`);
  if (r.status !== 0) fail(`release-tier: ${reason}`);
  if (decision === 'skip') stopCleanly(`Publish skipped — release-tier gate: ${reason}. To resume publishing, edit .instar/release-tier.json.`);
  if (decision !== 'allow') fail(`release-tier printed an unexpected decision ${JSON.stringify(decision)}`);
}

// ── 6. version ────────────────────────────────────────────────────────
step('Determine next version (scripts/resolve-publish-version.mjs + npm version)');
let VERSION;
{
  const npmVersion = npmPublishedVersion();
  const localVersion = readPkgVersion();
  console.log(`npm has:        ${npmVersion}\npackage.json:   ${localVersion}`);
  VERSION = must('node', ['scripts/resolve-publish-version.mjs', localVersion, npmVersion], { capture: true }).stdout.trim();
  if (!SEMVER.test(VERSION)) fail(`resolve-publish-version printed ${JSON.stringify(VERSION)}, not X.Y.Z`);
  console.log(`resolved:       ${VERSION}`);
  must('npm', ['version', VERSION, '--no-git-tag-version', '--allow-same-version']);
  if (readPkgVersion() !== VERSION) fail(`npm version did not set package.json to ${VERSION}`);
}

// ── 7. rename + consume fragments ─────────────────────────────────────
step(`Rename NEXT.md to upgrades/${VERSION}.md; remove consumed fragments`);
{
  const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
  const guidePath = path.join(ROOT, 'upgrades', `${VERSION}.md`);
  if (fs.existsSync(nextPath)) {
    fs.renameSync(nextPath, guidePath);
    console.log(`Renamed upgrades/NEXT.md → upgrades/${VERSION}.md`);
  } else {
    console.log('No upgrades/NEXT.md found — check-upgrade-guide will enforce');
  }
  const nextDir = path.join(ROOT, 'upgrades', 'next');
  const frags = fs.existsSync(nextDir) ? fs.readdirSync(nextDir).filter((f) => f.endsWith('.md')) : [];
  for (const f of frags) fs.unlinkSync(path.join(nextDir, f));
  if (frags.length) console.log(`Removed ${frags.length} consumed release-note fragment(s) from upgrades/next/`);
}

// ── 8. upgrade guide ──────────────────────────────────────────────────
step('Check upgrade guide (scripts/check-upgrade-guide.js)');
must('node', ['scripts/check-upgrade-guide.js']);

// ── 9. prepublishOnly gates, up front ─────────────────────────────────
step('Publish gates from prepublishOnly (Stage-B release evidence, contract evidence)');
// npm publish runs prepublishOnly again (build + these + check:upgrade-guide);
// running them here first means a --dry-run proves them too.
must('node', ['scripts/verify-codex-stage-b-release-evidence.mjs']);
must('node', ['scripts/check-contract-evidence.js']);

if (opts.dryRun) {
  const guide = `upgrades/${VERSION}.md`;
  console.log('\n══ DRY RUN COMPLETE ══');
  console.log(`Would publish:  instar@${VERSION}  (npm publish --access public, without --provenance)`);
  console.log(`Would commit:   "chore: release v${VERSION} [skip ci]" (package.json, package-lock.json, ${guide}, consumed fragments) with hooks`);
  console.log(`Would push:     HEAD → ${opts.remote}/main (rebase-retry ×5), then tag v${VERSION}`);
  stopCleanly('Dry run: tree restored. Nothing was published, committed or pushed.');
}

// ── 10. publish ───────────────────────────────────────────────────────
step(`npm publish instar@${VERSION}`);
console.log('NOTE: publishing WITHOUT --provenance. npm provenance needs the GitHub Actions OIDC');
console.log('      token, which only exists inside a CI run. This release will carry no provenance');
console.log('      attestation; everything else matches publish.yml.');
must('npm', ['publish', '--access', 'public', ...npmAuthArgs]);
published = true;

// ── 11. smoke ─────────────────────────────────────────────────────────
step('Post-publish smoke test (scripts/post-publish-smoke.mjs)');
must('node', ['scripts/post-publish-smoke.mjs', VERSION]);

// ── 12. commit, push, tag ─────────────────────────────────────────────
step(`Commit "chore: release v${VERSION} [skip ci]" (hooks run) and push to main`);
must('git', ['add', 'package.json', 'package-lock.json', 'upgrades/']);
must('git', ['commit', '-m', `chore: release v${VERSION} [skip ci]`]);
{
  let pushed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (run('git', ['push', opts.remote, 'HEAD:main']).status === 0) { pushed = true; break; }
    console.log(`push rejected — main moved (likely a concurrent merge); rebasing and retrying (attempt ${attempt})`);
    must('git', ['fetch', opts.remote, 'main']);
    if (run('git', ['rebase', `${opts.remote}/main`]).status !== 0) {
      run('git', ['rebase', '--abort']);
      fail('the release commit could not be rebased cleanly onto main (conflict) — aborted rather than force-pushing');
    }
  }
  if (!pushed) fail('could not push the release commit after 5 rebase-retries');
}
must('git', ['tag', `v${VERSION}`]);
must('git', ['push', opts.remote, `v${VERSION}`]);

const releaseSha = run('git', ['rev-parse', 'HEAD'], { capture: true, quiet: true }).stdout.trim();
const startSha = START_SHA;
const slug = SLUG || '<owner>/<repo>';
console.log(`\n══ RELEASED instar@${VERSION} ══  (release commit ${releaseSha.slice(0, 10)}, tag v${VERSION})`);
console.log(`\nThe merge that this release ships (${startSha.slice(0, 10)}) also queued a publish.yml run on GitHub.`);
console.log('When it gets a runner it will find no fragments and skip, but cancel it so it does not hold the');
console.log('publish concurrency group:');
console.log(`  gh run list -R ${slug} --workflow publish.yml --commit ${startSha} --json databaseId,status -q '.[] | select(.status != "completed") | .databaseId' | xargs -n1 gh run cancel -R ${slug}`);
