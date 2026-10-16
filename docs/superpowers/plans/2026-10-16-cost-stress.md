# Execution Cost Stress Implementation Plan

**Goal:** Measure whether backtest edge survives configurable extra spread, slippage, swap, and high-impact news costs.

**Architecture:** Add a pure cost-stress module over filled `BacktestTrade` rows. Baseline replay stays unchanged. Scenarios describe costs *additional to* costs already charged by the engine. Convert price costs into dollars through each trade's actual risk distance, so scenarios remain account-size and contract-size neutral.

**Tech Stack:** TypeScript, existing backtest trade model, Bun test.

## Constraints

- Never present assumed scenario costs as broker-historical facts.
- Keep baseline backtest result unchanged.
- Only filled trades receive extra cost.
- Missing stop distance means scenario result is explicitly excluded from cost adjustment, not guessed.
- News surcharge applies only to USD high-impact events inside configured time window.

## Tasks

### Task 1: Cost stress model

Create `lib/cost-stress.ts` with scenario types, three explicit default scenarios, news-window matching, per-trade adjustment, and aggregate report including net dollars, average R, profit factor, max drawdown, and adjusted trade count. **Done.**

### Task 2: Regression tests

Create `tests/cost-stress.test.ts` covering zero-cost identity, price-cost scaling by actual risk, swap by holding duration, news-window matching, and drawdown/profit-factor aggregation. **Done.**

### Task 3: Validation and commit

Run focused tests, full Bun tests, TypeScript, ESLint. Commit and push source, tests, and plan. UI exposure remains next phase after model review. **Done.**
