import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
// Drives the built CLI, which is the only way to see option wiring. The
// `pretest` script builds first, so dist/ is always present by the time this
// runs — do not "fix" a failure here by mocking the CLI away.
const distIndex = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");

async function help(...args: string[]): Promise<string> {
  const { stdout, stderr } = await exec("node", [distIndex, ...args, "--help"]);
  return stdout + stderr;
}

/** Subcommand names listed under a group's "Commands:" section. */
function subcommandsOf(helpText: string): string[] {
  const section = helpText.split(/^Commands:$/m)[1];
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.match(/^\s{2}(\S+)/)?.[1])
    .filter((name): name is string => Boolean(name) && name !== "help");
}

// Commander binds an option to the command it is declared on. Two failure
// modes follow, and both have shipped in this fleet more than once:
//
//   1. A handler reads opts.yes but the subcommand never declares --yes, so
//      the flag errors as "unknown option" and the handler branch is dead.
//   2. --json is declared in two places at once. The Output Contract makes it a
//      global root flag; re-declaring it on a subcommand shadows the root one,
//      and a command reading the wrong opts object silently emits pretty output
//      where JSON was asked for.
//
// Neither is visible to a unit test that calls a handler with a literal opts
// object, and neither is a type error — an undeclared option is a well-typed
// `undefined`. Only driving the registered CLI catches them.
type HelpPage = { group: string; sub?: string; text: string };

/**
 * The help text of the root, every group and every subcommand, fetched once. Each
 * page is a new Node process, so the pages load in parallel. Fetched one at a time,
 * the walk took over 5 seconds on a Windows CI machine.
 */
async function walkHelp(): Promise<{ root: string; pages: HelpPage[] }> {
  const root = await help();
  const groups = await Promise.all(
    subcommandsOf(root).map(async (group) => ({ group, text: await help(group) }))
  );
  const subs = await Promise.all(
    groups.flatMap(({ group, text }) =>
      subcommandsOf(text).map(async (sub) => ({ group, sub, text: await help(group, sub) }))
    )
  );
  return { root, pages: [...groups, ...subs] };
}

describe("command wiring", () => {
  let root = "";
  let pages: HelpPage[] = [];
  beforeAll(async () => {
    ({ root, pages } = await walkHelp());
  }, 60_000);

  it("the walk finds the standard commands", () => {
    // A walk that finds nothing would pass every check below without checking anything.
    expect(pages.map((p) => p.group)).toContain("doctor");
    expect(pages.some((p) => p.group === "config" && p.sub === "show")).toBe(true);
  });

  it("every destructive command declares --yes", () => {
    const missing = pages
      .filter((p) => p.text.includes("(destructive)") && !/^\s+--yes\b/m.test(p.text))
      .map((p) => (p.sub ? `${p.group} ${p.sub}` : p.group));

    // A destructive command that prompts but cannot be bypassed is unusable in
    // scripts and CI, which is a regression even though it looks safer.
    // A fresh scaffold has no destructive commands yet, so finding none is a
    // pass here — in a real CLI this walk is the whole point.
    expect(missing).toEqual([]);
  });

  it("--json is a global root flag, per the Output Contract", () => {
    expect(root).toContain("--json");
  });

  it("no subcommand re-declares --json", () => {
    const shadowed = pages
      .filter((p) => /^\s+--json\b/m.test(p.text))
      .map((p) => (p.sub ? `${p.group} ${p.sub}` : p.group));

    // Commands read the root flag through resolveFormat(program.opts()).
    // Re-declaring it locally is how a CLI ends up with divergent behavior
    // between `cli --json sub` and `cli sub --json`.
    expect(shadowed).toEqual([]);
  });
});
