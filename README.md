# GymTimer MCP Server

Connect your real workout data to an AI assistant. This lets you ask Cursor,
Claude, or any other AI app questions about your actual training - and have it
write plans back into the GymTimer app on your iPhone and Apple Watch.

Things you can say once it's running:

- *"Show my last 7 days of training."*
- *"Which muscle groups have I been neglecting?"*
- *"Build me a push day based on my history and preferences, then save it as a template."*
- *"Generate a week of meals for my calorie and protein targets, with Spanish recipes."*

[**PROMPTS.md**](PROMPTS.md) has longer, ready-to-paste prompts for generating
a full training week and a full nutrition week.

It works with whichever AI model you already use - the server only supplies
your data, and all the thinking happens in the model you've chosen.

---

## First, what is an MCP server?

MCP (Model Context Protocol) is a standard way to give an AI assistant access
to tools. An MCP "server" is just a small program that runs on your own
computer and offers a list of things the assistant can do - here, 21 tools like
"read my workout history" and "save a workout template".

You don't run it yourself or leave it running. Your AI app starts it in the
background whenever it needs it. Nothing is hosted anywhere, and your data
never passes through anyone else's server.

So the install below is really just two things: put this program on your
computer, then tell your AI app where to find it.

---

## Before you start

You need three things:

