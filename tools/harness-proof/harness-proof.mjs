#!/usr/bin/env node
import path from 'node:path';
import { parseArgs, readJson } from '../../skills/harness-creator/scripts/lib/harness-utils.mjs';
import { findListPath, findProblems, inspect, loadList, saveList, verifyFeature } from './lib/proof.mjs';
import { normalizeList } from './lib/schema.mjs';

const USAGE = `Usage: harness-proof <command> [--target DIR]

  status                     Show each feature's real state
  check [--rerun]            Exit 1 unless every passing feature is proven.
                             --rerun re-executes them first (use this in CI)
  verify <id>                Run a feature's commands and record the proof
  migrate [--default-cmd C]  Print the list in format v1. --write replaces it
  hook                       Claude Code Stop hook (reads the event on stdin)

States: proven, stale, failed, claimed, and the plain work statuses.`;

const OUTPUT_TAIL_LINES = 20;

function printRows(rows) {
  const width = Math.max(...rows.map(({ feature }) => feature.id.length), 2);
  for (const { feature, state } of rows) {
    console.log(`${state.padEnd(11)} ${feature.id.padEnd(width)}  ${feature.title}`);
  }
  const totals = {};
  for (const { state } of rows) totals[state] = (totals[state] ?? 0) + 1;
  console.log(`\n${Object.entries(totals).map(([state, n]) => `${n} ${state}`).join(', ')}`);
}

function printFailure(result) {
  console.error(`FAIL ${result.proof.feature}: ${result.proof.reason}`);
  if (!result.failure) return;
  const tail = result.failure.output.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
  if (tail) console.error(tail);
  if (result.failure.repair) console.error(`How to fix: ${result.failure.repair}`);
}

async function status(root) {
  const { list } = await loadList(root);
  printRows(await inspect(root, list));
}

async function check(root, args) {
  const { list, listPath, current } = await loadList(root);
  const rerunFailures = [];
  if (args.rerun) {
    if (!current) throw new Error('--rerun needs format v1. Run: harness-proof migrate --write');
    for (const feature of list.features.filter((f) => f.status === 'passing')) {
      if (feature.verify.length === 0) continue;
      const result = await verifyFeature(root, listPath, list, feature);
      if (result.proof.result !== 'passed') {
        printFailure(result);
        rerunFailures.push(`${feature.id}: failed on rerun`);
      }
    }
  }
  const rows = await inspect(root, list);
  printRows(rows);
  // A failed rerun demotes features to in_progress, which is not a real WIP violation.
  const problems = [...rerunFailures, ...findProblems(rows, { wip: rerunFailures.length === 0 })];
  if (problems.length > 0) {
    console.error(`\nNot proven:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exitCode = 1;
  }
}

async function verify(root, args) {
  const id = args._[1];
  if (!id) throw new Error('verify needs a feature id');
  const { list, listPath, current } = await loadList(root);
  if (!current) throw new Error('verify needs format v1. Run: harness-proof migrate --write');
  const feature = list.features.find((f) => f.id === id);
  if (!feature) throw new Error(`Unknown feature: ${id}`);

  const result = await verifyFeature(root, listPath, list, feature);
  if (result.proof.result === 'passed') {
    console.log(`PROVEN ${id} (${result.proof.commands.length} command(s), fingerprint ${result.proof.fingerprint.slice(0, 12)})`);
  } else {
    printFailure(result);
    process.exitCode = 1;
  }
}

async function migrate(root, args) {
  const listPath = await findListPath(root);
  const list = normalizeList(await readJson(listPath), { defaultCmd: args.defaultCmd });
  if (args.write) {
    await saveList(listPath, list);
    console.log(`Migrated ${list.features.length} feature(s) in ${listPath}`);
  } else {
    console.log(JSON.stringify(list, null, 2));
  }
}

// Claude Code Stop hook: exit 2 keeps the agent working and feeds stderr back to it.
// stop_hook_active means this hook already blocked once, so letting go avoids an
// endless loop. Anything unexpected also lets go: a broken tool must not trap an agent.
async function hook(root, args) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const event = input ? JSON.parse(input) : {};
    if (event.stop_hook_active) return;

    const target = args.target ? root : path.resolve(event.cwd ?? root);
    const { list, current } = await loadList(target);
    if (!current) return;
    const problems = findProblems(await inspect(target, list));
    if (problems.length > 0) {
      console.error(`Do not finish yet. These features are not proven:\n${problems.map((p) => `  ${p}`).join('\n')}\nRun harness-proof verify <id> for each one, or set its status back to in_progress and say why.`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`harness-proof hook skipped: ${error.message}`);
  }
}

const COMMANDS = { status, check, verify, migrate, hook };

const args = parseArgs(process.argv.slice(2));
const command = COMMANDS[args._[0]];
if (!command || args.help) {
  console.log(USAGE);
  process.exitCode = command || args.help ? 0 : 2;
} else {
  try {
    await command(path.resolve(args.target || process.cwd()), args);
  } catch (error) {
    console.error(`harness-proof: ${error.message}`);
    process.exitCode = 2;
  }
}
