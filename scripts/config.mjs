// Plain-JS twin of `src/config.ts`, for the scripts that have to run before
// (or without) a build: setup.sh, refresh-tokens.sh and `npm run doctor`.
// Keep the resolution order and the default in sync with that file - the
// point of having this at all is that a token refresh can never be minted
// for a different CloudKit environment than the one the server queries.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_DIR = process.env.GYMTIMER_CONFIG_DIR ?? path.join(homedir(), ".config", "gymtimer");

export const API_TOKEN_PATH = process.env.GYMTIMER_CK_API_TOKEN_PATH ?? path.join(CONFIG_DIR, "ck-api-token");

export const WEB_AUTH_TOKEN_PATH =
  process.env.GYMTIMER_CK_WEB_AUTH_TOKEN_PATH ?? path.join(CONFIG_DIR, "ck-web-auth-token");

export const ENVIRONMENT_PATH = path.join(CONFIG_DIR, "environment");

export const CONTAINER_ID = process.env.GYMTIMER_CONTAINER_ID ?? "iCloud.com.elkno.gymtimer.gymtimer";

export const DEFAULT_ENVIRONMENT = "production";

export function resolveEnvironment() {
  const fromEnv = process.env.GYMTIMER_CK_ENVIRONMENT?.trim();
  if (fromEnv) return fromEnv;

  try {
    const fromFile = readFileSync(ENVIRONMENT_PATH, "utf-8").trim();
    if (fromFile) return fromFile;
  } catch {
    // No saved choice - fall through to the default.
  }

  return DEFAULT_ENVIRONMENT;
}

export const ENVIRONMENT = resolveEnvironment();
