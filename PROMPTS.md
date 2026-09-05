# Prompts that work

Copy any of these into Cursor, Claude, or whichever AI app you connected, and
edit the bits in **bold**. They're written out in full because the difference
between a useful plan and a generic one is almost entirely about telling the
assistant to look at your data first.

## The one rule behind all of them: make it read your profile

Left to itself, an assistant will happily invent a plan for an average person.
The fix is one sentence at the start of every prompt: **read my profile first.**

The `get_training_preferences` tool returns your whole profile in one call:

- **Training** - goal, experience level, available equipment, days per week,
  preferred session length, injuries and limitations
- **Body** - height, weight, age, biological sex, body type, fat distribution,
  activity level
- **Food** - dietary restrictions and allergies, cuisine notes, nutrition goal,
  daily calorie and macro targets

All of it is what you entered in the app's Profile tab, so a plan built from it
uses your real numbers. Every prompt below starts there.

---

## 1. Generate a full training week

```
Design my training week and save it to the app.

First, read my data:
- get_training_preferences - my goal, experience level, equipment, days per
  week, preferred session length, and any injuries
- get_workout_history for the last 28 days - what I've actually been doing,
  including the difficultyRating I gave each session
- analyze_training_volume for the last 14 days grouped by muscle group - where
  my volume actually went
- get_recovery_status - how long since I trained each muscle group
- get_exercise_library - what I have to work with

Then design a week that:
- has exactly as many sessions as my profile's days per week
- fits my preferred session length
- uses only equipment listed in my profile
- works around my injuries, substituting movements where needed
- gives priority to the muscle groups the volume analysis shows I've
  under-trained
- doesn't hit a muscle group that get_recovery_status says I trained in the
  last 48 hours
- eases off if my recent difficultyRating values were consistently 4-5, and
  adds volume if they were consistently 1-2

Before saving anything, show me the whole week as a table and tell me which
profile values you used and which muscle groups you're prioritising, so I can
check your reasoning. Wait for my approval.

Once I approve, save each training day with save_workout_template, naming them
clearly (e.g. "Push A", "Pull A", "Legs A"). Include per-exercise target sets,
reps and rest, plus intensity as RIR where it's useful.
```

Why it's this long: the "wait for my approval" line matters because
`save_workout_template` writes straight to your phone, and asking it to state
which profile values it used is how you catch a plan built on assumptions rather
than your data.

**Variations**

- Add `Group accessory work into supersets where it saves time.` The
  `supersetGroup` field handles this, but exercises sharing a group must be
  consecutive in the list, which the tool will enforce.
- Add `Suggest a starting working weight for each exercise based on my logged
  history.` This fills in `targetWeight`.
- Add `Use a pyramid rep scheme on the main compound lifts.` This fills in
  `targetRepsPerSet` per set.

## 2. Generate a full nutrition week

```
Build my nutrition plan for the week and save it to the app.

First, read my data:
- get_training_preferences - my height, weight, age, biological sex, activity
  level, nutrition goal, daily calorie target, macro targets, dietary
  restrictions and allergies, and my cuisine notes
- get_workout_history for the last 14 days - so you know which days of the week
  I actually train

Then build 7 days of meals that:
- hit my daily calorie and macro targets from the profile (if any are missing,
  estimate them from my body stats, activity level and goal, and tell me what
  you assumed)
- put more carbohydrate on my training days and fewer on rest days, keeping
  protein steady every day
- respect every dietary restriction and allergy without exception
- follow the cuisine style in my food preferences
- reuse ingredients across the week so the shopping list stays realistic, and
  repeat breakfasts rather than inventing seven different ones

For each meal include the recipe name, a suggested time, the ingredient list
with quantities, short cooking instructions, and its calories, protein, carbs
and fat.

Show me the week with daily calorie and macro totals first so I can check it
against my targets. Then save it with save_nutrition_plan.
```

**Important:** `save_nutrition_plan` **replaces** your active plan - there is
only ever one, so saving a new week deletes the previous one along with its days
and meals. That's what you want when regenerating the whole week. For anything
smaller, use the prompts below instead, which edit the existing plan in place.

---

## Everyday asks

Short ones. Each names the tool it will end up using, so you can see what's
being touched.

**Swap one meal** - `update_nutrition_meal`, leaves the rest of the week alone.

```
Swap Tuesday's lunch for something with at least 15g more protein, same
calories, same cuisine style. Check my restrictions in
get_training_preferences first, then update just that meal.
```

**Redo one day** - `update_nutrition_day`.

```
I'm eating out on Saturday night. Rebuild just Saturday around a restaurant
dinner, keeping my weekly calorie average intact, and update only that day.
```

**Rebalance an existing template** - `get_workout_templates` then
`update_workout_template`. Reading first is essential: sending an exercise list
replaces the entire list, so anything left out gets removed.

```
Read my "Push A" template, then update it in place: swap the flat barbell press
for an incline dumbbell press, add one set to the lateral raises, and cut rest
on the isolation work to 60 seconds. Keep everything else exactly as it is.
```

**Review last week** - read-only, nothing gets written.

```
Compare my last 7 days against the 7 before, using get_workout_history and
analyze_training_volume. Tell me where volume went up or down by muscle group,
whether my difficulty ratings moved, and the single change you'd make next week.
```

**Start a training block** - `save_periodization_plan`.

```
Read my profile and last 6 weeks of history, then set up a 6-week hypertrophy
block starting Monday with save_periodization_plan, and link my existing
Push/Pull/Legs templates to it. Tell me how each week should progress.
```

**Add equipment you now have** - `create_exercise`.

```
My gym just got a **hack squat machine**. Add it to my exercise library with
create_exercise, with the right muscle groups and equipment type, then tell me
which of my existing templates it would improve.
```

**Track one lift** - `get_exercise_history`.

```
Show my **bench press** progression over the last 3 months from
get_exercise_history: estimated 1RM trend, total volume per session, and whether
I've actually been progressing or just maintaining.
```

**Check what's recovered before training today**

```
Using get_recovery_status and my last 7 days of history, tell me what's
recovered enough to train hard today, then build me a single session for it that
fits my profile's session length.
```

---

## Why a saved plan might not look exactly like you expect

Two known behaviours, both harmless once you know them:

- **Some fields keep the app's defaults.** An exercise's `category` and
  `movementPattern`, and a training cycle's `phase`, are never set by these
  tools - they'd risk corrupting how the app stores them. New exercises and
  cycles get the app's defaults (`compound`, `push`, `hypertrophy`) until you
  edit them on your phone. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reason.
- **Your profile is read-only here.** The assistant can read every body and
  food field but can't change them; the app is the editor. If a plan is built on
  a stale weight or calorie target, update it in the app's Profile tab and ask
  again.
