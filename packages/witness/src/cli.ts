#!/usr/bin/env node
/**
 * `witness` — the standalone command line for agents that do not run Instar
 * (for example an agent on threadline-mcp). It reads the agent's Threadline
 * identity file (~/.threadline/identity.json: base64 Ed25519 keys) and keeps its
 * own Witness key and local store in a separate directory.
 *
 *   witness init                      create the Witness key (once; never overwritten)
 *   witness bind --agent <did>        bind the Witness key to the Threadline key (both sign)
 *   witness sign --subject <did> --claim <claim> --context <text> [--evidence <item>]... [--confidence <0-100>]
 *   witness verify <record.json> --binding <binding.json>
 *   witness seal-evidence <seal-file> [--url <where-to-fetch>]
 *   witness export                    the binding chain and every record, as JSON
 *
 * Registry commands — the ONLY ones that talk to a network, and only when run:
 *   witness publish <record.json> --binding <binding.json>   verify locally, then POST to the registry
 *   witness lookup --subject <did> | --issuer <did> [--limit N] [--cursor C]   re-verifies every record
 *   witness get <recordHash>          one record from the registry, re-verified here
 *   witness stats                     the registry's own counts (its word, unverified)
 *   --registry <url> picks the server; without it the current default (DEFAULT_REGISTRY in registry.ts) is used,
 *   and every registry command prints the server it talked to as `registry`.
 *
 * Common options: --home <dir> (default $WITNESS_HOME or ~/.threadline/witness),
 * --identity <file> (default ~/.threadline/identity.json). Output is JSON on stdout;
 * errors go to stderr with exit code 1. Nothing is ever sent anywhere except by the
 * four registry commands above, each of which names the server it talks to.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadOrCreateWitnessKey, KEY_FILE_NAME } from './keyfile.js';
import { publicKeyFromPrivate, type WitnessKeyPair } from './keys.js';
import { createBinding, verifyBinding, threadlineFingerprint, type KeyBinding } from './binding.js';
import { createRecord, CLAIMS, type Claim } from './record.js';
import { WitnessStore } from './store.js';
import { publicKeyFromDidKey } from './didkey.js';
import { recordHash } from './record.js';
import { verifyRecordWithBinding } from './localverify.js';
import {
  LOOKUP_MAX_LIMIT, RegistryError, UNVERIFIED_NOTE, assessLookupPage, assessSingleRecord, registryBase, registryRequest,
} from './registry.js';

const BINDING_FILE = 'binding.json';

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function defaultHome(): string {
  return process.env.WITNESS_HOME || path.join(os.homedir(), '.threadline', 'witness');
}

function defaultIdentity(): string {
  return path.join(os.homedir(), '.threadline', 'identity.json');
}

/** The Threadline identity as hex, checked for internal consistency. */
export function readThreadlineIdentity(file: string): { publicKey: string; privateKey: string; fingerprint: string } {
  if (!fs.existsSync(file)) fail(`no Threadline identity at ${file} (pass --identity)`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON`);
  }
  const decode = (field: string): string => {
    const v = raw[field];
    if (typeof v !== 'string') fail(`${file}: missing ${field}`);
    const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
    if (buf.length !== 32) fail(`${file}: ${field} is not a 32-byte key`);
    return buf.toString('hex');
  };
  const publicKey = decode('publicKey');
  const privateKey = decode('privateKey');
  if (publicKeyFromPrivate(privateKey) !== publicKey) fail(`${file}: publicKey does not match privateKey`);
  const fingerprint = threadlineFingerprint(publicKey);
  if (typeof raw.agentId === 'string' && raw.agentId.toLowerCase() !== fingerprint) {
    fail(`${file}: agentId does not match publicKey`);
  }
  return { publicKey, privateKey, fingerprint };
}

function readJson(file: string, what: string): unknown {
  if (!fs.existsSync(file)) fail(`no ${what} at ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${file} is not JSON`);
  }
}

function existingKey(home: string): WitnessKeyPair {
  if (!fs.existsSync(path.join(home, KEY_FILE_NAME))) fail(`no Witness key in ${home}; run "witness init" first`);
  return loadOrCreateWitnessKey(home).key;
}

function existingBinding(home: string): KeyBinding {
  const result = verifyBinding(readJson(path.join(home, BINDING_FILE), 'binding (run "witness bind" first)'));
  if (!result.ok) fail(`the saved binding is invalid: ${result.reason}`);
  return result.binding;
}

/** A SEAL is carried by hash plus where to fetch it, never inline (Witness v0 evidence items cap at 500 chars). */
export function sealEvidence(sealBytes: Buffer, url?: string): string[] {
  const items = [`seal:sha256:${crypto.createHash('sha256').update(sealBytes).digest('hex')}`];
  if (url) {
    if (!/^https:\/\/\S+$/.test(url) || url.length > 500) fail('--url must be an https URL of at most 500 characters');
    items.push(url);
  }
  return items;
}

export async function run(argv: string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      identity: { type: 'string' },
      agent: { type: 'string' },
      issuer: { type: 'string' },
      subject: { type: 'string' },
      claim: { type: 'string' },
      context: { type: 'string' },
      evidence: { type: 'string', multiple: true },
      confidence: { type: 'string' },
      binding: { type: 'string' },
      url: { type: 'string' },
      registry: { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
    },
  });
  const home = path.resolve(values.home ?? defaultHome());
  // Only the four registry commands ever open a connection; everything else stays offline.
  const registry = (): URL => {
    try {
      return registryBase(values.registry);
    } catch (err) {
      fail((err as Error).message);
    }
  };
  const ask = async (route: string, options?: Parameters<typeof registryRequest>[2]) => {
    try {
      return await registryRequest(registry(), route, options);
    } catch (err) {
      if (err instanceof RegistryError) fail(err.message);
      throw err;
    }
  };
  const unexpected = (what: string, status: number, text: string): never =>
    fail(`registry answered ${status} to ${what}: ${text.slice(0, 300) || '(empty body)'}`);

  switch (command) {
    case 'init': {
      const { key, created } = loadOrCreateWitnessKey(home);
      return { created, home, witnessPublicKey: key.publicKey, keyId: key.keyId };
    }
    case 'bind': {
      if (!values.agent) fail('bind needs --agent <did:...>, the name records will use as issuer');
      if (fs.existsSync(path.join(home, BINDING_FILE))) {
        fail(`${home} already has a binding; changing keys needs a successor binding, which this tool does not make yet`);
      }
      const witness = existingKey(home);
      const threadline = readThreadlineIdentity(path.resolve(values.identity ?? defaultIdentity()));
      // A did:key name IS the agent's Threadline identity key (not its Witness key), so it
      // must be this agent's own key; otherwise verify would rightly refuse every record.
      if (values.agent.startsWith('did:key:')) {
        const named = publicKeyFromDidKey(values.agent);
        if (!named) fail('--agent is a did:key but not an Ed25519 one');
        if (named !== threadline.publicKey) fail('--agent did:key does not name this agent\'s Threadline identity key');
      }
      const binding = createBinding({ agent: values.agent, threadline, witness });
      const checked = verifyBinding(binding, threadline.fingerprint);
      if (!checked.ok) fail(`binding did not verify: ${checked.reason}`);
      // File first: if the store were written first and the file write failed, a re-run
      // would see no file and make a second seq-0 binding.
      const bindingFile = path.join(home, BINDING_FILE);
      fs.writeFileSync(bindingFile, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
      const added = new WitnessStore({ dir: path.join(home, 'store') }).addBinding(binding, { expectedFingerprint: threadline.fingerprint });
      if (added.status === 'rejected') {
        fs.rmSync(bindingFile, { force: true });
        fail(`store refused the binding: ${added.reason}`);
      }
      return binding;
    }
    case 'sign': {
      const binding = existingBinding(home);
      const key = existingKey(home);
      if (key.publicKey !== binding.witness_public_key) fail('the Witness key does not match the saved binding');
      const issuer = values.issuer ?? binding.agent;
      if (issuer !== binding.agent) fail(`--issuer must be the bound agent (${binding.agent})`);
      if (!values.subject) fail('sign needs --subject <did:...>');
      if (!values.claim || !(CLAIMS as readonly string[]).includes(values.claim)) fail(`--claim must be one of: ${CLAIMS.join(', ')}`);
      if (values.claim === 'revoked' || values.claim === 'verified-by-sas') fail(`--claim ${values.claim} is not issued by hand`);
      if (!values.context) fail('sign needs --context <what happened>');
      const confidence = values.confidence === undefined ? 100 : Number(values.confidence);
      if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) fail('--confidence must be an integer from 0 to 100');
      const record = createRecord({
        issuer, subject: values.subject, claim: values.claim as Claim, context: values.context,
        evidence: values.evidence ?? [], confidence,
      }, key);
      const added = new WitnessStore({ dir: path.join(home, 'store') }).add(record);
      if (added.status === 'rejected') fail(`store refused the record: ${added.reason}`);
      return { hash: added.hash, record };
    }
    case 'verify': {
      const file = positionals[0];
      if (!file) fail('verify needs a record file');
      if (!values.binding) fail('verify needs --binding <binding.json> naming the issuer\'s key');
      // The same check the registry commands run on every record they read back (localverify.ts).
      const v = verifyRecordWithBinding(readJson(path.resolve(file), 'record'), readJson(path.resolve(values.binding), 'binding'));
      if (!v.ok) return v;
      return { ok: true, expired: v.expired, threadlineFingerprint: v.threadlineFingerprint, issuerKeyCheck: v.issuerKeyCheck };
    }
    case 'publish': {
      const file = positionals[0];
      if (!file) fail('publish needs a record file');
      if (!values.binding) fail('publish needs --binding <binding.json> naming the issuer\'s key');
      const record = readJson(path.resolve(file), 'record');
      const binding = readJson(path.resolve(values.binding), 'binding');
      // Verify here first: a record this machine will not vouch for is never sent anywhere.
      const local = verifyRecordWithBinding(record, binding);
      if (!local.ok) fail(`refusing to publish: the record does not verify locally (${local.reason})`);
      const localHash = recordHash(local.record);
      const res = await ask('/witness/records', { method: 'POST', body: { record, binding } });
      const body = (res.json && typeof res.json === 'object' ? res.json : {}) as Record<string, unknown>;
      if (res.status === 422) {
        // The server runs the same verify as this package; its reason is printed unchanged.
        fail(`registry refused the record: ${typeof body.reason === 'string' ? body.reason : res.text.slice(0, 300)}`);
      }
      if (res.status !== 201 && res.status !== 200) unexpected('publish', res.status, res.text);
      if (body.ok !== true || typeof body.recordHash !== 'string') unexpected('publish', res.status, res.text);
      if (body.recordHash !== localHash) {
        fail(`registry reports recordHash ${body.recordHash} but the record hashes to ${localHash} here; ` +
          'the server did not store what was sent, or hashes it differently. Not treating it as published.');
      }
      return {
        ok: true,
        recordHash: localHash,
        duplicate: body.duplicate === true,
        registered: body.registered === true,
        registry: registry().origin,
      };
    }
    case 'lookup': {
      if (!values.subject && !values.issuer) fail('lookup needs --subject <did> and/or --issuer <did>');
      const q = new URLSearchParams();
      if (values.subject) q.set('subject', values.subject);
      if (values.issuer) q.set('issuer', values.issuer);
      if (values.limit !== undefined) {
        const n = Number(values.limit);
        if (!Number.isInteger(n) || n < 1 || n > LOOKUP_MAX_LIMIT) fail(`--limit must be an integer from 1 to ${LOOKUP_MAX_LIMIT}`);
        q.set('limit', String(n));
      }
      if (values.cursor) q.set('cursor', values.cursor);
      const res = await ask(`/witness/records?${q}`);
      if (res.status !== 200) unexpected('lookup', res.status, res.text);
      if (!res.json || typeof res.json !== 'object') unexpected('lookup', res.status, res.text);
      const page = assessLookupPage(res.json as Parameters<typeof assessLookupPage>[0]);
      return {
        registry: registry().origin,
        query: { ...(values.subject ? { subject: values.subject } : {}), ...(values.issuer ? { issuer: values.issuer } : {}) },
        count: page.records.length,
        counts: page.counts,
        records: page.records,
        ...(page.next ? { next: page.next } : {}),
        note: page.note,
      };
    }
    case 'get': {
      const hash = positionals[0];
      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) fail('get needs a recordHash (64 hex characters)');
      const res = await ask(`/witness/records/${hash}`);
      if (res.status === 404) fail(`the registry has no record ${hash}`);
      if (res.status !== 200) unexpected('get', res.status, res.text);
      return { registry: registry().origin, ...assessSingleRecord(hash, res.json), note: UNVERIFIED_NOTE };
    }
    case 'stats': {
      const res = await ask('/witness/stats');
      if (res.status !== 200) unexpected('stats', res.status, res.text);
      if (res.json === undefined) unexpected('stats', res.status, res.text);
      return res.json; // the server's word, printed as-is; nothing here is verifiable locally
    }
    case 'seal-evidence': {
      const file = positionals[0];
      if (!file) fail('seal-evidence needs the SEAL file');
      if (!fs.existsSync(file)) fail(`no file at ${file}`);
      return { evidence: sealEvidence(fs.readFileSync(file), values.url) };
    }
    case 'export': {
      const binding = existingBinding(home);
      const store = new WitnessStore({ dir: path.join(home, 'store') });
      return { binding, records: store.list({ issuer: binding.agent }).map((r) => r.record) };
    }
    default:
      fail(`unknown command "${command ?? ''}". Commands: init, bind, sign, verify, seal-evidence, export, publish, lookup, get, stats`);
  }
}

function isInvokedDirectly(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false; // an odd argv (a path that does not exist) never crashes an import
  }
}
const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    (result) => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); },
    (err) => {
      process.stderr.write(`witness: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
