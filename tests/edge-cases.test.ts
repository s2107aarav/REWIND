import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  captureSnapshot,
  createDemo,
  createFaultLab,
  createRepository,
  editDemo,
  getSnapshot,
  labRepository,
  loadScan,
  objectPath,
  openFaultLab,
  openRepository,
  planRepair,
  readObject,
  references,
  restoreSnapshot,
  scanHealth,
  storageAccounting,
  verifyReceipt,
} from "../packages/core/index.js";
import { readBounded, withLock } from "../packages/core/fs.js";
import { DesktopService } from "../apps/desktop/service.js";
import { fresh } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function small() {
  const root = await fresh("edges");
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "file.txt"), "original bytes");
  const repo = await createRepository(path.join(root, "repo"), source, [
    path.join(root, "a"),
    path.join(root, "b"),
  ]);
  const id = await captureSnapshot(repo);
  return { root, repo, id };
}

it("ignores malformed and mismatched saved scan evidence", async () => {
  const { repo } = await small();
  const scan = await scanHealth(repo, true);
  for (const invalid of [
    { repositoryId: repo.config.id },
    { ...scan, scope: ["/other-a", "/other-b"] },
    {
      ...scan,
      copies: Object.fromEntries(Object.keys(scan.copies).map((h) => [h, []])),
    },
    { ...scan, deep: false },
    { ...scan, counts: { VERIFIED_OK: 999 } },
  ]) {
    await fs.writeFile(
      path.join(repo.home, "latest-scan.json"),
      JSON.stringify(invalid),
    );
    expect(await loadScan(repo)).toBeUndefined();
  }
});

it("keeps the desktop usable when an expected storage directory is missing", async () => {
  const { root, repo } = await small();
  await fs.rm(path.join(repo.config.roots[0], "objects"), { recursive: true });
  const stats = await storageAccounting(repo);
  expect(stats.physicalBytes).toBeGreaterThan(0);
  const managed = path.join(root, "desktop");
  await fs.mkdir(managed);
  await fs.writeFile(
    path.join(managed, "active.json"),
    JSON.stringify({ repository: repo.home }),
  );
  const service = new DesktopService(managed);
  await service.init();
  const state = await service.state();
  expect(state.ready).toBe(true);
  expect(state.warnings.some((w) => w.includes("objects"))).toBe(true);
  expect(
    await service.request({ action: "scan", scope: "original", deep: true }),
  ).toBeDefined();
});

it("rejects relative or empty persisted repository paths", async () => {
  const { repo } = await small();
  for (const source of ["", "relative/source"]) {
    await fs.writeFile(
      path.join(repo.home, "repository.json"),
      JSON.stringify({ ...repo.config, source }),
    );
    await expect(openRepository(repo.home)).rejects.toThrow();
  }
});

it("refuses nonempty demo roots before touching their contents", async () => {
  const root = await fresh("existing-demo");
  roots.push(root);
  await fs.mkdir(path.join(root, "source", "Documents"), { recursive: true });
  const file = path.join(root, "source", "Documents", "project-notes.md");
  await fs.writeFile(file, "keep my edits");
  await expect(createDemo(root)).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("keep my edits");
  expect(await fs.readdir(root)).toEqual(["source"]);
});

it("demo edits reject symlinks without changing an external file", async () => {
  const root = await fresh("demo-links");
  roots.push(root);
  const repo = await createDemo(path.join(root, "demo"));
  const external = path.join(root, "external.txt");
  await fs.writeFile(external, "external bytes");
  const notes = path.join(repo.config.source, "Documents", "project-notes.md");
  await fs.unlink(notes);
  await fs.symlink(external, notes);
  await expect(editDemo(repo, 4)).rejects.toThrow("Symlink");
  expect(await fs.readFile(external, "utf8")).toBe("external bytes");
});

