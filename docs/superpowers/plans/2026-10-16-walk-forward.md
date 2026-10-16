# Walk-Forward Validation Implementation Plan

**Goal:** Add deterministic train/validation/test walk-forward evaluation without changing live signal logic.

**Architecture:** Add pure window construction and fold evaluation around existing `runBacktest`. Each fold learns only on its training slice. Validation selects no live parameters yet; frozen test starts after train plus validation and uses training output as prior. Control test uses default parameters over the same test candles.

**Tech Stack:** TypeScript, existing backtest engine, Bun test.

## Constraints

- No candle after a fold's test end may affect that fold.
- Test trades start only after train and validation candles.
- Control and frozen test use identical candles and execution settings.
- No live parameter adoption in this phase.
- Empty or short data returns an explicit insufficient result, not a guess.

## Tasks

### Task 1: Window construction

Files: `lib/walk-forward.ts`, `tests/walk-forward.test.ts`.

Add `buildWalkForwardWindows(candles, options)` with chronological, non-overlapping train/validation/test ranges and configurable step. Require enough candles for one complete fold. Test boundaries, no overlap, and insufficient data. **Done.**

### Task 2: Fold evaluation

Add `runWalkForward(candles, config)` using existing `runBacktest`:

- adaptive training run on train slice;
- control test on combined train+validation+test with `warmupBars = trainBars + validationBars`;
- frozen test with same combined candles and `startingPrior = training.finalWeights`;
- compare test stats only. **Done.**

Return fold summaries and aggregate test statistics. Preserve explicit `insufficient` status when no fold completes.

### Task 3: Regression validation

Use deterministic synthetic candles and a spy-friendly small configuration. Assert training output cannot alter control test, frozen test starts after validation, folds stay chronological, and aggregate uses only test trades. **Done.**

### Task 4: Full validation and commit

Run focused tests, all Bun tests, TypeScript, ESLint. Commit only source, tests, plan. Do not modify live defaults in this phase. **Done.**
