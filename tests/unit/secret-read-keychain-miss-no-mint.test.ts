/**
 * Feedback cluster "repeated secret reads on a keychain miss mint a new master
 * key": a READ of an existing vault (the path secret-get.mjs uses —
 * `new SecretStore({ stateDir }).read()`) must never create, replace or rotate
 * key material. When the keychain entry is unavailable the read fails clearly,
 * and once access is restored the original vault still decrypts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, type KeychainOps } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('secret read on a keychain miss', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-read-miss-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-read-keychain-miss-no-mint.test.ts' });
  });

  it('repeated reads during a keychain miss never mint or replace a master key and the vault stays decryptable', () => {
    // Fake keychain whose availability we can toggle; records every write.
    const entries = new Map<string, Buffer>();
    let available = true;
    const writes: string[] = [];
    const ops: KeychainOps = {
      read: (service, account) => (available ? entries.get(`${service}:${account}`) ?? null : null),
      write: (service, account, key) => {
        writes.push(account);
        entries.set(`${service}:${account}`, key);
        return true;
      },
    };

    // Disposable vault with a known secret, keyed in the (fake) keychain.
    new SecretStore({ stateDir, keychainOps: ops }).write({ dashboardPin: '4821' });
    const keyFile = path.join(stateDir, 'machine', 'secrets-master.key');
    const before = new Map([...entries].map(([k, v]) => [k, Buffer.from(v)]));
    const fileKeyBefore = fs.existsSync(keyFile);
    writes.length = 0;

    // Keychain entry becomes unavailable; a background loop keeps reading.
    available = false;
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        new SecretStore({ stateDir, keychainOps: ops }).read();
        outcomes.push('ok');
      } catch {
        outcomes.push('error');
      }
    }

    // Reads fail clearly …
    expect(outcomes).toEqual(['error', 'error', 'error']);
    // … and leave key material untouched.
    expect(writes).toEqual([]);
    expect(fs.existsSync(keyFile)).toBe(fileKeyBefore);
    expect([...entries.keys()]).toEqual([...before.keys()]);
    for (const [k, v] of before) expect(entries.get(k)!.equals(v)).toBe(true);

    // Access restored → the original vault still decrypts.
    available = true;
    expect(new SecretStore({ stateDir, keychainOps: ops }).read()).toEqual({ dashboardPin: '4821' });
  });
});
