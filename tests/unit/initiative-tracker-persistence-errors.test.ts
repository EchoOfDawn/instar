/**
 * InitiativeTracker × TaskFlow — persistence failures must surface and
 * ifMatch must be enforced atomically with the write.
 *
 * Real SQLite TaskFlow store; failures are injected by making a single
 * registry transition reject.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import {
  InitiativeTracker,
  type InitiativeCreateInput,
} from '../../src/core/InitiativeTracker.js';

interface Rig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  tracker: InitiativeTracker;
  cleanup: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-persist-err-test-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const registry = new TaskFlowRegistry({ store });
  const tracker = new InitiativeTracker(dir);
  tracker.setTaskFlowRegistry(registry, 'test-instance-1');
  return {
    dir,
    store,
    registry,
    tracker,
    cleanup: async () => {
      vi.restoreAllMocks();
      store.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/initiative-tracker-persistence-errors.test.ts',
      });
    },
  };
}

function baseInput(id = 'demo'): InitiativeCreateInput {
  return {
    id,
    title: 'Demo Initiative',
    description: 'Persistence error test.',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
    ],
  };
}

/** A fresh tracker over the same store reads only what was durably written. */
function durableRead(r: Rig, id: string) {
  const t = new InitiativeTracker(r.dir);
  t.setTaskFlowRegistry(r.registry, 'test-instance-2');
  return t.get(id);
}

describe('InitiativeTracker persistence errors and atomic ifMatch', () => {
  let r: Rig | undefined;
  afterEach(async () => {
    if (r) await r.cleanup();
    r = undefined;
  });

  it('update rejects when the TaskFlow write fails and leaves stored state unchanged', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(r.registry, 'setFlowWaiting').mockRejectedValueOnce(new Error('disk full'));

    await expect(r.tracker.update('demo', { title: 'New title' })).rejects.toThrow(/disk full|persist/i);

    const stored = durableRead(r, 'demo');
    expect(stored?.title).toBe('Demo Initiative');
    expect(stored?.version).toBe(1);
    // In-process reads agree with the durable store.
    expect(r.tracker.get('demo')?.title).toBe('Demo Initiative');
    expect(r.tracker.list().find((i) => i.id === 'demo')?.title).toBe('Demo Initiative');

    // A retry after the transient failure succeeds.
    const retried = await r.tracker.update('demo', { title: 'New title', ifMatch: 1 });
    expect(retried.title).toBe('New title');
    expect(durableRead(r, 'demo')?.version).toBe(2);
  });

  it('setPhaseStatus() rejects when the TaskFlow write fails', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(r.registry, 'setFlowWaiting').mockRejectedValueOnce(new Error('disk full'));
    await expect(r.tracker.setPhaseStatus('demo', 'plan', 'in-progress')).rejects.toThrow();
    expect(durableRead(r, 'demo')?.phases[0].status).toBe('pending');
  });

  it('create() whose record is durably stored succeeds even if a later status transition fails, and the next write repairs the flow', async () => {
    r = await rig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(r.registry, 'startStep').mockRejectedValueOnce(new Error('transient'));
    const created = await r.tracker.create(baseInput());
    expect(created.id).toBe('demo');
    expect(durableRead(r, 'demo')?.title).toBe('Demo Initiative');

    const updated = await r.tracker.update('demo', { title: 'Repaired', ifMatch: 1 });
    expect(updated.version).toBe(2);
    expect(durableRead(r, 'demo')?.title).toBe('Repaired');
  });

  it('create() that fails before anything is stored rejects and can be retried', async () => {
    r = await rig();
    vi.spyOn(r.registry, 'createFlow').mockRejectedValueOnce(new Error('disk full'));
    await expect(r.tracker.create(baseInput())).rejects.toThrow();
    expect(r.tracker.get('demo')).toBeUndefined();
    expect(r.tracker.list().some((i) => i.id === 'demo')).toBe(false);
    const created = await r.tracker.create(baseInput());
    expect(created.version).toBe(1);
  });

  it('concurrent updates with the same ifMatch: exactly one wins, the other gets a version mismatch', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate a slow store: each state-bearing transition yields before
    // writing, opening the window between the ifMatch check and the write.
    const reg = r.registry;
    const realWaiting = reg.setFlowWaiting.bind(reg);
    vi.spyOn(reg, 'setFlowWaiting').mockImplementation(async (args) => {
      await new Promise((res) => setTimeout(res, 5));
      return realWaiting(args);
    });

    const results = await Promise.allSettled([
      r.tracker.update('demo', { title: 'A', ifMatch: 1 }),
      r.tracker.update('demo', { title: 'B', ifMatch: 1 }),
    ]);
    const fulfilled = results.filter((x) => x.status === 'fulfilled');
    const rejected = results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error).name).toBe('OccVersionMismatchError');

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ title: string }>).value.title;
    const stored = durableRead(r, 'demo');
    expect(stored?.version).toBe(2);
    expect(stored?.title).toBe(winner);
  });

  it('updating a terminal initiative does not throw', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { status: 'archived' });
    await expect(r.tracker.update('demo', { title: 'after archive' })).resolves.toBeDefined();
  });
});
