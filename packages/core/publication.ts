import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { exists, noSymlinks } from "./fs.js";
const execute = promisify(execFile);
async function publicationHelper() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error(
      "Atomic exclusive restore publication is unsupported on this platform",
    );
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    ...(resources ? [path.join(resources, "rewind-publish")] : []),
    fileURLToPath(new URL("../../native/bin/rewind-publish", import.meta.url)),
    fileURLToPath(new URL("../native/bin/rewind-publish", import.meta.url)),
  ];
  let helper: string | undefined;
  for (const candidate of candidates)
    if (await exists(candidate)) {
      helper = candidate;
      break;
    }
  if (!helper)
    throw new Error(
      "Exclusive publication helper missing. Run npm install or npm run build; no unsafe rename fallback is used.",
    );
  await noSymlinks(helper);
  return helper;
}
export async function acquireFileLock(fd: number) {
  const helper = await publicationHelper();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, ["--lock"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    let error = "";
    child.stderr!.on("data", (b) => (error += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              code === 4
                ? "Repository busy in another operation"
                : "Repository locking failed: " + error.trim(),
            ),
          ),
    );
  });
}
export async function publishExclusive(stage: string, destination: string) {
  const helper = await publicationHelper();
  await noSymlinks(path.dirname(destination));
  try {
    await execute(helper, [stage, destination], { timeout: 30000 });
  } catch (e) {
    throw new Error(
      "Atomic exclusive publication refused: " +
        ((e as { stderr?: string }).stderr || (e as Error).message).trim(),
    );
  }
}
