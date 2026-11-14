/**
 * M3 UI checks: junction presets, junction form + flyover preview, OD editor, signal editor,
 * signal colours vs the Node signalState, and browser-vs-Node determinism on Silk Board.
 *
 * UI contract (M3):
 *  - PRESETS 'junction4-signal', 'junction4-flyover', 'merge-onramp', 'silkboard'
 *    (silkboard: network {kind:'file', id:'silkboard'}, fetched from /data/silkboard.json).
 *  - Junction form: "Arms", "Arm k angle (°)", "Arm k in width (m)", "Arm k out width (m)",
 *    select "Control", checkbox "Flyover", selects "Flyover from arm"/"Flyover to arm", number
 *    inputs "Deck width (m)", "Ramp width (m)", "Landing width (m)", "Ramp length (m)".
 *  - OD editor rows "{origin} → {destination} (veh/h)".
 *  - Signal editor (first signalised node): "Phase k green (s)", "Amber (s)", "All-red (s)",
 *    "Offset (s)", data-testid "cycle-length"; Apply applies it as signalOverrides.
 *  - weaveTest: signals() (SIG code per movement index), gridlock(), diagnostics().
 * Assumptions (flagged): weaveTest.signals() reports the colours at the sim time t returned by
 * the last advance(); Apply keeps the preset's seed and every field not edited.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { Network, PRESETS, createSim, cycleLength, defaultClasses, signalState } from '@weave/engine';

type Counters = { generated: number; exited: number; onNetwork: number; entryQueue: number };
type Hook = {
  load(id: string, seed: number): Promise<void>;
  advance(n: number): Promise<{ hash: string; t: number; count: number }>;
  counters(): Promise<Counters>;
  signals(): Promise<number[]>;
  gridlock(): Promise<{ detected: boolean; sinceS: number } | null>;
  diagnostics(): Promise<unknown>;
};
type AnySim = ReturnType<typeof createSim> & { counters(): Counters };
type SignalPlanT = ReturnType<typeof createSim>['network']['signals'][number];

const JUNCTION = PRESETS['junction4-signal']!;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
const hLoad = (page: Page, id: string, seed: number) =>
  page.evaluate(async ([i, s]) => (window as unknown as { weaveTest: Hook }).weaveTest.load(i, s), [id, seed] as const);
const hAdvance = (page: Page, n: number) =>
  page.evaluate(async (k) => (window as unknown as { weaveTest: Hook }).weaveTest.advance(k), n);
const hSignals = (page: Page) => page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.signals());
const hCounters = (page: Page) => page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.counters());
async function waitHook(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
}
async function open(page: Page, preset: string, url = '/') {
  await page.goto(url);
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption(preset);
  await expect(page.getByTestId('sim-canvas')).toBeVisible();
}
async function canvasPng(canvas: Locator): Promise<string> {
  const buf = await canvas.screenshot();
  return (buf as unknown as { toString(enc: 'base64'): string }).toString('base64');
}
async function changedPixels(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(async ([pa, pb]) => {
    const decode = async (s: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer.slice(0));
    };
    const A = await decode(pa);
    const B = await decode(pb);
    if (A.length !== B.length) return Math.max(A.length, B.length);
    let n = 0;
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) n++;
    return n;
  }, [a, b] as const);
}
function effectivePlan(sim: AnySim, preset = JUNCTION): SignalPlanT {
  const node = sim.network.signals[0]!.node;
  const override = (preset.signalOverrides ?? []).find((p) => p.node === node);
  return (override ? { amberS: 3, allRedS: 2, offsetS: 0, ...override, phases: override.phases.map((p) => ({ permissive: [], ...p })) } : sim.network.signals[0]!) as SignalPlanT;
}
const nodeSim = (scenario: typeof JUNCTION, network?: unknown) =>
  createSim({ scenario, classes: defaultClasses(), ...(network ? { network: network as never } : {}) }) as AnySim;

for (const id of ['junction4-signal', 'junction4-flyover', 'merge-onramp', 'silkboard']) {
  test(`preset ${id} loads and plays`, async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, id);
    await page.getByRole('button', { name: 'Play' }).click();
    await expect
      .poll(async () => Number(/\d+/.exec((await page.getByTestId('stat-vehicles').textContent()) ?? '')?.[0] ?? 0), { timeout: 45_000 })
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause' }).click();
    expect(errors).toEqual([]);
  });
}

test('signal colours follow the plan (browser vs Node signalState)', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?test=1');
  await waitHook(page);
  const seed = JUNCTION.seed;
  await hLoad(page, 'junction4-signal', seed);
  const sim = nodeSim(JUNCTION);
  const plan = effectivePlan(sim);
  let done = 0;
  for (const n of [10, 60, 140, 260, 400]) {
    const r = await hAdvance(page, n - done);
    done = n;
    const colours = await hSignals(page);
    sim.network.movements.forEach((m, i) => {
      if (m.control !== 'signal' || m.node !== plan.node) return;
      expect(colours[i], `${m.id} at t=${r.t}`).toBe(signalState(plan, m.id, r.t));
    });
  }
  expect(errors).toEqual([]);
});

test('editing a phase green updates the cycle length; after Apply the run matches Node', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'junction4-signal', '/?test=1');
  await waitHook(page);
  const sim = nodeSim(JUNCTION);
  const plan = effectivePlan(sim);
  const C = cycleLength(plan);
  await expect(page.getByTestId('cycle-length')).toContainText(String(C));
  const g1 = plan.phases[0]!.greenS + 10;
  await page.getByLabel('Phase 1 green (s)', { exact: true }).fill(String(g1));
  await expect(page.getByTestId('cycle-length')).toContainText(String(C + 10));
  await page.getByRole('button', { name: 'Apply' }).click();
  const r = await hAdvance(page, 1500);
  const edited = { ...plan, phases: plan.phases.map((p, i) => (i === 0 ? { ...p, greenS: g1 } : p)) };
  const node = nodeSim({ ...JUNCTION, signalOverrides: [edited] as never });
  node.advance(1500);
  expect(r.hash).toBe(node.stateHash());
  expect(errors).toEqual([]);
});

test('toggling Flyover redraws the junction preview', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'junction4-signal');
  const canvas = page.getByTestId('sim-canvas');
  const before = await canvasPng(canvas);
  await page.getByLabel('Flyover', { exact: true }).check();
  await expect.poll(async () => changedPixels(page, before, await canvasPng(canvas)), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);
  expect(errors).toEqual([]);
});

test('Silk Board: 300 steps give the same state hash in the browser and in Node', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?test=1');
  await waitHook(page);
  const silk = PRESETS['silkboard']!;
  const json = await (await page.request.get('/data/silkboard.json')).json();
  const network = Network.parse(json);
  await hLoad(page, 'silkboard', silk.seed);
  const r = await hAdvance(page, 300);
  const node = nodeSim(silk, network);
  node.advance(300);
  expect(r.hash).toBe(node.stateHash());
  expect(r.count).toBe(node.vehicleCount());
  expect(errors).toEqual([]);
});

test('editing an OD row changes generation deterministically (matches Node)', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'junction4-signal', '/?test=1');
  await waitHook(page);
  const od = JUNCTION.od ?? [];
  expect(od.length).toBeGreaterThan(0);
  const row = od[0]!;
  const rate = row.rateVph * 2 + 100;
  await page.getByLabel(`${row.origin} → ${row.destination} (veh/h)`, { exact: true }).fill(String(rate));
  await page.getByRole('button', { name: 'Apply' }).click();
  const r = await hAdvance(page, 1500);
  const c = await hCounters(page);
  const edited = nodeSim({ ...JUNCTION, od: od.map((o, i) => (i === 0 ? { ...o, rateVph: rate } : o)) });
  edited.advance(1500);
  expect(r.hash).toBe(edited.stateHash());
  expect(c).toEqual(edited.counters());
  const original = nodeSim(JUNCTION);
  original.advance(1500);
  expect(c.generated).not.toBe(original.counters().generated);
  expect(errors).toEqual([]);
});

test('no horizontal overflow with the junction form open', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'junction4-signal');
  await expect(page.getByLabel('Arms', { exact: true })).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
