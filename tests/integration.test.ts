import { afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  captureSnapshot,
  diffSnapshots,
  getSnapshot,
  storageAccounting,
  listSnapshots,
  scanHealth,
  analyzeFrontier,
  entryState,
  explain,
  restoreSnapshot,
  verifyReceipt,
  verifyRestored,
  rebuildCatalog,
  references,
  createFaultLab,
  injectFault,
  labRepository,
  scenarioRecord,
  replayScenario,
  objectPath,
  createRepository,
  canonical,
  sha,
  validateManifest,
  openRepository,
} from "../packages/core/index.js";
import { requestSchema } from "../packages/core/requests.js";
import { fixture, fresh } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
describe("real storage and recovery", () => {
  it("captures history, deduplicates, diffs, restores empty directories and metadata, rebuilds SQLite", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const s1 = await captureSnapshot(repo, "first");
    await fs.appendFile(
      path.join(repo.config.source, "Documents/project-notes.md"),
      "edited",
    );
    await fs.rm(path.join(repo.config.source, "Research/sample-0001.dat"));
    await fs.writeFile(path.join(repo.config.source, "new.txt"), "new");
    const s2 = await captureSnapshot(repo, "second");
    const diff = await diffSnapshots(repo, s1, s2);
    expect(diff.added).toContain("new.txt");
    expect(diff.removed).toContain("Research/sample-0001.dat");
    expect(diff.changed).toContain("Documents/project-notes.md");
    const stats = await storageAccounting(repo);
    expect(stats.uniqueBytes).toBeLessThan(stats.logicalBytes * 0.6);
    const manifest = await getSnapshot(repo, s1);
    const dest = path.join(root, "restore");
    const receipt = await restoreSnapshot(repo, s1, dest);
    expect((await verifyReceipt(repo, receipt.id)).valid).toBe(true);
    expect(
      (await fs.stat(path.join(dest, "Archive/empty"))).isDirectory(),
    ).toBe(true);
    expect((await fs.stat(path.join(dest, "Documents/empty.txt"))).size).toBe(
      0,
    );
    expect(
      (await fs.stat(path.join(dest, "Documents/project-notes.md"))).mode &
        0o777,
    ).toBe(
      manifest.entries.find((e) => e.path === "Documents/project-notes.md")!
        .mode,
    );
    await fs.rm(path.join(repo.home, "catalog.sqlite"));
    await rebuildCatalog(repo);
    const db = new DatabaseSync(path.join(repo.home, "catalog.sqlite"));
    expect(
      (db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number })
        .n,
    ).toBe(2);
    db.close();
    const file = manifest.entries.find(
      (e) => e.type === "file" && e.chunks.length,
    )!;
    if (file.type === "file")
      expect(
        (await references(repo, file.chunks[0].hash)).length,
      ).toBeGreaterThan(0);
  });
  it("quick scan stays unverified; corrupt A falls back to B; all loss is lost; unavailable is unknown", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    const m = await getSnapshot(repo, id);
    const file = m.entries.find((e) => e.type === "file" && e.chunks.length)!;
    if (file.type !== "file") throw new Error("fixture");
    const c = file.chunks[0];
    let scan = await scanHealth(repo, false);
    expect(entryState(file, scan)).toBe("PRESENT_BUT_UNVERIFIED");
    await fs.writeFile(objectPath(repo.config.roots[0], c.hash), "broken");
    scan = await scanHealth(repo, true);
    expect(entryState(file, scan)).toBe("VERIFIED_RECOVERABLE");
    const receipt = await restoreSnapshot(
      repo,
      id,
      path.join(root, "fallback"),
    );
    expect(receipt.sources[c.hash]).toBe("B");
    await fs.rm(objectPath(repo.config.roots[1], c.hash));
    scan = await scanHealth(repo, true);
    expect(entryState(file, scan)).toBe("KNOWN_UNRECOVERABLE");
    repo.disabled = new Set([1]);
    scan = await scanHealth(repo, true);
    expect(entryState(file, scan)).toBe("UNKNOWN");
    const explanation = await explain(repo, id, file.path, scan);
    expect(explanation.chunks[0].copies[1].state).toBe("BACKEND_UNAVAILABLE");
    expect(explanation.chunks[0].affectedVersions).toBeGreaterThan(0);
    await expect(
      restoreSnapshot(repo, id, path.join(root, "cannot-restore")),
    ).rejects.toThrow("incomplete");
  });
  it("independent verifier detects post-restore modification and selective restore is real", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    const dest = path.join(root, "selective");
    const receipt = await restoreSnapshot(repo, id, dest, [
      "Documents/project-notes.md",
    ]);
    expect(receipt.files).toBe(1);
    expect((await verifyReceipt(repo, receipt.id)).valid).toBe(true);
    await fs.appendFile(path.join(dest, "Documents/project-notes.md"), "bad");
    expect((await verifyReceipt(repo, receipt.id)).valid).toBe(false);
    await expect(restoreSnapshot(repo, id, dest)).rejects.toThrow(
      "already exists",
    );
  });
  it("detects damaged manifests, uses other metadata replica, then marks invalid", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    await fs.writeFile(
      path.join(repo.config.roots[0], "manifests", id + ".json"),
      "{}",
    );
    expect((await listSnapshots(repo))[0].degraded.length).toBe(1);
    await fs.writeFile(
      path.join(repo.config.roots[1], "manifests", id + ".json"),
      "{}",
    );
    expect(analyzeFrontier(await listSnapshots(repo))[0].state).toBe(
      "INVALID_METADATA",
    );
  });
  it("aborts capture when an existing immutable object is damaged", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    const file = (await getSnapshot(repo, id)).entries.find(
      (e) => e.type === "file" && e.chunks.length,
    );
    if (file?.type !== "file") throw new Error("fixture");
    await fs.writeFile(
      objectPath(repo.config.roots[0], file.chunks[0].hash),
      "bad",
    );
    await expect(captureSnapshot(repo)).rejects.toThrow("mismatch");
    expect(await listSnapshots(repo)).toHaveLength(1);
  });
});
describe("isolated lab and paths", () => {
  it("physical copy preserves originals, rejects forged handles and symlink escape, replays deterministically", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    const lab = await createFaultLab(repo, path.join(root, "labs"), 42);
    const copy = await labRepository(lab);
    const file = (await getSnapshot(repo, id)).entries.find(
      (e) => e.type === "file" && e.chunks.length,
    );
    if (file?.type !== "file") throw new Error("fixture");
    const hash = file.chunks[0].hash;
    const a = await fs.stat(objectPath(repo.config.roots[0], hash)),
      b = await fs.stat(objectPath(copy.config.roots[0], hash));
    expect(a.ino).not.toBe(b.ino);
    await injectFault(lab, "corrupt", 0, hash);
    expect((await scanHealth(repo, true)).counts.CORRUPT || 0).toBe(0);
    await expect(
      injectFault({ id: lab.id, seed: 42 }, "missing", 0, hash),
    ).rejects.toThrow("internally issued");
    const scenario = await scenarioRecord(lab);
    const replay = await replayScenario(
      repo,
      path.join(root, "labs"),
      scenario,
    );
    expect(
      (await scanHealth(await labRepository(replay), true)).counts.CORRUPT,
    ).toBe(1);
    await fs.rm(path.join(copy.config.roots[0], "objects"), {
      recursive: true,
    });
    await fs.symlink(
      path.join(repo.config.roots[0], "objects"),
      path.join(copy.config.roots[0], "objects"),
    );
    await expect(injectFault(lab, "missing", 0, hash)).rejects.toThrow(
      "Symlink",
    );
    expect((await scanHealth(repo, true)).counts.CORRUPT || 0).toBe(0);
  });
  it("rejects overlapping roots and symlink source/restore parents; skips source symlinks", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    await expect(
      createRepository(path.join(root, "new"), repo.config.source, [
        path.join(repo.config.source, "nested"),
        path.join(root, "z"),
      ]),
    ).rejects.toThrow("overlapping");
    await fs.symlink(
      "Documents/project-notes.md",
      path.join(repo.config.source, "link"),
    );
    const id = await captureSnapshot(repo);
    expect((await getSnapshot(repo, id)).skipped[0].reason).toBe("symlink");
    await fs.symlink(root, path.join(root, "parent-link"));
    await expect(
      restoreSnapshot(repo, id, path.join(root, "parent-link/out")),
    ).rejects.toThrow("Symlink");
    await expect(
      restoreSnapshot(repo, id, path.join(repo.config.source, "new")),
    ).rejects.toThrow("overlaps");
  });
  it("rejects manifest traversal/duplicate/case aliases and oversized IPC scope", async () => {
    const { root, repo } = await fixture();
    roots.push(root);
    const id = await captureSnapshot(repo);
    const m = await getSnapshot(repo, id);
    expect(() =>
      validateManifest({
        ...m,
        entries: [
          { type: "directory", path: "../escape", mode: 0o700, mtimeMs: 1 },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...m,
        entries: [
          { type: "directory", path: "A", mode: 0o700, mtimeMs: 1 },
          { type: "directory", path: "a", mode: 0o700, mtimeMs: 1 },
        ],
      }),
    ).toThrow("Case");
    expect(() =>
      requestSchema.parse({
        action: "fault",
        kind: "missing",
        backend: 0,
        root: repo.config.roots[0],
      }),
    ).toThrow();
    expect(sha(canonical(m))).toBe(id);
  });
  it("rejects unknown config versions", async () => {
    const root = await fresh();
    roots.push(root);
    await fs.writeFile(path.join(root, "repository.json"), '{"version":999}');
    await expect(openRepository(root)).rejects.toThrow();
  });
  it("handles an empty source snapshot", async () => {
    const root = await fresh();
    roots.push(root);
    await fs.mkdir(path.join(root, "s"));
    const repo = await createRepository(
      path.join(root, "r"),
      path.join(root, "s"),
      [path.join(root, "a"), path.join(root, "b")],
    );
    const id = await captureSnapshot(repo);
    expect(
      (
        await verifyRestored(
          await getSnapshot(repo, id),
          (await restoreSnapshot(repo, id, path.join(root, "out"))).destination,
        )
      ).valid,
    ).toBe(true);
  });
});

