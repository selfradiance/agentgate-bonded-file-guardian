# Agent 002: File Guardian

A bonded file guardian that watches a directory and enforces accountability on file changes through [AgentGate](https://github.com/selfradiance/agentgate).

When an AI coding agent (or anything else) modifies or deletes a file, the guardian posts a bond, verifies the change, and either releases the bond or slashes it and restores the file from a snapshot.

## Why

AI coding agents are being given filesystem access with zero accountability. A developer recently lost 2.5 years of production data when an AI agent executed a single destructive command. Rate limits and permission systems don't help when the agent has legitimate access — the problem is that nothing makes the agent economically accountable for what it does with that access. This project exists so that destructive file changes can't happen silently.

## How It Works

1. The guardian starts and snapshots every file in the watched directory
2. A file change is detected (modification or deletion)
3. A bond is posted to AgentGate (the agent puts up collateral)
4. Verification runs: either a user-supplied command (`--verify-cmd`, exit 0 = pass) or the default size-threshold check (file exists, not empty, size within threshold)
5. If verification passes → bond released, snapshot updated to the new file state
6. If verification fails → bond slashed, file restored from the pre-change snapshot

## Quick Start

**Prerequisites:** Node.js 20+, a running [AgentGate](https://github.com/selfradiance/agentgate) instance.

```bash
# Clone and install
git clone https://github.com/selfradiance/agent-002-file-guardian.git
cd agent-002-file-guardian
npm install

# Watch a TypeScript project — restore any change that breaks the build
npx tsx src/index.ts ./src --verify-cmd 'tsc --noEmit' --api-key YOUR_AGENTGATE_REST_KEY

# Or watch any directory with the default size-threshold verification
npx tsx src/index.ts /path/to/directory --api-key YOUR_AGENTGATE_REST_KEY
```

**Options:**

```
npx tsx src/index.ts <directory> [options]

  --agentgate-url <url>   AgentGate server URL (default: http://127.0.0.1:3000)
  --api-key <key>         AgentGate REST key (or set AGENTGATE_REST_KEY env var)
  --threshold <percent>   Max allowed size change % (default: 50)
  --verify-cmd <command>  Shell command to run for verification (exit 0 = pass)
  --verify-timeout <sec>  Timeout for verify command in seconds (default: 30)
  --fail-open             Allow changes through when AgentGate is unreachable (default: fail-closed)
```

The `--agentgate-url` flag also accepts `https://agentgate.run` — a live demo instance available until approximately March 2027.

## What Happens When a Change Is Caught

```
[14:32:01] [change] Change detected: db.ts
[14:32:01] [error]  Bond lifecycle failed for db.ts: fetch failed: ECONNREFUSED
[14:32:01] [failed] db.ts: AgentGate unreachable — change reverted (fail-closed)
```

```
[14:35:12] [change] Change detected: config.ts
[14:35:14] [failed] config.ts: Command failed (exit 1): tsc --noEmit — error TS2322: Type 'string' is not assignable to type 'number'. — restored from snapshot
```

```
[14:36:44] [change] Change detected: utils.ts
[14:36:46] [passed] utils.ts: Command passed: tsc --noEmit
```

## What It Watches For

- **File modifications:** runs the verify command (if configured) or checks that the file wasn't emptied and the size didn't change beyond the threshold
- **File deletions:** automatically caught and restored from snapshot — no verification needed, deletions always fail
- **What it does NOT watch:** new file creation, subdirectories, or files added after startup

## Safety Features

- **Fail-closed by default** — if AgentGate is unreachable, changes are reverted from snapshot. Use `--fail-open` to override.
- **Symlinks skipped** — symlinks in the watched directory are detected and ignored, preventing the guardian from reading or writing outside the directory
- **Restore-echo suppression** — when the guardian restores a file, the resulting filesystem event is suppressed so it doesn't waste a bond re-checking its own restore
- **Atomic restores** — restored files are written to a temp file first, then atomically renamed into place. A crash mid-restore won't corrupt the original.
- **Per-file locking** — concurrent changes to the same file are serialized, preventing race conditions in the bond/verify/restore cycle
- **10-second request timeout** — all AgentGate API calls time out after 10 seconds, so the guardian doesn't hang if AgentGate is unreachable
- **Input validation** — invalid CLI values (NaN thresholds, bad timeout values) are rejected at startup with clear errors

## Trust Model

The `--verify-cmd` flag runs an arbitrary shell command via `/bin/sh`. This is a deliberate design choice — the guardian's operator specifies the command, and it runs with the same permissions as the guardian process. Do not source the `--verify-cmd` value from untrusted input (e.g., user-facing config files or environment variables set by other processes). The trust boundary is the same as a `Makefile` target or an npm script.

## Tests

```bash
npm test
```

50 tests across 5 test files (snapshots, verification, bonds, watcher, integration).

Integration tests require a running AgentGate instance:

```bash
AGENTGATE_URL=http://127.0.0.1:3000 AGENTGATE_REST_KEY=yourkey npm test
```

## Built On

- [AgentGate](https://github.com/selfradiance/agentgate) — the bond-and-slash accountability layer for AI agents

## License

MIT
