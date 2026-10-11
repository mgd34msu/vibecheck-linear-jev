// Where vibecheck-linear-jev keeps its files. Nothing is ever written inside the
// plugin directory: data goes under the XDG data folder and configuration
// under the XDG config folder.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Environment = Readonly<Record<string, string | undefined>>;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function xdg(
  environment: Environment,
  variable: string,
  fallback: string,
): string {
  const value = environment[variable];
  return value !== undefined &&
    value.length > 0 &&
    isAbsolute(expandHome(value))
    ? expandHome(value)
    : join(homedir(), fallback);
}

/** Folder and database settings from the config file; null or absent means the default. */
export interface DataSettings {
  readonly folder?: string | null | undefined;
  readonly database?: string | null | undefined;
}

/** The configured data folder, or $XDG_DATA_HOME/vibecheck-linear-jev, or ~/.local/share/vibecheck-linear-jev. */
export function dataDirectory(
  environment: Environment = process.env,
  settings: DataSettings = {},
): string {
  if (settings.folder !== undefined && settings.folder !== null)
    return expandHome(settings.folder);
  return join(
    xdg(environment, "XDG_DATA_HOME", ".local/share"),
    "vibecheck-linear-jev",
  );
}

/** $XDG_CONFIG_HOME/vibecheck-linear-jev, or ~/.config/vibecheck-linear-jev. */
export function configDirectory(
  environment: Environment = process.env,
): string {
  return join(
    xdg(environment, "XDG_CONFIG_HOME", ".config"),
    "vibecheck-linear-jev",
  );
}

/** VIBECHECK_LINEAR_JEV_DB, else the configured database, else the local store (state.sqlite3) in the data folder. */
export function defaultDatabase(
  environment: Environment = process.env,
  settings: DataSettings = {},
): string {
  const configured = environment["VIBECHECK_LINEAR_JEV_DB"];
  if (configured !== undefined && configured.length > 0)
    return expandHome(configured);
  if (settings.database !== undefined && settings.database !== null)
    return expandHome(settings.database);
  return stateDatabasePath(environment, settings);
}

/** ~/.gemini/antigravity-cli/brain: where Antigravity keeps conversation stores. */
export function antigravityBrainDir(
  environment: Environment = process.env,
): string {
  const home = environment["HOME"];
  return join(
    home !== undefined && home.length > 0 ? home : homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
  );
}

/** $XDG_DATA_HOME/muse/sessions, or ~/.local/share/muse/sessions: where Muse keeps session logs. */
export function museSessionsDir(
  environment: Environment = process.env,
): string {
  return join(
    xdg(environment, "XDG_DATA_HOME", ".local/share"),
    "muse",
    "sessions",
  );
}

/** VIBECHECK_LINEAR_JEV_CONFIG, or config.jsonc in the config folder. */
export function configFile(environment: Environment = process.env): string {
  const configured = environment["VIBECHECK_LINEAR_JEV_CONFIG"];
  return configured !== undefined && configured.length > 0
    ? expandHome(configured)
    : join(configDirectory(environment), "config.jsonc");
}

/** Where `laya install` puts the Laya runtime and its native dependency. */
export function layaDirectory(
  environment: Environment = process.env,
  settings: DataSettings = {},
): string {
  return join(dataDirectory(environment, settings), "laya");
}

/** state.sqlite3 in the data folder: the local store beside Linear (src/local/store.ts). */
export function stateDatabasePath(
  environment: Environment = process.env,
  settings: DataSettings = {},
): string {
  return join(dataDirectory(environment, settings), "state.sqlite3");
}
