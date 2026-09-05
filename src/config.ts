import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Everything that decides *which* CloudKit container/environment this
 * server talks to, and where the two tokens live, resolved in one place.
 *
 * `scripts/config.mjs` is the plain-JS twin of this file, used by
 * `setup.sh`, `refresh-tokens.sh` and `npm run doctor` (which have to run
 * before a build exists, so they can't import from `dist/`). If you change
 * the resolution order or the default here, change it there too - the whole
 * point is that the server and the scripts never disagree about which
 * environment they're pointed at.
 */

export const CONFIG_DIR = process.env.GYMTIMER_CONFIG_DIR ?? path.join(homedir(), ".config", "gymtimer");

export const API_TOKEN_PATH = process.env.GYMTIMER_CK_API_TOKEN_PATH ?? path.join(CONFIG_DIR, "ck-api-token");

export const WEB_AUTH_TOKEN_PATH =
  process.env.GYMTIMER_CK_WEB_AUTH_TOKEN_PATH ?? path.join(CONFIG_DIR, "ck-web-auth-token");

export const ENVIRONMENT_PATH = path.join(CONFIG_DIR, "environment");

export const CONTAINER_ID = process.env.GYMTIMER_CONTAINER_ID ?? "iCloud.com.elkno.gymtimer.gymtimer";

/**
 * `production` is the default because that's where anyone who installed
 * GymTimer from TestFlight or the App Store syncs. `development` only holds
 * data for builds run from Xcode by the app's own developer.
 */
export const DEFAULT_ENVIRONMENT = "production";

/**
 * Resolution order, most explicit first:
 *
 * 1. `GYMTIMER_CK_ENVIRONMENT` - what an MCP client's `env` block sets.
 * 2. `~/.config/gymtimer/environment` - what `setup.sh` writes, so the
 *    scripts pick the same environment the server uses even when they're
 *    launched from a plain shell with no env block.
 * 3. `DEFAULT_ENVIRONMENT`.
 */
export function resolveEnvironment(): string {
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
