import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  asNumber,
  asString,
  decodeArchivedIntArrayBytes,
  decodeArchivedStringArrayBytes,
  decodeSingleEnumBytes,
  decodeStringArrayBytes,
  encodeStringArrayBytes,
  type PlainRecord
} from "./ckCodec.js";
import { createRecord, deleteRecord, modifyRecord, queryRecords, uploadAsset } from "./ckWebService.js";
import { encodeArchivedStringArrayBytes, encodeIntArrayBytes } from "./nsKeyedArchiver.js";

// Mirrors Shared/Enums.swift - kept in sync manually since this is a tiny,
// stable, hand-maintained list (see decodeSingleEnumBytes for why this is
// enough to decode these fields reliably without a full NSKeyedArchiver
// implementation in TypeScript).
const EXERCISE_CATEGORY_VALUES = ["compound", "isolation"] as const;
const MOVEMENT_PATTERN_VALUES = ["push", "pull", "squat", "hinge", "carry", "rotation", "isometric"] as const;
const TRAINING_GOAL_VALUES = ["strength", "hypertrophy", "endurance", "general"] as const;
const EXPERIENCE_LEVEL_VALUES = ["beginner", "intermediate", "advanced"] as const;
/** Valid `PeriodicizationCycle.phase` values - not currently writable (see `savePeriodizationPlan`), kept here for documentation/future use. */
export const TRAINING_PHASE_VALUES = ["hypertrophy", "strength", "deload", "endurance"] as const;
const MUSCLE_GROUP_VALUES = [
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "abs",
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "fullBody",
  "cardio"
] as const;
const EQUIPMENT_VALUES = ["barbell", "dumbbell", "kettlebell", "machine", "cable", "bodyweight", "band", "bench", "pullUpBar", "trx", "other"] as const;

/**
 * Common synonyms/aliases a model might reach for that aren't the exact
 * `Shared/Enums.swift` raw value - normalized to the real case before
 * validation so a slightly-off-but-obvious value doesn't get hard
 * rejected. This is exactly the class of bug that caused a real crash:
 * `"core"` was written for `abs` (SwiftData throws decoding an unknown
 * raw value for a non-optional/non-array enum - the app couldn't even
 * open the Exercises list, any workout, or history entry referencing
 * that exercise until the bad value was fixed - see `client-harden`/
 * `repair-data` fix in the same change as this validation).
 */
const MUSCLE_GROUP_SYNONYMS: Record<string, string> = {
  core: "abs",
  abdominals: "abs",
  ab: "abs",
  legs: "quads",
  leg: "quads",
  hips: "glutes",
  hamstring: "hamstrings",
  glute: "glutes",
  calf: "calves",
  bicep: "biceps",
  tricep: "triceps",
  shoulder: "shoulders",
  full_body: "fullBody",
  fullbody: "fullBody"
};
const EQUIPMENT_SYNONYMS: Record<string, string> = {
  dumbbells: "dumbbell",
  barbells: "barbell",
  kettlebells: "kettlebell",
  cables: "cable",
  bands: "band",
  benches: "bench",
  pullupbar: "pullUpBar",
  pull_up_bar: "pullUpBar",
  "pull-up bar": "pullUpBar",
  none: "bodyweight",
  "suspension trainer": "trx",
  suspensiontrainer: "trx",
  "trx straps": "trx"
};

/**
 * Normalizes and validates a list of free-form strings against a fixed
 * set of valid raw enum values, applying `synonyms` first (case/whitespace
 * insensitive on the input side). Throws a single error listing every
 * invalid entry plus the full set of valid values so the calling model
 * can self-correct, rather than silently writing (or one-at-a-time
 * rejecting) a value SwiftData can't decode on-device.
 */
function normalizeAndValidate(values: string[], validValues: readonly string[], synonyms: Record<string, string>, fieldLabel: string): string[] {
  const invalid: string[] = [];
  const normalized = values.map((raw) => {
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    const candidate = synonyms[lower] ?? trimmed;
    if (!validValues.includes(candidate as (typeof validValues)[number])) {
      invalid.push(raw);
      return candidate;
    }
    return candidate;
  });
  if (invalid.length > 0) {
    throw new Error(
      `Invalid ${fieldLabel} value(s): ${invalid.map((v) => `"${v}"`).join(", ")}. Valid values are: ${validValues.join(", ")}.`
    );
  }
  return normalized;
}

interface WorkoutSessionDTO {
  id: string;
  templateName?: string;
  startDate: string;
  endDate?: string;
  totalDurationSeconds: number;
  averageHeartRate?: number;
  notes?: string;
  /** "How hard was this workout?" feedback captured on the Watch summary screen, 1 (very easy) - 5 (extremely hard). Undefined for sessions recorded before this field existed. */
  difficultyRating?: number;
  exercises: CompletedExerciseDTO[];
}

interface CompletedExerciseDTO {
  exerciseName: string;
  orderCompleted: number;
  sets: CompletedSetDTO[];
}

interface CompletedSetDTO {
  setNumber: number;
  repsCompleted: number;
  weightUsed?: number;
  resistanceLevel?: number;
  rpe?: number;
}

interface ExerciseHistoryEntryDTO {
  date: string;
  sessionTemplateName?: string;
  sets: CompletedSetDTO[];
}

interface VolumeStatsDTO {
  sets: number;
  reps: number;
  totalVolume: number;
}

interface RecoveryStatusDTO {
  muscleGroup: string;
  daysSinceLastTrained?: number;
  weeklySets: number;
}

interface ExerciseDTO {
  name: string;
  muscleGroups: string[];
  equipment: string[];
  category: string;
  movementPattern: string;
  notes?: string;
  hasPhoto: boolean;
}

interface TrainingPreferencesDTO {
  goal: string;
  experienceLevel: string;
  availableEquipment: string[];
  daysPerWeek: number;
  sessionDurationMinutes: number;
  injuriesOrLimitations?: string;
  /** Body/food profile, primarily useful for nutrition planning - see `Shared/WorkoutModels.swift`'s `TrainingPreferences`. */
  heightCm?: number;
  weightKg?: number;
  age?: number;
  biologicalSex?: string;
  bodyType?: string;
  fatDistribution?: string;
  activityLevel?: string;
  dietaryRestrictions: string[];
  foodPreferences?: string;
  nutritionGoal?: string;
  dailyCalorieTarget?: number;
  proteinTargetGrams?: number;
  carbTargetGrams?: number;
  fatTargetGrams?: number;
}

