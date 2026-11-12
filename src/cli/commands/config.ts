import pc from "picocolors";
import { getConfigPath } from "../../config.js";
import { loadSettings, setSetting, unsetSetting } from "../../settings.js";
import { reporter } from "../output.js";

type Opts = { json?: boolean };

export async function configPath(opts: Opts = {}): Promise<void> {
  const path = getConfigPath();
  reporter(opts).result({ path }, path);
}

/** Print the validated settings. An invalid file fails here with the reason. */
export async function configShow(opts: Opts = {}): Promise<void> {
  const settings = loadSettings();
  const body = JSON.stringify(settings, null, 2);
  reporter(opts).result({ path: getConfigPath(), settings }, `${pc.dim(getConfigPath())}\n${body}`);
}

/** Set one setting, so nobody has to edit or copy the file by hand. */
export async function configSet(name: string, value: string, opts: Opts = {}): Promise<void> {
  const settings = setSetting(name, value);
  reporter(opts).result({ path: getConfigPath(), name, settings }, `${pc.green("Set")} ${name}.`);
}

export async function configUnset(name: string, opts: Opts = {}): Promise<void> {
  const removed = unsetSetting(name);
  reporter(opts).result(
    { path: getConfigPath(), name, removed },
    removed ? `${pc.green("Removed")} ${name}.` : pc.dim(`${name} was not set.`)
  );
}
