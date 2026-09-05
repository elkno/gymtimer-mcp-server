#!/usr/bin/env node
// Health check for the GymTimer MCP server: `npm run doctor`.
//
// Every check prints either "ok" or a plain-English fix, so a broken setup
// tells you what to do instead of surfacing a raw CloudKit error inside your
// AI client. The most common failure by far is an expired web auth token,
// which this reports as "run ./refresh-tokens.sh".

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_TOKEN_PATH,
  CONFIG_DIR,
  CONTAINER_ID,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT,
  ENVIRONMENT_PATH,
  WEB_AUTH_TOKEN_PATH
} from "./config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function ok(label, detail) {
  console.log(`  ok    ${label}${detail ? ` - ${detail}` : ""}`);
}

function fail(label, fix) {
  console.log(`  FAIL  ${label}`);
  console.log(`        -> ${fix}`);
  problems.push(label);
}

function warn(label, detail) {
  console.log(`  warn  ${label}`);
  console.log(`        -> ${detail}`);
}

console.log("\nGymTimer MCP server - health check\n");

// ---------------------------------------------------------------- 1. Node
console.log("Runtime");
const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) {
  ok(`Node.js ${process.version}`);
} else {
  fail(
    `Node.js ${process.version} is too old (18+ required)`,
    "Install a newer Node from https://nodejs.org, or run: brew upgrade node"
  );
}

// ---------------------------------------------------------------- 2. Build
console.log("\nBuild");
const entryPoint = path.join(ROOT, "dist", "index.js");
if (existsSync(entryPoint)) {
  ok("dist/index.js exists", entryPoint);
} else {
  fail("dist/index.js is missing - your MCP client has nothing to launch", "Run: npm install && npm run build");
}

// --------------------------------------------------------------- 3. Tokens
console.log("\nTokens");

function checkTokenFile(label, filePath, { hexLike = false } = {}) {
  if (!existsSync(filePath)) {
    fail(`${label} is missing (${filePath})`, "Run ./setup.sh - it walks you through both tokens");
    return null;
  }

  const value = readFileSync(filePath, "utf-8").trim();
  if (value.length === 0) {
    fail(`${label} is empty (${filePath})`, "Run ./setup.sh again to re-enter it");
    return null;
  }

  if (hexLike && !/^[0-9a-fA-F]{40,}$/.test(value)) {
    warn(
      `${label} doesn't look like a CloudKit API token`,
      "It should be a long hex string. Make sure you weren't given the User or Management token by mistake."
    );
  } else {
    ok(label, `${value.length} chars`);
  }

  // 0600 keeps a credential out of reach of other accounts on the machine.
  const mode = statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    warn(
      `${label} is readable by others (mode ${mode.toString(8)})`,
      `Tighten it with: chmod 600 ${filePath}`
    );
  }

  return value;
}

const apiToken = checkTokenFile("API token", API_TOKEN_PATH, { hexLike: true });
const webAuthToken = checkTokenFile("Web auth token", WEB_AUTH_TOKEN_PATH);

// ---------------------------------------------------------- 4. Environment
console.log("\nEnvironment");
let source;
if (process.env.GYMTIMER_CK_ENVIRONMENT?.trim()) {
  source = "GYMTIMER_CK_ENVIRONMENT (set by your MCP client or shell)";
} else if (existsSync(ENVIRONMENT_PATH)) {
  source = ENVIRONMENT_PATH;
} else {
  source = `built-in default (${DEFAULT_ENVIRONMENT})`;
}

if (ENVIRONMENT === "production" || ENVIRONMENT === "development") {
  ok(`CloudKit environment: ${ENVIRONMENT}`, `from ${source}`);
} else {
  fail(
    `CloudKit environment "${ENVIRONMENT}" is not valid`,
    'It must be exactly "production" or "development". Fix it in your MCP client config or in ' + ENVIRONMENT_PATH
  );
}
ok(`Container: ${CONTAINER_ID}`);
ok(`Config directory: ${CONFIG_DIR}`);

// --------------------------------------------------- 5. Live CloudKit call
console.log("\nCloudKit connection");
if (!apiToken || !webAuthToken) {
  fail("Skipped the live check because a token is missing", "Fix the token problems above, then run npm run doctor again");
} else {
  const base = `https://api.apple-cloudkit.com/database/1/${encodeURIComponent(CONTAINER_ID)}/${ENVIRONMENT}/private`;
  const auth = `ckAPIToken=${encodeURIComponent(apiToken)}&ckWebAuthToken=${encodeURIComponent(webAuthToken)}`;

  // 5a. Who am I? This is the call that fails first when a token expires.
  let authenticated = false;
  try {
    const response = await fetch(`${base}/users/current?${auth}`);
    const body = await response.json().catch(() => ({}));

    if (response.ok && !body.redirectURL) {
      authenticated = true;
      ok("Signed in to CloudKit", body.userRecordName ? `user record ${body.userRecordName}` : "users/current accepted");
    } else if (body.redirectURL || response.status === 401 || body.serverErrorCode === "AUTHENTICATION_REQUIRED") {
      fail(
        "Your web auth token has expired (CloudKit wants a fresh sign-in)",
        "Run ./refresh-tokens.sh - it opens an Apple ID sign-in and takes about a minute. Then restart your MCP client."
      );
    } else {
      fail(
        `CloudKit rejected the request (HTTP ${response.status}: ${body.reason ?? "no reason given"})`,
        `Check that the API token is valid for the "${ENVIRONMENT}" environment, then run ./refresh-tokens.sh --api-token if the owner issued a new one`
      );
    }
  } catch (error) {
    fail(`Could not reach api.apple-cloudkit.com (${error.message})`, "Check your internet connection, VPN, or proxy and try again");
  }

  // 5b. Can we actually read the app's data in this environment? A valid
  //     token pointed at the wrong environment gets past 5a but finds
  //     nothing here, which is the confusing case worth naming explicitly.
  if (authenticated) {
    try {
      const response = await fetch(`${base}/records/query?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zoneID: { zoneName: "com.apple.coredata.cloudkit.zone" },
          query: {
            recordType: "CD_Exercise",
            filterBy: [{ fieldName: "CD_entityName", comparator: "EQUALS", fieldValue: { value: "Exercise", type: "STRING" } }]
          },
          resultsLimit: 1
        })
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        fail(
          `Test query failed (HTTP ${response.status}: ${body.reason ?? "no reason given"})`,
          `If it mentions an unknown record type, the CloudKit schema hasn't been deployed to "${ENVIRONMENT}" yet - see docs/MAINTAINERS.md`
        );
      } else if ((body.records ?? []).length > 0) {
        ok("Read your GymTimer data", `found exercises in the "${ENVIRONMENT}" environment`);
      } else {
        warn(
          `Connected, but the "${ENVIRONMENT}" environment has no exercises in it`,
          ENVIRONMENT === "production"
            ? "If you run GymTimer from Xcode rather than TestFlight/App Store, your data is in development instead - see CLIENT-SETUP.md"
            : "If you installed GymTimer from TestFlight or the App Store, your data is in production instead - see CLIENT-SETUP.md"
        );
      }
    } catch (error) {
      fail(`Test query could not reach CloudKit (${error.message})`, "Check your internet connection and try again");
    }
  }
}

// ---------------------------------------------------------------- Summary
console.log("");
if (problems.length === 0) {
  console.log("All checks passed. Ask your assistant: \"show my last 7 days of training\".\n");
  process.exit(0);
}

console.log(`${problems.length} problem(s) found - see the "->" lines above for the fix.`);
console.log("Still stuck? README.md has a troubleshooting section.\n");
process.exit(1);
