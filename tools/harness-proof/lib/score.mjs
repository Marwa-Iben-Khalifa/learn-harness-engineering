import path from 'node:path';
import { exists, loadHarnessFiles, readText, scoreHarness } from '../../../skills/harness-creator/scripts/lib/harness-utils.mjs';
import { inspect, LIST_NAMES, loadList } from './proof.mjs';

// Evidence outweighs everything else on purpose: perfect documentation with no
// proofs must not reach a passing score.
export const WEIGHTS = { evidence: 70, structure: 25, reproducibility: 5 };

const PROGRESS_NAMES = ['progress.md', 'claude-progress.md', 'PROGRESS.md'];
const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'poetry.lock', 'Pipfile.lock',
  'uv.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'mix.lock', 'composer.lock'
];

async function firstExisting(root, names) {
  for (const name of names) {
    if (await exists(path.join(root, name))) return name;
  }
  return null;
}

async function hasList(root) {
  return (await firstExisting(root, LIST_NAMES)) !== null;
}

function evidenceScore(rows) {
  const passing = rows.filter(({ feature }) => feature.status === 'passing');
  const proven = rows.filter(({ state }) => state === 'proven');
  const ratio = passing.length === 0 ? 0 : proven.length / passing.length;
  return {
    score: Math.round(ratio * WEIGHTS.evidence),
    max: WEIGHTS.evidence,
    proven: proven.length,
    passing: passing.length,
    total: rows.length
  };
}

// Feeds the validator the course's real file names and the v1 field names, which
// it does not know about. Counts raw checks, because its per-subsystem score has
// a floor of 1 that gives an empty repository 20/100.
async function structureScore(root, list) {
  const files = (await loadHarnessFiles(root)).filter((file) => file.path !== 'feature_list.json');
  if (!files.some((file) => file.path === 'progress.md')) {
    const name = await firstExisting(root, PROGRESS_NAMES);
    if (name) files.push({ path: 'progress.md', content: await readText(path.join(root, name)) });
  }
  if (list) {
    const features = list.features.map((feature) => ({ ...feature, name: feature.title }));
    files.push({ path: 'feature_list.json', content: JSON.stringify({ features }) });
  }

  const checks = Object.values(scoreHarness(files).subsystems).flatMap(({ checks: items }) => items);
  const passed = checks.filter((check) => check.pass).length;
  return {
    score: Math.round((passed / checks.length) * WEIGHTS.structure),
    max: WEIGHTS.structure,
    passed,
    total: checks.length,
    missing: [...new Set(checks.filter((check) => !check.pass).map((check) => check.message))]
  };
}

async function reproducibilityScore(root) {
  const lockfile = await firstExisting(root, LOCKFILES);
  return { score: lockfile ? WEIGHTS.reproducibility : 0, max: WEIGHTS.reproducibility, lockfile };
}

export async function scoreRepo(root) {
  const loaded = (await hasList(root)) ? await loadList(root) : null;
  const rows = loaded ? await inspect(root, loaded.list) : [];

  const evidence = evidenceScore(rows);
  const structure = await structureScore(root, loaded?.list);
  const reproducibility = await reproducibilityScore(root);

  return {
    overall: evidence.score + structure.score + reproducibility.score,
    evidence,
    structure,
    reproducibility,
    unproven: rows
      .filter(({ state }) => ['claimed', 'stale', 'failed'].includes(state))
      .map(({ feature, state }) => ({ id: feature.id, state }))
  };
}

export function formatScore(result) {
  const { overall, evidence, structure, reproducibility, unproven } = result;
  const lines = [
    `Score: ${overall}/100`,
    '',
    `  Evidence         ${evidence.score}/${evidence.max}  ${evidence.proven} proven of ${evidence.passing} marked passing (${evidence.total} features)`,
    `  Structure        ${structure.score}/${structure.max}  ${structure.passed} of ${structure.total} checks`,
    `  Reproducibility  ${reproducibility.score}/${reproducibility.max}  ${reproducibility.lockfile ?? 'no lockfile'}`
  ];
  if (evidence.passing === 0) lines.push('', 'Nothing is marked passing, so there is no evidence to score yet.');
  if (unproven.length > 0) {
    const counts = {};
    for (const { state } of unproven) counts[state] = (counts[state] ?? 0) + 1;
    lines.push('', `Unproven: ${Object.entries(counts).map(([state, n]) => `${n} ${state}`).join(', ')}`);
  }
  if (structure.missing.length > 0) {
    lines.push('', 'Missing structure:', ...structure.missing.map((message) => `  ${message}`));
  }
  return lines.join('\n');
}
