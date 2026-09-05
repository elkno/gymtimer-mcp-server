# Architecture

How this server reaches your workout data, and the two non-obvious encoding
problems it has to solve. You don't need any of this to use the server - see
[README.md](../README.md) for that.

## The data path

```
Your AI app (any model) --MCP tools--> gymtimer-mcp-server (Node.js)
                                          |
                                          v
                     src/ckWebService.ts (records/query, records/modify, assets/upload)
                                          |
                                          v
                     CloudKit Web Services REST
                     auth: API token + your web auth token
                                          |
                                          v
                     your private CloudKit database
```

Your workout data lives on your iPhone and Watch and syncs through CloudKit's
*private* database (container `iCloud.com.elkno.gymtimer.gymtimer`). This server
talks straight to CloudKit Web Services' classic REST API
(`api.apple-cloudkit.com`), authenticated the same way CloudKit JS authenticates
a browser session.

Two earlier approaches were abandoned to get here, which explains why it looks
the way it does:

- A **signed macOS companion app** joining the CloudKit sync engine as a
  "device" hit an unresolvable device/zone-sync deadlock.
- **Apple's `cktool`** requires Xcode plus CloudKit Console access to the
  specific container, so only the container's owner could ever have run it.

The REST path needs neither. All anyone needs is the shared API token and their
own Apple ID, which is what makes the server distributable at all.

## Authentication

Every call carries two credentials, both read from files by
[`src/ckWebService.ts`](../src/ckWebService.ts) via
[`src/config.ts`](../src/config.ts):

| Token | Purpose | Scope |
| --- | --- | --- |
| API token | Identifies the app to CloudKit Web Services | The whole container, no data access on its own |
| Web auth token | Authenticates a person | That person's private database only |

Neither requires Apple Developer Program membership or CloudKit Console access.
The web auth token comes from an interactive browser sign-in redirect
([`scripts/get-web-auth-token.mjs`](../scripts/get-web-auth-token.mjs)) and is
session-length, which is why it periodically expires.

`src/config.ts` and `scripts/config.mjs` are deliberate twins: the TypeScript
one is what the server uses, the plain-JS one is what `setup.sh`,
`refresh-tokens.sh` and `npm run doctor` use, since those must run before a
build exists. They resolve the CloudKit environment identically -
`GYMTIMER_CK_ENVIRONMENT`, then `~/.config/gymtimer/environment`, then
`production` - so a token refresh can never target a different environment than
the server queries. Keep them in sync if you change either.

## Reading SwiftData through Core Data's CloudKit mirror

The app models are SwiftData. Core Data + CloudKit mirrors them using generated
`CD_`-prefixed record types and fields (`CD_WorkoutSession`, `CD_startDate`, and
so on), all inside one custom zone, `com.apple.coredata.cloudkit.zone`.

[`src/workoutStore.ts`](../src/workoutStore.ts) queries those record types
directly and re-creates in TypeScript the same joins and aggregations a native
SwiftData fetch would do. Queries filter on `CD_entityName` rather than
`___recordID`, which avoids needing a Queryable index on the record ID.

## Decoding SwiftData's encoded fields

A few attributes aren't plain CloudKit strings. SwiftData boxes non-primitive
attributes as `BYTES`, in three different shapes:

**1. Arrays of raw enum strings** (for example `[MuscleGroup]`) are stored as
base64-encoded JSON arrays. Trivial to decode - see `decodeStringArrayBytes` in
[`src/ckCodec.ts`](../src/ckCodec.ts).

**2. Single custom enums** (for example `ExerciseCategory`) are boxed as a full
`NSKeyedArchiver` binary plist. Rather than reimplement that format,
`decodeSingleEnumBytes` decodes the payload as raw bytes and checks which of the
enum's small fixed set of known raw values appears in it. `NSKeyedArchiver`
stores short strings as literal UTF-8 with no obfuscation, so this is reliable
in practice without a full plist parser. The known values are kept in the
`*_VALUES` lists in `src/workoutStore.ts`; if you add a new custom enum field
and want it exposed, add its raw values there.

**3. `[Int]` and `[String]` attributes** (`targetRepsPerSet`,
`NutritionMeal.ingredients`) go through SwiftData's
`NSSecureUnarchiveFromData` transformer, which really is a full
`NSKeyedArchiver` binary plist of an `NSArray`.
[`src/nsKeyedArchiver.ts`](../src/nsKeyedArchiver.ts) is a from-scratch,
pure-TypeScript writer for exactly this shape, with
`decodeArchivedStringArrayBytes` in `ckCodec.ts` as the matching reader. It was
verified byte-for-byte identical to real `NSKeyedArchiver` output - captured via
a standalone `swift` script, not the app - across empty arrays, ASCII and
non-ASCII strings, zero, negative and large integers, and repeated values. The
file's header comment documents the format, including an "orphan object" quirk
in Apple's own encoder that is replicated deliberately for byte-exactness.

