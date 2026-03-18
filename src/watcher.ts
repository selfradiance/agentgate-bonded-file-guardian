import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { DEFAULT_CONFIG } from "./config";
import { snapshotAll, hasSnapshot, getSnapshotSize, restoreSnapshot, takeSnapshot } from "./snapshots";
import { verifyChange, verifyCommand } from "./verify";
import { registerAgent, postBond, executeBondedAction, resolveBond, generateKeypair, type AgentKeys } from "./bonds";

export interface WatcherOptions {
  directory: string;
  agentGateUrl?: string;
  apiKey?: string;
  sizeChangeThreshold?: number;
  verifyCmd?: string;
  verifyCmdTimeoutMs?: number;
  failOpen?: boolean;
  onEvent?: (event: string, detail: string) => void;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

export async function startWatcher(options: WatcherOptions): Promise<WatcherHandle> {
  const {
    directory,
    agentGateUrl = DEFAULT_CONFIG.agentGateUrl,
    apiKey = DEFAULT_CONFIG.apiKey,
    sizeChangeThreshold = DEFAULT_CONFIG.sizeChangeThreshold,
    verifyCmd = DEFAULT_CONFIG.verifyCmd,
    verifyCmdTimeoutMs = DEFAULT_CONFIG.verifyCmdTimeoutMs,
    failOpen = false,
    onEvent,
  } = options;

  const absoluteDir = path.resolve(directory);

  // Validate directory
  if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
    throw new Error(`Not a valid directory: ${absoluteDir}`);
  }

  const log = (event: string, detail: string) => {
    onEvent?.(event, detail);
  };

  // Register agent with AgentGate
  const keys: AgentKeys = generateKeypair();
  let identityId: string;
  try {
    identityId = await registerAgent(agentGateUrl, apiKey, keys);
    log("registered", `Agent registered: ${identityId}`);
  } catch (err) {
    log("error", `AgentGate registration failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  // Snapshot all files
  snapshotAll(absoluteDir);
  const fileCount = fs.readdirSync(absoluteDir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  log("ready", `Watching ${absoluteDir} — ${fileCount} files snapshotted`);

  // Debounce tracking
  const lastSeen = new Map<string, number>();

  function isDuplicate(filePath: string): boolean {
    const now = Date.now();
    const last = lastSeen.get(filePath);
    lastSeen.set(filePath, now);
    return last !== undefined && now - last < DEFAULT_CONFIG.debounceMs;
  }

  // Per-file mutex — ensures only one handler runs per file at a time.
  // Subsequent events for the same file queue behind the in-flight handler.
  const fileLocks = new Map<string, Promise<void>>();

  function withFileLock(filePath: string, fn: () => Promise<void>): Promise<void> {
    const prev = fileLocks.get(filePath) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn regardless of whether prev succeeded or failed
    fileLocks.set(filePath, next);
    // Clean up the map entry when the chain settles to avoid unbounded growth
    next.then(() => {
      if (fileLocks.get(filePath) === next) fileLocks.delete(filePath);
    });
    return next;
  }

  // Restore-echo suppression — skip the chokidar event triggered by our own restore
  const justRestored = new Set<string>();

  // Bond lifecycle result — distinguishes connection errors from API errors
  type BondResult = { actionId: string } | { actionId: null; connectionError: boolean };

  function isConnectionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("timed out") ||
      msg.includes("UND_ERR") ||
      msg.includes("ETIMEDOUT");
  }

  async function tryBondLifecycle(filePath: string, action: string): Promise<BondResult> {
    try {
      const bondId = await postBond(agentGateUrl, apiKey, keys, identityId, filePath, action);
      const actionId = await executeBondedAction(agentGateUrl, apiKey, keys, identityId, bondId, filePath, action);
      return { actionId };
    } catch (err) {
      const connErr = isConnectionError(err);
      log("error", `Bond lifecycle failed for ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      return { actionId: null, connectionError: connErr };
    }
  }

