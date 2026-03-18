import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  takeSnapshot,
  restoreSnapshot,
  hasSnapshot,
  getSnapshotSize,
  snapshotAll,
  clearSnapshots,
} from "./snapshots";

describe("snapshots", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-snap-"));
    clearSnapshots();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearSnapshots();
  });

  it("takes a snapshot and restores it after modification", () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "original content", "utf8");

    takeSnapshot(file);
    expect(hasSnapshot(file)).toBe(true);

    // Modify the file
    fs.writeFileSync(file, "modified content", "utf8");
    expect(fs.readFileSync(file, "utf8")).toBe("modified content");

    // Restore from snapshot
    restoreSnapshot(file);
    expect(fs.readFileSync(file, "utf8")).toBe("original content");

    // Atomic restore: temp file should not persist
    expect(fs.existsSync(`${file}.tmp.restore`)).toBe(false);
  });

  it("getSnapshotSize returns correct byte size", () => {
    const file = path.join(tmpDir, "sized.txt");
    const content = "hello world"; // 11 bytes
    fs.writeFileSync(file, content, "utf8");

    takeSnapshot(file);
    expect(getSnapshotSize(file)).toBe(11);
  });

  it("throws when taking snapshot of nonexistent file", () => {
    expect(() => takeSnapshot(path.join(tmpDir, "nope.txt"))).toThrow("File not found");
  });

  it("throws when restoring with no snapshot", () => {
    const file = path.join(tmpDir, "no-snap.txt");
    fs.writeFileSync(file, "data", "utf8");
    expect(() => restoreSnapshot(file)).toThrow("No snapshot exists");
  });

  it("throws when getting size with no snapshot", () => {
    expect(() => getSnapshotSize(path.join(tmpDir, "nope.txt"))).toThrow("No snapshot exists");
  });

  it("hasSnapshot returns false for unknown file", () => {
    expect(hasSnapshot(path.join(tmpDir, "unknown.txt"))).toBe(false);
  });

  it("snapshotAll captures all files in a directory", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "aaa", "utf8");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "bbb", "utf8");
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "ccc", "utf8");

    snapshotAll(tmpDir);

    expect(hasSnapshot(path.join(tmpDir, "a.txt"))).toBe(true);
    expect(hasSnapshot(path.join(tmpDir, "b.txt"))).toBe(true);
    expect(hasSnapshot(path.join(tmpDir, "c.txt"))).toBe(true);
  });

  it("snapshotAll skips subdirectories", () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "data", "utf8");
    fs.mkdirSync(path.join(tmpDir, "subdir"));
    fs.writeFileSync(path.join(tmpDir, "subdir", "nested.txt"), "nested", "utf8");

    snapshotAll(tmpDir);

    expect(hasSnapshot(path.join(tmpDir, "file.txt"))).toBe(true);
    expect(hasSnapshot(path.join(tmpDir, "subdir", "nested.txt"))).toBe(false);
  });

  it("clearSnapshots removes all stored snapshots", () => {
    const file = path.join(tmpDir, "clear-me.txt");
    fs.writeFileSync(file, "data", "utf8");

    takeSnapshot(file);
    expect(hasSnapshot(file)).toBe(true);

    clearSnapshots();
    expect(hasSnapshot(file)).toBe(false);
  });

  it("handles binary files correctly", () => {
    const file = path.join(tmpDir, "binary.bin");
    const buf = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37]);
    fs.writeFileSync(file, buf);

    takeSnapshot(file);

    // Overwrite with different data
    fs.writeFileSync(file, Buffer.from([0xde, 0xad]));

    restoreSnapshot(file);
    expect(fs.readFileSync(file)).toEqual(buf);

    // Atomic restore: temp file should not persist
    expect(fs.existsSync(`${file}.tmp.restore`)).toBe(false);
  });

  it("takeSnapshot throws on symlinks", () => {
    const realFile = path.join(tmpDir, "real.txt");
    const link = path.join(tmpDir, "link.txt");
    fs.writeFileSync(realFile, "data", "utf8");
    fs.symlinkSync(realFile, link);

    expect(() => takeSnapshot(link)).toThrow("Refusing to snapshot symlink");
  });

  it("snapshotAll skips symlinks", () => {
    const realFile = path.join(tmpDir, "real.txt");
    const link = path.join(tmpDir, "link.txt");
    fs.writeFileSync(realFile, "data", "utf8");
    fs.symlinkSync(realFile, link);

    snapshotAll(tmpDir);

    expect(hasSnapshot(realFile)).toBe(true);
    expect(hasSnapshot(link)).toBe(false);
  });
});
