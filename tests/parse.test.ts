import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { parseCount, parseDate, parseId, parsePercent } from "../src/cli/parse.js";

describe("number option parsers", () => {
  it("accept whole numbers", () => {
    expect(parseId("42")).toBe(42);
    expect(parseId(" 7 ")).toBe(7);
    expect(parseCount("0")).toBe(0);
    expect(parsePercent("100")).toBe(100);
  });

  it.each(["abc", "", "1.5", "-3", "1e3", "0x10", "9007199254740993"])("refuse %j", (value) => {
    expect(() => parseId(value)).toThrow("Expected a whole number");
    expect(() => parseCount(value)).toThrow("Expected a whole number");
    expect(() => parsePercent(value)).toThrow("Expected a whole number");
  });

  it("refuse an ID of 0 and a percentage over 100", () => {
    expect(() => parseId("0")).toThrow("greater than 0");
    expect(() => parsePercent("101")).toThrow("0 to 100");
  });

  it("stop the command before it runs, and name the option", async () => {
    let ran = false;
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => undefined })
      .option("--limit <n>", "How many", parseCount)
      .action(() => {
        ran = true;
      });

    await expect(program.parseAsync(["--limit", "abc"], { from: "user" })).rejects.toThrow(
      /--limit.*not "abc"/
    );
    expect(ran).toBe(false);
  });
});

describe("parseDate", () => {
  it("takes both forms and returns YYYY-MM-DD", () => {
    expect(parseDate("2026-01-31")).toBe("2026-01-31");
    expect(parseDate("20260131")).toBe("2026-01-31");
  });

  it("refuses an impossible date or another format", () => {
    expect(() => parseDate("2026-02-30")).toThrow(/YYYY-MM-DD or YYYYMMDD/);
    expect(() => parseDate("31/01/2026")).toThrow(/YYYY-MM-DD or YYYYMMDD/);
    expect(() => parseDate("2026-1-5")).toThrow(/YYYY-MM-DD or YYYYMMDD/);
  });
});
