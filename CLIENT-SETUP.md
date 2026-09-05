# Adding this server to your AI app

`./setup.sh` already registers the server with Cursor. This guide covers every
other app, and explains what that configuration actually is so you can adapt it
to anything.

Before you start, make sure you've run `./setup.sh` (or at least
`npm install && npm run build`), so `dist/index.js` exists. Nothing here works
without it.

## The one config block

Almost every AI app configures MCP servers with the same three fields, just in
a different file:

```json
{
  "mcpServers": {
    "gymtimer": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOU/gymtimer-mcp-server/dist/index.js"],
      "env": { "GYMTIMER_CK_ENVIRONMENT": "production" }
    }
  }
}
```

That's it: `command` is how to run Node, `args` points at this server, and `env`
says which CloudKit environment your data is in.

Two rules that cause most of the trouble people hit:

- **Use absolute paths, in both fields.** `~` is not expanded, and a bare
  `node` fails in apps that don't inherit your shell's `PATH` (Claude Desktop
  in particular). Get your real values with:

  ```bash
  which node                      # -> use this for "command"
  echo "$PWD/dist/index.js"       # run from this folder -> use this for "args"
  ```

- **`production` or `development`?** `production` if you installed GymTimer
  from TestFlight or the App Store, `development` only if you build it from
  Xcode yourself. Run `npm run doctor` if you're unsure - it reports which one
  you're currently pointed at and whether it found data there.

---

## Cursor

Two choices of scope:

- **Every project** - `~/.cursor/mcp.json`. This is what `./setup.sh` writes.
- **One project only** - `.cursor/mcp.json` inside that project folder.

Paste the block above into either file. Or skip the file entirely and use
**Cursor Settings -> MCP -> Add new MCP Server**, with type `stdio`. That
dialog has no field for environment variables, so if you need
`development` you'll have to edit `~/.cursor/mcp.json` afterwards and add the
`env` block by hand.

**Confirm it worked:** restart Cursor, open Settings -> MCP, and look for
`gymtimer` with a green dot and 21 tools listed.

## Claude Code

One command, from anywhere:

```bash
claude mcp add gymtimer -e GYMTIMER_CK_ENVIRONMENT=production -- node ~/gymtimer-mcp-server/dist/index.js
```

By default that registers the server at **local** scope: only you, only in the
project you ran it from. Add `--scope user` to make it available in every
project, or `--scope project` to write a committable `.mcp.json` at the repo
root - though that last one isn't much use here, since the tokens are personal
to each Apple ID anyway.

**Confirm it worked:** run `/mcp` inside Claude Code, or `claude mcp list` in a
terminal.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows), and paste the block
above. You can also reach the file via **Settings -> Developer -> Edit Config**.

Two things specific to this app, and they account for nearly every "it just
won't connect" report:

1. **`command` must be an absolute path** like `/opt/homebrew/bin/node`. Claude
   Desktop is launched by macOS, not by your shell, so it has no idea where
   `node` is. Run `which node` and paste the result.
2. **Fully quit and reopen the app** - Cmd+Q, not just closing the window.
   Config is only read at launch.

**Confirm it worked:** the tools icon in the message box should list the
GymTimer tools.

## VS Code (GitHub Copilot agent mode)

Either create `.mcp.json` in your workspace root, or run **MCP: Open User
Configuration** from the Command Palette for a global setup. VS Code nests the
same entry under a `servers` key instead of `mcpServers`:

```json
{
  "servers": {
    "gymtimer": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/YOU/gymtimer-mcp-server/dist/index.js"],
      "env": { "GYMTIMER_CK_ENVIRONMENT": "production" }
    }
  }
}
```

**Confirm it worked:** open the Chat view in Agent mode and check the tools
picker for the GymTimer tools.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` and paste the standard block, then
hit refresh in the Cascade MCP panel.

## Zed

Zed calls these "context servers". In `settings.json` (**zed: open settings**):

```json
{
  "context_servers": {
    "gymtimer": {
      "command": {
        "path": "/opt/homebrew/bin/node",
        "args": ["/Users/YOU/gymtimer-mcp-server/dist/index.js"],
        "env": { "GYMTIMER_CK_ENVIRONMENT": "production" }
      }
    }
  }
}
```

## Any other MCP client

Any app that speaks MCP over stdio can run this server. Whatever the config
format, you're supplying the same three things:

- **command**: the absolute path to your `node` binary
- **arguments**: the absolute path to `dist/index.js` in this folder
- **environment**: `GYMTIMER_CK_ENVIRONMENT` set to `production` or `development`

You can sanity-check the server outside any client with `npm start`. It will sit
there waiting for MCP messages on stdin, which is exactly right - press Ctrl-C
to exit. A crash or an immediate error means the problem is the server, not
your client config, so run `npm run doctor`.

---

## It says failed, or no tools appear

Work down this list:

1. **Run `npm run doctor`.** It checks the build, both tokens, and a real
   CloudKit call. Most problems are one of those, and it prints the fix.
2. **Did you build it?** `dist/index.js` must exist - run `npm run build`.
3. **Are both paths absolute?** No `~`, no bare `node`, no relative paths.
4. **Did the app fully restart?** Claude Desktop needs Cmd+Q; Cursor needs a
   restart or the refresh icon in Settings -> MCP; Claude Code needs `/mcp`.
5. **Is your JSON valid?** A trailing comma or missing brace makes the app skip
   the file silently. Check with
   `node -e 'JSON.parse(require("fs").readFileSync("PATH","utf8"))'`.
6. **Still failing?** Check your app's MCP logs. Claude Desktop keeps them in
   `~/Library/Logs/Claude/`; Cursor shows them in the MCP settings panel.

If tools *do* appear but every call errors, that's a token or environment
problem rather than a config one - see
[README.md's refreshing section](README.md#when-it-stops-working-refreshing-your-token).