1. **Node.js 18 or newer.** Check with `node --version`. If that command isn't
   found, install it from [nodejs.org](https://nodejs.org) (or `brew install node`).
2. **The GymTimer app**, on an iPhone or Apple Watch signed into iCloud, with
   at least one workout logged. Your data lives in your own private iCloud
   (CloudKit) storage; this server reads it from there.
3. **A CloudKit API token**, which you get from whoever owns the GymTimer app.

That third one confuses people, so to be clear: the API token only identifies
*the app* to Apple. It is not a password and it does not grant access to
anyone's workouts, so the owner can safely give the same token to everybody.
What scopes things to *you* is a separate Apple ID sign-in during setup. If you
don't have a token yet, ask the app owner before continuing.

---

## Install (once per computer)

```bash
git clone https://github.com/elkno/gymtimer-mcp-server.git
cd gymtimer-mcp-server
./setup.sh
```

`./setup.sh` walks through six steps and asks you three questions:

| It asks | What to answer |
| --- | --- |
| Paste the CloudKit API token | The token from the app owner. Nothing appears as you type - that's intentional, just paste and press Enter. |
| production or development? | **production** if you installed GymTimer from TestFlight or the App Store (almost everyone). **development** only if you build the app from Xcode yourself. |
| Sign in with your Apple ID | It prints a URL. Open it, sign in with the *same* Apple ID as your iPhone and Watch, then copy the entire URL you land on afterwards and paste it back. That page may show an error or a blank page - it doesn't matter, the address bar is what's needed. |

Along the way it installs dependencies, builds the server, registers it with
Cursor, and finishes with a health check. Your answers are saved under
`~/.config/gymtimer/`, so you never repeat this.

Using something other than Cursor? See [**CLIENT-SETUP.md**](CLIENT-SETUP.md) -
it has copy-paste configuration for Claude Code, Claude Desktop, VS Code,
Windsurf and Zed. For Claude Code it's a single command.

---

## Check that it worked

```bash
npm run doctor
```

This checks everything in order - Node version, build, both tokens, which
CloudKit environment you're pointed at - and then actually calls CloudKit and
reads one record back. Every failure comes with the exact command that fixes
it, so start here whenever something seems off:

```
GymTimer MCP server - health check

Runtime
  ok    Node.js v22.11.0

Build
  ok    dist/index.js exists - /Users/you/gymtimer-mcp-server/dist/index.js

Tokens
  ok    API token - 64 chars
  ok    Web auth token - 1091 chars

Environment
  ok    CloudKit environment: production - from ~/.config/gymtimer/environment
  ok    Container: iCloud.com.elkno.gymtimer.gymtimer

CloudKit connection
  ok    Signed in to CloudKit
  ok    Read your GymTimer data - found exercises in the "production" environment

All checks passed. Ask your assistant: "show my last 7 days of training".
```

Then restart your AI app and ask it *"show my last 7 days of training"*. If it
answers with real workouts, you're done.

---

## When it stops working: refreshing your token

This is the one bit of routine maintenance, and it will happen every few weeks.

You have two tokens, and **only one of them expires**:

| Token | What it does | Expires? |
| --- | --- | --- |
| API token | Identifies the GymTimer app to Apple | No, effectively permanent |
| Web auth token | Proves *you* are you, from your Apple ID sign-in | **Yes, every few weeks** |

When the web auth token expires, tools stop working and your assistant shows an
error containing:

```
CloudKit ... authentication failed - your web auth token has likely expired
```

The fix takes about a minute:

```bash
cd gymtimer-mcp-server
./refresh-tokens.sh
```

It reopens the same Apple ID sign-in from installation - paste the URL back the
same way. Then **restart your AI app** so it reconnects:

- **Cursor** - restart it, or click the refresh icon in Settings -> MCP
- **Claude Code** - run `/mcp`
- **Claude Desktop** - fully quit and reopen (closing the window isn't enough)

Confirm with `npm run doctor`.

Two notes worth knowing before you go hunting for other causes:

- You almost never need `./refresh-tokens.sh --api-token`. That replaces the
  *app* token and is only for when the owner issues a new one.
- **A wrong environment looks exactly like an expired token.** If refreshing
  didn't help, you may be pointed at `development` when your data is in
  `production` (or the reverse). `npm run doctor` calls this out specifically -
  it will tell you it connected fine but found no exercises there.

---

## What you can ask for

You don't have to memorise any of this - just ask for what you want in plain
language and the assistant picks the tools. [PROMPTS.md](PROMPTS.md) has
worked-out prompts if you'd rather copy something that already does the job.

**Reading your data**

| Tool | What it returns |
| --- | --- |
| `get_workout_history` | Completed sessions with their exercises and sets, over the last N days |
| `get_exercise_history` | Every set you've logged for one exercise, over time |
| `analyze_training_volume` | Sets, reps and volume totalled by muscle group or exercise |
| `get_recovery_status` | Days since each muscle group was last trained |
| `get_exercise_library` | Your exercise library, optionally filtered |
| `get_workout_templates` | Your saved templates with their full ordered exercise lists |
| `get_training_preferences` | Your whole profile: training preferences, body stats, and food preferences |
| `get_nutrition_plan` | Your active nutrition plan - the week's days, meals and recipes |

**Writing back to the app**

| Tool | What it does |
| --- | --- |
| `create_exercise` | Adds an exercise (name, muscle groups, equipment, optional photo) |
| `update_exercise` | Changes an exercise's name, muscle groups, equipment or photo |
| `delete_exercise` | Removes an exercise from your library |
| `save_workout_template` | Creates a template with an ordered exercise list, target sets/reps/rest, tempo, intensity and supersets |
| `update_workout_template` | Edits a template in place, keeping its history links. Replaces the whole exercise list, so it reads first |
| `update_workout_template_name` | Renames a template without touching its exercises |
| `delete_workout_template` | Deletes a template (your past workouts stay) |
| `save_periodization_plan` | Creates a named training block with a date range, optionally linking templates to it |
| `save_nutrition_plan` | Creates the week's nutrition plan. **Replaces your current active plan** |
| `update_nutrition_plan` | Edits the active plan's name, notes or start date only |
| `update_nutrition_day` | Rewrites one day of the active plan |
| `update_nutrition_meal` | Rewrites a single meal - the "swap Tuesday's lunch" tool |
| `delete_nutrition_plan` | Deletes the active nutrition plan |

One limitation to be aware of: a few single-choice fields (an exercise's
`category` and `movementPattern`, a cycle's `phase`) are deliberately never
written by these tools, so anything created through MCP has no value for them.
Reads return `null` in that case rather than guessing. Even where a value does
exist it's usually just the app's default, so don't rely on these two fields to
tell a push from a hinge - the exercise name and its muscle groups are the
trustworthy signal. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains why.

---

## Settings

Everything has a working default; you only need these if you want to change
something. They're set in your AI app's config (see
[CLIENT-SETUP.md](CLIENT-SETUP.md)) or as ordinary environment variables.

| Variable | Default | What it's for |
| --- | --- | --- |
| `GYMTIMER_CK_ENVIRONMENT` | `production` | Which CloudKit environment to read. Falls back to `~/.config/gymtimer/environment` (written by `setup.sh`) before this default |
| `GYMTIMER_CONTAINER_ID` | `iCloud.com.elkno.gymtimer.gymtimer` | The CloudKit container to talk to |
| `GYMTIMER_CONFIG_DIR` | `~/.config/gymtimer` | Where tokens and your environment choice are stored |
| `GYMTIMER_CK_API_TOKEN_PATH` | `<config dir>/ck-api-token` | Path to the API token file |
| `GYMTIMER_CK_WEB_AUTH_TOKEN_PATH` | `<config dir>/ck-web-auth-token` | Path to your web auth token file |

---

## Is my data private?

Yes. The API token identifies the app and grants no access to workout data by
itself. Every read and write is additionally scoped by *your* web auth token,
from your own Apple ID sign-in, so you only ever see your own private CloudKit
data - exactly like the GymTimer app does.

Sharing the API token with someone else doesn't expose your data to them, or
theirs to you. Each person signs in with their own Apple ID. Both tokens are
stored as files readable only by your user account (mode `600`), and requests
go directly from your machine to Apple.

---

## Troubleshooting

**"Authentication failed" / "token has likely expired"** - your web auth token
expired. Run `./refresh-tokens.sh`, then restart your AI app. See
[the section above](#when-it-stops-working-refreshing-your-token).

**The server shows as failed, or no tools appear** - run `npm run doctor`
first, it catches most causes. If it passes, the problem is in your AI app's
config rather than the server, so check
[CLIENT-SETUP.md's checklist](CLIENT-SETUP.md#it-says-failed-or-no-tools-appear).
The usual culprits are a missing `npm run build`, a relative path where an
absolute one is required, or an app that needs a full restart.

**It connects but finds no data** - you're almost certainly pointed at the
wrong CloudKit environment. `production` is for TestFlight and App Store
installs; `development` only holds data from builds run in Xcode.
`npm run doctor` tells you which one you're on and where that setting came from.

**A field or record type seems to be missing** - CloudKit only adds an
*optional* field to its schema once some device has actually saved a value for
it, so a brand-new field won't appear in results until you've set it at least
once in the app. If a whole record type is missing, the schema may not be
deployed to your environment yet - see
[docs/MAINTAINERS.md](docs/MAINTAINERS.md).

**Duplicate exercises in `get_exercise_library`** - if the app's exercise
seeder ran on two devices before they synced with each other, you can end up
with duplicates. Harmless for reading; tidy them up in the iPhone app.

---

## More documentation

- [CLIENT-SETUP.md](CLIENT-SETUP.md) - adding the server to Cursor, Claude Code, Claude Desktop, VS Code, Windsurf and Zed
- [PROMPTS.md](PROMPTS.md) - ready-to-paste prompts for weekly training and nutrition plans
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how it talks to CloudKit, and how SwiftData's encoded fields are decoded
- [docs/MAINTAINERS.md](docs/MAINTAINERS.md) - for the app owner: issuing API tokens and deploying schema changes

## License

MIT - see [LICENSE](LICENSE).
