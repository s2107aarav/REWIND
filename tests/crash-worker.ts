import {
  captureSnapshot,
  openRepository,
  restoreSnapshot,
} from "../packages/core/index.js";
const [operation, home, id, dest] = process.argv.slice(2);
const repo = await openRepository(home);
if (operation === "capture") await captureSnapshot(repo, "crash-test");
else await restoreSnapshot(repo, id, dest);
