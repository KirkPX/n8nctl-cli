import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_KEY, startFakeN8n } from "./fake-n8n.js";

const distIndex = path.resolve(import.meta.dirname ?? ".", "../dist/index.js");

const dirs: string[] = [];
function tempDir(prefix = "n8nctl cfg "): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Run = { code: number | null; stdout: string; stderr: string };

/** Run the built CLI. stdin is closed unless `input` is given, so nothing can hang on it. */
function run(
  args: string[],
  opts: { env?: Record<string, string>; input?: string; nodeArgs?: string[] } = {}
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), distIndex, ...args], {
      env: { ...process.env, ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

describe("built binary smoke test", () => {
  it("--help exits 0 and prints usage", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("n8nctl");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("login");
    expect(stdout).toContain("logout");
  });

  it("--version matches package.json", async () => {
    const { stdout } = await run(["--version"]);
    const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(distIndex), "../package.json"), "utf-8"));
    expect(stdout.trim()).toBe(pkg.version);
  });

  // A piped run is machine-readable whether or not --json was passed.
  it("doctor exits 0 and emits parseable checks when piped", async () => {
    const { code, stdout } = await run(["doctor"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ok");
    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("Node.js");
    expect(names).toContain("Platform");
    expect(names).toContain("n8nctl on PATH");
  });

  it("doctor --install keeps its verdict out of stdout", async () => {
    const { stdout, stderr } = await run(["doctor", "--install"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toMatch(/Installed\.|Almost there/);
  });

  it("auth shows status when not signed in", async () => {
    const { code, stdout } = await run(["auth"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ authenticated: false });
  });

  it("login takes no site or key argument", async () => {
    const { stdout } = await run(["login", "--help"]);
    expect(stdout).toContain("--paste");
    expect(stdout).toContain("--force");
    expect(stdout).not.toContain("--api-key");
  });

  it("reports a failure with exit code 1 and the whole message on stderr", async () => {
    const { code, stdout, stderr } = await run(["list"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: true, message: "Not signed in." });
  });
});

describe("settings file", () => {
  it("config path honors the override", async () => {
    const file = path.join(tempDir(), "config.json");
    const { stdout } = await run(["config", "path"], {
      env: { N8NCTL_CLI_CONFIG_FILE: file },
    });
    expect(JSON.parse(stdout)).toEqual({ path: file });
  });

  it("config show reports a broken settings file and doctor survives it", async () => {
    const file = path.join(tempDir(), "config.json");
    writeFileSync(file, JSON.stringify({ readonly: true }));
    const env = { N8NCTL_CLI_CONFIG_FILE: file };

    const failed = await run(["config", "show"], { env });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Invalid settings");

    const doctor = await run(["doctor"], { env });
    expect(doctor.code).toBe(0);
    const check = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === "Config file");
    expect(check.ok).toBe(false);
    expect(check.fix.join(" ")).toContain("Invalid settings");
  });

  it("reads a settings file at a path with spaces and non-English characters", async () => {
    const dir = path.join(tempDir("n8nctl tést 日本語 "), "Configuración de prueba");
    mkdirSync(dir);
    const file = path.join(dir, "ajustes 設定.json");
    writeFileSync(file, JSON.stringify({ account: "cuenta-ñ", timeoutMs: 1234 }), "utf-8");

    const { code, stdout } = await run(["config", "show"], {
      env: { N8NCTL_CLI_CONFIG_FILE: file },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      path: file,
      settings: { account: "cuenta-ñ", timeoutMs: 1234 },
    });
  });
});

describe("closed pipes", () => {
  // console.log swallows a write error by itself, so an ordinary command proves
  // nothing about the listener in src/index.ts. This file loads before the CLI and
  // acts once the command is done, so it reaches the listener the way a direct
  // stream write would (commander, a large result, a progress line).
  function preload(body: string): string {
    const file = path.join(tempDir(), "after-command.mjs");
    writeFileSync(file, `let done = false;
process.on("beforeExit", () => {
  if (done) return;
  done = true;
  ${body}
});
`);
    return pathToFileURL(file).href;
  }

  /** Start the CLI with a reader that closes stdout before the CLI writes anything. */
  function runWithClosedStdout(args: string[], nodeArgs: string[] = []): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...nodeArgs, distIndex, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.destroy();
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout: "", stderr }));
    });
  }

  it.each([[["doctor"]], [["--help"]], [["config", "path"]]])(
    "%j exits 0 with no stack trace when the reader closes early",
    async (args) => {
      const { code, stderr } = await runWithClosedStdout(args);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    }
  );

  it("exits 0 when a direct stream write hits the closed pipe", async () => {
    const hook = preload(`process.stdout.write("more output\\n");`);
    const { code, stderr } = await runWithClosedStdout(["doctor"], ["--import", hook]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });

  it.each(["stdout", "stderr"])("exits 0 on an EPIPE from %s", async (stream) => {
    const hook = preload(
      `process.${stream}.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));`
    );
    const { code } = await run(["config", "path"], { nodeArgs: ["--import", hook] });
    expect(code).toBe(0);
  });

  it("does not hide any other stream error", async () => {
    const hook = preload(
      `process.stdout.emit("error", Object.assign(new Error("disk trouble"), { code: "EIO" }));`
    );
    const { code, stderr } = await run(["config", "path"], { nodeArgs: ["--import", hook] });
    expect(code).not.toBe(0);
    expect(stderr).toContain("disk trouble");
  });
});

describe("Ctrl-C at a prompt", () => {
  // Standard input is a pipe here, so this file makes it act as a terminal. The CLI
  // then reads the Ctrl-C byte the way it reads a real key press.
  function fakeTerminal(): string {
    const file = path.join(tempDir(), "fake-terminal.mjs");
    writeFileSync(file, `process.stdin.isTTY = true;
process.stdin.setRawMode = (mode) => {
  process.stderr.write("raw mode: " + mode + "\\n");
  return process.stdin;
};
`);
    return pathToFileURL(file).href;
  }

  it("exits 130 and restores typing", async () => {
    const { code, stdout, stderr } = await run(["login", "--paste"], {
      input: "\x03",
      nodeArgs: ["--import", fakeTerminal()],
    });
    expect(code).toBe(130);
    expect(stdout).toBe("");
    expect(stderr).toContain("Cancelled.");
    expect(stderr).not.toContain("Error:");
    expect(stderr).toContain("raw mode: true");
    expect(stderr.lastIndexOf("raw mode: false")).toBeGreaterThan(stderr.lastIndexOf("raw mode: true"));
  });
});

describe("bare command", () => {
  // Sign-in checks the key against n8n, so these tests use a fake n8n on
  // 127.0.0.1 (tests/fake-n8n.ts). Tests must not call a real service.
  it("signs in when never signed in, then shows help", async () => {
    const fake = await startFakeN8n();
    const file = path.join(tempDir(), "sub", "credentials.json");
    const env = {
      N8NCTL_CLI_CREDENTIAL_STORE: "file",
      N8NCTL_CLI_CREDENTIALS_FILE: file,
      N8NCTL_BASE_URL: fake.url,
    };

    const first = await run([], { env, input: `${FAKE_KEY}\n` });
    await fake.close();
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ loggedIn: true, credentialStore: "file" });
    expect(first.stdout).not.toContain(FAKE_KEY);

    const second = await run([], { env });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Usage: n8nctl");
  });

  it("fails cleanly when sign-in gets no key", async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: true, message: "Nothing entered." });
  });

  it("shows help when a key comes from the environment", async () => {
    const { code, stdout } = await run([], { env: { N8NCTL_API_KEY: "env-key" } });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: n8nctl");
  });
});
