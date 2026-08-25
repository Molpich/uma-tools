# Race simulator extension

This document describes the expanded `umalator` comparison simulator, how its newer models work and the remaining issues/approximations.

## What is new

The original simulator primarily estimated the efficiency of certain skills and stats and could be used as guidance. However, it intentionally didn't model interaction between umas during a race and approximated many different skills and completely ignored many conditions, especially lane/blocking and rank-related skills were modeled rather optimistically. This extension aims to more accurately model interaction and skill conditions and generaly more accurately represent the games actual behaviour. Note that due to the heavily increased simulation overhead the performance is obviously worse and you may need to wait a bit longer, especially for the skills table simulation.

The UI has main modes:

- **Compare** runs the configured Uma 1 other Uma builds and reports their distance distribution, head-to-head win rate, field win rate when applicable, representative runs, skill activation summaries, and all-run Monte Carlo graphs.
- **Skill table** now opens an evaluation workspace with two internal tabs. **Skills** measures candidate skill additions. Enablding the new experimental modes should more accurately measure skill efficacy and even potential negative effects of a skill if it denies a rank-dependent skill. 
**Umas** applies Uma 1's skills/build to each candidate, adds that candidate's level-1 unique, uses her default strategy, and compares her against a separate same-strategy no-unique baseline. This is mostly just meant to roughly see if an uma(non-inherited version, using her base style) has potential to be strong for the specified track. But take it with a major grain of salt, it's just a rough guidance for players to possibly test an Uma that the simulation valued highly.
- **Stamina calculator** retains the focused stamina workflow.

Uma 1 remains the primary editor, with a clearly visible **Other Umas** tab beside it. That tab uses the same HorseDef editor layout, initially showing Uma 2, and places clickable runner cards directly below it with each runner's style and summary. Selecting a card swaps that runner into the same editor. Uma 2 is still the internal Runner 2 comparison opponent, so this is a UI consolidation only and the internal two-runner baseline/candidate comparisons are unchanged.

## Comparison and sampling

All runs contribute to the reported distribution. Minimum and maximum are actual runs. Mean and median displays also select actual runs nearest the mathematical statistic; an even-sized sample set uses the lower middle run as its concrete median trajectory.

Skill comparisons use paired random inputs so the baseline and candidate see the same general race randomness. The idea behind is is to isolute the skills actual impact and minize variance due to different RNG.

The skill table uses adaptive checkpoints. Low-variance rows may stop early; noisy or plausibly relevant random effects receive more samples up to the configured safeguards.

## Shared-clock field model

When **Experimental full-field ranks** is enabled, every runner advances at 15 Hz in the same simulation loop. The field supplies:

- stable live longitudinal ranks and field-size-aware `order` / `order_rate` comparisons
- rank history, order gains and losses, nearby-runner counts, distance to leader/last place, visible runners, and overtake-target state;
- configurable runners 3–18, including build, strategy, skills, activation policies, and locally stored field presets
- head-to-head and whole-field outcomes with finish order and gap
- supported opponent-targeted effects routed by relative position, field of view, strategy, rushed state, or recovery state
- a stored median-run replay with ranks, longitudinal position, optional lanes, active states, skill activations, bonus acceleration, and total acceleration

The field uses deterministic post and seed handling. Copied-state links include the field configuration, and synthetic opponents are created from averaged comparison stats with a deterministic strategy mix.

### Finish interpolation

Physics still advances at 1/15 second. When a runner crosses the finish between two ticks, time and position are linearly interpolated within that final interval. This prevents sub-tick advantages from being collapsed into ties and preserves small distance gains in skill evaluation.

## Lane movement

Lane movement is an additional experimental option on top of full-field ranks. Lane zero is the inner rail. Positions and lateral speeds are represented internally in horse-width units; one course width is treated as 18 horse widths.

The implemented movement model follows the published, datamine-derived mechanics references listed below (see sources at the end):

- target lateral speed is `0.02 × (0.3 + 0.001 × power) × start modifier × rank modifier` course-widths per second;
- lateral acceleration is `0.02 × 1.5` course-widths per second squared;
- the start modifier increases slightly with starting lane distance, and the late-race modifier increases with rank;
- inward movement receives the documented inner-movement multiplier;
- the target is reconsidered when the runner comes within half a horse width or the movement side becomes blocked;
- front blocking uses `0 < gap < 2 m` and the narrowing lateral cone `(1 - 0.6 × gap / 2) × 0.75 horse widths`;
- side blocking uses `|gap| < 1.05 m` and less than two horse widths laterally;
- an overtake target normally has to be 1–20 m ahead, catchable within 15 seconds at the current speed difference, and slower in target-speed terms. The nearest front blocker is always eligible.

Target-lane selection is is still approximate.

When lanes are disabled, lane-qualified conditions retain only their necessary longitudinal checks. This is deliberately permissive and can overestimate activation rates of certain skills related to blocking/lanes. When lanes are enabled, the documented front/side geometry is applied to condition state.

The following are **not** applied by lane movement:

- the physical front-blocking speed cap;
- extra distance traveled on a wider curved path;
- exact course-width limits and course-specific width changes;
- collisions, every special target-lane mode, straight-course exceptions, and all skill-directed lane targets;
- a verified target-selection algorithm.

