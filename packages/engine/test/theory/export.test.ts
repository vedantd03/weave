/**
 * §6.4 run export: tripRecords, the RunExport schema, replayExport and the Node CLI.
 *
 * Assumptions (flagged): tripRecords and exportBody live in src/stats/export.ts; exportBody may
 * carry a partial manifest, which the test completes with the fields §6.4 lists as outside it
 * (buildSha, engineVersion, classesHash, exportedAt) plus scenario; classesHash is the SHA-256
 * of JSON.stringify(defaultClasses()).
 */
import { describe, expect, it } from 'vitest';
import silk from '../../../../apps/web/public/data/silkboard.json' with { type: 'json' };
import { tripRecords, exportBody } from '../../src/stats/export.ts';
import { replayExport } from '../../src/replay.ts';
import { PRESETS, defaultClasses } from '../../src/index.ts';
import { Network, RunExport, type ScenarioInput } from '../../src/schema/index.ts';
import { classSet, corridorScenario, makeSim, type M2Sim } from '../helpers/m2.ts';
import { STUCK_CAR, net as rerouteNet, scenario as rerouteScenario } from '../helpers/reroute-net.ts';
import type { M3Sim } from '../helpers/m3.ts';

const DT = 0.2;
// node built-ins through dynamic specifiers: the engine tsconfig has no node types
const nodeMod = (name: string) => import(/* @vite-ignore */ `node:${name}`) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Trip {
  id: number; origin: string; destination: string; classId: string; tGen: number;
  tInsert: number | null; tExit: number | null; freeFlowS: number; delayS: number; diverted: boolean; unfinished: boolean;
}
const records = (sim: M2Sim) => tripRecords(sim as never) as unknown as Trip[];

async function sha256(text: string): Promise<string> {
  const crypto = await nodeMod('crypto');
  return crypto.createHash('sha256').update(text).digest('hex') as string;
}

/** A complete RunExport for a sim advanced to its current step. */
async function makeExport(sim: M2Sim, scenario: ScenarioInput) {
  const body = exportBody(sim as never) as unknown as Record<string, unknown> & { manifest?: Record<string, unknown> };
  return {
    ...body,
    manifest: {
      schemaVersion: 1,
      seed: scenario.seed,
      simulatedTimeS: sim.t,
      steps: sim.step,
      finalStateHash: sim.stateHash(),
      ...(body.manifest ?? {}),
      buildSha: 'test',
      engineVersion: '0.1.0',
      classesHash: await sha256(JSON.stringify(defaultClasses())),
      exportedAt: new Date(0).toISOString(),
    },
    scenario,
  };
}

describe('tripRecords (§6.4)', () => {
  const classes = classSet([
    { id: 'car', length: 4.5, width: 1.8, idm: { v0: 13, T: 1.2, s0: 2, a: 1.5, b: 2 } },
    { id: 'motorcycle', length: 2, width: 0.8, idm: { v0: 14, T: 1.0, s0: 1.5, a: 2, b: 2.5 } },
  ]);

  it('one record per generated vehicle in id order; completed / on-network / queued cases; accounting identity', () => {
    // single-lane corridor above the insertion capacity: trips finish, are on the link or queued
    const sc = corridorScenario({ lengthM: 800, widthM: 3.5, lanes: 1, rateVph: 3000, mode: 'lane', composition: { car: 0.7, motorcycle: 0.3 }, seed: 2 });
    const sim = makeSim(sc, classes) as unknown as M3Sim;
    let VS = 0;
    for (let k = 0; k < 3000; k++) {
      sim.advance(1);
      const c = sim.counters();
      VS += (c.onNetwork + c.entryQueue) * DT;
    }
    const log = sim.generatedLog();
    const recs = records(sim);
    expect(recs.map((r) => r.id)).toEqual(log.map((r) => r.id));
    const trips = new Map(sim.trips().map((t) => [t.id, t]));
    const views = new Map(sim.vehicles().map((v) => [v.id, v as typeof v & { tInsert: number }]));
    let queued = 0;
    let onNet = 0;
    // accounting (as in experiment.test): Σ delay = VS − FFT_travelled − Σ_completed ℓ/v_ff,
    // within Σ 2·dt (generation inside a step, exit/end counted in whole steps)
    const L = 800;
    let fft = 0;
    let lengthCredit = 0;
    for (const r of recs) {
      const g = log.find((x) => x.id === r.id)!;
      expect([r.origin, r.destination, r.classId, r.tGen, r.freeFlowS]).toEqual([g.origin, g.destination, g.classId, g.tGen, g.freeFlowS]);
      expect(r.unfinished).toBe(r.tExit === null);
      const t = trips.get(r.id);
      const v = views.get(r.id);
      const vff = Math.min(g.v0, 40);
      if (t) {
        expect([r.tInsert, r.tExit]).toEqual([t.tInsert, t.tExit]);
        expect(Math.abs(r.delayS - (t.tExit - t.tGen - t.freeFlowS))).toBeLessThanOrEqual(1e-9);
        fft += (L - g.length) / vff;
        lengthCredit += g.length / vff;
      } else if (v) {
        onNet++;
        expect(r.tExit).toBeNull();
        expect(r.tInsert).toBe(v.tInsert);
        expect(Math.abs(r.delayS - (sim.t - r.tGen - v.freeFlowTravelledS))).toBeLessThanOrEqual(1e-9);
        fft += (v.s - g.length) / vff;
      } else {
        queued++;
        expect(r.tInsert).toBeNull();
        expect(r.tExit).toBeNull();
        expect(r.delayS).toBe(sim.t - r.tGen);
      }
      expect(r.diverted).toBe(false);
    }
    expect(queued).toBeGreaterThan(0);
    expect(onNet).toBeGreaterThan(0);
    const sum = recs.reduce((a, r) => a + r.delayS, 0);
    expect(Math.abs(sum - (VS - fft) + lengthCredit)).toBeLessThanOrEqual(recs.length * 2 * DT + 1e-9);
  });

  it('diverted records = diagnostics().diversions (deadlock-breaker diverge network)', () => {
    const sc: ScenarioInput = { ...rerouteScenario('diverge'), od: [{ origin: 'in', destination: 'out1', rateVph: 300 }] };
    const sim = makeSim(sc, classSet([STUCK_CAR]), rerouteNet('diverge')) as unknown as M3Sim;
    sim.advance(3000);
    const d = sim.diagnostics() as unknown as { diversions: number };
    const recs = records(sim);
    expect(d.diversions).toBeGreaterThan(0);
    expect(recs.filter((r) => r.diverted).length).toBe(d.diversions);
  });
});

