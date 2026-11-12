import { createInterface, type Interface } from "node:readline";
import { ask } from "../cli/ask.js";

/**
 * Read a secret from the terminal without echoing it.
 *
 * The prompt goes to stderr so a piped `--json` run keeps stdout clean. This is
 * the fallback when there is no browser to hand off to — SSH, a headless box,
 * or a locked-down desktop — so every CLI with a browser login MUST also have
 * this path.
 */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read it plainly. There is no terminal to echo to.
    return await nextPipedLine();
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  // readline has no masking, so suppress its echo while the answer is typed.
  const muted = rl as Interface & {
    _writeToOutput?: (text: string) => void;
    output?: NodeJS.WritableStream;
  };
  let masking = false;
  muted._writeToOutput = (text: string) => {
    if (masking && !text.includes(question)) return;
    muted.output?.write(text);
  };

  try {
    const answer = ask(rl, question);
    masking = true;
    return (await answer).trim();
  } finally {
    // The answer's Enter, or the Ctrl-C, was not echoed: end the line.
    process.stderr.write("\n");
    rl.close();
  }
}

export async function promptLine(question: string): Promise<string> {
  // Piped input holds one answer per line. readline would read past the first line
  // and lose the rest, so all of it is read once and handed out a line at a time.
  if (!process.stdin.isTTY) return await nextPipedLine();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await ask(rl, question)).trim();
  } finally {
    rl.close();
  }
}

let piped: Promise<string[]> | null = null;

/** The next line of piped input, or "" when there are no more. */
async function nextPipedLine(): Promise<string> {
  piped ??= readAllStdin().then((text) => text.split(/\r?\n/));
  const lines = await piped;
  return (lines.shift() ?? "").trim();
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
