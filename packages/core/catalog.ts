import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import * as fs from "node:fs/promises";
import { listSnapshots, type Repository } from "./repository.js";
import {
  atomicWrite,
  exists,
  failurePoint,
  noSymlinks,
  withLock,
} from "./fs.js";
import { canonical } from "./schema.js";
export async function rebuildCatalog(
  repo: Repository,
  lockHeld = false,
): Promise<void> {
  if (!lockHeld) return withLock(repo.home, () => rebuildCatalog(repo, true));
  const p = path.join(repo.home, "catalog.sqlite");
  await noSymlinks(repo.home);
  if (await exists(p)) await noSymlinks(p);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(p);
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Catalog integrity failure");
    for (const [table, columns] of [
      ["snapshots", "id,manifest"],
      ["versions", "snapshot,path,kind,bytes,hash"],
      ["refs", "chunk,snapshot,path,ordinal,bytes"],
      ["scans", "id,at,deep,payload"],
    ])
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table)
      )
        db.prepare("SELECT " + columns + " FROM " + table + " LIMIT 0").all();
  } catch {
    db?.close();
    if (await exists(p)) {
      const damaged = p + ".damaged-" + Date.now();
      await fs.rename(p, damaged);
      for (const suffix of ["-wal", "-shm"])
        if (await exists(p + suffix))
          await fs.rename(p + suffix, damaged + suffix);
    }
    db = new DatabaseSync(p);
  }
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(snapshot TEXT,path TEXT,kind TEXT,bytes INTEGER,hash TEXT,PRIMARY KEY(snapshot,path)); CREATE TABLE IF NOT EXISTS refs(chunk TEXT,snapshot TEXT,path TEXT,ordinal INTEGER,bytes INTEGER,PRIMARY KEY(snapshot,path,ordinal)); CREATE INDEX IF NOT EXISTS reverse_chunks ON refs(chunk); CREATE TABLE IF NOT EXISTS scans(id TEXT PRIMARY KEY,at TEXT,deep INTEGER,payload TEXT);",
    );
    const records = await listSnapshots(repo);
    db.exec(
      "BEGIN IMMEDIATE; DELETE FROM refs; DELETE FROM versions; DELETE FROM snapshots;",
    );
    failurePoint("catalog-during-update");
    try {
      const snap = db.prepare("INSERT INTO snapshots VALUES(?,?)"),
        entry = db.prepare("INSERT INTO versions VALUES(?,?,?,?,?)"),
        ref = db.prepare("INSERT INTO refs VALUES(?,?,?,?,?)");
      for (const row of records)
        if (row.manifest) {
          snap.run(row.id, canonical(row.manifest));
          for (const e of row.manifest.entries) {
            entry.run(
              row.id,
              e.path,
              e.type,
              e.type === "file" ? e.size : 0,
              e.type === "file" ? e.hash : null,
            );
            if (e.type === "file")
              e.chunks.forEach((c, i) =>
                ref.run(c.hash, row.id, e.path, i, c.size),
              );
          }
        }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}
async function openCatalog(repo: Repository) {
  const p = path.join(repo.home, "catalog.sqlite");
  await noSymlinks(p, true);
  let db: DatabaseSync | undefined;
  try {
    if (!(await exists(p))) await rebuildCatalog(repo);
    db = new DatabaseSync(p);
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Catalog integrity failure");
    db.prepare("SELECT id,manifest FROM snapshots LIMIT 0").all();
    db.prepare(
      "SELECT chunk,snapshot,path,ordinal,bytes FROM refs LIMIT 0",
    ).all();
    db.prepare("SELECT id,at,deep,payload FROM scans LIMIT 0").all();
    return db;
  } catch {
    db?.close();
    await rebuildCatalog(repo);
    return new DatabaseSync(p);
  }
}
export async function recordScan(
  repo: Repository,
  scan: { id: string; at: string; deep: boolean },
) {
  const db = await openCatalog(repo);
  try {
    db.prepare("INSERT OR REPLACE INTO scans VALUES(?,?,?,?)").run(
      scan.id,
      scan.at,
      Number(scan.deep),
      canonical(scan),
    );
  } finally {
    db.close();
  }
  await atomicWrite(path.join(repo.home, "latest-scan.json"), canonical(scan));
}
export async function references(repo: Repository, hash: string) {
  const db = await openCatalog(repo);
  try {
    return db
      .prepare(
        "SELECT snapshot,path,ordinal,bytes FROM refs WHERE chunk=? ORDER BY snapshot,path",
      )
      .all(hash);
  } finally {
    db.close();
  }
}
