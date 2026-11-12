import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { UsageError } from "../errors.js";

/**
 * Read a text file named by an option, as UTF-8. A failure names the option and
 * the file in plain words, not as a raw system error.
 */
export async function readOptionFile(option: string, file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT" ? "the file does not exist"
      : code === "EISDIR" ? "it is a folder, not a file"
      : code === "EACCES" || code === "EPERM" ? "you do not have permission to read it"
      : (code ?? "unknown error");
    throw new UsageError(`${option} cannot read "${file}": ${reason}.`);
  }
}

export type BodyOptions = { data?: string; dataFile?: string };

/**
 * A request body as text, from `--data <json>`, `--data @<path>`, `--data -`
 * (standard input) or `--data-file <path>`. Use it for any option that takes JSON.
 *
 * PowerShell strips double quotes inside arguments it passes to a program, so JSON
 * typed on the command line can arrive broken there. A file or standard input
 * reaches the CLI unchanged on every system.
 */
export async function readRequestBody(
  opts: BodyOptions,
  stdin: Readable & { isTTY?: boolean } = process.stdin
): Promise<string | undefined> {
  if (opts.data !== undefined && opts.dataFile !== undefined) {
    throw new UsageError("Pass --data or --data-file, not both.");
  }
  if (opts.dataFile !== undefined) return readOptionFile("--data-file", opts.dataFile);
  if (opts.data === "-") {
    if (stdin.isTTY) {
      throw new UsageError(
        "--data - reads the body from standard input, but nothing is piped in.",
        "Pipe the JSON in, or pass --data @<path> to read it from a file."
      );
    }
    let text = "";
    stdin.setEncoding("utf-8");
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  if (opts.data?.startsWith("@")) return readOptionFile("--data", opts.data.slice(1));
  return opts.data;
}

/**
 * The same body, parsed. Windows PowerShell can save a UTF-8 file with a byte-order
 * mark at the start, which JSON.parse refuses, so the mark is removed first.
 */
export async function readJsonBody(
  opts: BodyOptions,
  stdin: Readable & { isTTY?: boolean } = process.stdin
): Promise<unknown> {
  const text = await readRequestBody(opts, stdin);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new UsageError("The request body is not valid JSON.");
  }
}
