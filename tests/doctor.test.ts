import { chmod, mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commandOnPathCheck } from "../src/cli/commands/doctor.js";

const COMMAND = "n8nctl";
const PACKAGE = "n8nctl-cli";

describe("commandOnPathCheck", () => {
  let dir: string;
  let binDir: string;
  let ownEntry: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), `${COMMAND}-doctor-`));
    binDir = path.join(dir, "bin");
    await mkdir(binDir);
    ownEntry = path.join(dir, "dist", "index.js");
    await mkdir(path.dirname(ownEntry));
    await writeFile(ownEntry, "#!/usr/bin/env node\n", "utf-8");
    await chmod(ownEntry, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("warns when the command is not on PATH", () => {
    const result = commandOnPathCheck({ PATH: binDir }, "linux", ownEntry);
    expect(result.ok).toBe(false);
    expect(result.value).toContain("not found");
    expect(result.fix?.join(" ")).toContain("npm link");
  });

  it("points Windows users at %APPDATA%\\npm and a new terminal", () => {
    const result = commandOnPathCheck({ PATH: binDir }, "win32", ownEntry);
    expect(result.ok).toBe(false);
    const fix = result.fix?.join(" ") ?? "";
    expect(fix).toContain("%APPDATA%\\npm");
    expect(fix).toContain("NEW terminal");
  });

  it("passes when the command resolves back to this build", async () => {
    const shim = path.join(binDir, COMMAND);
    await symlink(ownEntry, shim);

    const result = commandOnPathCheck({ PATH: binDir }, "linux", ownEntry);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(shim);
  });

  // Finding the name on PATH is not enough: a different tool may be the one that runs.
  it("reports a different program of the same name as shadowing", async () => {
    const impostor = path.join(binDir, COMMAND);
    await writeFile(impostor, "#!/usr/bin/env python3\n", "utf-8");
    await chmod(impostor, 0o755);

    const result = commandOnPathCheck({ PATH: binDir }, "linux", ownEntry);
    expect(result.ok).toBe(false);
    expect(result.value).toContain("shadowed");
    expect(result.value).toContain(impostor);
  });

  it("accepts a Windows .cmd shim that references the package", async () => {
    // npm writes wrapper scripts on Windows rather than symlinks, so there is
    // no path to compare. The wrapper's contents are the only evidence.
    await writeFile(
      path.join(binDir, `${COMMAND}.cmd`),
      `@"%~dp0\\node_modules\\${PACKAGE}\\dist\\index.js" %*\r\n`,
      "utf-8"
    );

    const result = commandOnPathCheck({ PATH: binDir }, "win32", ownEntry);
    expect(result.ok).toBe(true);
  });

  it("rejects a Windows .cmd shim belonging to something else", async () => {
    await writeFile(
      path.join(binDir, `${COMMAND}.cmd`),
      '@"%~dp0\\some-other-tool\\main.py" %*\r\n',
      "utf-8"
    );

    const result = commandOnPathCheck({ PATH: binDir }, "win32", ownEntry);
    expect(result.ok).toBe(false);
    expect(result.value).toContain("shadowed");
  });
});

describe("doctor's Node check", () => {
  it("matches the versions the package supports", async () => {
    const { isSupportedNode } = await import("../src/cli/commands/doctor.js");
    for (const good of ["v22.18.0", "v22.20.1", "v24.11.0", "v26.0.0", "v28.1.0"]) expect(isSupportedNode(good), good).toBe(true);
    for (const bad of ["v20.19.0", "v22.17.9", "v23.11.0", "v24.10.0", "v25.9.0"]) expect(isSupportedNode(bad), bad).toBe(false);
  });
});
