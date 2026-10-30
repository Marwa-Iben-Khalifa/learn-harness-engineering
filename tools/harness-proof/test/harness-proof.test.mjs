import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isHollow } from '../lib/proof.mjs';
import { normalizeList, validateList } from '../lib/schema.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness-proof.mjs');

let root;

function cli(...args) {
  const run = spawnSync(process.execPath, [CLI, ...args, '--target', root], { encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

function writeList(features) {
  writeFileSync(path.join(root, 'feature_list.json'), JSON.stringify({ version: 1, features }));
}

function readList() {
  return JSON.parse(readFileSync(path.join(root, 'feature_list.json'), 'utf8'));
}

function feature(overrides = {}) {
  return { id: 'f1', title: 'One', status: 'in_progress', verify: [{ label: 'ok', cmd: 'test -f app.txt' }], ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harness-proof-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, 'app.txt'), 'v1');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function hook(event) {
  const run = spawnSync(process.execPath, [CLI, 'hook'], { encoding: 'utf8', input: JSON.stringify(event), cwd: os.tmpdir() });
  return { code: run.status, err: run.stderr };
}

describe('stop hook', () => {
  it('blocks when a passing feature is not proven', () => {
    writeList([feature({ status: 'passing' })]);
    const run = hook({ cwd: root });
    assert.equal(run.code, 2);
    assert.match(run.err, /f1: claimed/);
  });

  it('allows stopping once everything is proven', () => {
    writeList([feature()]);
    cli('verify', 'f1');
    assert.equal(hook({ cwd: root }).code, 0);
  });

  it('never blocks twice in a row', () => {
    writeList([feature({ status: 'passing' })]);
    assert.equal(hook({ cwd: root, stop_hook_active: true }).code, 0);
  });

  it('does not block on legacy lists, missing lists or bad input', () => {
    assert.equal(hook({ cwd: root }).code, 0);
    writeFileSync(path.join(root, 'feature_list.json'), JSON.stringify({ features: [{ id: 'a', status: 'pass' }] }));
    assert.equal(hook({ cwd: root }).code, 0);
    const run = spawnSync(process.execPath, [CLI, 'hook'], { encoding: 'utf8', input: 'not json', cwd: root });
    assert.equal(run.status, 0);
  });
});

describe('migration', () => {
  it('imports every legacy shape used in the course', () => {
    const cases = [
      [{ id: 'a', status: 'pass' }, 'passing'],
      [{ id: 'a', status: 'not-started' }, 'not_started'],
      [{ id: 'a', status: 'not_started' }, 'not_started'],
      [{ id: 'a', status: 'done' }, 'passing'],
      [{ id: 'a', state: 'active' }, 'in_progress'],
      [{ id: 'a', state: 'passing' }, 'passing'],
      [{ id: 'a', passes: false }, 'not_started'],
      [{ id: 'a', passes: true }, 'passing']
    ];
    for (const [legacy, expected] of cases) {
      assert.equal(normalizeList({ features: [legacy] }).features[0].status, expected);
    }
  });

  it('keeps prose checks and evidence out of verify', () => {
    const [migrated] = normalizeList([
      { id: 'a', description: 'd', verification: ['Open the app'], evidence: 'works', passes: true }
    ]).features;
    assert.deepEqual(migrated.verify, []);
    assert.deepEqual(migrated.manual, ['Open the app']);
    assert.equal(migrated.claimed_evidence, 'works');
  });

  it('rejects unknown statuses, duplicate ids and path traversal', () => {
    assert.throws(() => normalizeList({ features: [{ id: 'a', status: 'maybe' }] }), /unknown status/);
    assert.throws(() => normalizeList({ features: [{ id: 'a' }, { id: 'a' }] }), /duplicate/);
    assert.throws(() => normalizeList({ features: [{ id: '../evil' }] }), /id must match/);
    assert.ok(validateList({ version: 2, features: [] }).length > 0);
  });
});

describe('verify', () => {
  it('moves a feature to passing and records a proof', () => {
    writeList([feature()]);
    const run = cli('verify', 'f1');
    assert.equal(run.code, 0, run.out);
    assert.equal(readList().features[0].status, 'passing');
    assert.match(cli('status').out, /^proven/m);
    assert.equal(cli('check').code, 0);
  });

  it('stops at the first failing layer and prints the repair hint', () => {
    writeList([feature({
      verify: [
        { label: 'bad', cmd: 'echo boom >&2; exit 3', repair: 'fix the thing' },
        { label: 'never', cmd: 'touch ran.txt' }
      ]
    })]);
    const run = cli('verify', 'f1');
    assert.equal(run.code, 1);
    assert.match(run.out, /boom/);
    assert.match(run.out, /fix the thing/);
    assert.equal(readList().features[0].status, 'in_progress');
    assert.throws(() => readFileSync(path.join(root, 'ran.txt')));
  });

  it('demotes a passing feature when it fails', () => {
    writeList([feature({ status: 'passing', verify: [{ label: 'bad', cmd: 'false' }] })]);
    assert.equal(cli('verify', 'f1').code, 1);
    assert.equal(readList().features[0].status, 'in_progress');
  });

  it('refuses commands that cannot fail', () => {
    for (const cmd of ['true', 'exit 0', 'echo done', 'npm test || true']) assert.ok(isHollow(cmd), cmd);
    for (const cmd of ['npm test', 'echo x | grep y', 'true && npm test']) assert.ok(!isHollow(cmd), cmd);
    writeList([feature({ verify: [{ label: 'fake', cmd: 'npm test || true' }] })]);
    const run = cli('verify', 'f1');
    assert.equal(run.code, 2);
    assert.match(run.out, /proves nothing/);
    assert.equal(readList().features[0].status, 'in_progress');
  });

  it('refuses a feature without commands', () => {
    writeList([feature({ verify: [] })]);
    assert.equal(cli('verify', 'f1').code, 2);
  });

  it('fails when verification changes the files it checks', () => {
    writeList([feature({ verify: [{ label: 'mutate', cmd: 'printf v2 > app.txt' }] })]);
    const run = cli('verify', 'f1');
    assert.equal(run.code, 1);
    assert.match(run.out, /changed the files/);
  });
});

describe('check', () => {
  it('rejects a hand-written passing status', () => {
    writeList([feature({ status: 'passing' })]);
    const run = cli('check');
    assert.equal(run.code, 1);
    assert.match(run.out, /f1: claimed/);
  });

  it('marks a proof stale when files change, and fresh again when restored', () => {
    writeList([feature()]);
    cli('verify', 'f1');
    writeFileSync(path.join(root, 'app.txt'), 'v2');
    assert.equal(cli('check').code, 1);
    assert.match(cli('status').out, /^stale/m);
    writeFileSync(path.join(root, 'app.txt'), 'v1');
    assert.equal(cli('check').code, 0);
  });

  it('marks a proof stale when its commands are weakened', () => {
    writeList([feature()]);
    cli('verify', 'f1');
    const list = readList();
    list.features[0].verify[0].cmd = 'test -d .';
    writeFileSync(path.join(root, 'feature_list.json'), JSON.stringify(list));
    assert.equal(cli('check').code, 1);
  });

  it('ignores changes outside the feature paths', () => {
    writeList([feature({ paths: ['app.txt'] })]);
    cli('verify', 'f1');
    writeFileSync(path.join(root, 'other.txt'), 'x');
    assert.equal(cli('check').code, 0);
  });

  it('does not invalidate a proof by committing it', () => {
    writeList([feature()]);
    cli('verify', 'f1');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: root });
    assert.equal(cli('check').code, 0);
  });

  it('enforces WIP=1', () => {
    writeList([feature(), feature({ id: 'f2' })]);
    const run = cli('check');
    assert.equal(run.code, 1);
    assert.match(run.out, /WIP=1/);
  });

  it('--rerun catches a proof that no longer holds', () => {
    writeList([feature()]);
    cli('verify', 'f1');
    const proofFile = path.join(root, '.harness/proofs/f1.json');
    const forged = JSON.parse(readFileSync(proofFile, 'utf8'));
    rmSync(path.join(root, 'app.txt'));
    forged.fingerprint = 'recomputed-by-a-liar';
    writeFileSync(proofFile, JSON.stringify(forged));
    const run = cli('check', '--rerun');
    assert.equal(run.code, 1);
    assert.match(run.out, /failed on rerun/);
  });

  it('--rerun failures do not report a false WIP violation', () => {
    const passing = { status: 'passing', verify: [{ label: 'bad', cmd: 'false' }] };
    writeList([feature({ ...passing }), feature({ ...passing, id: 'f2' })]);
    const run = cli('check', '--rerun');
    assert.equal(run.code, 1);
    assert.doesNotMatch(run.out, /WIP=1/);
  });

  it('reads legacy lists without changing them', () => {
    const legacy = JSON.stringify({ features: [{ id: 'a', name: 'A', status: 'pass', evidence: 'trust me' }] });
    writeFileSync(path.join(root, 'feature_list.json'), legacy);
    assert.match(cli('check').out, /a: claimed/);
    assert.equal(readFileSync(path.join(root, 'feature_list.json'), 'utf8'), legacy);
  });
});
