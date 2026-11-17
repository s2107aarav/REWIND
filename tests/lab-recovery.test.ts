import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createRepository,
  captureSnapshot,
  getSnapshot,
  createFaultLab,
  openFaultLab,
  injectFault,
  scenarioRecord,
  replayScenario,
  labRepository,
  scanHealth,
  analyzeFrontier,
  entryState,
  listSnapshots,
  objectPath,
  sha,
  restoreSnapshot,
  verifyReceipt,
  explain,
} from "../packages/core/index.js";
import { requestSchema } from "../packages/core/requests.js";
import { DesktopService } from "../apps/desktop/service.js";
import type {
  AppState,
  RecoveryRecommendation,
  Explanation,
} from "../apps/desktop/api.js";
import { fresh } from "./helpers.js";
const roots: string[] = [];
it("preserves the real demo-to-lab-to-verified-restore desktop workflow", async () => {
  const root = await fresh("desktop-workflow");
  roots.push(root);
  const service = new DesktopService(path.join(root, "desktop"));
  await service.init();
  await service.request({ action: "demo" });
  await service.request({ action: "demo-edit" });
  await service.request({ action: "capture", label: "Workflow capture" });
  const state = (await service.request({
    action: "create-lab",
    seed: 42,
  })) as AppState;
  expect(state.snapshots).toHaveLength(4);
  const file = state.files.find((f) => f.type === "file" && f.chunks)!;
  const before = (await service.request({
    action: "explain",
    scope: "lab",
    snapshotId: state.snapshots[0].id,
    path: file.path,
  })) as Explanation;
  await service.request({
    action: "fault",
    kind: "corrupt",
    backend: 0,
    hash: before.chunks[0].hash,
  });
  const plan = (await service.request({
    action: "plan-recovery",
    scope: "lab",
  })) as RecoveryRecommendation;
  expect(plan.newestComplete).toBe(state.snapshots[0].id);
  const evidence = (await service.request({
    action: "explain",
    scope: "lab",
    snapshotId: state.snapshots[0].id,
    path: file.path,
  })) as Explanation;
  expect(evidence.chunks[0].copies[0].state).toBe("CORRUPT");
  expect(evidence.chunks[0].affectedVersions).toBeGreaterThan(0);
  const receipt = (await service.request({
    action: "restore",
    scope: "lab",
    snapshotId: plan.newestComplete!,
    parent: root,
    name: "recovered",
  })) as { id: string };
  expect(
    (
      (await service.request({ action: "verify", id: receipt.id })) as {
        valid: boolean;
      }
    ).valid,
  ).toBe(true);
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function history() {
  const root = await fresh("fault-regression");
  roots.push(root);
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const repo = await createRepository(path.join(root, "repo"), source, [
    path.join(root, "a"),
    path.join(root, "b"),
  ]);
  const ids: string[] = [];
  for (let n = 1; n <= 3; n++) {
    for (const file of n === 1 ? ["a", "b"] : ["a", "b", "c"])
      await fs.writeFile(path.join(source, file), `${file} version ${n}`);
    ids.push(await captureSnapshot(repo, `S${n}`));
  }
  return { root, repo, ids };
}
function states(scan: Awaited<ReturnType<typeof scanHealth>>) {
  return Object.fromEntries(
    Object.entries(scan.copies).map(([h, c]) => [h, c.map((x) => x.state)]),
  );
}
it("progresses corruption across reopen, rejects repeat damage and replays physical evidence", async () => {
  const { root, repo } = await history(),
    managed = path.join(root, "labs");
  const originalHashes = await Promise.all(
    repo.config.roots.map(async (r) => {
      const out: Record<string, string> = {};
      for (const p of await fs.readdir(r, { recursive: true })) {
        const f = path.join(r, p);
        if ((await fs.stat(f)).isFile()) out[p] = sha(await fs.readFile(f));
      }
      return out;
    }),
  );
  const lab = await createFaultLab(repo, managed, 42),
    equivalent = await createFaultLab(repo, managed, 42);
  const first = await injectFault(lab, "corrupt", 0);
  await injectFault(equivalent, "corrupt", 0);
  const r = await labRepository(lab),
    before = await fs.readFile(objectPath(r.config.roots[0], first.hash!));
  expect(sha(before)).not.toBe(first.hash);
  await expect(injectFault(lab, "corrupt", 0, first.hash)).rejects.toThrow(
    "intact eligible",
  );
  expect(await fs.readFile(objectPath(r.config.roots[0], first.hash!))).toEqual(
    before,
  );
  expect((await scenarioRecord(lab)).actions).toHaveLength(1);
  const reopened = await openFaultLab(managed, lab.id),
    second = await injectFault(reopened, "corrupt", 0);
  await injectFault(equivalent, "corrupt", 0);
  expect(second.hash).not.toBe(first.hash);
  const scan = await scanHealth(r, true);
  expect(scan.copies[first.hash!][0].state).toBe("CORRUPT");
  expect(scan.copies[second.hash!][0].state).toBe("CORRUPT");
  await injectFault(reopened, "missing", 1, first.hash);
  await injectFault(equivalent, "missing", 1, first.hash);
  const record = await scenarioRecord(reopened);
  expect((await scenarioRecord(equivalent)).actions).toEqual(record.actions);
  const replay = await replayScenario(
    repo,
    managed,
    JSON.parse(JSON.stringify(record)),
  );
  const final = await scanHealth(await labRepository(reopened), true);
  for (const copy of [equivalent, replay]) {
    const rr = await labRepository(copy),
      ss = await scanHealth(rr, true);
    expect(states(ss)).toEqual(states(final));
    for (const record of await listSnapshots(rr)) {
      expect(
        record.manifest?.entries.map((e) => [e.path, entryState(e, ss)]),
      ).toEqual(
        record.manifest?.entries.map((e) => [e.path, entryState(e, final)]),
      );
    }
    expect(analyzeFrontier(await listSnapshots(rr), ss)).toEqual(
      analyzeFrontier(await listSnapshots(r), final),
    );
  }
  expect((await scanHealth(repo, true)).counts.CORRUPT ?? 0).toBe(0);
  for (const file of ["a", "b", "c"])
    expect(await fs.readFile(path.join(repo.config.source, file), "utf8")).toBe(
      `${file} version 3`,
    );
  for (let b = 0; b < 2; b++)
    for (const [p, h] of Object.entries(originalHashes[b]))
      expect(sha(await fs.readFile(path.join(repo.config.roots[b], p)))).toBe(
        h,
      );
  const impacted = await explain(
    await labRepository(reopened),
    record.snapshotIds![0],
    "a",
    final,
  );
  expect(impacted.state).toBeDefined();
});
it("fails safely on exhausted, unavailable, simulated-error, missing and invalid targets; manifest damage stays damaged", async () => {
  const { root, repo, ids } = await history(),
    lab = await createFaultLab(repo, path.join(root, "labs"), 9),
    r = await labRepository(lab);
  const hashes = Object.keys((await scanHealth(r, true)).copies);
  for (const h of hashes) await injectFault(lab, "corrupt", 0, h);
  await expect(injectFault(lab, "corrupt", 0)).rejects.toThrow(
    "No intact eligible",
  );
  await expect(injectFault(lab, "missing", 0, hashes[0])).rejects.toThrow(
    "intact eligible",
  );
  await expect(injectFault(lab, "corrupt", 0, "../escape")).rejects.toThrow();
  expect((await scenarioRecord(lab)).actions).toHaveLength(hashes.length);
  await injectFault(lab, "missing", 1, hashes[0]);
  await expect(injectFault(lab, "corrupt", 1, hashes[0])).rejects.toThrow(
    "intact eligible",
  );
  await injectFault(lab, "manifest", 1, ids[0]);
  const bytes = await fs.readFile(
    path.join(r.config.roots[1], "manifests", ids[0] + ".json"),
  );
  await injectFault(lab, "manifest", 1, ids[0]);
  expect(
    await fs.readFile(
      path.join(r.config.roots[1], "manifests", ids[0] + ".json"),
    ),
  ).toEqual(bytes);
  expect(sha(bytes)).not.toBe(ids[0]);
  for (let repeat = 0; repeat < 2; repeat++) {
    await injectFault(lab, "manifest", 0, ids[0]);
    const evidence = await scanHealth(r, true);
    expect(
      analyzeFrontier(await listSnapshots(r), evidence).find(
        (s) => s.id === ids[0],
      )?.state,
    ).toBe("INVALID_METADATA");
  }
  await injectFault(lab, "unavailable", 0);
  await injectFault(lab, "io-error", 1);
  const length = (await scenarioRecord(lab)).actions.length;
  await expect(injectFault(lab, "corrupt", 0)).rejects.toThrow("unavailable");
  await expect(injectFault(lab, "missing", 1)).rejects.toThrow("I/O");
  expect((await scenarioRecord(lab)).actions).toHaveLength(length);
});
it("validates strict recovery requests", () => {
  for (const scope of ["lab", "original"])
    expect(requestSchema.parse({ action: "plan-recovery", scope })).toEqual({
      action: "plan-recovery",
      scope,
    });
  for (const request of [
    { action: "plan-recovery" },
    { action: "plan-recovery", scope: "other" },
    { action: "plan-recovery", scope: "lab", extra: true },
  ])
    expect(() => requestSchema.parse(request)).toThrow();
});
it("desktop recovery plans rescan real bytes, distinguish complete history from mixed salvage and isolate scopes", async () => {
  const { root, repo, ids } = await history(),
    managed = path.join(root, "desktop");
  await fs.mkdir(managed);
  await fs.writeFile(
    path.join(managed, "active.json"),
    JSON.stringify({ repository: repo.home }),
  );
  const service = new DesktopService(managed);
  await service.init();
  const healthy = (await service.request({
    action: "plan-recovery",
    scope: "original",
  })) as RecoveryRecommendation;
  expect(healthy.newestComplete).toBe(ids[2]);
  expect(healthy.scan.deep).toBe(true);
  const created = (await service.request({
    action: "create-lab",
    seed: 42,
  })) as AppState;
  for (const [id, file] of [
    [ids[1], "a"],
    [ids[2], "a"],
    [ids[2], "c"],
  ]) {
    const e = (await getSnapshot(repo, id)).entries.find(
      (e) => e.path === file,
    );
    if (e?.type !== "file") throw new Error("fixture");
    for (const backend of [0, 1])
      await service.request({
        action: "fault",
        kind: "missing",
        backend,
        hash: e.chunks[0].hash,
      });
  }
  const lab = await openFaultLab(path.join(managed, "labs"), created.lab!.id),
    rr = await labRepository(lab);
  const physicalBefore = await Promise.all(
    rr.config.roots.map(async (r) => {
      const out: Record<string, string> = {};
      for (const p of await fs.readdir(r, { recursive: true }))
        if ((await fs.stat(path.join(r, p))).isFile())
          out[p] = sha(await fs.readFile(path.join(r, p)));
      return out;
    }),
  );
  const plan = (await service.request({
    action: "plan-recovery",
    scope: "lab",
  })) as RecoveryRecommendation;
  expect(plan.scan.id).not.toBe(healthy.scan.id);
  expect(plan.newestComplete).toBe(ids[0]);
  expect(plan.eligibleVersions.find((v) => v.path === "a")?.snapshotId).toBe(
    ids[0],
  );
  expect(plan.eligibleVersions.find((v) => v.path === "b")?.snapshotId).toBe(
    ids[2],
  );
  expect(plan.eligibleVersions.find((v) => v.path === "c")?.snapshotId).toBe(
    ids[1],
  );
  expect(plan.warning).toContain("not a historical snapshot");
  for (let b = 0; b < 2; b++)
    for (const [p, h] of Object.entries(physicalBefore[b]))
      expect(sha(await fs.readFile(path.join(rr.config.roots[b], p)))).toBe(h);
  const original = (await service.request({
    action: "plan-recovery",
    scope: "original",
  })) as RecoveryRecommendation;
  expect(original.newestComplete).toBe(ids[2]);
  // Physical damage after cached evidence must be seen by the next request.
  const b = (await getSnapshot(repo, ids[2])).entries.find(
    (e) => e.path === "b",
  );
  if (b?.type !== "file") throw new Error("fixture");
  for (const r of rr.config.roots)
    await fs.writeFile(objectPath(r, b.chunks[0].hash), "new physical damage");
  const freshPlan = (await service.request({
    action: "plan-recovery",
    scope: "lab",
  })) as RecoveryRecommendation;
  expect(freshPlan.scan.id).not.toBe(plan.scan.id);
  expect(
    freshPlan.eligibleVersions.find((v) => v.path === "b")?.snapshotId,
  ).toBe(ids[1]);
  const receipt = await restoreSnapshot(
    rr,
    ids[0],
    path.join(root, "restored"),
  );
  expect((await verifyReceipt(rr, receipt.id)).valid).toBe(true);
  for (const [hash, copies] of Object.entries(
    (await scanHealth(rr, true)).copies,
  ))
    for (const backend of [0, 1])
      if (copies[backend].state === "VERIFIED_OK")
        await service.request({
          action: "fault",
          kind: "missing",
          backend,
          hash,
        });
  const empty = (await service.request({
    action: "plan-recovery",
    scope: "lab",
  })) as RecoveryRecommendation;
  expect(empty.newestComplete).toBeUndefined();
  expect(empty.eligibleVersions).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    service.request(
      { action: "plan-recovery", scope: "original" },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
});
