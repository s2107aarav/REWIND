import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  createDemo,
  listSnapshots,
  restoreSnapshot,
  verifyReceipt,
} from "../packages/core/index.ts";
const resources =
  process.platform === "darwin"
    ? path.resolve(`release/mac-${process.arch}/REWIND.app/Contents/Resources`)
    : path.resolve("release/linux-unpacked/resources");
Object.defineProperty(process, "resourcesPath", { value: resources });
const binary = await fs.readFile(path.join(resources, "rewind-publish"));
if (!binary.equals(await fs.readFile("native/bin/rewind-publish")))
  throw new Error("Packaged helper differs from exercised build");
const root = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "rewind-package-"),
);
try {
  const repo = await createDemo(path.join(root, "demo"));
  const latest = (await listSnapshots(repo)).at(-1);
  const receipt = await restoreSnapshot(
    repo,
    latest.id,
    path.join(root, "restored"),
  );
  const check = await verifyReceipt(repo, receipt.id);
  if (!check.valid)
    throw new Error(
      "Packaged publication helper restore failed independent verification",
    );
  const report = {
    date: new Date().toISOString(),
    command: "npm run package && npm run test:package",
    success: true,
    packagedBinarySha256: createHash("sha256").update(binary).digest("hex"),
    files: check.files,
    bytes: check.bytes,
    nativeExclusivePublication: true,
    receiptVerified: true,
    conditions:
      "Production core under Node with resourcesPath pointed at actual packaged helper. Fresh generated three-snapshot fixture; no mock reads or mutation responses. Electron app launch and native picker are separate UI checks.",
  };
  await fs.mkdir("results", { recursive: true });
  await fs.writeFile(
    "results/package-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
