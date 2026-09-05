#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeTrainingVolume,
  createExercise,
  deleteExercise,
  deleteNutritionPlan,
  deleteWorkoutTemplate,
  getExerciseHistory,
  getExerciseLibrary,
  getNutritionPlan,
  getRecoveryStatus,
  getTrainingPreferences,
  getWorkoutHistory,
  getWorkoutTemplates,
  saveNutritionPlan,
  savePeriodizationPlan,
  saveWorkoutTemplate,
  updateExercise,
  updateNutritionDay,
  updateNutritionMeal,
  updateNutritionPlan,
  updateWorkoutTemplate,
  updateWorkoutTemplateName
} from "./workoutStore.js";

const server = new McpServer({
  name: "gymtimer-mcp-server",
  version: "1.0.0"
});

function jsonToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
  };
}

function errorToolResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

server.registerTool(
  "get_workout_history",
  {
    title: "Get Workout History",
    description:
      "Returns completed workout sessions (with every exercise and set) from the last N days, newest first. Use this to see what the user actually did recently. Each session includes difficultyRating (1-5, how hard the user said the workout felt right after finishing it, 5 being extremely hard) when available - use it alongside volume/reps trends to judge whether intensity or volume should change.",
    inputSchema: {
      days: z.number().int().positive().default(30).describe("How many days back to look, e.g. 7, 14, 30")
    }
  },
  async ({ days }) => {
    try {
      return jsonToolResult(await getWorkoutHistory(days));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "get_exercise_history",
  {
    title: "Get Exercise History",
    description:
      "Returns every logged set for one specific exercise over time (most recent first), so you can see progression (reps/weight trend) for that movement.",
    inputSchema: {
      exerciseName: z.string().min(1).describe('Exercise name, e.g. "Bench Press" (fuzzy-matched)'),
      limit: z.number().int().positive().optional().describe("Optional cap on the number of history entries returned")
    }
  },
  async ({ exerciseName, limit }) => {
    try {
      return jsonToolResult(await getExerciseHistory(exerciseName, limit));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "analyze_training_volume",
  {
    title: "Analyze Training Volume",
    description:
      "Aggregates sets/reps/volume (reps x weight) over the last N days, grouped either by muscle group or by exercise. Use this to spot over/under-trained muscle groups before proposing a workout.",
    inputSchema: {
      days: z.number().int().positive().default(7).describe("How many days back to aggregate, e.g. 7, 14, 30"),
      groupBy: z.enum(["muscle_group", "exercise"]).default("muscle_group")
    }
  },
  async ({ days, groupBy }) => {
    try {
      return jsonToolResult(await analyzeTrainingVolume(days, groupBy));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "get_recovery_status",
  {
    title: "Get Recovery Status",
    description:
      "Returns days since each muscle group was last trained, plus sets trained this week, so you can judge whether a muscle group is ready to train again.",
    inputSchema: {
      muscleGroup: z
        .string()
        .optional()
        .describe('Optional single muscle group to filter to, e.g. "quads", "chest" (see get_exercise_library for valid values)')
    }
  },
  async ({ muscleGroup }) => {
    try {
      return jsonToolResult(await getRecoveryStatus(muscleGroup));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "get_exercise_library",
  {
    title: "Get Exercise Library",
    description:
      "Returns the user's exercise library (name, muscle groups, equipment, category, movement pattern, whether it has a custom photo), optionally filtered. Use this to know what exercises/equipment are available when proposing a workout. Note: `category` and `movementPattern` are null when the exercise has no stored value, and in practice are unreliable even when set (this app's exercises are largely left at the defaults \"compound\"/\"push\", so a hinge or isometric movement may still report \"push\"). Judge movement patterns from the exercise name and muscleGroups instead of trusting these two fields.",
    inputSchema: {
      muscleGroup: z.string().optional().describe("Comma-separated muscle groups to filter to, e.g. \"quads,hamstrings\""),
      equipment: z.string().optional().describe("Comma-separated equipment types to filter to, e.g. \"barbell,dumbbell\"")
    }
  },
  async ({ muscleGroup, equipment }) => {
    try {
      return jsonToolResult(await getExerciseLibrary(muscleGroup, equipment));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "get_training_preferences",
  {
    title: "Get Training Preferences",
    description:
      "Returns the user's full profile: training preferences (goal, experience level, available equipment, days per week, session length, injuries/limitations) PLUS body/personal info (height, weight, age, biological sex, body type, fat distribution, activity level) and food preferences (dietary restrictions/allergies, cuisine/food notes, nutrition goal, daily calorie/macro targets). Always check this before generating a workout AND before generating or adapting a nutrition plan (see save_nutrition_plan).",
    inputSchema: {}
  },
  async () => {
    try {
      return jsonToolResult(await getTrainingPreferences());
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "create_exercise",
  {
    title: "Create Exercise",
    description:
      "Adds a new exercise to the user's library, optionally with a photo. Note: the new exercise's category/movement pattern aren't set by this tool (a known limitation) - it'll show up on the user's devices with default values (compound/push) until edited from the app.",
    inputSchema: {
      name: z.string().min(1).describe('Exercise name, e.g. "Incline Dumbbell Press"'),
      muscleGroups: z
        .array(z.string())
        .describe(
          'Muscle groups worked, e.g. ["chest","triceps"]. Must be one of: chest, back, shoulders, biceps, triceps, forearms, abs, quads, hamstrings, glutes, calves, fullBody, cardio (e.g. "core" is invalid - use "abs"). Invalid values are rejected with an error rather than silently written, since a bad value crashes the app until fixed.'
        ),
      equipment: z
        .array(z.string())
        .describe(
          'Equipment needed, e.g. ["dumbbell","bench"]. Must be one of: barbell, dumbbell, kettlebell, machine, cable, bodyweight, band, bench, pullUpBar, trx, other.'
        ),
      photoPath: z
        .string()
        .optional()
        .describe(
          'Absolute local file path to a photo/image to attach (jpg/png/heic, max 15MB), e.g. "/Users/me/Pictures/lat-pulldown.jpg". Uploaded as the exercise\'s custom photo, shown instead of the default icon.'
        )
    }
  },
  async ({ name, muscleGroups, equipment, photoPath }) => {
    try {
      return jsonToolResult(await createExercise({ name, muscleGroups, equipment, photoPath }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_exercise",
  {
    title: "Update Exercise",
    description:
      "Updates an existing exercise's name, muscle groups, equipment, and/or photo (fuzzy-matched by name, or exact by id). Category and movement pattern can't be changed by this tool (a known limitation) - edit those from the app.",
    inputSchema: {
      exercise: z.string().min(1).describe('Exercise name or id to update, e.g. "Bench Press"'),
      name: z.string().optional().describe("New name, if renaming"),
      muscleGroups: z
        .array(z.string())
        .optional()
        .describe(
          "Replacement muscle groups list, if changing. Must be one of: chest, back, shoulders, biceps, triceps, forearms, abs, quads, hamstrings, glutes, calves, fullBody, cardio."
        ),
      equipment: z
        .array(z.string())
        .optional()
        .describe(
          "Replacement equipment list, if changing. Must be one of: barbell, dumbbell, kettlebell, machine, cable, bodyweight, band, bench, pullUpBar, trx, other."
        ),
      photoPath: z
        .string()
        .optional()
        .describe("Absolute local file path to a new/replacement photo (jpg/png/heic, max 15MB). Replaces any existing photo."),
      removePhoto: z
        .boolean()
        .optional()
        .describe("Set true to remove this exercise's existing custom photo. Ignored if photoPath is also provided.")
    }
  },
  async ({ exercise, name, muscleGroups, equipment, photoPath, removePhoto }) => {
    try {
      return jsonToolResult(await updateExercise(exercise, { name, muscleGroups, equipment, photoPath, removePhoto }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "delete_exercise",
  {
    title: "Delete Exercise",
    description: "Deletes an exercise from the user's library (fuzzy-matched by name, or exact by id).",
    inputSchema: {
      exercise: z.string().min(1).describe('Exercise name or id to delete, e.g. "Leg Press"')
    }
  },
  async ({ exercise }) => {
    try {
      return jsonToolResult(await deleteExercise(exercise));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

/**
 * One exercise slot in a workout template. Shared by save_workout_template
 * and update_workout_template so the two always accept exactly the same
 * shape - which is also what get_workout_templates returns, making a
 * read-modify-write round trip lossless.
 */
const templateExerciseSlotSchema = z.object({
  exerciseNameOrId: z.string().min(1).describe("Must match an existing exercise's name or id"),
  targetSets: z.number().int().positive(),
  targetReps: z.number().int().positive().describe("Fallback rep target used when targetRepsPerSet isn't provided"),
  restSeconds: z.number().int().positive(),
  targetRepsPerSet: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      "Optional per-set rep scheme (e.g. [12,10,8,8] for a pyramid). Must have exactly targetSets entries. Omit for straight sets (every set uses targetReps)."
    ),
  cadence: z
    .string()
    .optional()
    .describe('Optional tempo notation, e.g. "3-1-1" (eccentric-pause-concentric seconds). Omit for isometric holds or when tempo doesn\'t apply.'),
  intensity: z
    .string()
    .optional()
    .describe('Optional target intensity as RIR (reps in reserve) or RPE, e.g. "RIR 2" or "RPE 8". Omit when intensity isn\'t prescribed for this exercise.'),
  targetWeight: z
    .number()
    .positive()
    .optional()
    .describe(
      "Optional suggested working weight for this exercise slot (same unit convention as the user's own logged history - kg or lb, not enforced here). A starting-point recommendation, not a hard target. Omit when no weight is prescribed (e.g. bodyweight exercises)."
    ),
  supersetGroup: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Groups this slot into a superset (exercises performed back-to-back with no rest, one round at a time, sharing round count) with every OTHER slot in this same exercises array that has the SAME supersetGroup number, e.g. 1. Just a label to link slots within this one call - not stored as-is. Slots sharing a group MUST be placed consecutively (e.g. A1,B1,A2,B2 as one exercise-1/exercise-2 pair each with targetSets=2, not grouped by round) - a non-contiguous group is rejected. Omit for a standalone exercise."
    )
});

server.registerTool(
  "get_workout_templates",
  {
    title: "Get Workout Templates",
    description:
      "Returns the user's saved workout templates (training session blueprints) with their full ordered exercise lists - target sets/reps/rest plus tempo, intensity, suggested weight and superset grouping for every slot. Each slot comes back in exactly the shape save_workout_template/update_workout_template accept, so you can read a template, change part of it, and write it back without losing anything. Use this before update_workout_template - that tool replaces the whole exercise list, so you need the current one first.",
    inputSchema: {
      template: z
        .string()
        .optional()
        .describe('Optional single template to return, by name (fuzzy-matched) or id, e.g. "Push Day A". Omit to return all templates.')
    }
  },
  async ({ template }) => {
    try {
      return jsonToolResult(await getWorkoutTemplates(template));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "save_workout_template",
  {
    title: "Save Workout Template",
    description:
      "Creates a NEW workout template (a reusable training session blueprint) with an ordered list of exercises, each with target sets/reps/rest and optional tempo/cadence, intensity (RIR/RPE), suggested working weight, and superset grouping. Exercises must already exist in the library (see get_exercise_library, or create_exercise first). To change an existing template instead, use update_workout_template - creating a duplicate and deleting the old one loses its link to past workouts.",
    inputSchema: {
      name: z.string().min(1).describe('Template name, e.g. "Push Day A"'),
      estimatedDurationMinutes: z.number().positive().optional().describe("Estimated session length in minutes"),
      exercises: z
        .array(templateExerciseSlotSchema)
        .min(1)
        .describe("Ordered list of exercises for this template. To create a superset, give 2+ consecutive entries the same supersetGroup number.")
    }
  },
  async ({ name, estimatedDurationMinutes, exercises }) => {
    try {
      return jsonToolResult(await saveWorkoutTemplate({ name, estimatedDurationMinutes, exercises }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_workout_template",
  {
    title: "Update Workout Template",
    description:
      "Edits an existing workout template in place - its name, estimated duration, and/or its exercises - keeping the template itself, so its link to past workouts in history (and to any periodization cycle) survives. This is the tool for requests like \"swap the first three exercises of my chest day for cable variations\" or \"add a set to every exercise\". IMPORTANT: `exercises` REPLACES the entire exercise list, so call get_workout_templates first and send the full list back with your changes applied; omit `exercises` to change only the name/duration. Prefer this over delete_workout_template + save_workout_template.",
    inputSchema: {
      template: z.string().min(1).describe('Template to edit, by name (fuzzy-matched) or id, e.g. "Push Day A"'),
      name: z.string().min(1).optional().describe("New template name, if renaming"),
      estimatedDurationMinutes: z.number().positive().optional().describe("Replacement estimated session length in minutes"),
      exercises: z
        .array(templateExerciseSlotSchema)
        .min(1)
        .optional()
        .describe(
          "If provided, REPLACES this template's entire ordered exercise list (every existing slot is deleted first). Read the current list with get_workout_templates and send it back with your edits applied, or any slot you leave out is removed. Omit to leave the exercises untouched."
        )
    }
  },
  async ({ template, name, estimatedDurationMinutes, exercises }) => {
    try {
      return jsonToolResult(await updateWorkoutTemplate({ template, name, estimatedDurationMinutes, exercises }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_workout_template_name",
  {
    title: "Update Workout Template Name",
    description: "Renames an existing workout template in place (fuzzy-matched by name, or exact by id). Doesn't touch its exercises.",
    inputSchema: {
      template: z.string().min(1).describe('Current template name or id, e.g. "Push Day A"'),
      newName: z.string().min(1).describe("New name for the template")
    }
  },
  async ({ template, newName }) => {
    try {
      return jsonToolResult(await updateWorkoutTemplateName(template, newName));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "delete_workout_template",
  {
    title: "Delete Workout Template",
    description: "Deletes a workout template and its exercise slots (fuzzy-matched by name, or exact by id). Does not delete workout history/sessions that already used it.",
    inputSchema: {
      template: z.string().min(1).describe('Template name or id to delete, e.g. "Push Day A"')
    }
  },
  async ({ template }) => {
    try {
      return jsonToolResult(await deleteWorkoutTemplate(template));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "save_periodization_plan",
  {
    title: "Save Periodization Plan",
    description:
      "Creates a periodization cycle (a named training block, e.g. a hypertrophy or strength block with a start/end date) and optionally links existing workout templates to it. Note: the cycle's training phase isn't set by this tool (a known limitation) - edit that from the app.",
    inputSchema: {
      name: z.string().min(1).describe('Cycle name, e.g. "Hypertrophy Block 1"'),
      startDate: z.string().optional().describe("ISO 8601 date/time the cycle starts (defaults to now)"),
      endDate: z.string().optional().describe("ISO 8601 date/time the cycle ends"),
      notes: z.string().optional().describe("Free-form notes about this training block"),
      templateNamesOrIds: z
        .array(z.string())
        .optional()
        .describe("Names or ids of existing workout templates to mark as part of this cycle")
    }
  },
  async ({ name, startDate, endDate, notes, templateNamesOrIds }) => {
    try {
      return jsonToolResult(await savePeriodizationPlan({ name, startDate, endDate, notes, templateNamesOrIds }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

// MARK: - Nutrition Plan
//
// There is always exactly one *active* nutrition plan (the most recently
// created one - see workoutStore.ts's findActiveNutritionPlanRecord).
// `save_nutrition_plan` replaces it wholesale; the `update_*` tools adapt
// it in place for smaller changes so "swap Tuesday's lunch" doesn't
// require regenerating the whole week.

const nutritionMealSchema = z.object({
  name: z.string().min(1).describe('Meal slot name, e.g. "Breakfast", "Lunch", "Dinner", "Snack"'),
  recipeName: z.string().min(1).describe('Recipe/dish name, e.g. "Spanish Tortilla de Patatas"'),
  time: z.string().optional().describe('Optional suggested time, e.g. "8:00 AM"'),
  ingredients: z.array(z.string()).optional().describe('Ingredient list, e.g. ["4 eggs", "2 potatoes", "1 onion"]'),
  instructions: z.string().optional().describe("Free-form cooking instructions"),
  calories: z.number().int().positive().optional(),
  proteinGrams: z.number().nonnegative().optional(),
  carbsGrams: z.number().nonnegative().optional(),
  fatGrams: z.number().nonnegative().optional()
});

const nutritionDaySchema = z.object({
  dayIndex: z.number().int().min(0).max(6).describe("0 = Monday ... 6 = Sunday, controls display order"),
  title: z.string().min(1).describe('e.g. "Monday"'),
  notes: z.string().optional(),
  meals: z.array(nutritionMealSchema).describe("Ordered list of meals for this day")
});

server.registerTool(
  "get_nutrition_plan",
  {
    title: "Get Nutrition Plan",
    description:
      "Returns the single active nutrition plan - the week's days and meals with full recipe details (ingredients, instructions, calories/macros) - or null if none has been generated yet.",
    inputSchema: {}
  },
  async () => {
    try {
      return jsonToolResult(await getNutritionPlan());
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "save_nutrition_plan",
  {
    title: "Save Nutrition Plan",
    description:
      "Creates the week's nutrition plan. IMPORTANT: there is always exactly one active plan - calling this REPLACES whatever plan currently exists (deleting it and its days/meals) rather than creating a second one. Use this to generate/regenerate the whole week; for smaller tweaks to specific meals or days, prefer update_nutrition_meal / update_nutrition_day / update_nutrition_plan instead so the rest of the week isn't thrown away. Before calling this, check get_training_preferences (body stats + food preferences/restrictions) and ideally get_workout_history/get_recovery_status so the plan reflects the user's actual training and goals.",
    inputSchema: {
      name: z.string().min(1).describe('Plan name, e.g. "Week of July 14"'),
      startDate: z.string().optional().describe("ISO 8601 date/time this week starts (defaults to now)"),
      notes: z.string().optional().describe("Free-form plan-level notes"),
      aiGenerationPrompt: z.string().optional().describe("The prompt that produced this plan, if you generated it"),
      days: z.array(nutritionDaySchema).min(1).describe("The full week, one entry per day, each with its ordered meals")
    }
  },
  async ({ name, startDate, notes, aiGenerationPrompt, days }) => {
    try {
      return jsonToolResult(await saveNutritionPlan({ name, startDate, notes, aiGenerationPrompt, days }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_nutrition_plan",
  {
    title: "Update Nutrition Plan",
    description:
      "Adapts plan-level metadata (name, notes, start date, and/or the generation prompt) on the active nutrition plan in place, without touching its days or meals.",
    inputSchema: {
      name: z.string().optional().describe("New plan name, if renaming"),
      notes: z.string().optional().describe("Replacement plan-level notes"),
      startDate: z.string().optional().describe("Replacement ISO 8601 date/time this week starts"),
      aiGenerationPrompt: z.string().optional().describe("Replacement record of the prompt that produced/adapted this plan")
    }
  },
  async ({ name, notes, startDate, aiGenerationPrompt }) => {
    try {
      return jsonToolResult(await updateNutritionPlan({ name, notes, startDate, aiGenerationPrompt }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_nutrition_day",
  {
    title: "Update Nutrition Day",
    description:
      "Adapts one day of the active nutrition plan: rename/re-note it, and/or replace its whole meal list - without touching other days. Use update_nutrition_meal instead for a single-meal tweak (e.g. just swapping one recipe).",
    inputSchema: {
      day: z.string().min(1).describe('Day to update - its title (e.g. "Monday", fuzzy-matched) or numeric dayIndex ("0"-"6")'),
      title: z.string().optional().describe("New day title, if renaming"),
      notes: z.string().optional().describe("Replacement day-level notes"),
      meals: z
        .array(nutritionMealSchema)
        .optional()
        .describe("If provided, REPLACES this day's entire meal list (existing meals for this day are deleted first)")
    }
  },
  async ({ day, title, notes, meals }) => {
    try {
      return jsonToolResult(await updateNutritionDay(day, { title, notes, meals }));
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "update_nutrition_meal",
  {
    title: "Update Nutrition Meal",
    description:
      "Adapts a single meal's recipe, ingredients, instructions, macros, and/or time within the active nutrition plan, without regenerating the rest of the day or week. The main tool for requests like \"swap Tuesday's lunch for something else\" or \"make Wednesday's dinner higher protein\".",
    inputSchema: {
      day: z.string().min(1).describe('Day the meal belongs to - title (e.g. "Monday", fuzzy-matched) or numeric dayIndex ("0"-"6")'),
      meal: z.string().min(1).describe('Meal to update, matched by its meal name or recipe name (e.g. "Breakfast" or "Tortilla")'),
      name: z.string().optional().describe('New meal slot name, e.g. "Breakfast"'),
      time: z.string().optional().describe('New suggested time, e.g. "8:00 AM"'),
      recipeName: z.string().optional().describe("New recipe/dish name"),
      ingredients: z.array(z.string()).optional().describe("Replacement ingredient list"),
      instructions: z.string().optional().describe("Replacement cooking instructions"),
      calories: z.number().int().positive().optional(),
      proteinGrams: z.number().nonnegative().optional(),
      carbsGrams: z.number().nonnegative().optional(),
      fatGrams: z.number().nonnegative().optional()
    }
  },
  async ({ day, meal, name, time, recipeName, ingredients, instructions, calories, proteinGrams, carbsGrams, fatGrams }) => {
    try {
      return jsonToolResult(
        await updateNutritionMeal(day, meal, { name, time, recipeName, ingredients, instructions, calories, proteinGrams, carbsGrams, fatGrams })
      );
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

server.registerTool(
  "delete_nutrition_plan",
  {
    title: "Delete Nutrition Plan",
    description: "Deletes the active nutrition plan and all its days/meals.",
    inputSchema: {}
  },
  async () => {
    try {
      return jsonToolResult(await deleteNutritionPlan());
    } catch (error) {
      return errorToolResult(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting mcp-workout-server:", error);
  process.exit(1);
});