it("rejects malformed receipts before displaying or verifying success", async () => {
  const { root, repo, id } = await small();
  const receipt = await restoreSnapshot(repo, id, path.join(root, "out"));
  await fs.writeFile(
    path.join(repo.home, "receipts", receipt.id + ".json"),
    JSON.stringify({ ...receipt, files: 999 }),
  );
  await expect(verifyReceipt(repo, receipt.id)).rejects.toThrow("receipt");
});

it("records portable filenames that overlap Object prototype keys", async () => {
  const { root, repo } = await small();
  await fs.writeFile(
    path.join(repo.config.source, "__proto__"),
    "prototype filename",
  );
  const id = await captureSnapshot(repo);
  const receipt = await restoreSnapshot(
    repo,
    id,
    path.join(root, "prototype-out"),
  );
  expect(Object.hasOwn(receipt.hashes, "__proto__")).toBe(true);
  expect((await verifyReceipt(repo, receipt.id)).valid).toBe(true);
});

it("derived catalog access rejects a substituted symlink", async () => {
  const { root, repo } = await small();
  const target = path.join(root, "external.sqlite");
  const catalog = path.join(repo.home, "catalog.sqlite");
  await fs.copyFile(catalog, target);
  await fs.unlink(catalog);
  await fs.symlink(target, catalog);
  await expect(references(repo, "0".repeat(64))).rejects.toThrow("Symlink");
  await expect(scanHealth(repo, true)).rejects.toThrow("Symlink");
});

it("rebuilds a damaged catalog while recording a new scan", async () => {
  const { repo } = await small();
  await fs.writeFile(path.join(repo.home, "catalog.sqlite"), "broken sqlite");
  expect((await scanHealth(repo, true)).counts.VERIFIED_OK).toBeGreaterThan(0);
  expect(
    (await fs.readdir(repo.home)).some((n) =>
      n.startsWith("catalog.sqlite.damaged-"),
    ),
  ).toBe(true);
});

it("reopened laboratory handles see faults persisted by other handles", async () => {
  const { root, repo } = await small();
  const managed = path.join(root, "labs");
  const first = await createFaultLab(repo, managed);
  const second = await openFaultLab(managed, first.id);
  const { injectFault, scenarioRecord } = await import(
    "../packages/core/lab.js"
  );
  await injectFault(second, "unavailable", 0);
  expect((await labRepository(first)).disabled?.has(0)).toBe(true);
  expect((await scenarioRecord(first)).actions).toHaveLength(1);
});

it("repair utility excludes versions with contradictory whole-file metadata", async () => {
  const { repo, id } = await small();
  const { canonical, sha } = await import("../packages/core/schema.js");
  const manifest = await getSnapshot(repo, id);
  const file = manifest.entries.find((e) => e.type === "file");
  if (file?.type !== "file") throw new Error("fixture");
  file.hash = "0".repeat(64);
  const bytes = canonical(manifest),
    invalidId = sha(bytes);
  for (const root of repo.config.roots) {
    await fs.unlink(path.join(root, "commits", id + ".json"));
    await fs.writeFile(
      path.join(root, "manifests", invalidId + ".json"),
      bytes,
    );
    await fs.writeFile(
      path.join(root, "commits", invalidId + ".json"),
      canonical({
        version: 1,
        repositoryId: repo.config.id,
        snapshotId: invalidId,
      }),
    );
  }
  await fs.unlink(path.join(repo.home, "catalog.sqlite"));
  await fs.unlink(objectPath(repo.config.roots[0], file.chunks[0].hash));
  const scan = await scanHealth(repo, true);
  expect((await planRepair(repo, scan, 0, 10000)).utility).toBe(0);
});

it("recovers malformed lock metadata using actual OS ownership", async () => {
  const { repo } = await small();
  await fs.writeFile(
    path.join(repo.home, "operation.lock"),
    JSON.stringify({ pid: -1 }),
  );
  expect(await withLock(repo.home, async () => "recovered")).toBe("recovered");
});

