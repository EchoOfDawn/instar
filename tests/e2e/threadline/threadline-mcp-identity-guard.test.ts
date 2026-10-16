/**
 * An identity.json that exists but cannot be read is never replaced with a new identity (Echo review
 * SEC-15): that would be a new agent, every peer's pin of us would break, and the old key would be lost.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk'));

describe.skipIf(!hasDeps)('threadline-mcp identity guard', () => {
  it('refuses to start over a corrupt identity.json and leaves the file untouched', () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ident-'));
    fs.writeFileSync(path.join(sd, 'identity.json'), '{ "agentId": "trunc');
    const r = spawnSync(process.execPath, [path.join(pkg, 'dist', 'server.js')], {
      env: { ...process.env, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' },
      input: '', encoding: 'utf8', timeout: 15_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exists but is not a readable identity\. Refusing to replace it/);
    expect(fs.readFileSync(path.join(sd, 'identity.json'), 'utf8')).toBe('{ "agentId": "trunc');
  });
});
