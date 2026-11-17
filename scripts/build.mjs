import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, copyFile, rm } from "node:fs/promises";
await mkdir("dist", { recursive: true });
for (const [name, platform] of [
  ["main", "node"],
  ["preload", "node"],
  ["worker", "node"],
])
  await build({
    entryPoints: [`apps/desktop/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform,
    format: "cjs",
    target: "node22",
    external: ["electron", "node:sqlite"],
    define: { "import.meta.url": "__rewindImportMetaUrl" },
    banner:
      name === "preload"
        ? undefined
        : {
            js: "const __rewindImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
          },
  });
await viteBuild();
try {
  await copyFile("results/summary.json", "dist/evaluation.json");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await rm("dist/evaluation.json", { force: true });
}