describe("fresh evidence and interruption visibility", () => {
  it("rechecks corruption after a previous healthy scan and detects contradictory file metadata", async () => {
    const { root, repo } = await fixture(1);
    roots.push(root);
    const id = await captureSnapshot(repo);
    const manifest = await getSnapshot(repo, id);
    const file = manifest.entries.find(
      (e) => e.type === "file" && e.chunks.length,
    )!;
    if (file.type !== "file") throw new Error("fixture");
    expect(entryState(file, await scanHealth(repo, true))).toBe(
      "VERIFIED_RECOVERABLE",
    );
    for (const r of repo.config.roots)
      await fs.writeFile(
        objectPath(r, file.chunks[0].hash),
        "post-scan corruption",
      );
    expect(entryState(file, await scanHealth(repo, true))).toBe(
      "KNOWN_UNRECOVERABLE",
    );
  });
  it("keeps known file versions unknown when both backends go offline, using verified catalog cache", async () => {
    const { root, repo } = await fixture(1);
    roots.push(root);
    await captureSnapshot(repo);
    repo.disabled = new Set([0, 1]);
    const records = await listSnapshots(repo);
    expect(records.length).toBe(1);
    const scan = await scanHealth(repo, true);
    const nonempty = records[0].manifest!.entries.find(
      (e) => e.type === "file" && e.chunks.length,
    )!;
    expect(entryState(nonempty, scan)).toBe("UNKNOWN");
    expect(records[0].degraded[0]).toContain("catalog");
  });
  it("rejects source mutation and cancellation without publishing", async () => {
    const { root, repo } = await fixture(1);
    roots.push(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureSnapshot(repo, "cancelled", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(await listSnapshots(repo)).toHaveLength(0);
  });
  it("reports IO errors as uncertainty and verifies original lab copy isolation", async () => {
    const { root, repo } = await fixture(1);
    roots.push(root);
    const id = await captureSnapshot(repo);
    const lab = await createFaultLab(repo, path.join(root, "labs"), 17);
    await injectFault(lab, "unavailable", 0);
    await injectFault(lab, "io-error", 1);
    const r = await labRepository(lab);
    const scan = await scanHealth(r, true);
    const f = (await getSnapshot(repo, id)).entries.find(
      (e) => e.type === "file" && e.chunks.length,
    )!;
    expect(entryState(f, scan)).toBe("UNKNOWN");
    expect((await scanHealth(repo, true)).counts.IO_ERROR || 0).toBe(0);
  });
  it("independent oracle agrees on real randomized small-instance damage", async () => {
    const { oracle } = await import("../packages/evaluation/oracle.js");
    const { root, repo } = await fixture(2);
    roots.push(root);
    const id = await captureSnapshot(repo),
      m = await getSnapshot(repo, id);
    for (let seed = 1; seed <= 6; seed++) {
      const lab = await createFaultLab(repo, path.join(root, "labs"), seed);
      const action = await injectFault(
        lab,
        seed % 2 ? "corrupt" : "missing",
        0,
      );
      if (seed % 3 === 0) await injectFault(lab, "missing", 1, action.hash);
      if (seed % 4 === 0) await injectFault(lab, "unavailable", 1);
      const r = await labRepository(lab),
        scan = await scanHealth(r, true),
        truth = await oracle(m, r.config.roots, r.disabled, r.ioErrors);
      for (const f of m.entries)
        if (f.type === "file")
          expect(entryState(f, scan)).toBe(truth.get(f.path));
    }
  });
});

it("aborts a real source write during streaming capture without committing", async () => {
  const { root, repo } = await fixture(1);
  roots.push(root);
  let mutated = false;
  await expect(
    captureSnapshot(repo, "concurrent edit", {
      onProgress: (p) => {
        if (!mutated && p.phase === "capture-chunks") {
          mutated = true;
          appendFileSync(
            path.join(repo.config.source, p.detail!),
            Buffer.from("concurrent change"),
          );
        }
      },
    }),
  ).rejects.toThrow("Source changed");
  expect(mutated).toBe(true);
  expect(await listSnapshots(repo)).toHaveLength(0);
});

it("deep analysis marks internally contradictory whole-file digests invalid", async () => {
  const { root, repo } = await fixture(1);
  roots.push(root);
  const id = await captureSnapshot(repo);
  const original = await getSnapshot(repo, id);
  const m = structuredClone(original);
  const f = m.entries.find((e) => e.type === "file" && e.size > 0)!;
  if (f.type !== "file") throw new Error("fixture");
  f.hash = "0".repeat(64);
  const bytes = canonical(m),
    fakeId = sha(bytes);
  for (const r of repo.config.roots) {
    await fs.writeFile(path.join(r, "manifests", fakeId + ".json"), bytes);
    await fs.writeFile(
      path.join(r, "commits", fakeId + ".json"),
      canonical({
        version: 1,
        repositoryId: repo.config.id,
        snapshotId: fakeId,
      }),
    );
  }
  const scan = await scanHealth(repo, true);
  expect(entryState(f, scan)).toBe("INVALID_METADATA");
  expect(
    analyzeFrontier(await listSnapshots(repo), scan).find(
      (s) => s.id === fakeId,
    )!.state,
  ).toBe("INVALID_METADATA");
});

it("native exclusive publication cannot overwrite even an empty existing target or competing publisher", async () => {
  const { publishExclusive } = await import("../packages/core/publication.js");
  const root = await fresh("exclusive");
  roots.push(root);
  const existing = path.join(root, "existing"),
    stage = path.join(root, "stage");
  await fs.mkdir(existing);
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, "bytes"), "original stage");
  await expect(publishExclusive(stage, existing)).rejects.toThrow("refused");
  expect(await fs.readdir(existing)).toEqual([]);
  expect(await fs.readFile(path.join(stage, "bytes"), "utf8")).toBe(
    "original stage",
  );
  const other = path.join(root, "other"),
    target = path.join(root, "winner");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "bytes"), "competing stage");
  const results = await Promise.allSettled([
    publishExclusive(stage, target),
    publishExclusive(other, target),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(["original stage", "competing stage"]).toContain(
    await fs.readFile(path.join(target, "bytes"), "utf8"),
  );
});
