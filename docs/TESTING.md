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
pnpm --filter @weave/web e2e:live        # UI against https://weave-simulator.vercel.app
cd data-pipeline && uv run pytest        # data
```

## Investigated failure: "preset silkboard loads and plays" (fixed in 3e4eb2a)
**Symptom.** Against the live site, this test failed now and then. After Play, the vehicle count
stayed 0 for the whole 45 s poll. Locally it passed.

**Diagnosis.** The live site was run with the code unchanged.
- **Alone:** run alone 3 times, it failed once. Run 15 times in a row with one worker
  (`--repeat-each=15 --workers=1`), it failed on run 1 and passed on runs 2–15.
- **Contention ruled out:** a lone test with one worker can fail, so CPU contention from the
  parallel Experiments specs is not the cause.
- **Trace (Playwright trace of the failing run):**
  - the page opened at 514 ms;
  - the Scenario select changed to silkboard at 659 ms;
  - Play was clicked at 714 ms;
  - all network requests returned 200 quickly (`silkboard.json` included).
- **Final screenshot:** Silk Board loaded, paused at t = 0, with the "Press Play" prompt still
  shown. The click had been lost.

**Cause.** A real race in the app (`state/controller.ts`), not a slow test:
1. Selecting a preset with a file network first downloaded `silkboard.json`. Only after the
   download did the load become visible: status `loading`, and the counters the start-up logic
   checks.
2. During the download the previous scenario was still `ready`, so Play was enabled. A click
   started the previous scenario.
3. The new scenario then replaced the running sim, paused at t = 0. In the same window the
   start-up default could also start.

The race shows mostly on the first, cold load of a batch, so it shows mostly on the live site.

**Fix** (MODEL.md §6.3 item 1):
- A load is registered when it is requested, before the download. Status goes to `loading`, so
  Play and the prompt are disabled, and a playing run is paused.
- The start-up default never replaces a requested load.
- A load overtaken by a newer request is abandoned.
- Worker output from the previous scenario is ignored until the latest load has been sent.

**Regression test.** `e2e/m10-load-race.spec.ts` uses `page.route` to hold `silkboard.json`
on a promise the test releases. There are no timers.
- **While the request is held:** Play is disabled, and a forced click starts nothing.
- **After release:** Silk Board plays.
- **Before the fix:** red on desktop and mobile, failing on "Expected: disabled, Received:
  enabled". It was checked by building the pre-fix `controller.ts`.
- **After the fix:** green.
- **Start-up case:** a second case, a start-up load of `?preset=silkboard`, is green before and
  after the fix.

**After the fix, on the live site (build 3e4eb2a):**
- the formerly failing test passed 15 of 15 runs in a row with one worker;
- the full live suite passed 119 of 119 (desktop, mobile and WebKit hash checks).

No timeout was raised and no assertion was changed.

