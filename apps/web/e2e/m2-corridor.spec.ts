/**
 * M2 UI checks: corridor preset, scenario form (generator inputs, demand, lateral model, seed,
 * Apply), live charts and stat tiles, and browser-vs-Node determinism for corridor scenarios.
 *
 * UI contract (M2):
 *  - Scenario select option value "corridor-lanedrop" (label "Corridor with lane drop"),
 *    PRESETS['corridor-lanedrop'] exported by @weave/engine.
 *  - Form: number inputs labelled "Length (m)", "Width (m)", "Lanes", "At (m)", "Drop lanes",
 *    "Demand (veh/h)", "Seed"; selects labelled "Change" (none|width|laneDrop) and
 *    "Lateral model" (strip|lane); button "Apply" rebuilds the scenario from the form and
 *    leaves the sim paused. Editing a generator input redraws the network preview at once.
 *  - Charts: data-testid chart-flow / chart-speed / chart-density / chart-queue, each with a
 *    <canvas> once a 60 s window exists. Stat tiles: stat-vehicles, stat-mean-speed,
 *    stat-entry-queue, stat-throughput.
 *  - ?test=1: window.weaveTest.load, advance (M1) plus loadScenario(scenario), counters(),
 *    series() with the engine's shapes.
 *  Assumption (flagged in the report): "Demand (veh/h)" sets the rateVph of the preset's single
 *  OD row, "Seed" sets scenario.seed and "Lateral model" sets scenario.mode; Apply keeps every
 *  other preset field.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRESETS, createSim, defaultClasses } from '@weave/engine';

/** §6.3 item 1: the app now opens playing; tests that need a fixed, paused start add ?autoplay=0. */
const paused = (url: string) => url + (url.includes('?') ? '&' : '?') + 'autoplay=0';

type Counters = { generated: number; exited: number; onNetwork: number; entryQueue: number };
interface WeaveTestHook {
  load(presetId: string, seed: number): Promise<void>;
  advance(steps: number): Promise<{ hash: string; t: number; count: number }>;
  loadScenario(scenario: unknown): Promise<void>;
  counters(): Promise<Counters>;
  series(): Promise<unknown[]>;
}
type NodeSim = ReturnType<typeof createSim> & { counters(): Counters };

const PRESET = PRESETS['corridor-lanedrop']!;
const DT = PRESET.dtS ?? 0.2;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function openCorridor(page: Page, url = '/'): Promise<void> {
  await page.goto(paused(url));
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption('corridor-lanedrop');
  await expect(page.getByTestId('sim-canvas')).toBeVisible();
}

async function waitHook(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, {
    timeout: 15_000,
  });
}

const hookAdvance = (page: Page, n: number) =>
  page.evaluate(async (k) => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.advance(k), n);
const hookCounters = (page: Page) =>
  page.evaluate(async () => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.counters());

function nodeSim(overrides: { seed: number; rateVph?: number; mode?: 'strip' | 'lane' }): NodeSim {
  const od = PRESET.od ?? [];
  const scenario = {
    ...PRESET,
    seed: overrides.seed,
    ...(overrides.mode ? { mode: overrides.mode } : {}),
    ...(overrides.rateVph !== undefined ? { od: [{ ...od[0]!, rateVph: overrides.rateVph }] } : {}),
  };
  return createSim({ scenario, classes: defaultClasses() }) as NodeSim;
}

async function canvasPng(canvas: Locator): Promise<string> {
  const buf = await canvas.screenshot();
  return (buf as unknown as { toString(enc: 'base64'): string }).toString('base64');
}

/** Number of differing pixels between two PNG screenshots, decoded in the page. */
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

async function setNumber(page: Page, label: string, value: number): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value));
  await input.blur();
}