describe('RunExport schema (§6.4)', () => {
  it('a full export parses; a wrong classesHash or a trip without delayS fails', async () => {
    const sc: ScenarioInput = { ...PRESETS['junction4-signal']!, durationS: 600 };
    const sim = makeSim(sc, defaultClasses());
    sim.advance(1500);
    const run = JSON.parse(JSON.stringify(await makeExport(sim, sc)));
    expect(RunExport.safeParse(run).success).toBe(true);
    expect(run.trips.length).toBeGreaterThan(0);
    // NaN → null: nothing in metrics is NaN after a JSON round trip, and nulls are accepted
    expect(Object.values(run.metrics).every((v) => v === null || typeof v === 'number')).toBe(true);
    const badHash = { ...run, manifest: { ...run.manifest, classesHash: 'abc123' } };
    expect(RunExport.safeParse(badHash).success).toBe(false);
    const { delayS: _drop, ...trip0 } = run.trips[0];
    const badTrip = { ...run, trips: [trip0, ...run.trips.slice(1)] };
    expect(RunExport.safeParse(badTrip).success).toBe(false);
    const badState = { ...run, manifest: { ...run.manifest, finalStateHash: 'xyz' } };
    expect(RunExport.safeParse(badState).success).toBe(false);
  });
});

describe('replayExport (§6.4)', () => {
  it('junction preset: replay reproduces the state hash; a tampered hash does not match', async () => {
    const sc: ScenarioInput = { ...PRESETS['junction4-signal']!, durationS: 600 };
    const sim = makeSim(sc, defaultClasses());
    sim.advance(1500);
    const run = JSON.parse(JSON.stringify(await makeExport(sim, sc)));
    const r = replayExport(run) as unknown as { stateHash: string; expected: string; match: boolean };
    expect(r.stateHash).toBe(sim.stateHash());
    expect(r.expected).toBe(sim.stateHash());
    expect(r.match).toBe(true);
    const tampered = { ...run, manifest: { ...run.manifest, finalStateHash: '00000000' } };
    expect((replayExport(tampered) as unknown as { match: boolean }).match).toBe(false);
  });

  it('file network (Silk Board): replay with the network', async () => {
    const network = Network.parse(silk);
    const sc: ScenarioInput = { ...PRESETS['silkboard']!, durationS: 600 };
    const sim = makeSim(sc, defaultClasses(), network);
    sim.advance(1000);
    const run = JSON.parse(JSON.stringify(await makeExport(sim, sc)));
    const r = replayExport(run, network) as unknown as { stateHash: string; match: boolean };
    expect(r.stateHash).toBe(sim.stateHash());
    expect(r.match).toBe(true);
  });
});

describe('CLI bin/weave.mjs (§6.4)', () => {
  it('replays a written export: exit 0 and match; a wrong classesHash exits 2', { timeout: 120_000 }, async () => {
    const fs = await nodeMod('fs');
    const os = await nodeMod('os');
    const path = await nodeMod('path');
    const cp = await nodeMod('child_process');
    const url = await nodeMod('url');
    const here = (import.meta as unknown as { url: string }).url;
    const engineDir = path.resolve(path.dirname(url.fileURLToPath(here)), '../..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-export-'));
    const sc: ScenarioInput = { ...PRESETS['junction4-signal']!, durationS: 600 };
    const sim = makeSim(sc, defaultClasses());
    sim.advance(1000);
    const run = await makeExport(sim, sc);
    const good = path.join(dir, 'run.json');
    fs.writeFileSync(good, JSON.stringify(run));
    const ok = cp.spawnSync(process_execPath(), [path.join(engineDir, 'bin/weave.mjs'), '--scenario', good], { cwd: engineDir, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    const out = JSON.parse(ok.stdout.trim().split('\n').pop()!);
    expect(out.match).toBe(true);
    expect(out.stateHash).toBe(sim.stateHash());
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ ...run, manifest: { ...run.manifest, classesHash: '0'.repeat(64) } }));
    const fail = cp.spawnSync(process_execPath(), [path.join(engineDir, 'bin/weave.mjs'), '--scenario', bad], { cwd: engineDir, encoding: 'utf8' });
    expect(fail.status).toBe(2);
  });
});

function process_execPath(): string {
  return (globalThis as unknown as { process: { execPath: string } }).process.execPath;
}
