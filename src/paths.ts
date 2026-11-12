import { homedir } from "node:os";
import { join } from "node:path";

const FOLDER = "n8nctl-cli";

/**
 * The folder that holds this CLI's settings and, where the keychain cannot be
 * used, its credentials file. Windows uses %APPDATA%. Everything else uses the
 * XDG location, which is also where people look for a CLI's settings on macOS.
 */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), FOLDER);
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), FOLDER);
}

export function settingsFilePath(): string {
  return process.env.N8NCTL_CLI_CONFIG_FILE || join(configDir(), "config.json");
}