  async function tryResolve(actionId: string | null, passed: boolean): Promise<void> {
    if (!actionId) return;
    try {
      await resolveBond(agentGateUrl, apiKey, keys, actionId, passed);
    } catch (err) {
      log("error", `Bond resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Handle file modification
  async function handleChange(filePath: string): Promise<void> {
    if (isDuplicate(filePath)) return;

    // Skip events triggered by our own restore writes
    if (justRestored.has(filePath)) {
      justRestored.delete(filePath);
      log("skip", `Restore echo skipped: ${path.basename(filePath)}`);
      return;
    }

    // Skip symlinks — they could point outside the watched directory
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        log("skip", `Symlink skipped: ${path.basename(filePath)}`);
        return;
      }
    } catch {
      // lstat may fail if file was already deleted between event and check
    }

    const filename = path.basename(filePath);
    log("change", `Change detected: ${filename}`);

    if (!hasSnapshot(filePath)) {
      log("skip", `No snapshot for ${filename} — skipping`);
      return;
    }

    const snapshotSize = getSnapshotSize(filePath);
    const bondResult = await tryBondLifecycle(filePath, "modify");

    // Fail-closed: if AgentGate is unreachable and we're not in fail-open mode, restore immediately
    if (bondResult.actionId === null && bondResult.connectionError && !failOpen) {
      log("failed", `${filename}: AgentGate unreachable — change reverted (fail-closed)`);
      justRestored.add(filePath);
      try {
        restoreSnapshot(filePath);
      } catch (err) {
        log("error", `Failed to restore ${filename} from snapshot: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Use command-based verification if configured, otherwise fall back to size threshold
    const result = verifyCmd
      ? verifyCommand(verifyCmd, absoluteDir, verifyCmdTimeoutMs)
      : verifyChange(filePath, snapshotSize, sizeChangeThreshold);

    if (result.passed) {
      await tryResolve(bondResult.actionId, true);
      try {
        takeSnapshot(filePath);
      } catch (err) {
        log("error", `Failed to update snapshot for ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
      log("passed", `${filename}: ${result.reason}`);
    } else {
      await tryResolve(bondResult.actionId, false);
      justRestored.add(filePath);
      try {
        restoreSnapshot(filePath);
      } catch (err) {
        log("error", `Failed to restore ${filename} from snapshot: ${err instanceof Error ? err.message : String(err)}`);
      }
      log("failed", `${filename}: ${result.reason} — restored from snapshot`);
    }
  }

  // Handle file deletion
  async function handleUnlink(filePath: string): Promise<void> {
    if (isDuplicate(filePath)) return;

    const filename = path.basename(filePath);
    log("unlink", `Deletion detected: ${filename}`);

    if (!hasSnapshot(filePath)) {
      log("skip", `No snapshot for ${filename} — cannot restore`);
      return;
    }

    const bondResult = await tryBondLifecycle(filePath, "delete");
    await tryResolve(bondResult.actionId, false);
    justRestored.add(filePath);
    try {
      restoreSnapshot(filePath);
    } catch (err) {
      log("error", `Failed to restore deleted ${filename} from snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
    log("restored", `${filename}: Deleted file restored from snapshot`);
  }

  // Start chokidar — ignoreInitial skips the 'add' events at startup
  const watcher: FSWatcher = watch(absoluteDir, {
    ignoreInitial: true,
    depth: 0,
    followSymlinks: false,
  });

  // Wait for chokidar to be ready before returning, so callers
  // can immediately modify files and expect events to fire.
  await new Promise<void>((resolve) => {
    watcher.on("ready", () => resolve());
  });

  watcher.on("change", (fp) => {
    withFileLock(fp, () => handleChange(fp)).catch((err) => {
      log("error", `Unhandled error in handleChange: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  watcher.on("unlink", (fp) => {
    withFileLock(fp, () => handleUnlink(fp)).catch((err) => {
      log("error", `Unhandled error in handleUnlink: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  watcher.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("no longer exists")) {
      log("error", `Watched directory was deleted — guardian cannot continue`);
      watcher.close().catch(() => {});
      log("stopped", "Watcher stopped due to directory deletion");
    } else {
      log("error", `Watcher error: ${msg}`);
    }
  });

  return {
    stop: async () => {
      await watcher.close();
      await Promise.all([...fileLocks.values()]);
      log("stopped", "Watcher stopped");
    },
  };
}