/** One fetch-everything-then-join-in-memory snapshot, mirroring the same "fetch everything, filter in Swift" approach GymTimerAgent used - dataset sizes here are personal-use tiny. */
async function loadSnapshot() {
  const [sessions, templates, completedExercises, completedSets, exercises] = await Promise.all([
    queryRecords("CD_WorkoutSession", "WorkoutSession"),
    queryRecords("CD_WorkoutTemplate", "WorkoutTemplate"),
    queryRecords("CD_CompletedExercise", "CompletedExercise"),
    queryRecords("CD_CompletedSet", "CompletedSet"),
    queryRecords("CD_Exercise", "Exercise")
  ]);

  // Keyed by `recordName` (CloudKit's own record identifier), NOT the app-level
  // `id` field. Core Data + CloudKit doesn't use CKRecord.Reference for
  // relationships - it stores the target's `CKRecord.recordID.recordName` as a
  // plain string foreign key (see Apple's "Reading CloudKit Records for Core
  // Data" doc). `id` and `recordName` are unrelated values.
  const templateById = new Map(templates.map((t) => [asString(t.recordName), t]));
  const exerciseById = new Map(exercises.map((e) => [asString(e.recordName), e]));
  const setsByCompletedExerciseId = groupBy(completedSets, (s) => asString(s.completedExercise));
  const completedExercisesBySessionId = groupBy(completedExercises, (c) => asString(c.session));

  return { sessions, templateById, exerciseById, setsByCompletedExerciseId, completedExercisesBySessionId };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function toCompletedSetDTO(set: PlainRecord): CompletedSetDTO {
  return {
    setNumber: asNumber(set.setNumber) ?? 1,
    repsCompleted: asNumber(set.repsCompleted) ?? 0,
    weightUsed: asNumber(set.weightUsed),
    resistanceLevel: asNumber(set.resistanceLevel),
    rpe: asNumber(set.rpe)
  };
}

function orderedSets(snapshot: Awaited<ReturnType<typeof loadSnapshot>>, completedExerciseId: string | undefined): CompletedSetDTO[] {
  if (!completedExerciseId) return [];
  const sets = snapshot.setsByCompletedExerciseId.get(completedExerciseId) ?? [];
  return sets
    .slice()
    .sort((a, b) => (asNumber(a.setNumber) ?? 0) - (asNumber(b.setNumber) ?? 0))
    .map(toCompletedSetDTO);
}

function toCompletedExerciseDTO(snapshot: Awaited<ReturnType<typeof loadSnapshot>>, completed: PlainRecord): CompletedExerciseDTO {
  const exercise = snapshot.exerciseById.get(asString(completed.exercise));
  return {
    // Prefer the name snapshot captured on-device at completion time
    // (`CompletedExercise.exerciseName` in Shared/WorkoutModels.swift) so
    // the name survives the source Exercise being deleted later; fall back
    // to the live relationship for history recorded before that field
    // existed, then to a generic placeholder if even that's gone.
    exerciseName: asString(completed.exerciseName) || asString(exercise?.name) || "Unknown Exercise",
    orderCompleted: asNumber(completed.orderCompleted) ?? 0,
    sets: orderedSets(snapshot, asString(completed.recordName))
  };
}

function orderedCompletedExercises(snapshot: Awaited<ReturnType<typeof loadSnapshot>>, sessionRecordName: string | undefined): PlainRecord[] {
  if (!sessionRecordName) return [];
  const completed = snapshot.completedExercisesBySessionId.get(sessionRecordName) ?? [];
  return completed.slice().sort((a, b) => (asNumber(a.orderCompleted) ?? 0) - (asNumber(b.orderCompleted) ?? 0));
}

function toWorkoutSessionDTO(snapshot: Awaited<ReturnType<typeof loadSnapshot>>, session: PlainRecord): WorkoutSessionDTO {
  const template = snapshot.templateById.get(asString(session.template));
  return {
    id: asString(session.id) ?? session.recordName as string,
    // Same snapshot-first, live-relationship-fallback pattern as
    // `toCompletedExerciseDTO` above (`WorkoutSession.templateName`).
    // Stays undefined for genuinely freestyle sessions either way.
    templateName: asString(session.templateName) ?? asString(template?.name),
    startDate: asString(session.startDate) ?? "",
    endDate: asString(session.endDate),
    totalDurationSeconds: asNumber(session.totalDuration) ?? 0,
    averageHeartRate: asNumber(session.averageHeartRate),
    notes: asString(session.notes),
    difficultyRating: asNumber(session.difficultyRating),
    exercises: orderedCompletedExercises(snapshot, asString(session.recordName)).map((completed) =>
      toCompletedExerciseDTO(snapshot, completed)
    )
  };
}

export async function getWorkoutHistory(days: number): Promise<WorkoutSessionDTO[]> {
  const snapshot = await loadSnapshot();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return snapshot.sessions
    .filter((session) => {
      const startDate = asString(session.startDate);
      return startDate ? new Date(startDate).getTime() >= cutoff : false;
    })
    .sort((a, b) => new Date(asString(b.startDate) ?? 0).getTime() - new Date(asString(a.startDate) ?? 0).getTime())
    .map((session) => toWorkoutSessionDTO(snapshot, session));
}

export async function getExerciseHistory(name: string, limit?: number): Promise<ExerciseHistoryEntryDTO[]> {
  const snapshot = await loadSnapshot();
  const lowerName = name.trim().toLowerCase();
  const exercises = Array.from(snapshot.exerciseById.values());
  const exactMatch = exercises.find((e) => asString(e.name)?.toLowerCase() === lowerName);
  const fuzzyMatch = exactMatch ?? exercises.find((e) => asString(e.name)?.toLowerCase().includes(lowerName));
  if (!fuzzyMatch) {
    throw new Error(`No exercise found matching "${name}"`);
  }
  const exerciseRecordName = asString(fuzzyMatch.recordName);

  const allCompletedExercises = Array.from(snapshot.completedExercisesBySessionId.values()).flat();
  const matchingCompleted = allCompletedExercises.filter((c) => asString(c.exercise) === exerciseRecordName);
  const sessionByRecordName = new Map(snapshot.sessions.map((s) => [asString(s.recordName), s]));

  let entries: ExerciseHistoryEntryDTO[] = matchingCompleted.map((completed) => {
    const session = sessionByRecordName.get(asString(completed.session));
    const template = session ? snapshot.templateById.get(asString(session.template)) : undefined;
    return {
      date: asString(session?.startDate) ?? asString(completed.completedAt) ?? "",
      sessionTemplateName: asString(session?.templateName) ?? asString(template?.name),
      sets: orderedSets(snapshot, asString(completed.recordName))
    };
  });

  entries = entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  if (limit) entries = entries.slice(0, limit);
  return entries;
}

export async function analyzeTrainingVolume(
  days: number,
  groupBy: "muscle_group" | "exercise"
): Promise<Record<string, VolumeStatsDTO>> {
  const snapshot = await loadSnapshot();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const buckets = new Map<string, VolumeStatsDTO>();

  const recentSessions = snapshot.sessions.filter((session) => {
    const startDate = asString(session.startDate);
    return startDate ? new Date(startDate).getTime() >= cutoff : false;
  });

  for (const session of recentSessions) {
    for (const completed of orderedCompletedExercises(snapshot, asString(session.recordName))) {
      const exercise = snapshot.exerciseById.get(asString(completed.exercise));
      if (!exercise) continue;
      const keys =
        groupBy === "exercise"
          ? [asString(exercise.name) ?? "Unknown Exercise"]
          : (() => {
              const groups = decodeStringArrayBytes(exercise.muscleGroups);
              return groups.length > 0 ? groups : ["unspecified"];
            })();

      for (const set of orderedSets(snapshot, asString(completed.recordName))) {
        const volume = set.repsCompleted * (set.weightUsed ?? 0);
        for (const key of keys) {
          const bucket = buckets.get(key) ?? { sets: 0, reps: 0, totalVolume: 0 };
          bucket.sets += 1;
          bucket.reps += set.repsCompleted;
          bucket.totalVolume += volume;
          buckets.set(key, bucket);
        }
      }
    }
  }

  return Object.fromEntries(buckets);
}

export async function getRecoveryStatus(muscleGroupFilter?: string): Promise<RecoveryStatusDTO[]> {
  const snapshot = await loadSnapshot();
  const now = Date.now();
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;

  const lastTrained = new Map<string, number>();
  const weeklySets = new Map<string, number>();

  for (const session of snapshot.sessions) {
    const startDate = asString(session.startDate);
    const startMs = startDate ? new Date(startDate).getTime() : undefined;
    if (!startMs) continue;

    for (const completed of orderedCompletedExercises(snapshot, asString(session.recordName))) {
      const exercise = snapshot.exerciseById.get(asString(completed.exercise));
      if (!exercise) continue;
      const groups = decodeStringArrayBytes(exercise.muscleGroups);
      const setCount = orderedSets(snapshot, asString(completed.recordName)).length;

      for (const group of groups) {
        const existing = lastTrained.get(group);
        if (!existing || startMs > existing) lastTrained.set(group, startMs);
        if (startMs >= weekCutoff) {
          weeklySets.set(group, (weeklySets.get(group) ?? 0) + setCount);
        }
      }
    }
  }

  let groupKeys = new Set([...lastTrained.keys(), ...weeklySets.keys()]);
  if (muscleGroupFilter) {
    groupKeys = groupKeys.has(muscleGroupFilter) ? new Set([muscleGroupFilter]) : new Set();
  }

  return Array.from(groupKeys)
    .sort()
    .map((key) => {
      const last = lastTrained.get(key);
      const daysSinceLastTrained = last ? Math.floor((now - last) / (24 * 60 * 60 * 1000)) : undefined;
      return { muscleGroup: key, daysSinceLastTrained, weeklySets: weeklySets.get(key) ?? 0 };
    });
}

export async function getExerciseLibrary(muscleGroupFilter?: string, equipmentFilter?: string): Promise<ExerciseDTO[]> {
  const exercises = await queryRecords("CD_Exercise", "Exercise");
  let filtered = exercises.slice().sort((a, b) => (asString(a.name) ?? "").localeCompare(asString(b.name) ?? ""));

  if (muscleGroupFilter) {
    const wanted = new Set(muscleGroupFilter.split(",").map((s) => s.trim()));
    filtered = filtered.filter((e) => decodeStringArrayBytes(e.muscleGroups).some((g) => wanted.has(g)));
  }
  if (equipmentFilter) {
    const wanted = new Set(equipmentFilter.split(",").map((s) => s.trim()));
    filtered = filtered.filter((e) => decodeStringArrayBytes(e.equipment).some((eq) => wanted.has(eq)));
  }

  return filtered.map((exercise) => ({
    name: asString(exercise.name) ?? "",
    muscleGroups: decodeStringArrayBytes(exercise.muscleGroups),
    equipment: decodeStringArrayBytes(exercise.equipment),
    category: decodeSingleEnumBytes(exercise.category, EXERCISE_CATEGORY_VALUES) ?? "compound",
    movementPattern: decodeSingleEnumBytes(exercise.movementPattern, MOVEMENT_PATTERN_VALUES) ?? "push",
    notes: asString(exercise.notes),
    // `Exercise.customPhotoData` is `@Attribute(.externalStorage)`, so Core
    // Data + CloudKit mirrors it as a separate `CD_customPhotoData_ckAsset`
    // CKAsset field rather than inflating `CD_customPhotoData` itself (see
    // "Adding/updating an exercise photo" below) - just checking presence
    // here, not decoding it.
    hasPhoto: exercise.customPhotoData_ckAsset != null
  }));
}

// MARK: - Workout templates (read)

interface WorkoutTemplateSlotDTO {
  /** The exercise's name, which is also what the write tools accept as `exerciseNameOrId`. */
  exerciseNameOrId: string;
  orderIndex: number;
  targetSets: number;
  targetReps: number;
  restSeconds: number;
  targetRepsPerSet?: number[];
  cadence?: string;
  intensity?: string;
  targetWeight?: number;
  supersetGroup?: number;
}

interface WorkoutTemplateDTO {
  id: string;
  name: string;
  estimatedDurationMinutes?: number;
  createdDate?: string;
  isArchived: boolean;
  exercises: WorkoutTemplateSlotDTO[];
}

/**
 * Returns saved workout templates with their full ordered exercise lists.
 *
 * The deliberate design constraint here is that each slot comes back in
 * exactly the shape `update_workout_template`/`save_workout_template` take
 * as input, so a read-modify-write round trip is lossless. That includes
 * collapsing the stored `supersetID` UUIDs back down to the small
 * caller-facing `supersetGroup` numbers those tools use.
 */
export async function getWorkoutTemplates(idOrName?: string): Promise<WorkoutTemplateDTO[]> {
  const [templates, slots, exercises] = await Promise.all([
    queryRecords("CD_WorkoutTemplate", "WorkoutTemplate"),
    queryRecords("CD_WorkoutExercise", "WorkoutExercise"),
    queryRecords("CD_Exercise", "Exercise")
  ]);

  const wanted = idOrName ? [findWorkoutTemplateIn(templates, idOrName)] : templates;
  const exerciseNameByRecordName = new Map<string, string>(
    exercises.map((exercise) => [asString(exercise.recordName) ?? "", asString(exercise.name) ?? ""])
  );

  return wanted
    .slice()
    .sort((a, b) => (asString(a.name) ?? "").localeCompare(asString(b.name) ?? ""))
    .map((template) => {
      const templateRecordName = asString(template.recordName);
      const owned = slots
        .filter((slot) => asString(slot.template) === templateRecordName)
        .sort((a, b) => (asNumber(a.orderIndex) ?? 0) - (asNumber(b.orderIndex) ?? 0));

      // Stored superset ids are UUIDs; the write tools speak in small group
      // numbers instead, so they're renumbered 1..n in the order encountered.
      const groupNumberBySupersetID = new Map<string, number>();
      const estimatedDuration = asNumber(template.estimatedDuration);

      return {
        id: asString(template.id) ?? "",
        name: asString(template.name) ?? "",
        estimatedDurationMinutes: estimatedDuration !== undefined ? estimatedDuration / 60 : undefined,
        createdDate: asString(template.createdDate),
        isArchived: template.isArchived === true || template.isArchived === 1,
        exercises: owned.map((slot, index) => {
          const supersetID = asString(slot.supersetID);
          let supersetGroup: number | undefined;
          if (supersetID) {
            supersetGroup = groupNumberBySupersetID.get(supersetID);
            if (supersetGroup === undefined) {
              supersetGroup = groupNumberBySupersetID.size + 1;
              groupNumberBySupersetID.set(supersetID, supersetGroup);
            }
          }

          const targetRepsPerSet = decodeArchivedIntArrayBytes(slot.targetRepsPerSet);

          return {
            exerciseNameOrId: exerciseNameByRecordName.get(asString(slot.exercise) ?? "") ?? "",
            orderIndex: asNumber(slot.orderIndex) ?? index,
            targetSets: asNumber(slot.targetSets) ?? 0,
            targetReps: asNumber(slot.targetReps) ?? 0,
            restSeconds: asNumber(slot.restSeconds) ?? 0,
            targetRepsPerSet: targetRepsPerSet.length > 0 ? targetRepsPerSet : undefined,
            cadence: asString(slot.cadence),
            intensity: asString(slot.intensity),
            targetWeight: asNumber(slot.targetWeight),
            supersetGroup
          };
        })
      };
    });
}

// MARK: - Write tools
//
// Only fields verified to encode/decode safely both ways are writable here
// (plain strings, numbers, timestamps, and JSON-array-of-strings `BYTES`
// fields like muscleGroups/equipment). `category`/`movementPattern` and
// other single-custom-enum `BYTES` fields are deliberately left out: the
// exact bytes SwiftData expects for those turned out to depend on the
// SwiftData/OS version that wrote them (verified: a value encoded by this
// Mac's SwiftData did NOT match the same field's real encoding on an
// already-synced record), so writing a guessed encoding risks that field
// silently coming back wrong on your Watch/iPhone. Newly created records
// simply omit those fields, letting the receiving device fall back to the
// model's own Swift-level default (`ExerciseCategory.compound`,
// `MovementPattern.push`) - editable from the app itself in the meantime.

async function findExerciseRecord(idOrName: string): Promise<PlainRecord> {
  const exercises = await queryRecords("CD_Exercise", "Exercise");
  const byId = exercises.find((e) => asString(e.id) === idOrName);
  if (byId) return byId;
  const lower = idOrName.trim().toLowerCase();
  const exact = exercises.find((e) => asString(e.name)?.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = exercises.find((e) => asString(e.name)?.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;
  throw new Error(`No exercise found matching "${idOrName}"`);
}

async function findWorkoutTemplateRecord(idOrName: string): Promise<PlainRecord> {
  return findWorkoutTemplateIn(await queryRecords("CD_WorkoutTemplate", "WorkoutTemplate"), idOrName);
}

/**
 * The id/exact-name/substring matching every template tool uses, over a
 * template list already in hand - so callers that fetched templates for
 * other reasons (`getWorkoutTemplates`) don't have to query again.
 */
function findWorkoutTemplateIn(templates: PlainRecord[], idOrName: string): PlainRecord {
  const byId = templates.find((t) => asString(t.id) === idOrName);
  if (byId) return byId;
  const lower = idOrName.trim().toLowerCase();
  const exact = templates.find((t) => asString(t.name)?.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = templates.find((t) => asString(t.name)?.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;
  throw new Error(`No workout template found matching "${idOrName}"`);
}

// MARK: - Exercise photo handling
//
// `Exercise.customPhotoData` is `@Attribute(.externalStorage)`, so Core
// Data + CloudKit mirrors it as a *separate* `CD_customPhotoData_ckAsset`
// field of native CloudKit type `ASSET`, not as bytes packed into
// `CD_customPhotoData` itself (verified via `cktool export-schema`, and
// matches Apple's documented behavior for external-storage/large
// attributes - see "Reading CloudKit Records for Core Data"). Unlike the
// enum `BYTES` fields above, `ASSET` is a first-class, fully-documented
// CKValue type with no guessed encoding involved, so it's safe to write.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // CloudKit Web Services' own asset upload limit.
const CUSTOM_PHOTO_ASSET_FIELD = "CD_customPhotoData_ckAsset";

function resolvePhotoPath(photoPath: string): string {
  const expanded = photoPath.startsWith("~") ? path.join(homedir(), photoPath.slice(1)) : photoPath;
  return path.resolve(expanded);
}

function statPhotoFile(photoPath: string): { resolvedPath: string; size: number } {
  const resolvedPath = resolvePhotoPath(photoPath);
  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    throw new Error(`Could not find a photo file at "${resolvedPath}". Provide an absolute local path to an image file (jpg/png/heic).`);
  }
  if (!stats.isFile()) {
    throw new Error(`"${resolvedPath}" is not a file.`);
  }
  if (stats.size > MAX_PHOTO_BYTES) {
    throw new Error(
      `"${resolvedPath}" is ${(stats.size / (1024 * 1024)).toFixed(1)}MB, which exceeds CloudKit's 15MB asset upload limit.`
    );
  }
  return { resolvedPath, size: stats.size };
}

export interface CreateExerciseInput {
  name: string;
  muscleGroups: string[];
  equipment: string[];
  /** Absolute (or `~`-relative) local path to a photo to attach, e.g. "/Users/me/Pictures/lat-pulldown.jpg". */
  photoPath?: string;
}

export async function createExercise(input: CreateExerciseInput): Promise<{ id: string; name: string }> {
  const muscleGroups = normalizeAndValidate(input.muscleGroups, MUSCLE_GROUP_VALUES, MUSCLE_GROUP_SYNONYMS, "muscleGroups");
  const equipment = normalizeAndValidate(input.equipment, EQUIPMENT_VALUES, EQUIPMENT_SYNONYMS, "equipment");

  const id = randomUUID().toUpperCase();
  const fields: Record<string, { type: string; value: unknown }> = {
    CD_id: { type: "stringType", value: id },
    CD_entityName: { type: "stringType", value: "Exercise" },
    CD_name: { type: "stringType", value: input.name },
    CD_muscleGroups: { type: "bytesType", value: encodeStringArrayBytes(muscleGroups) },
    CD_equipment: { type: "bytesType", value: encodeStringArrayBytes(equipment) },
    CD_createdDate: { type: "timestampType", value: new Date().toISOString() }
  };

  let assetFiles: Record<string, string> | undefined;
  if (input.photoPath !== undefined) {
    const { resolvedPath } = statPhotoFile(input.photoPath);
    // `createRecord` (ckWebService.ts) performs the assets/upload dance
    // itself for any field of type "assetType"; the field value here is
    // just a placeholder key that `assetFiles` resolves to a local path.
    fields[CUSTOM_PHOTO_ASSET_FIELD] = { type: "assetType", value: "PHOTO" };
    assetFiles = { PHOTO: resolvedPath };
  }

  await createRecord("CD_Exercise", fields, assetFiles);
  return { id, name: input.name };
}

export interface UpdateExerciseInput {
  name?: string;
  muscleGroups?: string[];
  equipment?: string[];
  /** Absolute (or `~`-relative) local path to a new/replacement photo. */
  photoPath?: string;
  /** Set true to remove this exercise's existing custom photo. Ignored if `photoPath` is also provided. */
  removePhoto?: boolean;
}

export async function updateExercise(idOrName: string, updates: UpdateExerciseInput): Promise<{ id: string; name: string }> {
  const record = await findExerciseRecord(idOrName);
  // Note: `modifyRecord` (ckWebService.ts) takes classic CloudKit Web
  // Services REST field type strings directly ("STRING"/"BYTES"/...),
  // whereas `createRecord` also accepts the older camelCase names
  // ("stringType"/"bytesType"/...) for call sites that still use them.
  const fields: Record<string, { value: unknown; type?: string }> = {};
  if (updates.name !== undefined) fields.CD_name = { type: "STRING", value: updates.name };
  if (updates.muscleGroups !== undefined) {
    const muscleGroups = normalizeAndValidate(updates.muscleGroups, MUSCLE_GROUP_VALUES, MUSCLE_GROUP_SYNONYMS, "muscleGroups");
    fields.CD_muscleGroups = { type: "BYTES", value: encodeStringArrayBytes(muscleGroups) };
  }
  if (updates.equipment !== undefined) {
    const equipment = normalizeAndValidate(updates.equipment, EQUIPMENT_VALUES, EQUIPMENT_SYNONYMS, "equipment");
    fields.CD_equipment = { type: "BYTES", value: encodeStringArrayBytes(equipment) };
  }
  if (updates.photoPath !== undefined) {
    const { resolvedPath } = statPhotoFile(updates.photoPath);
    const asset = await uploadAsset("CD_Exercise", CUSTOM_PHOTO_ASSET_FIELD, readFileSync(resolvedPath), record.recordName as string);
    fields[CUSTOM_PHOTO_ASSET_FIELD] = { type: "ASSETID", value: asset };
  } else if (updates.removePhoto) {
    fields[CUSTOM_PHOTO_ASSET_FIELD] = { type: "ASSETID", value: null };
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("No updatable fields provided (name, muscleGroups, equipment, photoPath, removePhoto)");
  }

  await modifyRecord({
    recordName: record.recordName as string,
    recordType: "CD_Exercise",
    fields
  });
  return { id: asString(record.id) ?? "", name: updates.name ?? asString(record.name) ?? "" };
}

export async function deleteExercise(idOrName: string): Promise<{ deleted: string }> {
  const record = await findExerciseRecord(idOrName);
  await deleteRecord(record.recordName as string);
  return { deleted: asString(record.name) ?? idOrName };
}

export interface SaveWorkoutTemplateExerciseInput {
  exerciseNameOrId: string;
  targetSets: number;
  targetReps: number;
  /**
   * Planned rest, in seconds, after this slot's set. Rendered on the
   * Watch as a dedicated, manually-advanced "rest" step in the workout
   * sequence (a count-up elapsed timer with this value shown as the
   * target, not a countdown that auto-advances) - inserted after every
   * standalone exercise's set, and after the *last* member of each
   * superset round (never between a superset's own members). For a
   * `supersetGroup`, only the last slot in the group's `restSeconds` is
   * used as that round's rest target - the other members' values are
   * saved but not read for this, since there's only ever one rest step
   * per round, not one per member.
   */
  restSeconds: number;
  /**
   * Optional per-set rep targets (e.g. `[12, 10, 8, 8]` for a pyramid).
   * Must have exactly `targetSets` entries when provided. When omitted,
   * every set falls back to the flat `targetReps` value on-device.
   */
  targetRepsPerSet?: number[];
  /**
   * Optional tempo notation, e.g. "3-1-1" (eccentric-pause-concentric
   * seconds). Plain string field - no special encoding needed.
   */
  cadence?: string;
  /**
   * Optional target intensity as RIR (reps in reserve) or RPE, e.g.
   * "RIR 2" or "RPE 8". Plain string field - no special encoding needed.
   */
  intensity?: string;
  /**
   * Optional suggested working weight for this exercise slot (same unit
   * convention as the user's logged history - kg or lb, not enforced
   * here). A starting-point recommendation, not a hard target; plain
   * number field - no special encoding needed.
   */
  targetWeight?: number;
  /**
   * Groups this slot into a superset with every other slot in the same
   * `exercises` array that shares this same number (e.g. `1`) - they're
   * performed back-to-back with no rest between them, one round at a
   * time (A1, B1, rest, A2, B2, rest, ...), sharing the same round count
   * (mirrors `Shared/WorkoutModels.swift`'s `WorkoutExercise.supersetID`:
   * an app-level UUID shared by consecutive slots). Rest (see
   * `restSeconds`) only happens after the *last* member of each round,
   * never between a round's own members. The number itself is just a
   * caller-chosen label to link slots within this one call - it is NOT
   * stored as-is; a fresh UUID is generated per distinct group number and
   * written to `CD_supersetID`. Grouped slots MUST be placed
   * consecutively in `exercises` - the app only merges *consecutive*
   * same-`supersetID` slots into one superset block, so a non-contiguous
   * group would silently start a new block. Omit for a standalone
   * (non-superset) exercise.
   */
  supersetGroup?: number;
}

export interface SaveWorkoutTemplateInput {
  name: string;
  estimatedDurationMinutes?: number;
  exercises: SaveWorkoutTemplateExerciseInput[];
}

export async function saveWorkoutTemplate(input: SaveWorkoutTemplateInput): Promise<{ id: string; name: string; exerciseCount: number }> {
  // Validated before the template record is created, so a rejected call
  // doesn't leave a named-but-empty template behind.
  const prepared = await prepareTemplateExerciseSlots(input.exercises);

  const templateId = randomUUID().toUpperCase();
  const templateFields: Record<string, { value: unknown; type?: string }> = {
    CD_id: { type: "stringType", value: templateId },
    CD_entityName: { type: "stringType", value: "WorkoutTemplate" },
    CD_name: { type: "stringType", value: input.name },
    CD_createdDate: { type: "timestampType", value: new Date().toISOString() }
  };
  if (input.estimatedDurationMinutes !== undefined) {
    templateFields.CD_estimatedDuration = { type: "doubleType", value: input.estimatedDurationMinutes * 60 };
  }
  // Core Data + CloudKit relationship foreign keys (CD_template, CD_exercise
  // below) must hold the target's `CKRecord.recordID.recordName` - the
  // CloudKit-assigned record identifier - NOT the app-level `CD_id` value.
  // Those are two independent UUIDs; using `CD_id` here silently breaks the
  // relationship on-device (the workout looks "empty" - no exercises/sets).
  const templateRecordName = await createRecord("CD_WorkoutTemplate", templateFields);

  await writeTemplateExerciseSlots(templateRecordName, prepared);

  return { id: templateId, name: input.name, exerciseCount: input.exercises.length };
}

type PreparedSlotFields = Record<string, { value: unknown; type?: string }>;

/**
 * Validates and resolves an exercise list into ready-to-write field sets,
 * without touching CloudKit's records at all.
 *
 * Separated from the writing below so that **every** way this call can be
 * rejected happens before anything is created or deleted. That matters most
 * for `updateWorkoutTemplate`, which has to delete the template's existing
 * slots before writing the replacements: validating mid-write there meant a
 * single bad entry (an exercise name that doesn't exist, a `targetRepsPerSet`
 * of the wrong length, a non-contiguous superset) destroyed the user's real
 * exercise list and left a half-written one in its place. An invalid call
 * must be a no-op, not a partial edit.
 *
 * `CD_template` is deliberately left out - the caller fills it in, since
 * `saveWorkoutTemplate` doesn't know the new template's record name until
 * after this has run.
 */
async function prepareTemplateExerciseSlots(slots: SaveWorkoutTemplateExerciseInput[]): Promise<PreparedSlotFields[]> {
  // Maps each caller-chosen `supersetGroup` number to the single app-level
  // superset UUID shared by every slot in that group (see
  // `SaveWorkoutTemplateExerciseInput.supersetGroup` doc comment) - built
  // lazily so a group number is only ever assigned one UUID no matter how
  // many slots reference it.
  const supersetUUIDsByGroup = new Map<number, string>();
  function resolveSupersetID(group: number | undefined): string | undefined {
    if (group === undefined) return undefined;
    const existing = supersetUUIDsByGroup.get(group);
    if (existing) return existing;
    const fresh = randomUUID().toUpperCase();
    supersetUUIDsByGroup.set(group, fresh);
    return fresh;
  }

  const prepared: PreparedSlotFields[] = [];
  let previousGroup: number | undefined;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const exercise = await findExerciseRecord(slot.exerciseNameOrId);
    if (slot.targetRepsPerSet !== undefined && slot.targetRepsPerSet.length !== slot.targetSets) {
      throw new Error(
        `"${slot.exerciseNameOrId}": targetRepsPerSet has ${slot.targetRepsPerSet.length} entries but targetSets is ${slot.targetSets}`
      );
    }
    // A group number reappearing after a *different* group/standalone slot
    // in between would silently start a second, disconnected superset
    // block on-device (see supersetGroup's doc comment) - caught here
    // rather than shipping a template that looks grouped in this call but
    // doesn't render that way in the app.
    if (
      slot.supersetGroup !== undefined &&
      slot.supersetGroup !== previousGroup &&
      supersetUUIDsByGroup.has(slot.supersetGroup)
    ) {
      throw new Error(
        `supersetGroup ${slot.supersetGroup} is used non-contiguously (slots sharing a group must be consecutive in "exercises").`
      );
    }
    previousGroup = slot.supersetGroup;
    const fields: PreparedSlotFields = {
      CD_id: { type: "stringType", value: randomUUID().toUpperCase() },
      CD_entityName: { type: "stringType", value: "WorkoutExercise" },
      CD_exercise: { type: "stringType", value: asString(exercise.recordName) },
      CD_targetSets: { type: "int64Type", value: slot.targetSets },
      CD_targetReps: { type: "int64Type", value: slot.targetReps },
      CD_restSeconds: { type: "int64Type", value: slot.restSeconds },
      CD_orderIndex: { type: "int64Type", value: i }
    };
    if (slot.targetRepsPerSet !== undefined) {
      // NSKeyedArchiver-encoded, not plain JSON - see nsKeyedArchiver.ts for why.
      fields.CD_targetRepsPerSet = { type: "bytesType", value: await encodeIntArrayBytes(slot.targetRepsPerSet) };
    }
    if (slot.cadence !== undefined && slot.cadence.trim().length > 0) {
      fields.CD_cadence = { type: "stringType", value: slot.cadence.trim() };
    }
    if (slot.intensity !== undefined && slot.intensity.trim().length > 0) {
      fields.CD_intensity = { type: "stringType", value: slot.intensity.trim() };
    }
    if (slot.targetWeight !== undefined) {
      fields.CD_targetWeight = { type: "doubleType", value: slot.targetWeight };
    }
    const supersetID = resolveSupersetID(slot.supersetGroup);
    if (supersetID !== undefined) {
      fields.CD_supersetID = { type: "stringType", value: supersetID };
    }
    prepared.push(fields);
  }
  return prepared;
}

/**
 * Creates one `CD_WorkoutExercise` row per prepared slot, in order, for an
 * existing template record. Assumes any previous slots for this template
 * have already been removed - it only ever creates.
 */
async function writeTemplateExerciseSlots(templateRecordName: string, prepared: PreparedSlotFields[]): Promise<void> {
  for (const fields of prepared) {
    await createRecord("CD_WorkoutExercise", {
      ...fields,
      CD_template: { type: "stringType", value: templateRecordName }
    });
  }
}

/** Deletes every `CD_WorkoutExercise` row belonging to one template, returning how many went. */
async function deleteTemplateExerciseSlots(templateRecordName: string | undefined): Promise<number> {
  const slots = await queryRecords("CD_WorkoutExercise", "WorkoutExercise");
  const owned = slots.filter((slot) => asString(slot.template) === templateRecordName);
  for (const slot of owned) {
    await deleteRecord(slot.recordName as string);
  }
  return owned.length;
}

export interface UpdateWorkoutTemplateInput {
  template: string;
  name?: string;
  estimatedDurationMinutes?: number;
  exercises?: SaveWorkoutTemplateExerciseInput[];
}

/**
 * Edits an existing template in place: its name, its estimated duration,
 * and/or its whole exercise list.
 *
 * Editing in place rather than deleting and re-creating is the entire point.
 * The template record keeps its `recordName` and app-level `CD_id`, so every
 * `WorkoutSession` in History that points at this template stays linked to
 * it, as does any periodization cycle it belongs to - all of which a
 * delete-and-recreate silently severs.
 *
 * `exercises` replaces the list wholesale (matching how
 * `update_nutrition_day` replaces a day's meals) rather than patching
 * individual slots, so callers should read the current list with
 * `get_workout_templates` first and send it back with their edits applied.
 * Omit `exercises` entirely to leave the list untouched.
 */
export async function updateWorkoutTemplate(
  input: UpdateWorkoutTemplateInput
): Promise<{ id: string; name: string; exerciseCount?: number }> {
  const template = await findWorkoutTemplateRecord(input.template);
  const templateRecordName = asString(template.recordName);

  // Everything that can be rejected is resolved and validated here, before
  // the first mutation - the existing slots are about to be deleted, and a
  // failure partway through that would leave the template's real exercise
  // list destroyed with a partial replacement in its place.
  const prepared = input.exercises !== undefined ? await prepareTemplateExerciseSlots(input.exercises) : undefined;

  // NOTE: `modifyRecord` sends `fields` straight to the REST API, so these
  // are the CloudKit Web Services type names ("STRING"/"DOUBLE") - unlike
  // `createRecord`, which maps the SwiftData-ish "stringType" spellings.
  const fields: Record<string, { value: unknown; type?: string }> = {};
  if (input.name !== undefined) {
    fields.CD_name = { type: "STRING", value: input.name };
  }
  if (input.estimatedDurationMinutes !== undefined) {
    fields.CD_estimatedDuration = { type: "DOUBLE", value: input.estimatedDurationMinutes * 60 };
  }
  if (Object.keys(fields).length > 0) {
    await modifyRecord({
      recordName: templateRecordName as string,
      recordType: "CD_WorkoutTemplate",
      fields
    });
  }

  let exerciseCount: number | undefined;
  if (prepared !== undefined) {
    await deleteTemplateExerciseSlots(templateRecordName);
    await writeTemplateExerciseSlots(templateRecordName as string, prepared);
    exerciseCount = prepared.length;
  }

  return {
    id: asString(template.id) ?? "",
    name: input.name ?? asString(template.name) ?? "",
    exerciseCount
  };
}

export async function updateWorkoutTemplateName(idOrName: string, newName: string): Promise<{ id: string; name: string }> {
  const template = await findWorkoutTemplateRecord(idOrName);
  await modifyRecord({
    recordName: template.recordName as string,
    recordType: "CD_WorkoutTemplate",
    fields: { CD_name: { type: "STRING", value: newName } }
  });
  return { id: asString(template.id) ?? "", name: newName };
}

export async function deleteWorkoutTemplate(idOrName: string): Promise<{ deleted: string; exercisesRemoved: number }> {
  const template = await findWorkoutTemplateRecord(idOrName);
  const exercisesRemoved = await deleteTemplateExerciseSlots(asString(template.recordName));
  await deleteRecord(template.recordName as string);

  return { deleted: asString(template.name) ?? idOrName, exercisesRemoved };
}

/**
 * `PeriodicizationCycle` was defined in the SwiftData schema from the start
 * but no device had ever actually synced one, so CloudKit's schema for it
 * (and for `WorkoutTemplate.periodizationCycle`) didn't exist yet - `cktool`/
 * REST writes can't create a brand-new record type on their own (that needs
 * schema-deployment rights, which only the signed app normally exercises on
 * first real sync). Deployed both via `cktool import-schema` with the
 * Management Token as a one-time step, mirroring what Xcode/the app would
 * eventually have done. `phase` is the one field intentionally left
 * unwritable, for the same single-custom-enum-encoding reason as
 * `Exercise.category`/`movementPattern` above - new cycles get the model's
 * Swift-level default (`TrainingPhase.hypertrophy`) until edited from the app.
 */
export interface SavePeriodizationPlanInput {
  name: string;
  startDate?: string;
  endDate?: string;
  notes?: string;
  /** Existing workout templates (name or id) to mark as belonging to this cycle. */
  templateNamesOrIds?: string[];
}

export async function savePeriodizationPlan(
  input: SavePeriodizationPlanInput
): Promise<{ id: string; name: string; templatesLinked: number }> {
  const cycleId = randomUUID().toUpperCase();
  const fields: Record<string, { value: unknown; type?: string }> = {
    CD_id: { type: "stringType", value: cycleId },
    CD_entityName: { type: "stringType", value: "PeriodicizationCycle" },
    CD_name: { type: "stringType", value: input.name },
    CD_startDate: { type: "timestampType", value: input.startDate ?? new Date().toISOString() }
  };
  if (input.endDate !== undefined) fields.CD_endDate = { type: "timestampType", value: input.endDate };
  if (input.notes !== undefined) fields.CD_notes = { type: "stringType", value: input.notes };

  // Same rule as saveWorkoutTemplate above: the relationship foreign key
  // (CD_periodizationCycle on CD_WorkoutTemplate) must hold the cycle's
  // CloudKit `recordName`, not its app-level `CD_id`.
  const cycleRecordName = await createRecord("CD_PeriodicizationCycle", fields);

  let templatesLinked = 0;
  for (const templateRef of input.templateNamesOrIds ?? []) {
    const template = await findWorkoutTemplateRecord(templateRef);
    await modifyRecord({
      recordName: template.recordName as string,
      recordType: "CD_WorkoutTemplate",
      fields: { CD_periodizationCycle: { type: "STRING", value: cycleRecordName } }
    });
    templatesLinked++;
  }

  return { id: cycleId, name: input.name, templatesLinked };
}

export async function getTrainingPreferences(): Promise<TrainingPreferencesDTO> {
  const preferences = await queryRecords("CD_TrainingPreferences", "TrainingPreferences");
  const record = preferences[0];
  if (!record) {
    return {
      goal: "general",
      experienceLevel: "beginner",
      availableEquipment: [],
      daysPerWeek: 3,
      sessionDurationMinutes: 45,
      injuriesOrLimitations: undefined,
      dietaryRestrictions: []
    };
  }
  return {
    goal: decodeSingleEnumBytes(record.goal, TRAINING_GOAL_VALUES) ?? "general",
    experienceLevel: decodeSingleEnumBytes(record.experienceLevel, EXPERIENCE_LEVEL_VALUES) ?? "beginner",
    availableEquipment: decodeStringArrayBytes(record.availableEquipment),
    daysPerWeek: asNumber(record.daysPerWeek) ?? 3,
    sessionDurationMinutes: (asNumber(record.sessionDuration) ?? 2700) / 60,
    injuriesOrLimitations: asString(record.injuriesOrLimitations),
    // Body & personal - see `Shared/WorkoutModels.swift`'s `TrainingPreferences` doc comment for why these are
    // plain scalars/strings rather than custom enums (keeps the door open to writing them from MCP later).
    heightCm: asNumber(record.heightCm),
    weightKg: asNumber(record.weightKg),
    age: asNumber(record.age),
    biologicalSex: asString(record.biologicalSex),
    bodyType: asString(record.bodyType),
    fatDistribution: asString(record.fatDistribution),
    activityLevel: asString(record.activityLevel),
    // Food preferences & nutrition targets - read this before generating or adapting a nutrition plan.
    dietaryRestrictions: decodeStringArrayBytes(record.dietaryRestrictions),
    foodPreferences: asString(record.foodPreferences),
    nutritionGoal: asString(record.nutritionGoal),
    dailyCalorieTarget: asNumber(record.dailyCalorieTarget),
    proteinTargetGrams: asNumber(record.proteinTargetGrams),
    carbTargetGrams: asNumber(record.carbTargetGrams),
    fatTargetGrams: asNumber(record.fatTargetGrams)
  };
}

// MARK: - Nutrition Plan
//
// Mirrors the WorkoutTemplate -> WorkoutExercise write pattern above
// (NutritionPlan -> NutritionDay -> NutritionMeal), with one added
// invariant: there is always at most one `NutritionPlan` that matters -
// "the active plan" (see `Shared/NutritionModels.swift`'s
// `NutritionPlan.fetchActive`, which the app itself uses the same way).
// `saveNutritionPlan` enforces this by deleting any existing plan before
// creating the new one, so "regenerate my week" never piles up duplicates.
// `updateNutritionMeal`/`updateNutritionDay`/`updateNutritionPlan` instead
// adapt the existing plan in place via `modifyRecord` (the same
// `forceUpdate` REST path `updateExercise` uses), for changes that
// shouldn't blow away the rest of the week.

interface NutritionMealDTO {
  id: string;
  orderIndex: number;
  name: string;
  time?: string;
  recipeName: string;
  ingredients: string[];
  instructions?: string;
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
}

interface NutritionDayDTO {
  id: string;
  dayIndex: number;
  title: string;
  notes?: string;
  meals: NutritionMealDTO[];
}

interface NutritionPlanDTO {
  id: string;
  name: string;
  startDate: string;
  notes?: string;
  aiGenerationPrompt?: string;
  createdDate: string;
  days: NutritionDayDTO[];
}

function toNutritionMealDTO(meal: PlainRecord): NutritionMealDTO {
  return {
    id: asString(meal.id) ?? "",
    orderIndex: asNumber(meal.orderIndex) ?? 0,
    name: asString(meal.name) ?? "",
    time: asString(meal.time),
    recipeName: asString(meal.recipeName) ?? "",
    ingredients: decodeArchivedStringArrayBytes(meal.ingredients),
    instructions: asString(meal.instructions),
    calories: asNumber(meal.calories),
    proteinGrams: asNumber(meal.proteinGrams),
    carbsGrams: asNumber(meal.carbsGrams),
    fatGrams: asNumber(meal.fatGrams)
  };
}

function toNutritionDayDTO(day: PlainRecord, dayMeals: PlainRecord[]): NutritionDayDTO {
  return {
    id: asString(day.id) ?? "",
    dayIndex: asNumber(day.dayIndex) ?? 0,
    title: asString(day.title) ?? "",
    notes: asString(day.notes),
    meals: dayMeals
      .slice()
      .sort((a, b) => (asNumber(a.orderIndex) ?? 0) - (asNumber(b.orderIndex) ?? 0))
      .map(toNutritionMealDTO)
  };
}

function toNutritionPlanDTO(plan: PlainRecord, planDays: PlainRecord[], mealsByDay: Map<string, PlainRecord[]>): NutritionPlanDTO {
  const orderedDays = planDays
    .slice()
    .sort((a, b) => (asNumber(a.dayIndex) ?? 0) - (asNumber(b.dayIndex) ?? 0))
    .map((day) => toNutritionDayDTO(day, mealsByDay.get(asString(day.recordName) ?? "") ?? []));
  return {
    id: asString(plan.id) ?? "",
    name: asString(plan.name) ?? "",
    startDate: asString(plan.startDate) ?? "",
    notes: asString(plan.notes),
    aiGenerationPrompt: asString(plan.aiGenerationPrompt),
    createdDate: asString(plan.createdDate) ?? "",
    days: orderedDays
  };
}

/** The most recently created `NutritionPlan` record is "the active plan" - see file header. Throws if none exists yet. */
async function findActiveNutritionPlanRecord(): Promise<PlainRecord> {
  const plans = await queryRecords("CD_NutritionPlan", "NutritionPlan");
  if (plans.length === 0) {
    throw new Error("No active nutrition plan found. Use save_nutrition_plan to create one first.");
  }
  return plans
    .slice()
    .sort((a, b) => new Date(asString(b.createdDate) ?? 0).getTime() - new Date(asString(a.createdDate) ?? 0).getTime())[0];
}

/** Finds a day within the active plan by title (exact, then fuzzy) or by numeric `dayIndex` (e.g. "0" for Monday). */
async function findNutritionDayRecord(planRecordName: string, dayRef: string): Promise<PlainRecord> {
  const days = (await queryRecords("CD_NutritionDay", "NutritionDay")).filter((d) => asString(d.plan) === planRecordName);
  const trimmed = dayRef.trim();

  const asIndex = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asIndex) && String(asIndex) === trimmed) {
    const byIndex = days.find((d) => asNumber(d.dayIndex) === asIndex);
    if (byIndex) return byIndex;
  }

  const lower = trimmed.toLowerCase();
  const exact = days.find((d) => asString(d.title)?.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = days.find((d) => asString(d.title)?.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;

  throw new Error(
    `No day found matching "${dayRef}" in the active nutrition plan. Valid days: ${days.map((d) => asString(d.title)).join(", ")}`
  );
}

/** Finds a meal within a day by recipe name or meal name (exact, then fuzzy). */
async function findNutritionMealRecord(dayRecordName: string, mealRef: string): Promise<PlainRecord> {
  const meals = (await queryRecords("CD_NutritionMeal", "NutritionMeal")).filter((m) => asString(m.day) === dayRecordName);
  const lower = mealRef.trim().toLowerCase();

  const exact = meals.find((m) => asString(m.recipeName)?.toLowerCase() === lower || asString(m.name)?.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = meals.find((m) => asString(m.recipeName)?.toLowerCase().includes(lower) || asString(m.name)?.toLowerCase().includes(lower));
  if (fuzzy) return fuzzy;

  throw new Error(
    `No meal found matching "${mealRef}" for that day. Valid meals: ${meals.map((m) => `${asString(m.name)} (${asString(m.recipeName)})`).join(", ")}`
  );
}

function toEpochMillis(dateInput: string): number {
  const ms = new Date(dateInput).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid date/time value: "${dateInput}"`);
  return ms;
}

export interface SaveNutritionMealInput {
  name: string;
  recipeName: string;
  time?: string;
  ingredients?: string[];
  instructions?: string;
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
}

export interface SaveNutritionDayInput {
  /** 0 = Monday ... 6 = Sunday - controls display order, independent of `title`. */
  dayIndex: number;
  title: string;
  notes?: string;
  meals: SaveNutritionMealInput[];
}

export interface SaveNutritionPlanInput {
  name: string;
  startDate?: string;
  notes?: string;
  aiGenerationPrompt?: string;
  days: SaveNutritionDayInput[];
}

async function createNutritionMealRecord(dayRecordName: string, meal: SaveNutritionMealInput, orderIndex: number): Promise<string> {
  const fields: Record<string, { value: unknown; type?: string }> = {
    CD_id: { type: "stringType", value: randomUUID().toUpperCase() },
    CD_entityName: { type: "stringType", value: "NutritionMeal" },
    CD_day: { type: "stringType", value: dayRecordName },
    CD_orderIndex: { type: "int64Type", value: orderIndex },
    CD_name: { type: "stringType", value: meal.name },
    CD_recipeName: { type: "stringType", value: meal.recipeName }
  };
  if (meal.time !== undefined) fields.CD_time = { type: "stringType", value: meal.time };
  // `ingredients` is a `[String]` attribute, stored by SwiftData via the
  // NSSecureUnarchiveFromData transformer - it MUST be an NSKeyedArchiver
  // archive, not plain JSON, or Core Data throws while importing and aborts
  // the whole CloudKit sync. Empty arrays are left unset (the model defaults
  // to []), avoiding an unnecessary agent round-trip.
  if (meal.ingredients !== undefined && meal.ingredients.length > 0) {
    fields.CD_ingredients = { type: "bytesType", value: await encodeArchivedStringArrayBytes("NutritionMeal", "ingredients", meal.ingredients) };
  }
  if (meal.instructions !== undefined) fields.CD_instructions = { type: "stringType", value: meal.instructions };
  if (meal.calories !== undefined) fields.CD_calories = { type: "int64Type", value: meal.calories };
  if (meal.proteinGrams !== undefined) fields.CD_proteinGrams = { type: "doubleType", value: meal.proteinGrams };
  if (meal.carbsGrams !== undefined) fields.CD_carbsGrams = { type: "doubleType", value: meal.carbsGrams };
  if (meal.fatGrams !== undefined) fields.CD_fatGrams = { type: "doubleType", value: meal.fatGrams };
  return await createRecord("CD_NutritionMeal", fields);
}

async function createNutritionDayRecord(planRecordName: string, day: SaveNutritionDayInput): Promise<string> {
  const fields: Record<string, { value: unknown; type?: string }> = {
    CD_id: { type: "stringType", value: randomUUID().toUpperCase() },
    CD_entityName: { type: "stringType", value: "NutritionDay" },
    CD_plan: { type: "stringType", value: planRecordName },
    CD_dayIndex: { type: "int64Type", value: day.dayIndex },
    CD_title: { type: "stringType", value: day.title }
  };
  if (day.notes !== undefined) fields.CD_notes = { type: "stringType", value: day.notes };
  return await createRecord("CD_NutritionDay", fields);
}

/** Deletes a nutrition plan and cascades to its days/meals (REST has no native cascade - see `deleteWorkoutTemplate`). */
async function deleteNutritionPlanRecordCascade(planRecord: PlainRecord): Promise<{ daysRemoved: number; mealsRemoved: number }> {
  const planRecordName = asString(planRecord.recordName);
  const days = (await queryRecords("CD_NutritionDay", "NutritionDay")).filter((d) => asString(d.plan) === planRecordName);
  const meals = await queryRecords("CD_NutritionMeal", "NutritionMeal");

  let mealsRemoved = 0;
  for (const day of days) {
    const dayRecordName = asString(day.recordName);
    for (const meal of meals.filter((m) => asString(m.day) === dayRecordName)) {
      await deleteRecord(meal.recordName as string);
      mealsRemoved++;
    }
    await deleteRecord(day.recordName as string);
  }
  await deleteRecord(planRecord.recordName as string);

  return { daysRemoved: days.length, mealsRemoved };
}

/** Returns the active nutrition plan (most recently created), or `null` if none has been generated yet. */
export async function getNutritionPlan(): Promise<NutritionPlanDTO | null> {
  const plans = await queryRecords("CD_NutritionPlan", "NutritionPlan");
  if (plans.length === 0) return null;

  const activePlan = plans
    .slice()
    .sort((a, b) => new Date(asString(b.createdDate) ?? 0).getTime() - new Date(asString(a.createdDate) ?? 0).getTime())[0];
  const planRecordName = asString(activePlan.recordName);

  const [days, meals] = await Promise.all([queryRecords("CD_NutritionDay", "NutritionDay"), queryRecords("CD_NutritionMeal", "NutritionMeal")]);
  const planDays = days.filter((d) => asString(d.plan) === planRecordName);
  const mealsByDay = groupBy(meals, (m) => asString(m.day));

  return toNutritionPlanDTO(activePlan, planDays, mealsByDay);
}

/**
 * Creates the week's nutrition plan, replacing whatever plan was
 * previously active (deleting it and its days/meals first) so there is
 * always exactly one. Use this for "generate/regenerate my whole week";
 * for smaller tweaks to an existing plan, prefer `updateNutritionMeal`/
 * `updateNutritionDay`/`updateNutritionPlan` instead so unrelated days
 * aren't thrown away.
 */
export async function saveNutritionPlan(
  input: SaveNutritionPlanInput
): Promise<{ id: string; name: string; dayCount: number; mealCount: number; replacedExistingPlan: boolean }> {
  const existingPlans = await queryRecords("CD_NutritionPlan", "NutritionPlan");
  for (const existing of existingPlans) {
    await deleteNutritionPlanRecordCascade(existing);
  }

  const planId = randomUUID().toUpperCase();
  const planFields: Record<string, { value: unknown; type?: string }> = {
    CD_id: { type: "stringType", value: planId },
    CD_entityName: { type: "stringType", value: "NutritionPlan" },
    CD_name: { type: "stringType", value: input.name },
    CD_startDate: { type: "timestampType", value: input.startDate ?? new Date().toISOString() },
    CD_createdDate: { type: "timestampType", value: new Date().toISOString() }
  };
  if (input.notes !== undefined) planFields.CD_notes = { type: "stringType", value: input.notes };
  if (input.aiGenerationPrompt !== undefined) planFields.CD_aiGenerationPrompt = { type: "stringType", value: input.aiGenerationPrompt };
  const planRecordName = await createRecord("CD_NutritionPlan", planFields);

  let mealCount = 0;
  for (const day of input.days) {
    const dayRecordName = await createNutritionDayRecord(planRecordName, day);
    for (let i = 0; i < day.meals.length; i++) {
      await createNutritionMealRecord(dayRecordName, day.meals[i], i);
      mealCount++;
    }
  }

  return { id: planId, name: input.name, dayCount: input.days.length, mealCount, replacedExistingPlan: existingPlans.length > 0 };
}

export interface UpdateNutritionPlanInput {
  name?: string;
  notes?: string;
  /** ISO 8601 date/time. */
  startDate?: string;
  aiGenerationPrompt?: string;
}

/** Adapts plan-level metadata (name/notes/startDate/prompt) on the active plan in place, without touching its days/meals. */
export async function updateNutritionPlan(updates: UpdateNutritionPlanInput): Promise<{ id: string; name: string }> {
  const plan = await findActiveNutritionPlanRecord();

  const fields: Record<string, { value: unknown; type?: string }> = {};
  if (updates.name !== undefined) fields.CD_name = { type: "STRING", value: updates.name };
  if (updates.notes !== undefined) fields.CD_notes = { type: "STRING", value: updates.notes };
  if (updates.startDate !== undefined) fields.CD_startDate = { type: "TIMESTAMP", value: toEpochMillis(updates.startDate) };
  if (updates.aiGenerationPrompt !== undefined) fields.CD_aiGenerationPrompt = { type: "STRING", value: updates.aiGenerationPrompt };
  if (Object.keys(fields).length === 0) {
    throw new Error("No updatable fields provided (name, notes, startDate, aiGenerationPrompt)");
  }

  await modifyRecord({ recordName: plan.recordName as string, recordType: "CD_NutritionPlan", fields });
  return { id: asString(plan.id) ?? "", name: updates.name ?? asString(plan.name) ?? "" };
}

export interface UpdateNutritionDayInput {
  title?: string;
  notes?: string;
  /** Replaces this day's entire meal list (existing meals for this day are deleted first). Omit to leave meals untouched. */
  meals?: SaveNutritionMealInput[];
}

/** Adapts one day of the active plan: rename/re-note it, and/or wholesale-replace its meal list, without touching other days. */
export async function updateNutritionDay(
  dayRef: string,
  updates: UpdateNutritionDayInput
): Promise<{ id: string; title: string; mealCount: number }> {
  const plan = await findActiveNutritionPlanRecord();
  const day = await findNutritionDayRecord(asString(plan.recordName) ?? "", dayRef);
  const dayRecordName = day.recordName as string;

  const fields: Record<string, { value: unknown; type?: string }> = {};
  if (updates.title !== undefined) fields.CD_title = { type: "STRING", value: updates.title };
  if (updates.notes !== undefined) fields.CD_notes = { type: "STRING", value: updates.notes };
  if (Object.keys(fields).length > 0) {
    await modifyRecord({ recordName: dayRecordName, recordType: "CD_NutritionDay", fields });
  }

  const existingMeals = (await queryRecords("CD_NutritionMeal", "NutritionMeal")).filter((m) => asString(m.day) === dayRecordName);
  let mealCount = existingMeals.length;
  if (updates.meals !== undefined) {
    for (const meal of existingMeals) {
      await deleteRecord(meal.recordName as string);
    }
    for (let i = 0; i < updates.meals.length; i++) {
      await createNutritionMealRecord(dayRecordName, updates.meals[i], i);
    }
    mealCount = updates.meals.length;
  }

  if (Object.keys(fields).length === 0 && updates.meals === undefined) {
    throw new Error("No updatable fields provided (title, notes, meals)");
  }

  return { id: asString(day.id) ?? "", title: updates.title ?? asString(day.title) ?? "", mealCount };
}

export interface UpdateNutritionMealInput {
  name?: string;
  time?: string;
  recipeName?: string;
  ingredients?: string[];
  instructions?: string;
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
}

/** Adapts a single meal's recipe/macros/time in place, without touching the rest of the day or plan. */
export async function updateNutritionMeal(
  dayRef: string,
  mealRef: string,
  updates: UpdateNutritionMealInput
): Promise<{ id: string; name: string; recipeName: string }> {
  const plan = await findActiveNutritionPlanRecord();
  const day = await findNutritionDayRecord(asString(plan.recordName) ?? "", dayRef);
  const meal = await findNutritionMealRecord(day.recordName as string, mealRef);

  const fields: Record<string, { value: unknown; type?: string }> = {};
  if (updates.name !== undefined) fields.CD_name = { type: "STRING", value: updates.name };
  if (updates.time !== undefined) fields.CD_time = { type: "STRING", value: updates.time };
  if (updates.recipeName !== undefined) fields.CD_recipeName = { type: "STRING", value: updates.recipeName };
  // See createNutritionMealRecord: `[String]` must be an NSKeyedArchiver
  // archive (via the agent), never plain JSON, or on-device import crashes.
  if (updates.ingredients !== undefined && updates.ingredients.length > 0) {
    fields.CD_ingredients = { type: "BYTES", value: await encodeArchivedStringArrayBytes("NutritionMeal", "ingredients", updates.ingredients) };
  }
  if (updates.instructions !== undefined) fields.CD_instructions = { type: "STRING", value: updates.instructions };
  if (updates.calories !== undefined) fields.CD_calories = { type: "INT64", value: updates.calories };
  if (updates.proteinGrams !== undefined) fields.CD_proteinGrams = { type: "DOUBLE", value: updates.proteinGrams };
  if (updates.carbsGrams !== undefined) fields.CD_carbsGrams = { type: "DOUBLE", value: updates.carbsGrams };
  if (updates.fatGrams !== undefined) fields.CD_fatGrams = { type: "DOUBLE", value: updates.fatGrams };
  if (Object.keys(fields).length === 0) {
    throw new Error(
      "No updatable fields provided (name, time, recipeName, ingredients, instructions, calories, proteinGrams, carbsGrams, fatGrams)"
    );
  }

  await modifyRecord({ recordName: meal.recordName as string, recordType: "CD_NutritionMeal", fields });
  return {
    id: asString(meal.id) ?? "",
    name: updates.name ?? asString(meal.name) ?? "",
    recipeName: updates.recipeName ?? asString(meal.recipeName) ?? ""
  };
}

/** Deletes the active nutrition plan and its days/meals. */
export async function deleteNutritionPlan(): Promise<{ deleted: string; daysRemoved: number; mealsRemoved: number }> {
  const plan = await findActiveNutritionPlanRecord();
  const { daysRemoved, mealsRemoved } = await deleteNutritionPlanRecordCascade(plan);
  return { deleted: asString(plan.name) || "Nutrition Plan", daysRemoved, mealsRemoved };
}
