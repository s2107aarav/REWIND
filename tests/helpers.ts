import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createRepository,
  makeFixture,
  type Repository,
} from "../packages/core/index.js";
export async function fresh(name = "test") {
  return fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "rewind-" + name + "-"),
  );
}
export async function fixture(
  count = 8,
): Promise<{ root: string; repo: Repository }> {
  const root = await fresh();
  const source = path.join(root, "source");
  await makeFixture(source, count);
  const repo = await createRepository(
    path.join(root, "repository"),
    source,
    [path.join(root, "a"), path.join(root, "b")],
    true,
  );
  return { root, repo };
}
