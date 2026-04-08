# Agent 002: File Guardian

A bonded file guardian that watches a directory, intercepts modifications and deletions, verifies changes via configurable commands, and slashes the bond if verification fails — restoring the file from a pre-change snapshot.

## Why This Exists

AI coding agents modify files constantly. If a change breaks something, the cost falls entirely on you. Agent 002 puts the agent's bond on the line: every file change triggers a verification step, and failure means the bond is slashed and the file is restored to its pre-change state.

This is the second agent in the AgentGate ecosystem. It proves command-based verification — you choose what "pass" means by supplying your own verification command.

## How It Relates to AgentGate

[AgentGate](https://github.com/selfradiance/agentgate) is the enforcement substrate. Agent 002 calls AgentGate's API to register an identity, lock a bond per file change, execute a bonded action, and resolve based on the verification result. AgentGate handles bonding and settlement. Agent 002 handles watching, snapshotting, verifying, and restoring.

AgentGate must be running for Agent 002 to work.

## What's Implemented

- Background process watching a single directory via chokidar
- Pre-change snapshots (binary-safe)
- Configurable command-based verification (`--verify-cmd "tsc --noEmit"`)
- Atomic restores (write-to-temp + rename)
- Per-file locking (promise-chain mutex — no concurrent bond calls for the same file)
- Fail-closed default when AgentGate is unreachable (`--fail-open` to override)
- Full AgentGate lifecycle per file change: snapshot → bond → verify → resolve → restore if failed
- Ed25519 signed requests
- Configurable verification timeout (`--verify-timeout`)
- GitHub Actions CI

## Quick Start

```bash
# 1. Start AgentGate
cd ~/Desktop/projects/agentgate && npm run restart

# 2. Run Agent 002
cd ~/Desktop/projects/agent-002-file-guardian
cp .env.example .env  # add your AGENTGATE_REST_KEY
npm install
npx tsx src/cli.ts ./watched-directory --verify-cmd "tsc --noEmit"
```

## Example

An AI coding agent modifies `src/index.ts` in the watched directory. Agent 002 detects the change, takes a snapshot, posts a bond on AgentGate, runs `tsc --noEmit`. If TypeScript compilation passes, the bond is released. If it fails, the bond is slashed and the file is restored from the snapshot.

## Scope / Non-Goals

- Single directory only — no recursive watching (v0.3.0 candidate)
- New identity every run — no persistence
- `execSync` blocks during verification — acceptable for v0.2.0
- Orphaned bonds possible if execution fails after bond posting (AgentGate sweeper handles via TTL)
- No MCP server — standalone background process

## Tests

50 tests (44 pass, 6 skipped for missing AgentGate). Covers snapshot integrity, watcher reliability, bond integration, verification logic, configuration validation, error handling, and edge cases.

```bash
npm test
```

## Related Projects

- [AgentGate](https://github.com/selfradiance/agentgate) — the core execution engine
- [Agent 001: Bonded File Transform](https://github.com/selfradiance/agentgate-bonded-file-transform) — deterministic verification
- [Agent 003: Email Rewriter](https://github.com/selfradiance/agentgate-bonded-email-rewriter) — human judgment in the loop

## Status

Complete — v0.2.0 shipped. Triple-audited (Claude Code 8-round × 2 versions + Codex cold-eyes). 50 tests.

## License

MIT
