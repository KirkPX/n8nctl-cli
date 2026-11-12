import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// .env.example drifts silently: someone reads a new env var in src/ and nobody
// notices the doc never learned about it. Cheap to check, so check it.
describe("docs", () => {
  it("documents every env var the CLI reads", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf-8");

    const read = new Set(
      filesUnder(path.join(ROOT, "src"))
        .filter((f) => f.endsWith(".ts"))
        .flatMap((f) => [
          ...readFileSync(f, "utf-8").matchAll(/(?:process\.env\.|\benv\(")([A-Z][A-Z0-9_]*)/g),
        ])
        .map((m) => m[1]!)
    );

    const undocumented = [...read].filter((name) => !example.includes(name)).sort();
    expect(undocumented).toEqual([]);
  });

  it("README covers the sections every user needs", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf-8").toLowerCase();
    for (const section of [
      "install",
      "configure",
      "first command",
      "troubleshooting",
      "uninstall",
    ]) {
      expect(readme).toContain(`## ${section}`);
    }
    // Auth is covered by a section named for the verb the CLI actually uses.
    expect(/^## (authenticate|auth|sign in)/m.test(readme)).toBe(true);
  });

  it("docs/json-output.md names every field backup prints", () => {
    const doc = readFileSync(path.join(ROOT, "docs", "json-output.md"), "utf-8");
    const fields = [
      "schemaVersion", "dir", "index", "startedAt", "completedAt", "complete", "counts", "workflows", "failures", "staleFiles",
      "saved", "changed", "failed", "archived", "inactive", "contentHash", "updatedAt", "not-on-server", "renamed",
    ];
    for (const field of fields) expect(doc).toContain(`\`${field}\``);
  });
});
