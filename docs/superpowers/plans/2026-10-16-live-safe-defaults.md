# Live-Safe Defaults Implementation Plan

> **For agentic workers:** Implement this plan natively in the current session after user review.

**Goal:** Make live trading start from the tested fixed configuration, not from adaptive learning after each trade.

**Architecture:** Keep learning records and Backtest Lab unchanged. Change only the live default switch and its explanatory test/documentation. Users can still opt into self-learning manually; default behavior matches the tested configuration.

**Tech Stack:** TypeScript, Next.js, Bun test.

**Spec:** Based on repository audit and `lib/tested-configuration.ts` benchmark: fixed parameters outperformed live adaptive learning in the documented replay.

## Global Constraints

- Never claim guaranteed profitability.
- Preserve user ability to enable self-learning manually.
- Do not change signal geometry, risk calculation, or broker assumptions in this phase.
- Keep all code comments and user-facing copy in Indonesian where existing project copy is Indonesian.
- Do not commit generated `package-lock.json` from local npm validation.

## Review Focus

- Fresh profile must use fixed parameters by default.
- Existing saved user preference must remain loadable and user-controlled.
- `learningInput` must still return records when explicitly enabled.
- Existing test suite must remain green.

---

### Task 1: Align live learning default

**Files:**
- Modify: `lib/tested-configuration.ts:72-81`
- Modify: `tests/tested-configuration.test.ts`

**Interfaces:**
- Preserve `DEFAULT_SELF_LEARNING: boolean` export.
- Preserve `learningInput<T>(records: T[], enabled?: boolean): T[]` behavior.

- [x] **Step 1: Add failing regression assertion**

Add test named `fresh live configuration keeps self-learning off` and assert `DEFAULT_SELF_LEARNING` is `false`.

- [x] **Step 2: Implement minimal default change**

Run:

```bash
~/.bun/bin/bun test tests/tested-configuration.test.ts
```

The regression test pins the required default before full validation.

- [x] **Step 3: Change default and explanatory comment**

Set `DEFAULT_SELF_LEARNING = false`. Update nearby comment to state that live learning remains opt-in because documented fixed-parameter replay beat adaptive replay. Keep `LIVE_LEARNING = false` and `learningInput` unchanged.

- [x] **Step 4: Run focused test and full validation**

Run:

```bash
~/.bun/bin/bun test tests/tested-configuration.test.ts
~/.bun/bin/bun test
npx tsc --noEmit
npx eslint .
```

Expected: all tests pass; typecheck and lint exit zero.

- [x] **Step 5: Commit**

```bash
git add lib/tested-configuration.ts tests/tested-configuration.test.ts docs/superpowers/plans/2026-10-16-live-safe-defaults.md
git commit -m "fix: keep live adaptive learning opt-in"
```

---

### Later phases, separate plans

1. Walk-forward backtest with train/validation/test boundaries.
2. Historical spread, slippage, swap, and news-cost stress model.
3. Monte Carlo drawdown and risk-of-ruin report.
4. Broker-aligned bid/ask data capture.
5. Controlled parameter adoption gate for out-of-sample results.
