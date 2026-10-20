/**
 * Tier-1 invariant: CI must supersede its own stale runs.
 *
 * WHY THIS TEST EXISTS (measured 2026-10-20). GitHub Actions concurrency is
 * account-wide, shared across every repo this owner has. With instar-2 holding 10
 * jobs running and 25 queued, this repo ran at ~3 concurrent jobs against a 20-job
 * allowance: one PR needs 8 unit shards, so a single heavy run took 17-19h and a
 * one-line test-config fix sat 3h54m in the queue.
 *
 * The avoidable half of that waste is supersession. With no `concurrency` block,
 * every push to a branch started a NEW 13-job run while the previous one kept
 * consuming shared slots, so 126 stale runs had to be cancelled BY HAND in one
 * night. A superseded run is waste by definition — nobody is waiting on its result.
 *
 * This is the Structure-beats-Willpower half of that fix: the block can no longer be
 * dropped silently, because removing it fails here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');

function loadCi(): Record<string, unknown> {
  const parsed = yaml.load(readFileSync(CI_PATH, 'utf8'));
  // A workflow that does not parse as a mapping is a broken workflow, not a pass.
  expect(parsed).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

describe('ci.yml concurrency invariant', () => {
  it('declares a top-level concurrency block', () => {
    const ci = loadCi();
    expect(ci.concurrency, 'ci.yml must declare `concurrency` so stale runs supersede').toBeTruthy();
  });

  it('groups by PR so every event type for one PR shares a slot', () => {
    const c = loadCi().concurrency as { group?: string };
    expect(typeof c.group).toBe('string');
    // pull_request and pull_request_review must land in the SAME group, else a
    // review event spawns a second full 13-job run alongside the push run.
    expect(c.group).toContain('github.event.pull_request.number');
    // And a push to main (no PR number) must still resolve to something stable.
    expect(c.group).toContain('github.ref');
  });

  it('cancels superseded branch runs but NEVER main', () => {
    const c = loadCi().concurrency as { 'cancel-in-progress'?: unknown };
    const cancel = c['cancel-in-progress'];
    expect(cancel, '`cancel-in-progress` must be set, or stale runs still pile up').toBeDefined();
    // Main's post-merge run is the release gate and its record is the evidence a
    // merge was sound, so a blanket `true` is WRONG here — it must exclude main.
    expect(String(cancel)).toContain("github.ref != 'refs/heads/main'");
  });

  it('keeps the unit matrix at the shard count the capacity math assumes', () => {
    // Not a style check: the 8-shard figure is what makes a single PR cost ~2h of
    // shared allowance. If this grows, the concurrency fix alone stops being enough
    // and the capacity question has to be re-opened deliberately.
    const jobs = loadCi().jobs as Record<string, { strategy?: { matrix?: Record<string, unknown[]> } }>;
    const matrix = jobs.unit?.strategy?.matrix;
    expect(matrix).toBeTruthy();
    const nodes = (matrix!['node-version'] ?? []).length;
    const shards = (matrix!.shard ?? []).length;
    expect(nodes * shards).toBe(8);
  });
});
