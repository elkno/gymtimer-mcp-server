# For the app owner

Two tasks that only the owner of the `iCloud.com.elkno.gymtimer.gymtimer`
CloudKit container can do. Everything else in this repo is self-serve and needs
neither Xcode nor CloudKit Console.

## Issuing the API token

Each person who wants to run this server needs the shared CloudKit Web Services
API token. Generate it once and hand out the same value - the step-by-step
click path is in
[README.md's "Creating the API token"](../README.md#creating-the-api-token-app-owner-only).

The three things that actually matter, since they're the ones that go wrong:

- **The console's environment selector must be on `Production`** when you create
  it, because that's where TestFlight and App Store installs sync and what this
  server defaults to.
- **Sign in Callback must be `URL Redirect`**, not `Post Message`. The whole
  sign-in flow depends on Apple redirecting the browser to a URL carrying
  `ckWebAuthToken`, which `scripts/get-web-auth-token.mjs` then parses. Any
  https URL works and it's fine if it 404s.
- **Hand out the API Access token, not the User Token or Management Token.**
  Neither of those works with this REST flow. `refresh-tokens.sh --api-token`
  validates the shape, which catches the mistake.

The token identifies the app only. It grants no access to anyone's workout data,
since every read and write is additionally scoped by the recipient's own Apple
ID sign-in - so the same value can go to everybody.

This is the only CloudKit Console step anyone needs for normal use.

## Deploying schema changes

Only relevant if you're actively developing GymTimer and have added a brand-new
SwiftData model or relationship that no device has ever synced. CloudKit won't
have that record type in its schema yet, so MCP write tools targeting it fail.

This is the one place in the project that still needs `cktool` (bundled with
Xcode) and a Management Token:

```bash
xcrun cktool export-schema    # inspect the current deployed schema
# hand-edit the exported file to add the new record type/field
xcrun cktool validate-schema
xcrun cktool import-schema    # deploys to development
```

That mirrors what a real device's first sync would eventually do, just done ahead
of time so the write tools can target it immediately.

If your users are on `production`, also run **Deploy Schema Changes: Development
to Production** from CloudKit Console afterwards.

Everything the current tools write has already been deployed. This only comes up
again for a genuinely new model or relationship.

### Optional attributes are different

You don't need any of the above for a new *optional* attribute on an existing
record type. CloudKit extends the schema for those automatically, but only once
some device actually syncs a non-nil value, so a new optional field won't appear
in query results until it's been set at least once from the app. This is the
usual explanation for "the field exists in Swift but MCP never returns it".

## Two environments

CloudKit keeps `development` and `production` data completely separate:

- **`development`** - builds run from Xcode on your dev team's devices.
- **`production`** - TestFlight and App Store installs. This is the default the
  server assumes, since it's what everyone you share with will be on.

Before pointing anyone at `production`, confirm the schema has been deployed
there, or their writes will fail on record types that only exist in development.
Container API tokens generally cover both environments; a single read tool call,
or `npm run doctor`, confirms it.

## Releasing a change to this server

There's no publish step - people run it from a clone. After merging a change:

1. `npm run build` must pass. CI runs it on Node 18, 20 and 22 for every push
   and pull request.
2. If you changed a tool's name or input schema, tell users to restart their AI
   app. Clients cache the tool list at connection time, and a stale cache shows
   up as a tool that "exists" but rejects valid arguments.
3. Users update with `git pull && npm install && npm run build`. The `prepare`
   script means `npm install` alone also rebuilds.
