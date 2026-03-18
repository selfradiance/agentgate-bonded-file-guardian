import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { DEFAULT_CONFIG } from "./config";
import { snapshotAll, hasSnapshot, getSnapshotSize, restoreSnapshot, takeSnapshot } from "./snapshots";
import { verifyChange } from "./verify";
import { registerAgent, postBond, executeBondedAction, resolveBond, generateKeypair, type AgentKeys } from "./bonds";

export interface WatcherOptions {
  directory: string;
  agentGateUrl?: string;
  apiKey?: string;
  sizeChangeThreshold?: number;
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

  // Restore-echo suppression — skip the chokidar event triggered by our own restore
  const justRestored = new Set<string>();

  // Bond lifecycle helper — posts bond, executes action, returns actionId.
  // Returns null if AgentGate calls fail (graceful degradation).
  async function tryBondLifecycle(filePath: string, action: string): Promise<string | null> {
    try {
      const bondId = await postBond(agentGateUrl, apiKey, keys, identityId, filePath, action);
      const actionId = await executeBondedAction(agentGateUrl, apiKey, keys, identityId, bondId, filePath, action);
      return actionId;
    } catch (err) {
      log("error", `Bond lifecycle failed for ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
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
    const actionId = await tryBondLifecycle(filePath, "modify");

    const result = verifyChange(filePath, snapshotSize, sizeChangeThreshold);

    if (result.passed) {
      await tryResolve(actionId, true);
      takeSnapshot(filePath); // Update snapshot to new state
      log("passed", `${filename}: ${result.reason}`);
    } else {
      await tryResolve(actionId, false);
      justRestored.add(filePath);
      restoreSnapshot(filePath);
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

    const actionId = await tryBondLifecycle(filePath, "delete");
    await tryResolve(actionId, false);
    justRestored.add(filePath);
    restoreSnapshot(filePath);
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
    handleChange(fp).catch((err) => {
      log("error", `Unhandled error in handleChange: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  watcher.on("unlink", (fp) => {
    handleUnlink(fp).catch((err) => {
      log("error", `Unhandled error in handleUnlink: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return {
    stop: async () => {
      await watcher.close();
      log("stopped", "Watcher stopped");
    },
  };
}
