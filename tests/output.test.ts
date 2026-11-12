import { afterEach, describe, expect, it } from "vitest";
import { output, resolveFormat } from "../src/cli/output.js";

// isTTY is a plain property, so save and restore it rather than spying.
const original = process.stdout.isTTY;

afterEach(() => {
  process.stdout.isTTY = original;
});

function capture(run: () => void): string[] {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    run();
  } finally {
    console.log = log;
  }
  return lines;
}

describe("resolveFormat", () => {
  it("gives an interactive terminal human output", () => {
    process.stdout.isTTY = true;
    expect(resolveFormat({})).toBe("pretty");
  });

  it("gives JSON when stdout is not a TTY, with no flag", () => {
    // This is the case that matters: piped, redirected, CI, or an agent. A
    // script gets parseable output without having to remember --json.
    process.stdout.isTTY = false;
    expect(resolveFormat({})).toBe("json");
  });

  it("honors --json even at an interactive terminal", () => {
    process.stdout.isTTY = true;
    expect(resolveFormat({ json: true })).toBe("json");
  });

  it("defaults to JSON when isTTY is undefined", () => {
    // Node leaves isTTY undefined rather than false in some contexts. The safe
    // reading is "not a terminal", so machine format.
    process.stdout.isTTY = undefined as unknown as boolean;
    expect(resolveFormat({})).toBe("json");
  });
});

describe("output", () => {
  // Printing nothing looks the same as a broken command.
  it("emits an empty array as [] in json mode", () => {
    expect(JSON.parse(capture(() => output([], "json")).join("\n"))).toEqual([]);
  });

  it("says so when a pretty result is empty", () => {
    expect(capture(() => output([], "pretty"))).toEqual(["No results."]);
  });
});
