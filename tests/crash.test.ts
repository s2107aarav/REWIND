import { afterEach, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  captureSnapshot,
  listSnapshots,
  scanHealth,
  analyzeFrontier,
  reconcileRestore,
  verifyReceipt,
  objectPath,
  getSnapshot,
} from "../packages/core/index.js";
import { fixture } from "./helpers.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await fs.rm(r, { recursive: true, force: true });
});
function killAt(point: string, args: string[]) {
  return new Promise<{
    signal: NodeJS.Signals | null;
    code: number | null;
    error: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/crash-worker.ts", ...args],
      {
        env: { ...process.env, REWIND_TEST_CRASH: point },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (b) => (error += b));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, error }));
  });
}
describe("actual SIGKILL publication tests", () => {
  it.each([
    "capture-chunk",
    "capture-before-manifest",
    "capture-manifest",
    "capture-before-commit",
    "capture-commit-a",
    "capture-commit-b",
    "capture-before-catalog",
    "capture-after-catalog",
    "catalog-during-update",
  ])(
    "restart at %s only exposes complete committed snapshots",
    async (point) => {
      const { root, repo } = await fixture(1);
      roots.push(root);
      const result = await killAt(point, ["capture", repo.home]);
      expect(result.signal, result.error).toBe("SIGKILL");
      const records = await listSnapshots(repo);
      if (
        [
          "capture-chunk",
          "capture-before-manifest",
          "capture-manifest",
          "capture-before-commit",
        ].includes(point)
      )
        expect(records).toHaveLength(0);
      else {
        expect(records).toHaveLength(1);
        const scan = await scanHealth(repo, true);
        expect(analyzeFrontier(records, scan)[0].state).toBe(
          "VERIFIED_RECOVERABLE",
        );
        if (point === "capture-commit-a")
          expect(records[0].degraded.length).toBe(1);
      }
      await captureSnapshot(repo, "retry");
      expect((await listSnapshots(repo)).length).toBeGreaterThan(0);
    },
    20000,
  );
  it.each([
    "restore-before-write",
    "restore-chunk",
    "restore-independent-verify",
    "restore-before-rename",
    "restore-after-rename",
    "restore-before-receipt",
    "restore-after-receipt",
  ])(
    "restart at %s has no false successful receipt",
    async (point) => {
      const { root, repo } = await fixture(1);
      roots.push(root);
      const id = await captureSnapshot(repo),
        dest = path.join(root, "output");
      const result = await killAt(point, ["restore", repo.home, id, dest]);
      expect(result.signal, result.error).toBe("SIGKILL");
      const receipts = await fs.readdir(path.join(repo.home, "receipts"));
      const published = [
        "restore-after-rename",
        "restore-before-receipt",
        "restore-after-receipt",
      ].includes(point);
      expect(receipts.length).toBe(point === "restore-after-receipt" ? 1 : 0);
      const intents = await fs.readdir(path.join(repo.home, "restore-intents"));
      expect(intents).toHaveLength(1);
      const intentId = intents[0].slice(0, -5);
      const reconciled = await reconcileRestore(repo, intentId);
      expect(reconciled.status).toBe(published ? "VERIFIED" : "INCOMPLETE");
      if (published) {
        expect((await verifyReceipt(repo, intentId)).valid).toBe(true);
        await expect(
          import("../packages/core/restore.js").then((m) =>
            m.restoreSnapshot(repo, id, dest),
          ),
        ).rejects.toThrow("already exists");
      } else
        await import("../packages/core/restore.js").then((m) =>
          m.restoreSnapshot(repo, id, path.join(root, "fresh-output")),
        );
    },
    20000,
  );
  it("termination during replica fallback cannot publish a success", async () => {
    const { root, repo } = await fixture(1);
    roots.push(root);
    const id = await captureSnapshot(repo),
      file = (await getSnapshot(repo, id)).entries.find(
        (e) => e.type === "file" && e.chunks.length,
      );
    if (file?.type !== "file") throw new Error("fixture");
    await fs.writeFile(
      objectPath(repo.config.roots[0], file.chunks[0].hash),
      "damaged",
    );
    const result = await killAt("restore-fallback", [
      "restore",
      repo.home,
      id,
      path.join(root, "out"),
    ]);
    expect(result.signal, result.error).toBe("SIGKILL");
    expect(await fs.readdir(path.join(repo.home, "receipts"))).toHaveLength(0);
  }, 20000);
});
