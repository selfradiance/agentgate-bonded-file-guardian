import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSnapshots } from "../src/snapshots";
import { startWatcher, type WatcherHandle } from "../src/watcher";

const AGENTGATE_URL = process.env.AGENTGATE_URL;
const AGENTGATE_KEY = process.env.AGENTGATE_REST_KEY;

function waitForEvent(
  events: Array<{ event: string; detail: string }>,
  eventName: string,
  timeoutMs = 5000,
): Promise<{ event: string; detail: string }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const found = events.find((e) => e.event === eventName);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for event "${eventName}". Got: ${JSON.stringify(events.map(e => e.event))}`));
      }
    }, 50);
  });
}

// Reset events array helper — finds events added AFTER a given index
function eventsAfter(events: Array<{ event: string; detail: string }>, startIndex: number) {
  return events.slice(startIndex);
}

describe.skipIf(!AGENTGATE_URL || !AGENTGATE_KEY)(
  "end-to-end integration (live AgentGate)",
  () => {
    let tmpDir: string;
    let handle: WatcherHandle;
    let events: Array<{ event: string; detail: string }>;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-e2e-"));

      // Create test files
      fs.writeFileSync(path.join(tmpDir, "important-data.txt"), "This is critical production data", "utf8");
      fs.writeFileSync(path.join(tmpDir, "config.json"), '{"setting": "value"}', "utf8");

      events = [];
      clearSnapshots();

      handle = await startWatcher({
        directory: tmpDir,
        agentGateUrl: AGENTGATE_URL!,
        apiKey: AGENTGATE_KEY!,
        sizeChangeThreshold: 0.5,
        onEvent: (event, detail) => {
          events.push({ event, detail });
        },
      });

      // Confirm watcher is ready
      const readyEvent = events.find((e) => e.event === "ready");
      expect(readyEvent).toBeDefined();
      expect(readyEvent!.detail).toContain("2 files snapshotted");
    }, 15000); // Allow extra time for AgentGate registration

    afterAll(async () => {
      if (handle) {
        await handle.stop();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearSnapshots();
    });

    it("releases bond when file modification is within threshold", async () => {
      const file = path.join(tmpDir, "important-data.txt");
      const before = fs.readFileSync(file, "utf8");
      const eventsBefore = events.length;

      // Append small text (well within 50% threshold)
      fs.writeFileSync(file, before + " - updated", "utf8");

      // Wait for the watcher to process
      const recent = () => eventsAfter(events, eventsBefore);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (recent().some((e) => e.event === "passed")) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - start > 10000) {
            clearInterval(interval);
            reject(new Error(`Timed out. Events after action: ${JSON.stringify(recent())}`));
          }
        }, 50);
      });

      // File should still have the appended text (change was accepted)
      expect(fs.readFileSync(file, "utf8")).toBe(before + " - updated");
    }, 15000);

    it("slashes bond and restores file when file is emptied", async () => {
      const file = path.join(tmpDir, "config.json");
      const contentBefore = fs.readFileSync(file, "utf8");
      const eventsBefore = events.length;

      // Empty the file
      fs.writeFileSync(file, "", "utf8");

      // Wait for restoration
      const recent = () => eventsAfter(events, eventsBefore);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (recent().some((e) => e.event === "failed")) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - start > 10000) {
            clearInterval(interval);
            reject(new Error(`Timed out. Events after action: ${JSON.stringify(recent())}`));
          }
        }, 50);
      });

      // File should be restored to previous content
      expect(fs.readFileSync(file, "utf8")).toBe(contentBefore);
    }, 15000);

    it("slashes bond and restores file when file is deleted", async () => {
      const file = path.join(tmpDir, "important-data.txt");
      const contentBefore = fs.readFileSync(file, "utf8");
      const eventsBefore = events.length;

      // Delete the file
      fs.unlinkSync(file);

      // Wait for restoration
      const recent = () => eventsAfter(events, eventsBefore);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (recent().some((e) => e.event === "restored")) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - start > 10000) {
            clearInterval(interval);
            reject(new Error(`Timed out. Events after action: ${JSON.stringify(recent())}`));
          }
        }, 50);
      });

      // File should exist again, restored from snapshot
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(contentBefore);
    }, 15000);
  },
);
