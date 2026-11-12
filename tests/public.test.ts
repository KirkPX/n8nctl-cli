import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

// Built from parts so this file does not match its own search.
const HOME_PATHS = ["/Use" + "rs/", "C:\\Use" + "rs\\"];

const NOT_TRACKED = new Set(["node_modules", "dist", "coverage", ".git"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (NOT_TRACKED.has(entry)) return [];
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [path.relative(ROOT, full)];
  });
}

/**
 * Tracked files, plus new files git would track, so the check also works before
 * the first commit. Outside a git repo, such as an unpacked copy, walk the folder.
 */
function trackedFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return walk(ROOT);
  }
}

function homePathsIn(text: string): string[] {
  return HOME_PATHS.filter((needle) => text.includes(needle));
}

// A home-folder path in a public repo names a person and a machine, and it is
// wrong on every other computer.
describe("public repo", () => {
  it("no tracked text file contains a home-folder path", () => {
    const files = trackedFiles();
    // A search that finds no files would pass without checking anything.
    expect(files).toContain("package.json");

    const offenders = files.filter((file) => {
      const full = path.join(ROOT, file);
      if (!existsSync(full)) return false; // deleted, not yet committed
      const content = readFileSync(full);
      if (content.includes(0)) return false; // binary
      return homePathsIn(content.toString("utf-8")).length > 0;
    });

    expect(offenders).toEqual([]);
  });

  it("the search finds both path shapes", () => {
    expect(homePathsIn("see " + "/Use" + "rs/someone/x")).toHaveLength(1);
    expect(homePathsIn("see " + "C:\\Use" + "rs\\someone\\x")).toHaveLength(1);
    expect(homePathsIn("see /usr/local/bin")).toHaveLength(0);
  });
});
