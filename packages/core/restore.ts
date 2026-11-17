import { z } from "zod";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonical,
  digest,
  relativePath,
  sha,
  type Manifest,
  type Entry,
} from "./schema.js";
import { publishExclusive } from "./publication.js";
import { getSnapshot, readObject, type Repository } from "./repository.js";
import {
  atomicWrite,
  checkCancelled,
  contains,
  exists,
  failurePoint,
  noSymlinks,
  readBounded,
  syncDir,
  withLock,
  type OperationOptions,
} from "./fs.js";
export interface Receipt {
  version: 1;
  id: string;
  repositoryId: string;
  snapshotId: string;
  manifestId: string;
  destination: string;
  status: "VERIFIED";
  createdAt: string;
  startedAt: string;
  files: number;
  bytes: number;
  selectedPaths: string[] | null;
  hashes: Record<string, string>;
  sources: Record<string, string>;
  limitations: string[];
}
interface Intent {
  version: 1;
  id: string;
  snapshotId: string;
  destination: string;
  stage: string;
  selectedPaths: string[] | null;
  startedAt: string;
}
function selection(manifest: Manifest, paths?: string[]) {
  if (paths === undefined) return manifest.entries;
  z.array(relativePath)
    .min(1)
    .max(100000)
    .refine((v) => new Set(v).size === v.length, "Duplicate selected paths")
    .parse(paths);
  const wanted = new Set(paths);
  for (const p of paths)
    if (!manifest.entries.some((e) => e.path === p))
      throw new Error("Selected path not in manifest");
  return manifest.entries.filter(
    (e) =>
      wanted.has(e.path) ||
      (e.type === "directory" && paths.some((p) => p.startsWith(e.path + "/"))),
  );
}
export async function restoreSnapshot(
  repo: Repository,
  snapshotId: string,
  destination: string,
  paths?: string[],
  options: OperationOptions = {},
): Promise<Receipt> {
  return withLock(repo.home, async () => {
    const manifest = await getSnapshot(repo, snapshotId),
      entries = selection(manifest, paths);
    const requested = path.resolve(destination);
    const dest = path.join(
      await fs.realpath(await noSymlinks(path.dirname(requested))),
      path.basename(requested),
    );
    if (await exists(dest))
      throw new Error(
        "Destination already exists; choose a new child directory",
      );
    for (const protectedPath of [
      repo.home,
      repo.config.source,
      ...repo.config.roots,
    ])
      if (contains(protectedPath, dest) || contains(dest, protectedPath))
        throw new Error(
          "Restore target overlaps protected repository/source paths",
        );
    const id = randomUUID(),
      stage = path.join(path.dirname(dest), ".rewind-stage-" + id);
    const intent: Intent = {
      version: 1,
      id,
      snapshotId,
      destination: dest,
      stage,
      selectedPaths: paths || null,
      startedAt: new Date().toISOString(),
    };
    await atomicWrite(
      path.join(repo.home, "restore-intents", id + ".json"),
      canonical(intent),
    );
    await fs.mkdir(stage, { mode: 0o700 });
    const sources: Record<string, string> = Object.create(null),
      hashes: Record<string, string> = Object.create(null);
    let bytes = 0,
      files = 0;
    failurePoint("restore-before-write");
    try {
      for (const entry of entries) {
        checkCancelled(options);
        const target = path.join(stage, ...entry.path.split("/"));
        await noSymlinks(path.dirname(target));
        if (entry.type === "directory") {
          await fs.mkdir(target, { mode: 0o700 });
          continue;
        }
        const handle = await fs.open(
          target,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        const hash = createHash("sha256");
        let size = 0;
        try {
          for (const c of entry.chunks) {
            checkCancelled(options);
            let data: Buffer | undefined;
            const errors = [];
            for (let b = 0; b < 2; b++)
              try {
                data = await readObject(repo, b, c);
                sources[c.hash] = b ? "B" : "A";
                break;
              } catch (e) {
                errors.push((e as Error).message);
                failurePoint("restore-fallback");
              }
            if (!data)
              throw new Error(
                "No verified copy for " + c.hash + ": " + errors.join("; "),
              );
            hash.update(data);
            size += data.length;
            await handle.writeFile(data);
            failurePoint("restore-chunk");
          }
          const actual = hash.digest("hex");
          if (size !== entry.size || actual !== entry.hash)
            throw new Error("Whole-file verification failed: " + entry.path);
          await handle.sync();
          hashes[entry.path] = actual;
          bytes += size;
          files++;
        } finally {
          await handle.close();
        }
        await applyMetadata(target, entry);
        const metadataHandle = await fs.open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await metadataHandle.sync();
        } finally {
          await metadataHandle.close();
        }
        options.onProgress?.({
          phase: "restore",
          completed: files,
          total: entries.filter((e) => e.type === "file").length,
          detail: entry.path,
        });
      }
      for (const e of [...entries].reverse())
        if (e.type === "directory") {
          const p = path.join(stage, e.path);
          await applyMetadata(p, e);
          await syncDir(p);
        }
      await syncDir(stage);
      checkCancelled(options);
      options.onProgress?.({
        phase: "independent-verify",
        completed: 0,
        total: files,
      });
      const independent = await verifyRestored(manifest, stage, paths);
      if (!independent.valid)
        throw new Error(
          "Independent staging verification failed: " +
            independent.errors.join("; "),
        );
      checkCancelled(options);
      failurePoint("restore-before-rename");
      await noSymlinks(path.dirname(dest));
      if (await exists(dest))
        throw new Error(
          "Destination appeared during restore; refusing overwrite",
        );
      await publishExclusive(stage, dest);
      await syncDir(path.dirname(dest));
      failurePoint("restore-after-rename");
      const receipt: Receipt = {
        version: 1,
        id,
        repositoryId: repo.config.id,
        snapshotId,
        manifestId: sha(canonical(manifest)),
        destination: dest,
        status: "VERIFIED",
        createdAt: new Date().toISOString(),
        startedAt: intent.startedAt,
        files,
        bytes,
        selectedPaths: paths || null,
        hashes,
        sources,
        limitations: [
          "Point-in-time byte verification, not cryptographic attestation.",
          "Publication uses a native exclusive rename; trusted path ancestors are still required against hostile local races.",
          "No ACL, xattr or resource-fork restoration.",
        ],
      };
      failurePoint("restore-before-receipt");
      await atomicWrite(
        path.join(repo.home, "receipts", id + ".json"),
        canonical(receipt),
      );
      failurePoint("restore-after-receipt");
      await fs.unlink(path.join(repo.home, "restore-intents", id + ".json"));
      return receipt;
    } catch (e) {
      throw new Error(
        "Restore incomplete: " +
          (e as Error).message +
          ". Intent " +
          id +
          " retained; staging or published destination may need verification.",
      );
    }
  });
}
async function applyMetadata(p: string, e: Entry) {
  await fs.chmod(p, e.mode & 0o777);
  await fs.utimes(p, new Date(e.mtimeMs), new Date(e.mtimeMs));
}
/** Independent reader: does not use production chunk reads, reconstruction or classification. */
export async function verifyRestored(
  manifest: Manifest,
  destination: string,
  paths?: string[],
) {
  const errors: string[] = [],
    hashes: Record<string, string> = Object.create(null);
  let files = 0,
    bytes = 0;
  await noSymlinks(destination);
  const expected = selection(manifest, paths);
  const allowed = new Set(expected.map((e) => e.path));
  async function inspect(dir: string, rel: string) {
    for (const child of await fs.readdir(dir, { withFileTypes: true })) {
      const name = rel ? rel + "/" + child.name : child.name;
      if (!allowed.has(name)) errors.push(name + ": unexpected path");
      if (child.isSymbolicLink()) errors.push(name + ": symlink rejected");
      else if (child.isDirectory())
        await inspect(path.join(dir, child.name), name);
    }
  }
  await inspect(destination, "");
  for (const entry of expected) {
    const p = path.join(destination, ...entry.path.split("/"));
    try {
      await noSymlinks(p);
      const stat = await fs.lstat(p);
      if (entry.type === "directory") {
        if (!stat.isDirectory()) throw new Error("Directory missing");
        continue;
      }
      if (!stat.isFile()) throw new Error("Regular file missing");
      const h = createHash("sha256");
      let n = 0;
      const f = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for await (const b of f.createReadStream({
          autoClose: false,
          highWaterMark: 131072,
        })) {
          h.update(b);
          n += b.length;
        }
      } finally {
        await f.close();
      }
      failurePoint("restore-independent-verify");
      const hash = h.digest("hex");
      if (hash !== entry.hash || n !== entry.size)
        throw new Error("Hash/size mismatch");
      hashes[entry.path] = hash;
      files++;
      bytes += n;
    } catch (e) {
      errors.push(entry.path + ": " + (e as Error).message);
    }
  }
  return { valid: errors.length === 0, files, bytes, errors, hashes };
}
const outputPath = z
  .string()
  .min(1)
  .refine(
    (v) => !v.includes("\0") && path.isAbsolute(v) && path.resolve(v) === v,
    "Expected an absolute output path",
  );
