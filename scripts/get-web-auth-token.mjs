#!/usr/bin/env node
// One-time (or whenever it expires) helper to obtain a real CloudKit Web
// Services `ckWebAuthToken` via the interactive browser sign-in redirect
// flow, and save it locally for ckWebService.ts to use. This is a
// *different* credential than cktool's "User Token" - CloudKit Web
// Services' classic REST auth flow doesn't accept that one.
//
// Usage: node scripts/get-web-auth-token.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { API_TOKEN_PATH, CONTAINER_ID, ENVIRONMENT, WEB_AUTH_TOKEN_PATH } from "./config.mjs";

let apiToken;
try {
  apiToken = readFileSync(API_TOKEN_PATH, "utf-8").trim();
} catch {
  console.error(`Could not read the CloudKit API token from ${API_TOKEN_PATH}.`);
  console.error("Run ./setup.sh first - it asks for that token and saves it there.");
  process.exit(1);
}

console.log(`Signing in for the "${ENVIRONMENT}" CloudKit environment.\n`);

const checkUrl =
  `https://api.apple-cloudkit.com/database/1/${encodeURIComponent(CONTAINER_ID)}/${ENVIRONMENT}/private/users/current` +
  `?ckAPIToken=${encodeURIComponent(apiToken)}`;

const response = await fetch(checkUrl);
const body = await response.json();

if (!body.redirectURL) {
  console.error("Expected an AUTHENTICATION_REQUIRED response with a redirectURL, got:");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log("1. Open this URL in your browser and sign in with the same Apple ID as your iPhone/Watch:\n");
console.log(body.redirectURL);
console.log(
  "\n2. After signing in, Apple will redirect you somewhere (it may 404 - that's fine).\n" +
    "   Copy the FULL final URL from your browser's address bar (it contains ckWebAuthToken=...).\n"
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pastedUrl = await rl.question("3. Paste that full URL here, then press Enter: ");
rl.close();

let token;
try {
  const parsed = new URL(pastedUrl.trim());
  token = parsed.searchParams.get("ckWebAuthToken");
} catch {
  // not a URL - maybe they pasted just the token value itself
  token = pastedUrl.trim();
}

if (!token) {
  console.error("Could not find a ckWebAuthToken value in what you pasted.");
  process.exit(1);
}

mkdirSync(path.dirname(WEB_AUTH_TOKEN_PATH), { recursive: true });
writeFileSync(WEB_AUTH_TOKEN_PATH, token, { mode: 0o600 });
console.log(`\nSaved to ${WEB_AUTH_TOKEN_PATH}`);
