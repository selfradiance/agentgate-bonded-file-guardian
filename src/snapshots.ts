import fs from "node:fs";
import path from "node:path";

const snapshots = new Map<string, Buffer>();

export function takeSnapshot(filePath: string): void {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`File not found: ${absolute}`);
  }
  if (fs.lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Refusing to snapshot symlink: ${absolute}`);
  }
  snapshots.set(absolute, fs.readFileSync(absolute));
}

export function restoreSnapshot(filePath: string): void {
  const absolute = path.resolve(filePath);
  const data = snapshots.get(absolute);
  if (!data) {
    throw new Error(`No snapshot exists for: ${absolute}`);
  }
  // Atomic restore: write to temp file, then rename into place.
  // Same-directory temp file ensures rename is on the same filesystem.
  const tmpPath = `${absolute}.tmp.restore`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, absolute);
}

export function hasSnapshot(filePath: string): boolean {
  return snapshots.has(path.resolve(filePath));
}

export function getSnapshotSize(filePath: string): number {
  const absolute = path.resolve(filePath);
  const data = snapshots.get(absolute);
  if (!data) {
    throw new Error(`No snapshot exists for: ${absolute}`);
  }
  return data.length;
}

export function snapshotAll(directory: string): void {
  const absolute = path.resolve(directory);
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const fullPath = path.join(absolute, entry.name);
      // Skip symlinks — they could point outside the watched directory
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
      takeSnapshot(fullPath);
    }
  }
}

export function clearSnapshots(): void {
  snapshots.clear();
}
