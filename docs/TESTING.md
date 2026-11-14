# Test strategy

## Rules
- **Where expected values come from:** either theory (docs/MODEL.md), computed inside the
  test, or a number traced to a cited paper. A number pasted from a run is never an expected
  value.
- **Order:** tests are written first, by the test-author agent, from the specification and not
  from the implementation. They are committed failing (`test:`) before the implementation
  (`feat:`).
- **Tests stay as written:** no test is weakened, skipped or deleted to make it pass. A test
  that looks wrong is escalated to the user.
- **Tolerances:** every tolerance is derived in the test, with a comment explaining it (from a
  dt error bound, or from a binomial or t bound over seeds).

## Suites
| Suite | Runner | Location |
|---|---|---|
| Theory and unit (engine) | Vitest | `packages/engine/test/{theory,unit}` |
| Property (engine) | Vitest + fast-check | `packages/engine/test/property` |
| Data | pytest | `data-pipeline/tests` |
| UI | Playwright (desktop + mobile) | `apps/web/e2e` |
| Shared fixtures | used by Vitest and pytest | `docs/fixtures` |

## Catalogue
See the plan for the full catalogue: T1–T23, the property tests, D1–D8 and the UI checks.
Each milestone's acceptance checks name the tests that must pass.

| Milestone | Tests that must pass |
|---|---|
| M1 | T1–T6 |
| M2 | T7–T12, the no-collision property test, the corridor generator property test |
| M3 | T13–T18, T22–T23, the generator property tests, D1–D8 |
| M4 | T19–T21 |
| M5 | the whole UI suite, against the production build and the deployed URL |

## Running
```
pnpm test                                # engine theory/unit/property
pnpm --filter @weave/web e2e             # UI against the local production build
BASE_URL=https://<deploy> pnpm --filter @weave/web e2e   # UI against the deployment
cd data-pipeline && uv run pytest        # data
```
