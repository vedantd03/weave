#!/usr/bin/env node
// Weave headless CLI (docs/MODEL.md §6.4). Node >= 24 (imports the TypeScript engine directly).
//
//   node bin/weave.mjs --scenario run.json            replay a run export, check the final hash
//   node bin/weave.mjs --scenario scenario.json [--steps N]   run a plain scenario
//   options: --network <network.json>  (file networks default to apps/web/public/data/<id>.json)
//
// Prints one JSON object on the last line of stdout. Exit codes: 0 ok / hash matches,
// 1 hash mismatch, 2 classes differ from the export's classesHash, 3 bad input.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, defaultClasses, Network, replayExport, runSummary, RunExport, Scenario } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../../apps/web/public/data');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(code, message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(code);
}
function loadNetwork(scenario) {
  const explicit = arg('network');
  if (scenario.network.kind !== 'file' && !explicit) return undefined;
  const path = explicit ?? resolve(dataDir, `${scenario.network.id}.json`);
  if (!existsSync(path)) fail(3, `network file not found: ${path}`);
  return Network.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const file = arg('scenario');
if (!file) fail(3, 'usage: weave --scenario <run.json | scenario.json> [--steps N] [--network file]');
let json;
try {
  json = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(3, `cannot read ${file}: ${e.message}`);
}

if (json && typeof json === 'object' && 'manifest' in json) {
  const parsed = RunExport.safeParse(json);
  if (!parsed.success) fail(3, `not a valid run export: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  const run = parsed.data;
  const classesHash = createHash('sha256').update(JSON.stringify(defaultClasses())).digest('hex');
  if (classesHash !== run.manifest.classesHash) {
    fail(2, `classes differ from the export: sha256 ${classesHash} here, ${run.manifest.classesHash} in the export`);
  }
  const r = replayExport(run, loadNetwork(run.scenario));
  console.log(JSON.stringify(r));
  process.exit(r.match ? 0 : 1);
} else {
  const parsed = Scenario.safeParse(json);
  if (!parsed.success) fail(3, `not a valid scenario: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  const scenario = parsed.data;
  const sim = createSim({ scenario, classes: defaultClasses(), ...(loadNetwork(scenario) ? { network: loadNetwork(scenario) } : {}) });
  const steps = arg('steps') !== undefined ? Number(arg('steps')) : Math.round(scenario.durationS / sim.dt);
  sim.advance(steps);
  console.log(JSON.stringify({ stateHash: sim.stateHash(), simulatedTimeS: sim.t, metrics: runSummary(sim, scenario.warmupS) }));
}
