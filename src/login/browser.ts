import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export type Opener = { command: string; args: string[] };

/**
 * Open a URL in the user's default browser.
 *
 * Returns false instead of throwing when no opener exists — a headless box or
 * an SSH session is a normal case, and the caller prints the URL instead.
 */
export function openBrowser(url: string): boolean {
  // Checked here, not at the call site, so nothing reaches a real browser by
  // forgetting to ask. Tests set this; see vitest.config.ts.
  if (process.env.N8NCTL_CLI_NO_BROWSER) return false;

  const opener = findOpener();
  if (!opener) return false;

  try {
    const child = spawn(opener.command, [...opener.args, openerArgument(url)], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    // Without this the CLI cannot exit until the browser does.
    child.unref();
    child.on("error", () => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare the URL for the opener.
 *
 * On Windows the URL goes through `cmd /c start`, and cmd reads `&`, `|`, `<`,
 * `>` and `^` as its own. Without escaping, everything after the first `&` in
 * a URL is lost, so a sign-in page with two settings in its address opens
 * with one.
 */
export function openerArgument(url: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? url.replace(/[\^&|<>]/g, "^$&") : url;
}

/**
 * Pick the platform's URL opener.
 *
 * `exists` is injectable so one platform's branch can be asserted from
 * another. Probing the real filesystem makes the macOS case fail on a Windows
 * runner — a test that asserts the host rather than the code.
 */
export function findOpener(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = executableAt
): Opener | null {
  if (platform === "win32") {
    const comspec = env.ComSpec || "cmd.exe";
    // cmd's `start` reads a quoted first token as the window title, so the URL
    // needs an empty title ahead of it or it is swallowed. That title must be a
    // genuinely empty argument: Node renders "" for it on Windows, whereas a
    // string of two quote characters is escaped to "\"\"" and reaches cmd as a
    // literal title.
    return { command: comspec, args: ["/c", "start", ""] };
  }

  if (platform === "darwin") {
    return exists("/usr/bin/open")
      ? { command: "/usr/bin/open", args: [] }
      : null;
  }

  const xdgOpen = findOnPath("xdg-open", env, exists);
  return xdgOpen ? { command: xdgOpen, args: [] } : null;
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean
): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function executableAt(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
