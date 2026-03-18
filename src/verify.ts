import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type VerificationResult = {
  passed: boolean;
  reason: string;
};

export function verifyChange(
  filePath: string,
  snapshotSize: number,
  sizeChangeThreshold: number,
): VerificationResult {
  const absolute = path.resolve(filePath);

  // a. File still exists
  if (!fs.existsSync(absolute)) {
    return { passed: false, reason: "File was deleted" };
  }

  const currentSize = fs.statSync(absolute).size;

  // b. File is not empty
  if (currentSize === 0) {
    return { passed: false, reason: "File was emptied" };
  }

  // c. Size change within threshold (skip if snapshot was 0 bytes — can't compute ratio)
  if (snapshotSize > 0) {
    const ratio = Math.abs(currentSize - snapshotSize) / snapshotSize;
    if (ratio > sizeChangeThreshold) {
      const actualPct = Math.round(ratio * 100);
      const thresholdPct = Math.round(sizeChangeThreshold * 100);
      return {
        passed: false,
        reason: `File size changed by ${actualPct}% (threshold: ${thresholdPct}%)`,
      };
    }
  }

  return { passed: true, reason: "All checks passed" };
}

/**
 * Run a user-supplied shell command as verification.
 * Exit code 0 = pass, non-zero = fail.
 * Runs with the watched directory as cwd.
 */
export function verifyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): VerificationResult {
  try {
    execSync(command, {
      cwd: path.resolve(cwd),
      timeout: timeoutMs,
      stdio: "pipe", // capture output, don't print to guardian's stdout
    });
    return { passed: true, reason: `Command passed: ${command}` };
  } catch (err: unknown) {
    const error = err as { status?: number; killed?: boolean; signal?: string; stderr?: Buffer; message?: string };

    if (error.killed || error.signal === "SIGTERM") {
      return {
        passed: false,
        reason: `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`,
      };
    }

    const exitCode = error.status ?? "unknown";
    const stderr = error.stderr ? error.stderr.toString("utf8").trim().slice(0, 200) : "";
    const detail = stderr ? ` — ${stderr}` : "";
    return {
      passed: false,
      reason: `Command failed (exit ${exitCode}): ${command}${detail}`,
    };
  }
}