test('corridor preset: Play brings vehicles onto the road', async ({ page }) => {
  const errors = watchErrors(page);
  await openCorridor(page);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect
    .poll(async () => Number(/\d+/.exec((await page.getByTestId('stat-vehicles').textContent()) ?? '')?.[0] ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause' }).click();
  for (const id of ['stat-vehicles', 'stat-mean-speed', 'stat-entry-queue', 'stat-throughput']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('charts render once at least two 60 s windows exist', async ({ page }) => {
  const errors = watchErrors(page);
  await openCorridor(page, '/?test=1');
  await waitHook(page);
  await page.evaluate(
    async (seed) => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.load('corridor-lanedrop', seed),
    PRESET.seed,
  );
  const steps = Math.ceil(125 / DT); // ≥ 120 s
  await hookAdvance(page, steps);
  const rows = await page.evaluate(async () => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.series());
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const id of ['chart-flow', 'chart-speed', 'chart-density', 'chart-queue']) {
    await expect(page.getByTestId(id).locator('canvas').first()).toBeVisible({ timeout: 15_000 });
  }
  expect(errors).toEqual([]);
});

test('Apply with a different demand: paused, and counters/hash equal Node createSim', async ({ page }) => {
  const errors = watchErrors(page);
  expect((PRESET.od ?? []).length).toBe(1); // the form's demand maps onto this single OD row
  await openCorridor(page, '/?test=1');
  await waitHook(page);
  const N = 1500; // 300 s
  const results: Counters[] = [];
  for (const rate of [1500, 600]) {
    await setNumber(page, 'Demand (veh/h)', rate);
    await setNumber(page, 'Seed', 7);
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible(); // paused after Apply
    const r = await hookAdvance(page, N);
    const c = await hookCounters(page);
    const node = nodeSim({ seed: 7, rateVph: rate });
    node.advance(N);
    expect(r.hash).toBe(node.stateHash());
    expect(c).toEqual(node.counters());
    results.push(c);
  }
  // a lower demand generates fewer vehicles over 300 s (125 vs 50 expected; 5σ apart)
  expect(results[1]!.generated).toBeLessThan(results[0]!.generated);
  expect(errors).toEqual([]);
});

test('switching the lateral model to lane changes the state and matches Node', async ({ page }) => {
  const errors = watchErrors(page);
  await openCorridor(page, '/?test=1');
  await waitHook(page);
  const N = 1000;
  const strip = nodeSim({ seed: 11, mode: 'strip' });
  strip.advance(N);
  const lane = nodeSim({ seed: 11, mode: 'lane' });
  lane.advance(N);
  expect(lane.stateHash()).not.toBe(strip.stateHash());

  await setNumber(page, 'Seed', 11);
  await page.getByLabel('Lateral model', { exact: true }).selectOption('strip');
  await page.getByRole('button', { name: 'Apply' }).click();
  expect((await hookAdvance(page, N)).hash).toBe(strip.stateHash());

  await page.getByLabel('Lateral model', { exact: true }).selectOption('lane');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  expect((await hookAdvance(page, N)).hash).toBe(lane.stateHash());
  expect(errors).toEqual([]);
});

test('cross-runtime determinism for the corridor preset at several step counts', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(paused('/?test=1'));
  await waitHook(page);
  for (const seed of [3, 4242]) {
    await page.evaluate(
      async (s) => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.load('corridor-lanedrop', s),
      seed,
    );
    const node = nodeSim({ seed });
    let done = 0;
    for (const target of [50, 400, 1500]) {
      const r = await hookAdvance(page, target - done);
      node.advance(target - done);
      done = target;
      expect(r.hash).toBe(node.stateHash());
      expect(r.count).toBe(node.vehicleCount());
      expect(r.t).toBe(node.t);
      expect(await hookCounters(page)).toEqual(node.counters());
    }
  }
  expect(errors).toEqual([]);
});

test('editing a generator input redraws the network preview before Apply', async ({ page }) => {
  const errors = watchErrors(page);
  await openCorridor(page);
  const canvas = page.getByTestId('sim-canvas');
  const before = await canvasPng(canvas);
  const params = PRESET.network.kind === 'generator' ? PRESET.network.params : null;
  const width = params && 'widthM' in params ? params.widthM : 7;
  await setNumber(page, 'Width (m)', width + 3.5);
  // A 3.5 m wider carriageway changes a band of road pixels along the whole corridor at any
  // zoom where the road is visible; ≥ 50 changed pixels is a deliberately low bar.
  await expect.poll(async () => changedPixels(page, before, await canvasPng(canvas)), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);
  expect(errors).toEqual([]);
});

test('no horizontal page overflow with the scenario form open', async ({ page }) => {
  const errors = watchErrors(page);
  await openCorridor(page);
  await expect(page.getByLabel('Demand (veh/h)', { exact: true })).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