const selectedPaths = z
  .array(relativePath)
  .min(1)
  .max(100000)
  .refine((v) => new Set(v).size === v.length, "Duplicate selected paths")
  .nullable();
const hashMap = z.custom<Record<string, string>>(
  (v) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([k, value]) =>
        relativePath.safeParse(k).success && digest.safeParse(value).success,
    ),
);
const receiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    repositoryId: z.string().uuid(),
    snapshotId: digest,
    manifestId: digest,
    destination: outputPath,
    status: z.literal("VERIFIED"),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    selectedPaths,
    hashes: hashMap,
    sources: z.record(digest, z.enum(["A", "B"])),
    limitations: z.array(z.string()),
  })
  .strict();
const intentSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    snapshotId: digest,
    destination: outputPath,
    stage: outputPath,
    selectedPaths,
    startedAt: z.string().datetime(),
  })
  .strict();
export async function readReceipt(
  repo: Repository,
  id: string,
): Promise<Receipt> {
  if (!z.string().uuid().safeParse(id).success)
    throw new Error("Invalid receipt id");
  const parsed = receiptSchema.safeParse(
    JSON.parse(
      (
        await readBounded(path.join(repo.home, "receipts", id + ".json"))
      ).toString(),
    ),
  );
  if (!parsed.success) throw new Error("Invalid receipt format");
  const receipt = parsed.data;
  if (
    receipt.id !== id ||
    receipt.repositoryId !== repo.config.id ||
    receipt.manifestId !== receipt.snapshotId ||
    Object.keys(receipt.hashes).length !== receipt.files
  )
    throw new Error("Invalid receipt identity or file count");
  return receipt;
}
export async function verifyReceipt(repo: Repository, id: string) {
  const receipt = await readReceipt(repo, id),
    manifest = await getSnapshot(repo, receipt.snapshotId);
  const files = selection(manifest, receipt.selectedPaths || undefined).filter(
    (e) => e.type === "file",
  );
  if (
    files.length !== receipt.files ||
    files.reduce((n, e) => n + e.size, 0) !== receipt.bytes ||
    files.some(
      (e) =>
        !Object.hasOwn(receipt.hashes, e.path) ||
        receipt.hashes[e.path] !== e.hash,
    )
  )
    throw new Error("Invalid receipt file summary");
  return verifyRestored(
    manifest,
    receipt.destination,
    receipt.selectedPaths || undefined,
  );
}
export async function reconcileRestore(repo: Repository, id: string) {
  return withLock(repo.home, async () => {
    if (!z.string().uuid().safeParse(id).success)
      throw new Error("Invalid intent id");
    const intent = intentSchema.parse(
      JSON.parse(
        (
          await readBounded(
            path.join(repo.home, "restore-intents", id + ".json"),
          )
        ).toString(),
      ),
    );
    if (
      intent.id !== id ||
      intent.stage !==
        path.join(path.dirname(intent.destination), ".rewind-stage-" + id)
    )
      throw new Error("Invalid restore intent identity");
    for (const protectedPath of [
      repo.home,
      repo.config.source,
      ...repo.config.roots,
    ])
      if (
        contains(protectedPath, intent.destination) ||
        contains(intent.destination, protectedPath)
      )
        throw new Error("Restore intent overlaps protected paths");
    const manifest = await getSnapshot(repo, intent.snapshotId);
    if (!(await exists(intent.destination)))
      return { status: "INCOMPLETE", stage: intent.stage };
    const result = await verifyRestored(
      manifest,
      intent.destination,
      intent.selectedPaths || undefined,
    );
    if (!result.valid) return { status: "INCOMPLETE", errors: result.errors };
    const receipt: Receipt = {
      version: 1,
      id,
      repositoryId: repo.config.id,
      snapshotId: intent.snapshotId,
      manifestId: sha(canonical(manifest)),
      destination: intent.destination,
      status: "VERIFIED",
      createdAt: new Date().toISOString(),
      startedAt: intent.startedAt,
      files: result.files,
      bytes: result.bytes,
      selectedPaths: intent.selectedPaths,
      hashes: result.hashes,
      sources: {},
      limitations: [
        "Receipt regenerated by independent verification after interruption. Original per-chunk backend selection unavailable.",
      ],
    };
    await atomicWrite(
      path.join(repo.home, "receipts", id + ".json"),
      canonical(receipt),
    );
    await fs.unlink(path.join(repo.home, "restore-intents", id + ".json"));
    return receipt;
  });
}
