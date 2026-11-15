# Weave — working rules (binding on every agent in this repo)

Agent-based mixed-traffic simulator. Static site: TS engine in a Web Worker, React UI, Vercel.
Plan: ~/.claude/plans/quest-lab-full-stack-moonlit-dream.md. Spec: docs/MODEL.md. Decisions: docs/DECISIONS.md.

## Tests
- Expected values come from theory (docs/MODEL.md) computed inside the test, or are traced to a
  cited paper. Never paste numbers from a run. Never compute an expected value by calling the
  engine helper under test.
- Tests are written before the code they test (`test:` commit, red, then `feat:` commit).
- Never weaken, skip or delete a test to make it pass. If a test looks wrong: stop and tell the user.
- Tolerances are derived in the test (dt error bound, binomial/t bound over seeds) with a comment.
- Implementation work never edits test files; the test-author agent owns packages/engine/test/**,
  apps/web/e2e/** and docs/fixtures/**.

## Dependencies and services
- Ask the user before adding ANY dependency (npm, Python, build backend, types package) or external service.
- Approved: typescript, vite, @vitejs/plugin-react, vitest, @playwright/test, fast-check, tailwindcss,
  @tailwindcss/vite, react, react-dom, @types/react(-dom), uplot, zod, three, @types/three (3D view, lazy-loaded); Python: numpy, pandas, scipy,
  openpyxl, jsonschema, eclipse-sumo, pytest. No backend, accounts or database.
- Chennai raw data lives in data/chennai/ (provided by the user). Never commit the .xlsx; never download it.

## Engine rules
- packages/engine has no DOM/React imports. Hot path: only + − × ÷ sqrt floor ceil min max abs
  (determinism across JS engines); logs via core/dmath.ts `dln`.
- All randomness via `substream(seed, purpose, entity)` (docs/MODEL.md §1.2).
- Shared contract = zod schemas in packages/engine/src/schema + src/protocol.ts; only the main
  agent changes them; run `pnpm emit-schema` after any change (Python validates docs/schema/*.json).

## Commands
- `pnpm typecheck` · `pnpm test` · `pnpm emit-schema` · `pnpm --filter @weave/web dev|build|e2e`
- `cd data-pipeline && uv run pytest`
- Commit at each milestone with a meaningful message; push to origin main (SSH).
