/**
 * "Connecting to another agent" — agent knowledge for the pairing-by-invite flow
 * (docs/specs/a2a-pairing-invite-link.md §3).
 *
 * Why: a brand-new agent asked its person for the other agent's "Threadline
 * fingerprint" and offered to "package a bundle" instead of offering an invite
 * (Justin, topic 61599, 2026-10-20). The invite flow existed; the agent's
 * knowledge framed it only around sharing credentials.
 *
 * Covers: the template carries the key instructions (Agent Awareness), the
 * migration delivers the SAME section to an existing agent exactly once
 * (Migration Parity), the self-knowledge tree serves it, and triage routes a
 * "connect with X" question to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { AGENT_CONNECT_HEADING, agentConnectSection, generateClaudeMd } from '../../src/scaffold/templates.js';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { TreeTraversal } from '../../src/knowledge/TreeTraversal.js';
import { TreeTriage } from '../../src/knowledge/TreeTriage.js';
import { ProbeRegistry } from '../../src/knowledge/ProbeRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test' });
}
function runClaudeMd(projectDir: string): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator(projectDir) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
function runTree(projectDir: string): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator(projectDir) as unknown as { migrateSelfKnowledgeTree(r: MigrationResult): void }).migrateSelfKnowledgeTree(r);
  return r;
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

// What an agent scaffolded before this change has: the Threadline section with
// its tools list, and no "Connecting to another agent".
const OLD_THREADLINE = `# CLAUDE.md — test

## Threadline Network (Agent-to-Agent Communication)

### How to Use

- "Connect to the agent network" → I'll enable the relay

### MCP Tools Available

- \`threadline_send\` — Send a message to another agent

### One identity across my machines (agent identity)

I am ONE agent.
`;

describe('Connecting to another agent: the instruction itself', () => {
  const section = agentConnectSection(4042);

  it('tells the agent to OFFER an invite, with the real tool and route', () => {
    expect(section.startsWith(AGENT_CONNECT_HEADING + '\n')).toBe(true);
    expect(section).toContain('I OFFER AN INVITE');
    expect(section).toContain('`threadline_pair` with `action: "invite"`');
    expect(section).toContain('POST /threadline/pairing/invites');
  });

  it('never asks the person for a fingerprint, settings or a bundle', () => {
    expect(section).toContain('I never ask my person for a fingerprint');
    expect(section).toContain('I never ask them to edit settings');
    expect(section).toMatch(/never offer a "bundle"/);
    expect(section).toContain('If I need the other agent\'s fingerprint, I look it up myself.');
  });

  it('says a PERSON carries the invite, outside the agent network, never over Threadline', () => {
    expect(section).toContain('A person carries the invite, outside the agent network.');
    expect(section).toContain('I never send it over Threadline');
    expect(section).toContain('Send this privately to Echo\'s person');
    expect(section).toContain('forward it to Echo\'s Telegram chat');
  });

  it('explains Approve (their person), Finish (mine) and how to check status', () => {
    expect(section).toContain('tap **Approve**');
    expect(section).toContain('**Finish pairing**');
    expect(section).toContain('No agent can approve for a person');
    expect(section).toContain('http://localhost:4042/threadline/pairing');
    expect(section).toContain('`mutual-verified`');
    expect(section).toContain('GET /threadline/pairing/invites');
  });

  it('when pairing is switched off, the agent switches it on itself (the exact keys)', () => {
    expect(section).toContain('`threadline.relayEnabled` and `threadline.verifiedPairing.enabled`');
    expect(section).toContain('I switch both on myself');
  });

  it('uses the port it is given', () => {
    expect(agentConnectSection(5555)).toContain('http://localhost:5555/threadline/pairing');
  });
});

describe('Connecting to another agent: new agents (template)', () => {
  it('appears once, inside the Threadline section, before the MCP tools list', () => {
    const md = generateClaudeMd('test', 'Test', 4042, true);
    expect(count(md, AGENT_CONNECT_HEADING)).toBe(1);
    expect(md).toContain(agentConnectSection(4042) + '\n### MCP Tools Available\n');
    const threadlineIdx = md.indexOf('## Threadline Network (Agent-to-Agent Communication)');
    expect(threadlineIdx).toBeGreaterThan(-1);
    expect(md.indexOf(AGENT_CONNECT_HEADING)).toBeGreaterThan(threadlineIdx);
  });

  it('lists threadline_pair among the Threadline tools and maps "connect with X" to an invite', () => {
    const md = generateClaudeMd('test', 'Test', 4042, true);
    expect(md).toContain('- `threadline_pair` — Pair with another agent');
    expect(md).toContain('"Connect with Echo" / "talk to <an agent>" / "pair with <an agent>" → I make a pairing invite');
  });
});

describe('Connecting to another agent: existing agents (migration)', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-connect-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/agent-connect-knowledge.test.ts:cleanup' }));

  it('delivers the same section once, before the Threadline tools list; a second run changes nothing', () => {
    fs.writeFileSync(claudeMd, OLD_THREADLINE);
    const r1 = runClaudeMd(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added "Connecting to another agent" (pairing by invite)');
    expect(count(once, AGENT_CONNECT_HEADING)).toBe(1);
    // Byte-identical to what a new agent gets, in the same place.
    expect(once).toContain(agentConnectSection(4042) + '\n### MCP Tools Available\n');
    // Nothing the agent already had is lost.
    expect(once).toContain('### One identity across my machines (agent identity)\n\nI am ONE agent.');

    const r2 = runClaudeMd(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: "Connecting to another agent" already present');
  });

  it('appends the whole section when the agent has no Threadline tools heading', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md — test\n\nSome custom file.\n');
    runClaudeMd(projectDir);
    const md = fs.readFileSync(claudeMd, 'utf8');
    expect(count(md, AGENT_CONNECT_HEADING)).toBe(1);
    expect(md).toContain('Some custom file.\n');
    // Appended whole (later migrations may append after it).
    expect(md).toContain('\n' + agentConnectSection(4042));
  });

  it('a freshly scaffolded agent is left alone (already has it)', () => {
    const fresh = generateClaudeMd('test', 'Test', 4042, true);
    fs.writeFileSync(claudeMd, fresh);
    const r = runClaudeMd(projectDir);
    expect(r.skipped).toContain('CLAUDE.md: "Connecting to another agent" already present');
    expect(count(fs.readFileSync(claudeMd, 'utf8'), AGENT_CONNECT_HEADING)).toBe(1);
  });
});

describe('Connecting to another agent: self-knowledge tree', () => {
  let projectDir: string; let stateDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-connect-tree-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/agent-connect-knowledge.test.ts:tree-cleanup' }));

  it('an existing tree without the node gets it on update, and it serves the CLAUDE.md section', async () => {
    // An existing agent's tree from before this change: generate, then strip the node.
    const gen = new TreeGenerator();
    const before = gen.generate({ projectDir, stateDir, agentName: 'test', hasMemory: true, hasJobs: true, hasDecisionJournal: true });
    for (const layer of before.layers) layer.children = layer.children.filter((n) => n.id !== 'capabilities.agent_connect');
    gen.save(before, stateDir);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'self-knowledge-tree.json'), 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('capabilities.agent_connect');

    const r = runTree(projectDir);
    expect(r.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'self-knowledge-tree.json'), 'utf8'));
    const caps = after.layers.find((l: { id: string }) => l.id === 'capabilities');
    const node = caps.children.find((n: { id: string }) => n.id === 'capabilities.agent_connect');
    expect(node).toBeDefined();
    expect(node.managed).toBe(true);
    expect(node.description).toContain('OFFER AN INVITE');
    expect(node.description).toContain('Never ask for a fingerprint');

    // The node's source reads the section out of the agent's CLAUDE.md.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), generateClaudeMd('test', 'Test', 4042, true));
    const traversal = new TreeTraversal({ projectDir, stateDir, probeRegistry: new ProbeRegistry() });
    const { fragments, errors } = await traversal.gather([node], { capabilities: 1 });
    expect(errors).toEqual([]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].content).toContain('I OFFER AN INVITE');
    expect(fragments[0].content).toContain('**Finish pairing**');
    // The section stops at the next heading, not the rest of the file.
    expect(fragments[0].content).not.toContain('### MCP Tools Available');
  });

  it('triage routes "connect with Echo" to the node', async () => {
    const gen = new TreeGenerator();
    const tree = gen.generate({ projectDir, stateDir, agentName: 'test', hasMemory: true, hasJobs: true, hasDecisionJournal: true });
    const triage = new TreeTriage(null);
    for (const q of ['can you connect with Echo?', 'please pair with Scout', 'what is the fingerprint of Echo']) {
      const result = await triage.triage(q, tree.layers);
      expect(result.nodeScores?.['capabilities.agent_connect'] ?? 0, q).toBeGreaterThan(0);
    }
  });
});
