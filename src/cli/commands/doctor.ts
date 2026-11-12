// `n8nctl doctor` diagnoses the local install: runtime, whether the command
// is reachable, the settings file, the credential store and whether a key exists.
// It never prints the secret itself, and it reports problems without stopping.

import { createRequire } from "node:module";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pc from "picocolors";
import { credentialsFilePath, getCredentialStoreInfo } from "../../auth.js";
import { getConfigPath, resolveConfig, resolvePassword } from "../../config.js";
import { loadSettings, type Settings } from "../../settings.js";
import { reporter } from "../output.js";

const COMMAND = "n8nctl";
const PACKAGE = "n8nctl-cli";

type CheckResult = {
  name: string;
  ok: boolean;
  value: string;
  fix?: string[];
};

export async function doctorCommand(
  opts: { install?: boolean; json?: boolean } = {}
): Promise<void> {
  const pathCheck = commandOnPathCheck();
  const checks: CheckResult[] = [
    { name: "Node.js", ok: isSupportedNode(), value: process.version },
    { name: "Platform", ok: true, value: `${process.platform}/${process.arch}` },
    pathCheck,
  ];

  // Doctor exists to diagnose problems, so a broken settings file is a result
  // here and not a crash. The checks below carry on as if the file were empty.
  let settings: Settings = {};
  try {
    settings = loadSettings();
    checks.push({ name: "Config file", ok: true, value: getConfigPath() });
  } catch (error) {
    checks.push({
      name: "Config file",
      ok: false,
      value: getConfigPath(),
      fix: [(error as Error).message],
    });
  }

  const cfg = resolveConfig({}, settings);
  checks.push({
    name: "n8n address",
    ok: Boolean(cfg.baseUrl),
    value: cfg.baseUrl ?? "not set — run `n8nctl login`, or set N8NCTL_BASE_URL",
  });
  checks.push({
    name: "API key",
    // Never the key itself, only whether one is reachable.
    ok: Boolean(cfg.apiKey),
    value: cfg.apiKey
      ? "present"
      : "not found — run `n8nctl login`, or set N8NCTL_API_KEY",
  });
  checks.push({
    name: "Email sign-in",
    // Optional: only archive, unarchive and run need it.
    ok: true,
    value:
      cfg.email && resolvePassword(cfg.account)
        ? `${cfg.email} (for archive, unarchive and run)`
        : "not set — only archive, unarchive and run need it (`n8nctl login --email`)",
  });
  checks.push(credentialStoreCheck());

  const r = reporter(opts);
  const pretty = checks
    .flatMap((check) => [
      `${check.ok ? pc.green("OK  ") : pc.yellow("WARN")} ${check.name}: ${check.value}`,
      ...(check.fix ?? []).map((line) => `     ${pc.dim(line)}`),
    ])
    .join("\n");

  r.result({ ok: checks.every((c) => c.ok), checks }, pretty);

  // The closing verdict for `npm run setup` goes to stderr: it is a message
  // about the install, not part of doctor's result, so it must not go into a
  // pipe. It still shows in a terminal, in both formats.
  if (opts.install) {
    if (pathCheck.ok) {
      r.warn("\n" + pc.green("Installed.") + " Next: " + pc.cyan(`${COMMAND} login`));
    } else {
      r.warn(
        "\n" +
          pc.yellow(`Almost there — the \`${COMMAND}\` command is not reachable yet.`) +
          "\nDo this, then run " +
          pc.cyan(`${COMMAND} login`) +
          ":\n" +
          (pathCheck.fix ?? []).map((line) => `  ${line}`).join("\n")
      );
    }
  }
}

function credentialStoreCheck(): CheckResult {
  const store = getCredentialStoreInfo();
  let keyringInstalled = false;
  try {
    createRequire(import.meta.url).resolve("@napi-rs/keyring");
    keyringInstalled = true;
  } catch {
    // not installed, or not loadable on this platform
  }

  let value: string;
  if (store.kind === "file") {
    value = `no keychain here (credentials persist in ${credentialsFilePath()})`;
  } else if (keyringInstalled && store.kind === "keyring") {
    value = `OS keychain (or ${credentialsFilePath()} where the keychain is closed, as over SSH)`;
  } else {
    value = "in memory (credentials do not persist; use N8NCTL_API_KEY for automation)";
  }
  return { name: "Credential store", ok: store.persistent, value };
}

/**
 * Is the command actually runnable by name?
 *
 * The CLI cannot report this failure when it is run by name: if the command is
 * missing, the shell prints an error and nothing here ever runs. So `npm run
 * doctor` calls this through Node directly, which works before the command resolves.
 */
export function commandOnPathCheck(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  // argv[1] is the entry script, which is what the installed command links to.
  // The module path is not usable here: the bundler splits the code, so
  // import.meta.url points at a chunk that no installed command references.
  ownEntry: string = process.argv[1] ?? fileURLToPath(import.meta.url)
): CheckResult {
  const name = `${COMMAND} on PATH`;
  const found = findCommandOnPath(COMMAND, env, platform);

  if (!found) {
    return {
      name,
      ok: false,
      value: `not found — the \`${COMMAND}\` command will not be recognised yet`,
      fix:
        platform === "win32"
          ? [
              "`npm link` writes its launcher scripts to %APPDATA%\\npm.",
              "Open a NEW terminal — an existing one keeps the old PATH.",
              "Still missing? Check that directory is on your PATH:",
              "  npm config get prefix",
              "  $env:PATH -split ';' | Select-String 'npm'",
            ]
          : [
              "Run `npm link` in the repo, then open a new terminal.",
              "Still missing? Check npm's bin directory is on your PATH:",
              "  npm config get prefix    # binaries are in <prefix>/bin",
            ],
    };
  }

  // Finding a command of this name is not enough. Another tool of the same name
  // earlier on PATH wins, and the user gets its errors while believing they
  // are running this one.
  if (!pointsAtUs(found, ownEntry, platform)) {
    return {
      name,
      ok: false,
      value: `shadowed — \`${COMMAND}\` runs ${found}, which is not this CLI`,
      fix: [
        "Another program of the same name comes first on your PATH.",
        "If you already fixed your PATH, open a NEW terminal — this one",
        "still has the PATH it started with.",
        "Otherwise put npm's bin directory ahead of the other program.",
        `This CLI lives at ${ownEntry}`,
      ],
    };
  }

  return { name, ok: true, value: found };
}

/** Does the command on PATH actually lead back to this build? */
function pointsAtUs(found: string, ownEntry: string, platform: NodeJS.Platform): boolean {
  try {
    if (realpathSync(found) === realpathSync(ownEntry)) return true;
  } catch {
    // fall through to the Windows check
  }

  // npm writes .cmd and .ps1 wrapper scripts on Windows rather than symlinks, so
  // there is no path to compare. Read the wrapper and look for the package.
  if (platform === "win32") {
    try {
      return readFileSync(found, "utf-8").includes(PACKAGE);
    } catch {
      return false;
    }
  }

  return false;
}

function findCommandOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | null {
  // Windows resolves a bare name through PATHEXT, and npm writes several
  // wrappers. Any one of them makes the command work.
  const candidates =
    platform === "win32" ? [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name] : [name];

  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        accessSync(full, platform === "win32" ? constants.F_OK : constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }

  return null;
}

/** The versions named by `engines` in package.json. The build tools need them. */
export function isSupportedNode(version: string = process.version): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major === 22) return minor >= 18;
  if (major === 24) return minor >= 11;
  return major >= 26;
}
