import { describe, it, expect } from "vitest";
import { chunkStream, MAX_CHUNK, MIN_CHUNK } from "../packages/core/chunker.js";
import {
  canonical,
  sha,
  safeRelative,
  validateManifest,
  classify,
  solveRepair,
  randomBytes,
} from "../packages/core/index.js";
async function chunks(b: Buffer, block = 8191) {
  async function* stream() {
    for (let i = 0; i < b.length; i += block) yield b.subarray(i, i + block);
  }
  const out = [];
  for await (const c of chunkStream(stream())) out.push(c);
  return out;
}
describe("content defined streaming chunks", () => {
  it("handles empty/tiny and independent stream partitioning", async () => {
    expect(await chunks(Buffer.alloc(0))).toHaveLength(0);
    expect((await chunks(Buffer.from("hello")))[0].toString()).toBe("hello");
    const bytes = randomBytes(3 * 1024 * 1024);
    const a = await chunks(bytes),
      b = await chunks(bytes, 113);
    expect(a.map(sha)).toEqual(b.map(sha));
    expect(Buffer.concat(a)).toEqual(bytes);
    expect(
      a.every(
        (c, i) =>
          c.length <= MAX_CHUNK &&
          (i === a.length - 1 || c.length >= MIN_CHUNK),
      ),
    ).toBe(true);
  });
  it("reuses substantially more chunks after an insertion than fixed partitioning", async () => {
    const input = randomBytes(8 * 1024 * 1024, 901);
    const edited = Buffer.concat([
      input.subarray(0, 90000),
      Buffer.from("inserted bytes"),
      input.subarray(90000),
    ]);
    const a = new Set((await chunks(input)).map(sha)),
      b = await chunks(edited);
    const reuse =
      b.reduce((n, c) => n + (a.has(sha(c)) ? c.length : 0), 0) / input.length;
    let fixed = 0;
    for (let i = 0; i < edited.length; i += 65536)
      if (input.subarray(i, i + 65536).equals(edited.subarray(i, i + 65536)))
        fixed += 65536;
    expect(reuse).toBeGreaterThan(0.8);
    expect(reuse).toBeGreaterThan(fixed / input.length + 0.5);
  });
});
describe("metadata safety and evidence states", () => {
  it("canonical serialization is deterministic", () =>
    expect(canonical({ z: 1, a: { b: 3, a: 2 } })).toBe(
      '{"a":{"a":2,"b":3},"z":1}',
    ));
  it.each([
    "../escape",
    "/root",
    "a/../x",
    "a\\x",
    "a//b",
    "CON",
    "x.",
    "a\0b",
    "e\u0301",
  ])("rejects %s", (p) => expect(() => safeRelative(p)).toThrow());
  it("unknown versions fail closed", () =>
    expect(() => validateManifest({ version: 9 })).toThrow());
  it("does not collapse inaccessible into proven lost", () => {
    const c = (
      state:
        | "MISSING"
        | "CORRUPT"
        | "BACKEND_UNAVAILABLE"
        | "VERIFIED_OK"
        | "NOT_YET_VERIFIED",
    ) => ({ backend: "A", state });
    expect(classify([[c("MISSING"), c("BACKEND_UNAVAILABLE")]])).toBe(
      "UNKNOWN",
    );
    expect(classify([[c("MISSING"), c("CORRUPT")]])).toBe(
      "KNOWN_UNRECOVERABLE",
    );
    expect(classify([[c("VERIFIED_OK"), c("CORRUPT")]])).toBe(
      "VERIFIED_RECOVERABLE",
    );
    expect(classify([[c("NOT_YET_VERIFIED"), c("MISSING")]])).toBe(
      "PRESENT_BUT_UNVERIFIED",
    );
    expect(classify([])).toBe("VERIFIED_RECOVERABLE");
  });
});
describe("budget repair", () => {
  it("accounts for all-or-nothing bundles where popularity fails", () => {
    const costs = new Map([
      ["a", 5],
      ["b", 5],
      ["c", 5],
    ]);
    const versions = [
      ...Array.from({ length: 4 }, () => ({
        missing: new Set(["a", "b"]),
        weight: 1,
      })),
      ...Array.from({ length: 3 }, () => ({
        missing: new Set(["c"]),
        weight: 1,
      })),
    ];
    const result = solveRepair({ costs, versions, budget: 5 });
    expect(result.utility).toBe(3);
    expect(result.baselineUtility).toBe(0);
    expect(result.optimal).toBe(true);
  });
  it("exact solver matches separately enumerated brute force", () => {
    for (let seed = 1; seed < 12; seed++) {
      const costs = new Map(
        Array.from({ length: 7 }, (_, i) => [String(i), 1 + ((i * seed) % 7)]),
      );
      const versions = Array.from({ length: 9 }, (_, i) => ({
        missing: new Set([String(i % 7), String((i * seed + 2) % 7)]),
        weight: 1,
      }));
      let best = 0;
      for (let bits = 0; bits < 128; bits++) {
        const selected = [...costs.keys()].filter((_, i) => (bits >> i) & 1);
        if (selected.reduce((n, k) => n + costs.get(k)!, 0) > 12) continue;
        const score = versions.filter((v) =>
          [...v.missing].every((k) => selected.includes(k)),
        ).length;
        best = Math.max(best, score);
      }
      expect(solveRepair({ costs, versions, budget: 12 }).utility).toBe(best);
    }
  });
});

it("large repair heuristic counts only completed bundles within budget", () => {
  const costs = new Map(Array.from({ length: 22 }, (_, i) => [String(i), 10]));
  const versions = [
    { missing: new Set(["0", "1", "2"]), weight: 5 },
    { missing: new Set(["3", "4"]), weight: 4 },
    { missing: new Set(["5"]), weight: 1 },
  ];
  const result = solveRepair({ costs, versions, budget: 30 });
  expect(result.optimal).toBe(false);
  expect(result.bytes).toBeLessThanOrEqual(30);
  const actual = versions
    .filter((v) => [...v.missing].every((h) => result.chunks.includes(h)))
    .reduce((n, v) => n + v.weight, 0);
  expect(result.utility).toBe(actual);
});
