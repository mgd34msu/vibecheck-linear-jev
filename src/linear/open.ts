// Choosing the LinearApi the runtime talks to.
//
// Normally GraphqlLinearApi with the user's personal key, found in this
// order: the environment variable named by
// `linear.apiKeyEnv` (LINEAR_API_KEY), then `linear.apiKeyFile`, then the
// interactive shell's environment. The key's value never appears in a message.
//
// For tests only, VIBECHECK_LINEAR_JEV_LINEAR_BACKEND=memory selects
// FileMemoryLinearApi on the JSON file named by VIBECHECK_LINEAR_JEV_MEMORY_FILE,
// so every process of a test run shares one fake workspace with no network.
// The memory backend is refused unless both variables are set.

import type { LinearConfig } from "../jev/config.js";
import { findKeySync, type KeyEnvironment } from "../keys.js";
import { expandHome } from "../paths.js";
import type { LinearApi } from "./api.js";
import { GraphqlLinearApi } from "./graphql.js";
import { FileMemoryLinearApi } from "./memory-file.js";

export const LINEAR_BACKEND_ENV = "VIBECHECK_LINEAR_JEV_LINEAR_BACKEND";
export const MEMORY_FILE_ENV = "VIBECHECK_LINEAR_JEV_MEMORY_FILE";
export const DEFAULT_KEY_ENV = "LINEAR_API_KEY";

export type OpenedLinear =
  | {
      readonly api: LinearApi;
      readonly from: "memory" | "env" | "file" | "shell";
    }
  | { readonly api: undefined; readonly reason: string };

/**
 * The LinearApi for this process, or why there is none. Throws when the
 * environment asks for a backend this build does not have, or for the memory
 * backend without its file.
 */
export function openLinear(
  config: LinearConfig | undefined,
  env: KeyEnvironment = process.env,
): OpenedLinear {
  const backend = env[LINEAR_BACKEND_ENV]?.trim() ?? "";
  if (backend !== "") {
    if (backend !== "memory")
      throw new Error(
        `${LINEAR_BACKEND_ENV} must be "memory" or unset, not "${backend}".`,
      );
    const file = env[MEMORY_FILE_ENV]?.trim() ?? "";
    if (file === "")
      throw new Error(
        `${LINEAR_BACKEND_ENV}=memory is for tests and needs ${MEMORY_FILE_ENV} to name the workspace file.`,
      );
    return { api: new FileMemoryLinearApi(expandHome(file)), from: "memory" };
  }
  const envName = config?.apiKeyEnv ?? DEFAULT_KEY_ENV;
  const file =
    config?.apiKeyFile === undefined || config.apiKeyFile === null
      ? undefined
      : expandHome(config.apiKeyFile);
  const found = findKeySync({ envName, file, env });
  if (found.value === undefined)
    return {
      api: undefined,
      reason: `no Linear API key found (tried ${found.tried.join("; ")})`,
    };
  return {
    api: new GraphqlLinearApi({ apiKey: found.value }),
    from: found.from,
  };
}
