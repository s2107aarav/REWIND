# Five-minute real-data walkthrough

Install Node 22.13+ (tested 22.23.2), npm and a C compiler (macOS Command Line Tools or Linux cc) for the tiny exclusive-publication helper. From this project root run `npm ci`, then `npm run dev`. For a built app: `npm run build && npm start`. Internet is only needed to install dependencies/Electron; runtime operations are local.

1. Click **Create demo workspace**. It generates deterministic fixture bytes (seed 7241 for shared media), takes three real captures with edits/additions/deletion, and runs a deep scan. Generated roots are under `.rewind/desktop/demos/UUID/`. The source is disposable; no personal folder is inspected. Overview displays actual history/unique/physical/metadata sizes and a defined dedup denominator.
2. Open **Snapshot timeline**. Select the latest capture and **Compare with previous**. Inspect added/removed/changed paths. **Edit demo source**, then **Capture snapshot**, creates a further real version; no manual source editing is needed. File hashes and chunk dependencies are inspectable.
3. Open **Disaster laboratory**, set seed **2409**, and **Create lab copy**. Read the Simulation-only banner. Bit-flip a chunk on A with the seeded selection. Real scans should show a corrupt copy while verified B still makes dependent versions recoverable. Export scenario JSON to see the exact chosen digest.
4. In **Recovery frontier**, inspect a path and each chunk's A/B evidence. The matrix shows baseline paths across six recent snapshots, with older snapshots available in the selector. To demonstrate loss, copy the recorded digest into the lab fault input, choose B and remove that same digest. Versions requiring it should become known-unrecoverable. To demonstrate uncertainty instead, recreate the lab, corrupt A, then make B unavailable; affected bytes may now be unknown. Empty or unrelated files remain correctly classified. Recreate resets; Reset & replay rebuilds and applies the recorded exact actions against unchanged original history.
5. In **Recovery frontier**, click **Analyze recovery options**. A new deep scan identifies the latest complete verified snapshot, if any, and a searchable list (25 rows per page) of newest individually verified file versions. Use **Inspect snapshot** to select that history. Versions may come from different moments: the salvage list is not a coherent historical snapshot. Recommendations are cleared on scope changes or operations and hidden when scan evidence changes. No mixed-version restore is executed automatically.
6. Restore from the original scope, or from an intact lab snapshot. Choose **Verified restore**, a fully verified snapshot and a native-picked parent. Enter a fresh child name (for example `rewind-demo-recovery-01`). Click **Restore & verify**, then **Verify output**. A receipt records file hashes and source-copy summary. Selective mode allows explicitly selected verified paths from one snapshot; it is not a complete application-consistent snapshot.

Scans are point-in-time evidence. Two folders on the same disk are not physical disk redundancy. Live capture is not globally atomic. Faults never target the original stores. File metadata diffs are provided, not line-level text diffs.

Automatic chunk selection advances with the seed and persisted action count over sorted intact copies on the requested backend. Both missing and corrupt operations require a currently intact copy; absent, corrupt or unreadable explicit targets are rejected without a successful action. Disabled/erroring backends reject physical faults. Repeated manifest damage writes the same invalid marker; unavailable and I/O-error simulation are idempotent. Export/replay uses resolved digests, not a new random choice. Older v1 scenarios that repeat a now-ineligible physical fault fail explicitly rather than reproducing a reversible mutation.

## CLI reproduction

```
npm run demo
npm run cli -- frontier .rewind/cli-demo/repository
npm run cli -- accounting .rewind/cli-demo/repository
npm run cli -- rebuild-catalog .rewind/cli-demo/repository
npm run cli -- list .rewind/cli-demo/repository
```

`npm run demo` requires its default directory to be absent/empty. For repeated runs choose a fresh path: `npm run cli -- demo .rewind/another-demo`. Use an actual returned snapshot ID:

```
npm run cli -- explain .rewind/cli-demo/repository SNAPSHOT_ID Documents/project-notes.md
npm run cli -- restore .rewind/cli-demo/repository SNAPSHOT_ID .rewind/recovered-01
npm run cli -- verify .rewind/cli-demo/repository RECEIPT_UUID
npm run cli -- verify-files .rewind/cli-demo/repository SNAPSHOT_ID .rewind/recovered-01
npm run cli -- lab .rewind/cli-demo/repository .rewind/cli-labs 2409
npm run cli -- fault .rewind/cli-labs LAB_UUID corrupt 0
npm run cli -- plan-recovery .rewind/cli-demo/repository
```

`reconcile CATALOG_DIR INTENT_UUID` regenerates evidence only after independently checking a published interrupted destination. Incomplete staging is reported as incomplete. Do not delete stages/intents before inspecting them.

## Verification and evidence

`npm test`, `npm run test:integration`, `npm run evaluate`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run package`. `npm run test:ui` requires Electron graphical display and installed `agent-browser` CLI; it exercises real demo/lab/matrix and ungranted-path denial. Native picker/restore was separately exercised on macOS with a real grant and independently checked output. It is not mocked by the UI script. On headless Linux, wrap Electron tests with an available `xvfb-run`.

Evaluation generates known bytes, runs 32 physical lab scenarios with independent oracle comparison, benchmarks two captures on >10,000 files, deep scans, reverse impact, paginated analysis and full restore. It writes actual `results/summary.json` and `results/report.md`, then removes only its own temporary generated directory. Fixture/read/cache/fsync conditions and limitations accompany the numbers. Performance varies significantly with metadata latency and disk sync behavior; compare only like conditions.

`npm run package && npm run test:package` additionally verifies the actual packaged native helper matches the source-built binary, generates a fresh three-snapshot fixture, restores through the production core using the packaged resource path, and independently verifies the receipt. This is a core/helper packaging probe, not a mocked Electron IPC or native-picker test. See `results/package-smoke.json`.
