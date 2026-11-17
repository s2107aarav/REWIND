# REWIND measured evaluation

Run: 2026-11-12T01:53:03.317Z
Command: npm run evaluate
Seed: 2409
Host: Apple M1, darwin/arm64, v22.23.2

288/288 independent oracle agreements; 0 false positives in 32 physically mutated scenarios.

10023 files in latest benchmark snapshot. Logical history 35014208 bytes; unique referenced chunk bytes 8522139; actual duplicated object bytes 17044278; backend metadata 10941856 bytes.

| Operation | Measured ms |
|---|---:|
| oracleScenariosMs | 8914.29 |
| captureS1Ms | 17111.00 |
| captureS2Ms | 7499.99 |
| deepScanMs | 1667.65 |
| fullFrontierMs | 60.68 |
| page10000Ms | 30.89 |
| incrementalImpactMs | 527.19 |
| restoreMs | 130144.92 |
| independentVerifyMs | 3857.66 |

Independent restore verifier: true, 10023 files, 17507102 bytes. Shared object references: 4. Repair adversary exact utility 3, popularity utility 0.

Conditions: Local temporary directory; warm OS cache; two directories on same volume; no independent disk fault domains.

- One macOS host, warm caches; measurements are not universal speed claims.
- Oracle cases are small generated instances and finite randomized seeds.
- Incremental timing is reverse-index reclassification after a completed scan, not incremental physical scanning.
- Storage metadata bytes include backend manifests/commits; SQLite and filesystem allocation overhead are excluded.
- maxRSS is process peak including fixture generation; not isolated operation peak.

Failures: None in exercised cases.
