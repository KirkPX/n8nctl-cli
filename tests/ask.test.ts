import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { ask } from "../src/cli/ask.js";
import { confirmDestructive } from "../src/cli/guardrails.js";
import { InterruptedError } from "../src/errors.js";
import { promptLine, promptSecret } from "../src/login/prompt.js";

const CTRL_C = "\x03";
const CTRL_D = "\x04";

// A stand-in terminal: readline puts a TTY input in raw mode, and must take it out
// again, or the shell shows nothing the person types after the CLI exits.
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  return { input, output };
}

function useFakeTerminal() {
  const terminal = fakeTerminal();
  vi.spyOn(process, "stdin", "get").mockReturnValue(terminal.input as never);
  vi.spyOn(process, "stderr", "get").mockReturnValue(terminal.output as never);
  return terminal;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask", () => {
  function open() {
    const { input, output } = fakeTerminal();
    return { input, rl: createInterface({ input, output, terminal: true }) };
  }

  it("returns the typed answer", async () => {
    const { input, rl } = open();
    const answer = ask(rl, "Name? ");
    input.write("Ada\r");
    await expect(answer).resolves.toBe("Ada");
    rl.close();
  });

  it("Ctrl-C rejects and restores the terminal", async () => {
    const { input, rl } = open();
    const answer = ask(rl, "Token: ");
    expect(input.setRawMode).toHaveBeenLastCalledWith(true);
    input.write(CTRL_C);
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("Ctrl-D answers with nothing, so the question cannot hang", async () => {
    const { input, rl } = open();
    const answer = ask(rl, "Name? ");
    input.write(CTRL_D);
    await expect(answer).resolves.toBe("");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

describe("every prompt stops on Ctrl-C", () => {
  it("promptSecret", async () => {
    const { input } = useFakeTerminal();
    const answer = promptSecret("Token: ");
    input.write(CTRL_C);
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("promptLine", async () => {
    const { input } = useFakeTerminal();
    const answer = promptLine("Name: ");
    input.write(CTRL_C);
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
  });

  it("confirmDestructive", async () => {
    const { input } = useFakeTerminal();
    const answer = confirmDestructive("Delete it?");
    input.write(CTRL_C);
    await expect(answer).rejects.toBeInstanceOf(InterruptedError);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

describe("prompts still answer normally", () => {
  it("promptSecret returns the trimmed answer and does not echo it", async () => {
    const { input, output } = useFakeTerminal();
    let shown = "";
    output.on("data", (chunk) => (shown += chunk));
    const answer = promptSecret("Token: ");
    input.write("secret-value\r");
    await expect(answer).resolves.toBe("secret-value");
    expect(shown).toContain("Token: ");
    expect(shown).not.toContain("secret-value");
  });

  it("confirmDestructive takes y as yes, and Ctrl-D as no", async () => {
    const yes = useFakeTerminal();
    const confirmed = confirmDestructive("Delete it?");
    yes.input.write("y\r");
    await expect(confirmed).resolves.toEqual({ confirmed: true });
    vi.restoreAllMocks();

    const eof = useFakeTerminal();
    const declined = confirmDestructive("Delete it?");
    eof.input.write(CTRL_D);
    await expect(declined).resolves.toEqual({ confirmed: false, reason: "declined" });
  });
});