it("bounded reads reject oversized objects", async () => {
  const { repo, id } = await small();
  const file = (await getSnapshot(repo, id)).entries.find(
    (e) => e.type === "file",
  );
  if (file?.type !== "file") throw new Error("fixture");
  await fs.writeFile(
    objectPath(repo.config.roots[0], file.chunks[0].hash),
    Buffer.alloc(262145),
  );
  await expect(readObject(repo, 0, file.chunks[0])).rejects.toThrow();
  await expect(
    readBounded(path.join(repo.config.source, "file.txt"), 1),
  ).rejects.toThrow();
});

it("holds an exclusive lock until the operation closes its descriptor", async () => {
  const { repo } = await small();
  await withLock(repo.home, async () => {
    await expect(withLock(repo.home, async () => "overlap")).rejects.toThrow(
      "busy",
    );
  });
  expect(await withLock(repo.home, async () => "released")).toBe("released");
});

it("keeps cached history visible when only some commit inventories are accessible", async () => {
  const { repo, id } = await small();
  await fs.writeFile(path.join(repo.config.source, "file.txt"), "newer bytes");
  const second = await captureSnapshot(repo);
  await fs.unlink(path.join(repo.config.roots[1], "commits", id + ".json"));
  repo.disabled = new Set([0]);
  const { listSnapshots } = await import("../packages/core/repository.js");
  const records = await listSnapshots(repo);
  expect(records.map((r) => r.id)).toEqual([id, second]);
  expect(records[0].degraded.join(" ")).toContain("catalog");
});

it("a cancelled desktop mutation does not apply a fault", async () => {
  const { root, repo } = await small();
  const managed = path.join(root, "desktop");
  await fs.mkdir(managed);
  await fs.writeFile(
    path.join(managed, "active.json"),
    JSON.stringify({ repository: repo.home }),
  );
  const service = new DesktopService(managed);
  await service.init();
  await service.request({ action: "create-lab", seed: 42 });
  const controller = new AbortController();
  controller.abort();
  await expect(
    service.request(
      { action: "fault", kind: "unavailable", backend: 0 },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect((await service.state("lab")).lab?.actions).toEqual([]);
});

it("missing receipt directories produce warnings without breaking the workspace", async () => {
  const { root, repo } = await small();
  const managed = path.join(root, "desktop");
  await fs.mkdir(managed);
  await fs.writeFile(
    path.join(managed, "active.json"),
    JSON.stringify({ repository: repo.home }),
  );
  await fs.rm(path.join(repo.home, "receipts"), { recursive: true });
  const service = new DesktopService(managed);
  await service.init();
  const state = await service.state();
  expect(state.ready).toBe(true);
  expect(state.warnings.join(" ")).toContain("receipts");
});

it("rebuilds structurally damaged derived tables", async () => {
  const { repo } = await small();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(repo.home, "catalog.sqlite"));
  db.exec("DROP TABLE scans; CREATE TABLE scans (wrong TEXT)");
  db.close();
  expect((await scanHealth(repo, true)).counts.VERIFIED_OK).toBeGreaterThan(0);
});

it("rejects source aliases on a case-insensitive filesystem", async () => {
  const { root, repo } = await small();
  const alias = path.join(root, "SOURCE");
  try {
    if ((await fs.stat(alias)).ino !== (await fs.stat(repo.config.source)).ino)
      return;
  } catch {
    return;
  }
  await expect(
    createRepository(path.join(root, "other"), repo.config.source, [
      path.join(alias, "nested"),
      path.join(root, "other-copy"),
    ]),
  ).rejects.toThrow("overlapping");
  await expect(
    restoreSnapshot(
      repo,
      (
        await (
          await import("../packages/core/repository.js")
        ).listSnapshots(repo)
      )[0].id,
      path.join(alias, "restore"),
    ),
  ).rejects.toThrow("overlaps");
});
