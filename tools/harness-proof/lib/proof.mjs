import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson, writeText } from '../../../skills/harness-creator/scripts/lib/harness-utils.mjs';
import { isCurrentFormat, normalizeList, validateList } from './schema.mjs';

export const LIST_NAMES = ['feature_list.json', 'features.json'];
export const PROOF_DIR = '.harness/proofs';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// A command that cannot fail proves nothing.
const HOLLOW_CMD = /^\s*(true|:|exit\s+0|echo\b[^|;&]*)\s*$|\|\|\s*(true|:|exit\s+0)\s*$/;

export function isHollow(cmd) {
  return HOLLOW_CMD.test(cmd);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function findListPath(root) {
  for (const name of LIST_NAMES) {
    const candidate = path.join(root, name);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`No ${LIST_NAMES.join(' or ')} in ${root}`);
}

export async function loadList(root) {
  const listPath = await findListPath(root);
  const raw = await readJson(listPath);
  const current = isCurrentFormat(raw);
  const list = current ? raw : normalizeList(raw);
  const errors = validateList(list);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { list, listPath, current };
}

export async function saveList(listPath, list) {
  await writeText(listPath, `${JSON.stringify(list, null, 2)}\n`);
}

function proofPath(root, id) {
  return path.join(root, PROOF_DIR, `${id}.json`);
}

export async function loadProof(root, id) {
  const target = proofPath(root, id);
  return (await exists(target)) ? readJson(target) : null;
}

// Fingerprints file contents rather than HEAD, so committing a proof does not
// invalidate it. The list and the proofs are excluded for the same reason.
export async function fingerprint(root, paths = []) {
  let listing;
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z', '--', ...paths],
      { cwd: root, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch {
    throw new Error(`${root} is not inside a git repository`);
  }

  const files = [...new Set(listing.split('\0').filter(Boolean))]
    .filter((file) => !LIST_NAMES.includes(file) && !file.startsWith(`${PROOF_DIR}/`))
    .sort();

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      hash.update(await readFile(path.join(root, file)));
    } catch (error) {
      // Deleted tracked files, submodules and broken symlinks still count as state.
      hash.update(`<${error.code}>`);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyHash(feature) {
  return sha256(JSON.stringify(feature.verify.map(({ cmd }) => cmd)));
}

// proven   passing, and a passing proof matches the current commands and files
// claimed  passing, with no proof at all
// failed   passing, but the latest proof failed
// stale    passing, but the commands or the files changed since the proof
export function classify(feature, proof, currentFingerprint) {
  if (feature.status !== 'passing') return feature.status;
  if (!proof) return 'claimed';
  if (proof.result !== 'passed') return 'failed';
  if (proof.verifyHash !== verifyHash(feature)) return 'stale';
  return proof.fingerprint === currentFingerprint ? 'proven' : 'stale';
}

export async function inspect(root, list) {
  const fingerprints = new Map();
  const rows = [];
  for (const feature of list.features) {
    const key = JSON.stringify(feature.paths ?? []);
    if (!fingerprints.has(key)) fingerprints.set(key, await fingerprint(root, feature.paths));
    const proof = await loadProof(root, feature.id);
    rows.push({ feature, proof, state: classify(feature, proof, fingerprints.get(key)) });
  }
  return rows;
}

export function findProblems(rows, { wip = true } = {}) {
  const problems = rows
    .filter(({ state }) => ['claimed', 'failed', 'stale'].includes(state))
    .map(({ feature, state }) => `${feature.id}: ${state}`);
  const active = rows.filter(({ feature }) => feature.status === 'in_progress');
  if (wip && active.length > 1) {
    problems.push(`WIP=1 violated: ${active.map(({ feature }) => feature.id).join(', ')} are in progress`);
  }
  return problems;
}

function runCommand(root, layer) {
  const startedAt = Date.now();
  const run = spawnSync(layer.cmd, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    label: layer.label,
    cmd: layer.cmd,
    exitCode: run.status,
    signal: run.signal,
    durationMs: Date.now() - startedAt,
    outputSha256: sha256(output),
    output
  };
}

// Layers run in order and stop at the first failure (L09). The feature only
// moves to passing here, so an agent never sets that status itself.
export async function verifyFeature(root, listPath, list, feature) {
  if (feature.verify.length === 0) {
    throw new Error(`${feature.id}: no verify commands. Add one, or a manual check cannot be proven.`);
  }
  const hollow = feature.verify.find((layer) => isHollow(layer.cmd));
  if (hollow) throw new Error(`${feature.id}: "${hollow.cmd}" cannot fail, so it proves nothing`);

  const before = await fingerprint(root, feature.paths);
  const commands = [];
  let failure = null;
  for (const layer of feature.verify) {
    const { output, ...result } = runCommand(root, layer);
    commands.push(result);
    if (result.exitCode !== 0) {
      failure = { ...result, output, repair: layer.repair };
      break;
    }
  }
  const after = await fingerprint(root, feature.paths);

  let reason = null;
  if (failure) reason = `"${failure.label}" exited with ${failure.exitCode ?? failure.signal}`;
  else if (before !== after) reason = 'verification changed the files it was checking';

  const proof = {
    feature: feature.id,
    result: reason ? 'failed' : 'passed',
    ...(reason ? { reason } : {}),
    verifiedAt: new Date().toISOString(),
    fingerprint: after,
    verifyHash: verifyHash(feature),
    commands
  };
  await writeText(proofPath(root, feature.id), `${JSON.stringify(proof, null, 2)}\n`);

  if (reason === null) feature.status = 'passing';
  else if (feature.status === 'passing') feature.status = 'in_progress';
  await saveList(listPath, list);

  return { proof, failure };
}