The replay track is schematic. Its centerline is reconstructed from exact course distance, straights, corners, and turn direction, but it is not survey-accurate racecourse geometry. This is fine for shorter tracks but often buggy/wrong for longer (multi-lap) race courses. Despite this, the replay itself should be accurate, regardless of how the track looks.

## Skill-condition and effect changes

The condition engine can receive live field values instead of treating every opponent-dependent condition as an assumed success/fail based on some "random" logic. The main additions are:

- dynamic preconditions remain distinct from the eventual activation condition;
- prior-history counters remain distinct from events emitted during a skill's active duration (e.g. Bamboo Memory unqie should be accurate);
- a general race-event subscription path can scale any supported effect type;
- current events include overtaking, being overtaken, and another skill activating;
- supported effect resolution can change target speed, current speed, acceleration, HP recovery, or other known effect types at activation or after an active-duration event;
- activation-count and recovery-count state supports chained-skill conditions;
- remaining-HP effect scaling and known start-of-race green-skill scaling are resolved from simulation state;
- unique/evolved level scaling is applied by effect type;
- opponent effects can be attached to field targets instead of incorrectly modifying only the source runner.

`@` condition branches are parsed as alternative activation regions. That is different from data entries whose alternative records describe priority-ordered stronger/weaker effects. A priority resolver exists for the audited trigger-style case, and `audit:skill-branches` lists other multi-alternative records for manual review. `audit:special-scaling` flags effect patterns that may need runtime scaling rather than a constant modifier.
(TDLR; Some skills with `@` condition are not yet correctly implemented)

This infrastructure reduces the code needed for future event-based skills -> add a reusable event emitter or condition adapter -> return a boolean/count or effect scaling result. This should hopefully make new (unique) skill effects easier to manually implement after an update.

## Monte Carlo analysis and replay

The compare result includes all-run summaries rather than relying only on a representative trajectory:

- mean velocity over time
- lead over time and lead by race position
- pointwise median and percentile bands
- per-skill activation rate, non-activation count, and activation position/time distributions
- consistency checks between accumulated position and reported velocity

Finished runners are held at the finish for time-indexed position statistics and treated as stopped for mean velocity. Distance-indexed lead uses the frontmost runner's distance as its x-axis and stops a run when the first runner finishes, preserving the winning gap at the endpoint.

## Known limitations

The most important remaining limitations are:

- **Position keeping is incomplete.** The existing synthetic pacer and supported modes remain, but this is not a complete multi-runner reproduction of all game AI.
- **Physical interaction is incomplete.** Blocking state can activate skills, but it does not slow a runner. Lane overlap and curved-lane distance are omitted.
- **Targeting is partial.** Ally/team membership and arbitrary character-specific targets are not modeled. Only the generic target categories implemented by the field router work.
- **Rare field conditions are uneven.** Common rank, proximity, history, blocking, strategy, visibility, and overtake concepts have live state. Unimplemented condition names may still fall back to legacy assumptions or sampled activation.
- **Event vocabulary is finite.** The event-scaling system is generic, but a future skill reacting to a new kind of event still needs that event to be detected and emitted.
- **Multi-alternative skill data needs auditing.** `@` alternatives and true stronger/weaker trigger variants are not interchangeable. The audit script identifies candidates; only verified priority behavior should be encoded.
- **Cooldown/repeat activation remains limited.** The solver generally records a skill as used after activation, so arbitrary game cooldown and repeat-proc behavior is not a complete model.
- **Special scaling is data-dependent.** Known HP-, green-, recovery-count-, and active-event-scaled patterns are supported. New modifier types or undocumented caps still require verification and an effect resolver.
- **Uma-table values are comparative estimates.** They use the selected sample count, the configured field/settings, level-1 uniques, and default strategies. A low sample count is suitable for screening, not precise ranking.

The static audits are the quickest way to find "outdated/wrong" legacy implementations. They identify structural risk—constant modifiers on special effect types, alternative records, ignored condition tokens—not semantic intent. `npm run audit:data` verifies generated Uma/skill references, while `npm run audit:conditions` fails on new unknown condition findings and reports only the exact allowlisted legacy gaps.

The Pages repository also contains an upstream-sync workflow. It polls the original `alpha123/uma-tools` master branch, merges changes into a dedicated branch, and opens or updates a pull request. The pull request must pass the data audits, condition audits, regression tests, and production build before it is merged and deployed. This keeps upstream data updates automatic without silently replacing local mechanics changes.

## Sources and provenance

The implementation is based on the following sources:

1. The upstream [uma-tools](https://github.com/alpha123/uma-tools) and [uma-skill-tools](https://github.com/alpha123/uma-skill-tools) source and their datamined skill-condition data.
2. The community-maintained [Umamusume Wiki mechanics reference](https://umamusu.wiki/Game%3AMechanics), which documents horse-lane units, lateral-speed formulas, target-lane updates, overtaking, and front/side blocking geometry.
3. The Japanese [ウマ娘スクール lane-movement reference](https://umamusumeschool.com/lane_move/) and [overtake-target reference](https://umamusumeschool.com/overtake/), used as a second detailed statement of the lateral speed, acceleration, target refresh, blocking, and specific rules.

These mechanics pages are community/datamine references, not official Cygames specifications. Where the sources describe a formula, the formula is implemented directly. Where they describe navigation behavior without enough detail to reproduce it, the code and this document label the result as an approximation.
