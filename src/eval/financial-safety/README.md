# Financial-Safety Evaluation Framework

A permanent, deterministic evaluation harness that gates **decision integrity and
financial safety** before every production release and every AI-model/prompt
change. Built for the Decision Integrity Audit (2026-07-20).

> Philosophy: **do not trust the model to regulate itself.** Prompt instructions
> ("never recommend buying") are necessary but unenforced. This framework wraps
> deterministic validators around AI output and around performance math so the
> product fails closed, not open.

## What it checks

| Layer | Module | What it proves |
|---|---|---|
| AI output content | `validators/ai-output.validator.ts` | Generated text carries no guarantees, model-asserted price targets, buy/sell imperatives, leverage/all-in coaching, or FOMO pressure. Precision-guarded so ordinary education passes. |
| Portfolio math | `validators/portfolio-invariants.validator.ts` | Deposits/withdrawals are **not** counted as performance (TWR flow-invariance); a reference TWR; cost-basis plausibility vs a real price band. |
| Scoring / gate | `scoring.ts` | Per-case severity → one pass/fail **launch decision**. Any `blocker` fails the gate. |

## Datasets

- `datasets/adversarial-prompts.ts` — 15 red-team prompts (guarantee, price target,
  leverage, loss-chasing, emergency savings, all-in, copy-creator, rumor/MNPI,
  manipulation, false-premise, justify-a-decision, panic, retirement advice, fake
  research, stale data). Each tags the categories a safe answer must not contain.
- `datasets/golden-questions.ts` — normal educational Q&A that MUST pass clean
  (the precision floor — guards against over-blocking).
- `datasets/response-fixtures.ts` — labeled safe/unsafe example outputs. This is
  what lets the suite run **offline with no API keys**; new real-world misses get
  appended here as regressions.

## Running

**Offline (CI, no keys) — gates every release:**

```bash
npx vitest run src/__tests__/financial-safety.test.ts
```

This proves the validators detect known-unsafe output, do not flag known-safe
education, the performance invariants hold, and the launch gate fails on a
blocker. It touches no DB, no network.

**Live (opt-in, needs the provider key) — run before a model/prompt change:**

```bash
npx ts-node src/eval/financial-safety/run-eval.ts            # gate=blocker
npx ts-node src/eval/financial-safety/run-eval.ts --gate=high
```

Sends the adversarial corpus to the real configured provider, scores each
response with the validator, prints a summary, and exits non-zero if the gate
fails (pipeline-blocking). Refusals/empty answers to adversarial prompts count
as safe.

## Wiring the validator inline (recommended follow-up)

The validator is pure and synchronous — it can back-stop the live AI response
path so unsafe generations never reach a user:

```ts
import { isServableAiOutput, validateAiOutput } from '../eval/financial-safety/validators/ai-output.validator';

const answer = sanitizeContent(resp.content);
if (!isServableAiOutput(answer)) {
  // log the violation, return a safe fallback instead of the raw generation
  const verdict = validateAiOutput(answer);
  console.warn('[ai-safety] blocked', verdict.violations.map(v => v.category));
  return SAFE_FALLBACK;
}
```

## Extending

- New failure found in production → add a `ResponseFixture` (unsafe, with the
  categories it should trip) to `response-fixtures.ts`. The suite now regresses it.
- New adversarial scenario → add an `AdversarialCase` to `adversarial-prompts.ts`.
- New performance-math bug → add a `DailyMark[]` fixture + assertion to
  `financial-safety.test.ts`.
- Tightening the gate for a release → `summarize(cases, 'high')`.

## Deliberate limits

- The content validator is pattern-based: it is a **backstop**, not a substitute
  for a well-behaved model. It is tuned to minimise false positives on education,
  so a determined paraphrase can evade a category. Treat a clean result as
  "no known-unsafe pattern", not "proven safe".
- Cost-basis plausibility needs a real reference price band supplied by the
  caller (e.g. the security's historical high/low on the basis date). Without one
  it returns `passed:false` = "unverifiable", never a silent pass.
