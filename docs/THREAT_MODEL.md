# Threat model

Target failures: accidental chunk/manifest corruption, missing data, inaccessible storage roots, simulated read failures, interrupted capture/restore/catalog publication and stale scan evidence. Expected digests and committed metadata are locally trusted. SHA-256 is integrity evidence, not authenticity when an attacker can rewrite both bytes and expected identities.

Trust boundaries:

- Source: read-only during capture. Generated demo edits only operate on internally marked demo repositories; production UI never edits user sources. Symlinks and unsupported files are visibly skipped; changed regular files abort capture. Source/backend/catalog path overlap is rejected.
- Storage: two roots with matching repository markers. Each candidate read verifies hash and length; a damaged A cannot poison B. Corrupt metadata falls back to a separately verified manifest replica. Unknown versions fail closed.
- Renderer: no Node integration; sandbox and context isolation enabled. Preload exports a narrow API; every request is strict-Zod validated in main and worker. IPC sender and top-frame identity are checked. Setup and restore parent paths require native-picker grants. Output navigation reveals the known output in the file manager instead of launching a possible restored application bundle. Renderer cannot pass arbitrary roots to a fault API, spawn shells or request arbitrary filesystem reads.
- Navigation: new windows, webviews, unsolicited navigation and permissions are denied. CSP restricts scripts/fonts/assets to local resources; no remote code. Vite dev-only WebSocket connects to loopback. React escapes filenames and labels; there is no `dangerouslySetInnerHTML`.
- Laboratory: internally issued WeakMap capability, fixed root layout, marker nonce, repeated containment/symlink checks, physical copies with independent inodes. The mutation API accepts a handle, backend index, scenario kind and validated referenced digest; it accepts no target filesystem path. Persisted scenarios are local trusted state, not untrusted downloadable executable instructions. Replay checks repository ID and snapshot inventory.
- Restore: new staging/output, no ordinary overwrite, portable validated paths, no symlink-following leaf opens, full-file verification. Parent directories must be privately controlled; see native exclusive-publication and path-ancestor race boundaries in DURABILITY_AND_LIMITS.
- Catalog/evidence: optional derived acceleration, not sole backup truth. Scan timestamps and scope are visible. Receipts can be independently checked, but are not signatures.

Out of scope: malware, an administrator or malicious process able to race/rewrite local directories, ransomware targeting both roots, malicious trust-anchor substitution, compromised dependencies/OS, hostile multi-user destination parents, cloud/remote transport, encryption and adversarial authenticity. Do not describe this application as tamper-proof or guaranteed recovery.

Tests cover traversal/case aliases, forbidden IPC fields and ungranted paths, symlink restore parents and lab object escapes, forged lab handles, alternate-copy corruption, unknown metadata versions and actual worker termination. These are bounded exercised cases, not proof of general filesystem-race immunity. Dependency audit is an observed command result and can change with advisories.

Design reference: [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security) informed isolation, sandbox, permission, CSP, navigation and IPC validation choices. The running packaged application is still local trusted software and should only be used with understood limitations.
