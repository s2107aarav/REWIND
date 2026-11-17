import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";
for (const name of ["main", "preload", "worker"])
  await build({
    entryPoints: [`apps/desktop/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform: "node",
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
const vite = await createServer();
await vite.listen();
const env = { ...process.env, REWIND_DEV_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env,
});
electron.on("error", async (error) => {
  console.error(error.message);
  await vite.close();
  process.exitCode = 1;
});
electron.on("exit", async (code, signal) => {
  await vite.close();
  process.exit(code ?? (signal ? 1 : 0));
});
process.on("SIGINT", () => electron.kill("SIGTERM"));
