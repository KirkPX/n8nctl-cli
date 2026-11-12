import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { readJsonBody, readOptionFile, readRequestBody } from "../src/cli/read-file.js";

const root = mkdtempSync(path.join(tmpdir(), "n8nctl read "));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fileWith(text: string): string {
  // A path with spaces and non-English characters, as the cross-platform rules ask.
  const dir = mkdtempSync(path.join(root, "café 東京 "));
  const file = path.join(dir, "body file.json");
  writeFileSync(file, text);
  return file;
}

function piped(text: string): Readable {
  return Readable.from([Buffer.from(text)]);
}

describe("readOptionFile", () => {
  it("reads a path with spaces and non-English characters", async () => {
    await expect(readOptionFile("--file", fileWith("héllo"))).resolves.toBe("héllo");
  });

  it("names the option and the file when the file is missing", async () => {
    const missing = path.join(root, "missing.json");
    await expect(readOptionFile("--file", missing)).rejects.toThrow(
      `--file cannot read "${missing}": the file does not exist.`
    );
  });

  it("says so when the path is a folder", async () => {
    const dir = path.join(root, "a folder");
    mkdirSync(dir);
    await expect(readOptionFile("--file", dir)).rejects.toThrow("it is a folder, not a file");
  });
});

describe("readRequestBody", () => {
  it("takes the text as given", async () => {
    await expect(readRequestBody({ data: '{"a":1}' })).resolves.toBe('{"a":1}');
  });

  it("returns nothing when no body was asked for", async () => {
    await expect(readRequestBody({})).resolves.toBeUndefined();
  });

  it("reads @path and --data-file", async () => {
    const file = fileWith('{"a":1}');
    await expect(readRequestBody({ data: `@${file}` })).resolves.toBe('{"a":1}');
    await expect(readRequestBody({ dataFile: file })).resolves.toBe('{"a":1}');
  });

  it("reads standard input for -", async () => {
    await expect(readRequestBody({ data: "-" }, piped('{"a":1}'))).resolves.toBe('{"a":1}');
  });

  it("refuses - when nothing is piped in, instead of waiting", async () => {
    const stdin = Object.assign(piped(""), { isTTY: true });
    await expect(readRequestBody({ data: "-" }, stdin)).rejects.toThrow("nothing is piped in");
  });

  it("refuses --data with --data-file", async () => {
    await expect(readRequestBody({ data: "{}", dataFile: "x" })).rejects.toThrow("not both");
  });
});

describe("readJsonBody", () => {
  it("parses the body", async () => {
    await expect(readJsonBody({ data: '{"a":1}' })).resolves.toEqual({ a: 1 });
  });

  it("accepts a file saved with a byte-order mark", async () => {
    await expect(readJsonBody({ dataFile: fileWith('﻿{"a":1}') })).resolves.toEqual({ a: 1 });
  });

  it("says so when the body is not JSON", async () => {
    await expect(readJsonBody({ data: "{a:1" })).rejects.toThrow("not valid JSON");
  });
});
