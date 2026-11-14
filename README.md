# Weave

Agent-based simulation of mixed (non-lane-disciplined) traffic on road networks with junctions,
flyovers and roads of different widths. It runs entirely in the browser: a TypeScript engine in
a Web Worker, a React UI, and a static deployment.

> Work in progress. The full README, with data sources and validation, arrives at M5.

## Layout
- `packages/engine`: the simulation engine. Pure TypeScript, with no DOM or React.
- `apps/web`: the Vite + React app.
- `data-pipeline`: offline Python (uv) for trajectory calibration and the OSM → network
  conversion.
- `docs`: the model spec, decisions, testing and validation notes, and the emitted JSON Schemas.

## Develop
```
pnpm install
pnpm typecheck && pnpm test
pnpm --filter @weave/web dev
cd data-pipeline && uv sync && uv run pytest
```
