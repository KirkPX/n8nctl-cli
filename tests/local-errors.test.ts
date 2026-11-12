import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { extractSafeDetail } from "../src/client.js";
import { setSetting } from "../src/settings.js";

const exec = promisify(execFile);
const dist = resolve(import.meta.dirname ?? ".", "../dist/index.js");
const scratch = () => mkdtempSync(join(tmpdir(), "n8nctl erreurs é "));
const savedConfig = process.env.N8NCTL_CLI_CONFIG_FILE;

afterEach(() => {
  process.env.N8NCTL_CLI_CONFIG_FILE = savedConfig;
});

describe("the service's reason for a refusal", () => {
  it("reads the common shapes", () => {
    expect(extractSafeDetail({ MESSAGE: "Project not found" })).toBe("Project not found");
    expect(extractSafeDetail({ errors: [{ title: "Bad Request", detail: "due must be a date" }] })).toBe(
      "Bad Request: due must be a date"
    );
    expect(extractSafeDetail({ error: "Closed" })).toBe("Closed");
  });

  it("shows a sentence whole, without masking the middle", () => {
    const long = "You do not have permission to add items in this project";
    expect(extractSafeDetail({ message: long })).toBe(long);
  });

  it("removes the key if a reply repeats it, and cuts very long text", () => {
    expect(extractSafeDetail({ message: "bad key k_secret_123" }, "k_secret_123")).toBe("bad key ****");
    expect(extractSafeDetail({ message: "x".repeat(500) }).length).toBe(300);
  });

  it("ignores an HTML error page", () => {
    expect(extractSafeDetail("<html><body>502</body></html>")).toBe("no response detail");
  });

  it("gives a next step for the common refusals", () => {
    const hint = (status: number) =>
      new ApiError({ status, statusText: "", operation: "GET /x", safeDetail: "" }).hint;
    expect(hint(401)).toContain("login --force");
    expect(hint(403)).toContain("permission");
    for (const status of [404, 422, 429, 503]) expect(hint(status), String(status)).toBeTruthy();
    expect(hint(418)).toBeUndefined();
  });
});

describe("settings file errors read in plain words", () => {
  it("names the reason when the settings path is a folder", () => {
    const folder = join(scratch(), "config.json");
    mkdirSync(folder);
    process.env.N8NCTL_CLI_CONFIG_FILE = folder;
    expect(() => setSetting("readOnly", "true")).toThrow("Cannot read the settings file: it is a folder, not a file.");
  });

  it("names the reason when part of the settings path is a file", () => {
    const blocker = join(scratch(), "not a folder");
    writeFileSync(blocker, "");
    process.env.N8NCTL_CLI_CONFIG_FILE = join(blocker, "config.json");
    expect(() => setSetting("readOnly", "true")).toThrow("settings file: part of the path is a file, not a folder.");
  });
});

describe("the credentials file", () => {
  it("refuses to write over a damaged file, so other accounts' keys are kept", async () => {
    const file = join(scratch(), "credentials.json");
    writeFileSync(file, "{ not json");
    const env = {
      ...process.env,
      N8NCTL_CLI_CREDENTIAL_STORE: "file",
      N8NCTL_CLI_CREDENTIALS_FILE: file,
      N8NCTL_CLI_CONFIG_FILE: join(scratch(), "config.json"),
    };
    const failed = await exec(process.execPath, [dist, "--json", "auth", "--login", "--api-key", "k"], { env }).catch(
      (e: { stderr: string }) => e
    );
    expect(JSON.parse((failed as { stderr: string }).stderr).message).toContain("credentials file is damaged");
    expect(readFileSync(file, "utf-8")).toBe("{ not json");
  });
});

describe("commander errors follow --json", () => {
  it("prints one JSON object for an unknown command", async () => {
    const failed = await exec(process.execPath, [dist, "no-such-command", "--json"]).catch(
      (e: { stderr: string; code: number }) => e
    );
    const { stderr, code } = failed as { stderr: string; code: number };
    expect(code).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ error: true, message: expect.any(String) });
  });
});
