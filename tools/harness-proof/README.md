# harness-proof

Stops an agent from declaring a feature done without evidence. A feature only reaches `passing` when this tool has run its verification commands itself and recorded the result (see L08 and L09).

Requires Node.js and git (tested on Node.js 26 only). It has no npm dependencies, but it imports helpers from `skills/harness-creator`, so run it from this repository.

## Commands

```sh
node tools/harness-proof/harness-proof.mjs <command> --target path/to/repo
```

| Command | What it does |
|---------|--------------|
| `status` | Shows the real state of each feature. Works on legacy lists without changing them. |
| `check` | Exits 1 if a passing feature is not proven, or if more than one feature is in progress. |
| `check --rerun` | Re-executes every passing feature first. Use this one in CI. |
| `verify <id>` | Runs the feature's commands in order, writes `.harness/proofs/<id>.json`, and updates the status. |
| `migrate` | Prints the list in format v1. Add `--write` to replace the file and `--default-cmd "npm test"` to give every feature a command. |

## States

| State | Meaning |
|-------|---------|
| `proven` | A passing proof matches the current commands and files. |
| `stale` | The files or the commands changed since the proof. |
| `failed` | The latest proof failed. |
| `claimed` | The list says passing, but no proof exists. |

## Format

Version 1 is defined in [feature-list.v1.schema.json](feature-list.v1.schema.json):

```json
{
  "version": 1,
  "features": [
    {
      "id": "qa-001",
      "title": "Answers cite their sources",
      "status": "in_progress",
      "verify": [
        { "label": "types", "cmd": "npm run check" },
        { "label": "tests", "cmd": "npm test", "repair": "Read the failing test before changing the code." }
      ],
      "manual": ["Open the app and ask a question"],
      "paths": ["src/services"]
    }
  ]
}
```

`manual` steps and migrated `claimed_evidence` are kept for reference and never count as proof. Without `paths`, any file change in the target makes the proof stale.

## How a proof is bound

A proof stores a hash of the file contents, not the commit, so committing a proof does not invalidate it. It also stores a hash of the commands, so weakening a command makes it stale.

`verify` refuses commands that cannot fail, such as `true`, `echo done` or `npm test || true`. It also fails if the commands change the files they check, so build output must be gitignored.

## Enforcement

### In CI

Install the project's dependencies first, because the commands run for real:

```yaml
- uses: actions/checkout@v5
- run: npm ci
- uses: Marwa-Iben-Khalifa/learn-harness-engineering/tools/harness-proof@main
  with:
    target: .
```

### In Claude Code

Add a Stop hook to `.claude/settings.json`, with the path to your copy of this repository:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/tools/harness-proof/harness-proof.mjs hook" }
        ]
      }
    ]
  }
}
```

The hook sends unproven features back to the agent instead of letting it finish. It blocks once per stop attempt, then lets go so the agent cannot loop forever, which makes it a nudge and not a lock. It ignores legacy lists until they are migrated.

Without `paths`, any edit makes every proven feature stale, so the hook will fire often. Set `paths` on each feature to keep it useful.

## Limits

- **A proof file can be forged.** `check` only compares hashes, and a determined agent could rewrite them. `check --rerun` in CI is the real gate, because it trusts nothing already on disk.
- **The hollow-command filter is a short pattern list.** It catches common cases, not a test that asserts nothing.
- **`verify` runs shell commands from the feature list.** Treat that file as code.

## Tests

```sh
npm run proof:test
```