None of this needs Xcode or native code at runtime.

## Known limitation: single-enum fields are never written

`category`, `movementPattern`, `phase` and other single-custom-enum fields are
never set or changed by the write tools.

The reason is shape 2 above. Those fields are `NSKeyedArchiver` binary plists
whose *exact* bytes turned out to depend on the SwiftData and OS version that
wrote them. Reading them by byte-scanning is safe; writing a guessed encoding
risked the field coming back wrong on your Watch or iPhone, so it was left out
rather than risk corrupting data. New exercises and cycles get the model's
Swift-level defaults (`compound`, `push`, `hypertrophy`) until edited in the app.

Arrays (muscle groups, equipment) are unaffected, since shapes 1 and 3 are
fully understood.

Reads of these fields return `null` when the record has no value, rather than
substituting the Swift-level default. A fabricated default is indistinguishable
from a real one to whatever model consumes the output, which matters here
because these fields are close to information-free in practice: an exercise
created through MCP has no such field at all, and the app's own seeded
exercises are largely left at `compound`/`push` regardless of the movement, so
a Romanian deadlift can legitimately report `push`. Treat the exercise name and
its muscle groups as the reliable signal.

## Supersets

`save_workout_template` takes a `supersetGroup` number per exercise slot. Give
two or more **consecutive** slots the same number to make them a superset,
performed back-to-back with no rest, one round at a time, sharing the group's
round count.

This matches `WorkoutExercise.supersetID` in the app's
`Shared/WorkoutModels.swift`, which the Watch's step-based progression and the
iPhone editor and mirror views all read. The number itself is only a label to
link slots within one call: a fresh UUID is generated per distinct group and
written to the optional `CD_supersetID` `STRING` field.

A group used non-contiguously is rejected outright, because the app only merges
*consecutive* same-`supersetID` slots into one superset block.

## Exercise photos

`create_exercise` and `update_exercise` accept a `photoPath` - an absolute or
`~`-relative path to a jpg, png or heic, up to CloudKit's 15MB asset limit -
uploaded as the exercise's custom photo (`Exercise.customPhotoData`, which the
app shows instead of the default muscle-group icon). `update_exercise` also
takes `removePhoto`.

`customPhotoData` is `@Attribute(.externalStorage)`, so Core Data + CloudKit
mirrors it as its own first-class `ASSET`-typed field
(`CD_customPhotoData_ckAsset`) rather than packing bytes into
`CD_customPhotoData`, matching Apple's documented behaviour for large
attributes. Writing it is CloudKit's standard two-step asset upload:
`assets/upload` for a URL, then POST the file bytes. `createRecord` does this
automatically for new exercises given an `assetFiles` map; `update_exercise`
calls `uploadAsset()` manually, since creates and updates need different
CloudKit operations regardless.

## Names surviving deletion

`get_workout_history` and `get_exercise_history` still show the exercise or
template name for a history entry after you delete the exercise or template it
used. `CompletedExercise` and `WorkoutSession` snapshot the name on-device at
completion time (`exerciseName`, `templateName`), independent of the relationship
to the deleted record, which is `.nullify` rather than `.cascade`.

This only covers workouts completed after that on-device change shipped, because
`CD_exerciseName` and `CD_templateName` are new optional fields that Core Data +
CloudKit only starts populating once a device writes them. Older history falls
back to the live relationship lookup and shows a placeholder ("Unknown
Exercise", "Freestyle Workout") if the source record was already deleted.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | MCP server: registers all 21 tools and their input schemas |
| `src/workoutStore.ts` | All the querying, joining and aggregation logic |
| `src/ckWebService.ts` | CloudKit Web Services REST client and auth |
| `src/ckCodec.ts` | Record flattening and the `BYTES` decoders |
| `src/nsKeyedArchiver.ts` | Pure-TypeScript `NSKeyedArchiver` writer |
| `src/config.ts` | Environment, container and token-path resolution |
| `scripts/config.mjs` | Plain-JS twin of `src/config.ts`, for the scripts |
| `scripts/doctor.mjs` | `npm run doctor` health check |
| `scripts/get-web-auth-token.mjs` | Interactive Apple ID sign-in flow |
| `scripts/write-mcp-config.mjs` | Registers the server in a client's JSON config |
