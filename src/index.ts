// Agent 002: File Guardian — entry point

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config";
import { startWatcher, type WatcherHandle } from "./watcher";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  directory: string;
  agentGateUrl: string;
  apiKey: string;
  sizeChangeThreshold: number;
  verifyCmd: string;
  verifyCmdTimeoutMs: number;
} {
  const args = argv.slice(2);
  let directory = "";
  let agentGateUrl = DEFAULT_CONFIG.agentGateUrl;
  let apiKey = DEFAULT_CONFIG.apiKey;
  let sizeChangeThreshold = DEFAULT_CONFIG.sizeChangeThreshold;
  let verifyCmd = DEFAULT_CONFIG.verifyCmd;
  let verifyCmdTimeoutMs = DEFAULT_CONFIG.verifyCmdTimeoutMs;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agentgate-url" && args[i + 1]) {
      agentGateUrl = args[++i];
    } else if (args[i] === "--api-key" && args[i + 1]) {
      apiKey = args[++i];
    } else if (args[i] === "--threshold" && args[i + 1]) {
      sizeChangeThreshold = parseFloat(args[++i]) / 100; // user passes percentage, e.g. 50 → 0.5
    } else if (args[i] === "--verify-cmd" && args[i + 1]) {
      verifyCmd = args[++i];
    } else if (args[i] === "--verify-timeout" && args[i + 1]) {
      verifyCmdTimeoutMs = parseInt(args[++i], 10) * 1000; // user passes seconds, e.g. 30 → 30000
    } else if (args[i] === "--dir" && args[i + 1]) {
      directory = args[++i];
    } else if (!args[i].startsWith("--") && !directory) {
      directory = args[i];
    }
  }

  return { directory, agentGateUrl, apiKey, sizeChangeThreshold, verifyCmd, verifyCmdTimeoutMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { directory, agentGateUrl, apiKey, sizeChangeThreshold, verifyCmd, verifyCmdTimeoutMs } = parseArgs(process.argv);

  // Validate threshold
  if (!Number.isFinite(sizeChangeThreshold) || sizeChangeThreshold < 0) {
    console.error("Error: Invalid threshold value — must be a positive number (e.g., 50 for 50%)");
    process.exit(1);
  }
  if (sizeChangeThreshold === 0) {
    console.warn("Warning: threshold 0 means ANY size change will trigger a slash — this is almost certainly not what you want");
  }
  if (sizeChangeThreshold > 10) {
    console.warn("Warning: threshold greater than 1000% means files can change dramatically without triggering — this is very permissive");
  }

  if (!directory) {
    console.error("Usage: npx tsx src/index.ts <directory> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --agentgate-url <url>   AgentGate server URL (default: http://127.0.0.1:3000)");
    console.error("  --api-key <key>         AgentGate REST key (default: AGENTGATE_REST_KEY env var)");
    console.error("  --threshold <percent>   Max allowed size change % (default: 50)");
    console.error("  --verify-cmd <command>  Shell command to run for verification (exit 0 = pass)");
    console.error("  --verify-timeout <sec>  Timeout for verify command in seconds (default: 30)");
    process.exit(1);
  }

  const absoluteDir = path.resolve(directory);

  if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
    console.error(`Error: "${absoluteDir}" is not a valid directory`);
    process.exit(1);
  }

  console.log("");
  console.log("  Agent 002: File Guardian");
  console.log(`  Watching:        ${absoluteDir}`);
  console.log(`  AgentGate:       ${agentGateUrl}`);
  console.log(`  Verification:    ${verifyCmd ? `command: ${verifyCmd} (${Math.round(verifyCmdTimeoutMs / 1000)}s timeout)` : `size threshold: ${Math.round(sizeChangeThreshold * 100)}%`}`);
  console.log("");

  let handle: WatcherHandle | undefined;

  try {
    handle = await startWatcher({
      directory: absoluteDir,
      agentGateUrl,
      apiKey,
      sizeChangeThreshold,
      verifyCmd: verifyCmd || undefined,
      verifyCmdTimeoutMs,
      onEvent: (event, detail) => {
        const timestamp = new Date().toISOString().slice(11, 19);
        console.log(`[${timestamp}] [${event}] ${detail}`);
      },
    });
  } catch (err) {
    console.error(`Failed to start guardian: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    try {
      if (handle) await handle.stop();
    } catch (err) {
      console.error(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    process.exit(0);
  });

  // Keep process alive
  process.on("uncaughtException", async (err) => {
    console.error(`Fatal error: ${err.message}`);
    if (handle) {
      await handle.stop();
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
