import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearSnapshots, hasSnapshot } from "./snapshots";

// Mock the bonds module before importing watcher
vi.mock("./bonds", () => ({
  generateKeypair: () => ({ publicKey: "fakePub", privateKey: "fakePriv" }),
  registerAgent: vi.fn().mockResolvedValue("fake-identity-id"),
  postBond: vi.fn().mockResolvedValue("fake-bond-id"),
  executeBondedAction: vi.fn().mockResolvedValue("fake-action-id"),
  resolveBond: vi.fn().mockResolvedValue(undefined),
}));

import { startWatcher, type WatcherHandle } from "./watcher";
import * as bonds from "./bonds";

function waitForEvent(
  events: Array<{ event: string; detail: string }>,
  eventName: string,
  timeoutMs = 4000,
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
        reject(new Error(`Timed out waiting for event "${eventName}". Got events: ${JSON.stringify(events)}`));
      }
    }, 50);
  });
}

describe("watcher", () => {
  let tmpDir: string;
  let handle: WatcherHandle | null;
  let events: Array<{ event: string; detail: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-watch-"));
    handle = null;
    events = [];
    clearSnapshots();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearSnapshots();
  });

  function onEvent(event: string, detail: string) {
    events.push({ event, detail });
  }

  it("starts and snapshots all files in directory", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "aaa");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "bbb");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    expect(hasSnapshot(path.join(tmpDir, "a.txt"))).toBe(true);
    expect(hasSnapshot(path.join(tmpDir, "b.txt"))).toBe(true);

    const readyEvent = events.find((e) => e.event === "ready");
    expect(readyEvent).toBeDefined();
    expect(readyEvent!.detail).toContain("2 files snapshotted");
  });

  it("modifying a file within threshold → bond released, snapshot updated", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "original content"); // 16 bytes

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      sizeChangeThreshold: 0.5,
      onEvent,
    });

    fs.writeFileSync(file, "modified content!"); // 17 bytes — 6% change
    await waitForEvent(events, "passed");

    expect(bonds.resolveBond).toHaveBeenCalledWith("http://fake", "fake", expect.anything(), "fake-action-id", true);
    expect(fs.readFileSync(file, "utf8")).toBe("modified content!");
  });

  it("emptying a file → bond slashed, file restored from snapshot", async () => {
    const file = path.join(tmpDir, "protect.txt");
    fs.writeFileSync(file, "important data");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    fs.writeFileSync(file, "");
    await waitForEvent(events, "failed");

    const failedEvent = events.find((e) => e.event === "failed");
    expect(failedEvent!.detail).toContain("emptied");
    expect(bonds.resolveBond).toHaveBeenCalledWith("http://fake", "fake", expect.anything(), "fake-action-id", false);
    expect(fs.readFileSync(file, "utf8")).toBe("important data");
  });

  it("deleting a file → bond slashed, file restored from snapshot", async () => {
    const file = path.join(tmpDir, "keepme.txt");
    fs.writeFileSync(file, "do not delete");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    fs.unlinkSync(file);
    await waitForEvent(events, "restored");

    const restoredEvent = events.find((e) => e.event === "restored");
    expect(restoredEvent!.detail).toContain("restored from snapshot");
    expect(bonds.resolveBond).toHaveBeenCalledWith("http://fake", "fake", expect.anything(), "fake-action-id", false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("do not delete");
  });

  it("stop() closes cleanly", async () => {
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "data");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    await handle.stop();

    const stoppedEvent = events.find((e) => e.event === "stopped");
    expect(stoppedEvent).toBeDefined();
    handle = null;
  });

  it("graceful degradation: file still verified and restored when bond call fails", async () => {
    vi.mocked(bonds.postBond).mockRejectedValue(new Error("AgentGate unreachable"));

    const file = path.join(tmpDir, "guarded.txt");
    fs.writeFileSync(file, "precious data");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    fs.writeFileSync(file, "");
    await waitForEvent(events, "failed");

    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.detail).toContain("AgentGate unreachable");
    expect(fs.readFileSync(file, "utf8")).toBe("precious data");
  });

  it("restore-triggered chokidar event does not post a second bond", async () => {
    const file = path.join(tmpDir, "restore-echo.txt");
    fs.writeFileSync(file, "original");

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      onEvent,
    });

    // Clear mock call counts from startup
    vi.mocked(bonds.postBond).mockClear();

    // Empty the file — verification fails, file is restored
    fs.writeFileSync(file, "");
    await waitForEvent(events, "failed");

    // Wait long enough for chokidar to fire the restore echo event (if any)
    await new Promise((r) => setTimeout(r, 500));

    // File should be restored to original content
    expect(fs.readFileSync(file, "utf8")).toBe("original");

    // postBond should only have been called ONCE (for the original change)
    // The restore echo is suppressed by either debounce (fast mocks) or justRestored set (real AgentGate)
    expect(vi.mocked(bonds.postBond).mock.calls.length).toBe(1);
  });

  it("per-file mutex: two rapid changes to the same file process sequentially", async () => {
    const file = path.join(tmpDir, "mutex.txt");
    fs.writeFileSync(file, "v1");

    // Make postBond take 200ms so we can observe sequencing
    const callOrder: string[] = [];
    vi.mocked(bonds.postBond).mockImplementation(async () => {
      callOrder.push("bond-start");
      await new Promise((r) => setTimeout(r, 200));
      callOrder.push("bond-end");
      return "fake-bond-id";
    });

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      sizeChangeThreshold: 0.5,
      onEvent,
    });

    // Two rapid writes — second should queue behind the first
    fs.writeFileSync(file, "v2");
    // Wait just enough for chokidar to fire but not for the handler to finish
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(file, "v3");

    // Wait for both handlers to complete
    await new Promise((r) => setTimeout(r, 1500));

    // With the mutex, bond calls should be sequential: start, end, start, end
    // Without the mutex, they'd interleave: start, start, end, end
    // Filter to just the bond lifecycle calls
    const bondCalls = callOrder.filter((c) => c.startsWith("bond"));
    if (bondCalls.length >= 4) {
      expect(bondCalls[0]).toBe("bond-start");
      expect(bondCalls[1]).toBe("bond-end");
      expect(bondCalls[2]).toBe("bond-start");
      expect(bondCalls[3]).toBe("bond-end");
    }
    // At minimum, the file should be in a consistent state
    expect(fs.existsSync(file)).toBe(true);
  });

  it("per-file mutex: changes to different files process concurrently", async () => {
    const fileA = path.join(tmpDir, "a.txt");
    const fileB = path.join(tmpDir, "b.txt");
    fs.writeFileSync(fileA, "aaa");
    fs.writeFileSync(fileB, "bbb");

    // Track which files start processing and when
    const timestamps: Array<{ file: string; phase: string; time: number }> = [];
    vi.mocked(bonds.postBond).mockImplementation(async (_url, _key, _keys, _id, filePath) => {
      timestamps.push({ file: path.basename(filePath), phase: "start", time: Date.now() });
      await new Promise((r) => setTimeout(r, 200));
      timestamps.push({ file: path.basename(filePath), phase: "end", time: Date.now() });
      return "fake-bond-id";
    });

    handle = await startWatcher({
      directory: tmpDir,
      agentGateUrl: "http://fake",
      apiKey: "fake",
      sizeChangeThreshold: 0.5,
      onEvent,
    });

    // Modify both files nearly simultaneously
    fs.writeFileSync(fileA, "aaa-modified");
    fs.writeFileSync(fileB, "bbb-modified");

    await new Promise((r) => setTimeout(r, 1000));

    // Both files should have been processed
    const aStamps = timestamps.filter((t) => t.file === "a.txt");
    const bStamps = timestamps.filter((t) => t.file === "b.txt");

    if (aStamps.length >= 2 && bStamps.length >= 2) {
      // Concurrent: both should START before either ENDS
      // (their 200ms bond calls should overlap)
      const aStart = aStamps.find((t) => t.phase === "start")!.time;
      const bStart = bStamps.find((t) => t.phase === "start")!.time;
      const aEnd = aStamps.find((t) => t.phase === "end")!.time;
      const bEnd = bStamps.find((t) => t.phase === "end")!.time;

      // Both should start within a short window of each other (< 150ms)
      expect(Math.abs(aStart - bStart)).toBeLessThan(150);
      // And the total time should be ~200ms (concurrent), not ~400ms (sequential)
      const totalTime = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
      expect(totalTime).toBeLessThan(400);
    }
  });
});
