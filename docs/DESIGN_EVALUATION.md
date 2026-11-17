# Interface constraints and visual checks

The desktop interface uses graphite surfaces, chartreuse actions, amber uncertainty and explicit status text. Color alone never conveys recoverability. Overview distinguishes logical history, unique chunks, duplicated physical data and metadata; the laboratory always identifies its scope.

Recovery tables page 50 baseline paths and show at most six recent history columns. Suggested recovery pages 25 eligible versions and exposes their originating snapshots separately from the newest complete snapshot. It never offers automatic mixed-version restoration. Main owns native folder grants; UI refactoring must preserve that boundary.

The supported desktop window is at least 800px wide. Keep horizontal scrolling within tables, readable operational labels (matrix cells are 11px), visible focus styles and a prominent mixed-snapshot warning. Mobile widths are outside the desktop product scope.

Historical screenshots in `results/overview.png` and `results/laboratory.png` were captured from the running app on 9 November 2026. `npm run test:ui` regenerates `results/ui-frontier.png` at 1440×900 and `results/compact.png` at 800×900, checking for document overflow. The dated `results/ui-smoke.json` identifies the latest executed checks. This is UI evidence, not an accessibility certification or security attestation.
