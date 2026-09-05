#!/usr/bin/env node
// Adds (or updates) the "gymtimer" server entry in an MCP client config file,
// leaving any other servers and keys in it untouched. Used by setup.sh so
// nobody has to hand-edit JSON.
//
// Usage: node scripts/write-mcp-config.mjs <configPath> <entryPoint> <environment>

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { delimiter } from "node:path";

/**
 * An absolute path to `node`, because some clients (Claude Desktop most
 * notably) don't inherit a shell PATH and can't resolve a bare `node`.
 *
 * `process.execPath` is absolute but can be version-pinned - Homebrew reports
 * `/opt/homebrew/Cellar/node/25.2.1/bin/node`, which breaks on the next
 * upgrade. So prefer a stable symlink that resolves to the same binary, and
 * only fall back to execPath if none does.
 */
function stableNodePath() {
  const target = realpathSync(process.execPath);
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => path.join(dir, "node")),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node"
  ];

  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === target) return candidate;
    } catch {
      // Not present, or a broken symlink - try the next one.
    }
  }

  return process.execPath;
}

const [, , configPath, entryPoint, environment] = process.argv;
if (!configPath || !entryPoint || !environment) {
  console.error("Usage: node scripts/write-mcp-config.mjs <configPath> <entryPoint> <environment>");
  process.exit(1);
}

let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    console.error(`  ! ${configPath} exists but isn't valid JSON - leaving it alone.`);
    console.error(`    Add this entry yourself under "mcpServers" (see CLIENT-SETUP.md):`);
    console.error(`      "gymtimer": { "command": "node", "args": ["${entryPoint}"], "env": { "GYMTIMER_CK_ENVIRONMENT": "${environment}" } }`);
    process.exit(1);
  }
}

config.mcpServers ??= {};
config.mcpServers.gymtimer = {
  command: stableNodePath(),
  args: [entryPoint],
  env: { GYMTIMER_CK_ENVIRONMENT: environment }
};

mkdirSync(path.dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`  - registered "gymtimer" in ${configPath} (environment: ${environment})`);
