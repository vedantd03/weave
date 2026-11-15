/**
 * Revision 3 app behaviour (docs/MODEL.md §6.3).
 *
 * Contract assumptions (flagged in the report):
 *  - "Colour by" and "2D / 3D" are two-option controls whose options are reachable by role and
 *    name (radio, tab or button named "Class" / "Speed" and "2D" / "3D").
 *  - Test hook additions: weaveTest.frame() → { data: number[]; count: number } (the current
 *    frame floats, FRAME_STRIDE per vehicle) and weaveTest.worldToScreen(x, y) → { x, y } in
 *    page (client) pixels for the 2D view.
 *  - The export button is "Export run"; runSummary is exported by '@weave/engine'.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { F_X, F_Y, PRESETS, RunExport, createSim, defaultClasses, runSummary } from '@weave/engine';

type Hook = {
  load(id: string, seed: number): Promise<void>;
  advance(n: number): Promise<{ hash: string; t: number; count: number }>;
  frame(): Promise<{ data: number[]; count: number }>;
  worldToScreen(x: number, y: number): Promise<{ x: number; y: number }>;
  runExperiment(o: { replications: number; compare: string }): Promise<unknown>;
};

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
async function waitHook(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
}
const hAdvance = (page: Page, n: number) => page.evaluate(async (k) => (window as unknown as { weaveTest: Hook }).weaveTest.advance(k), n);
const hFrame = (page: Page) => page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.frame());
const hW2S = (page: Page, x: number, y: number) =>
  page.evaluate(async ([a, b]) => (window as unknown as { weaveTest: Hook }).weaveTest.worldToScreen(a, b), [x, y] as const);
const simTime = async (page: Page) => Number(/-?\d+(?:\.\d+)?/.exec((await page.getByTestId('sim-time').textContent()) ?? '')?.[0] ?? NaN);
const option = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true }).or(page.getByRole('tab', { name, exact: true })).or(page.getByRole('button', { name, exact: true })).first();

async function canvasPng(canvas: Locator): Promise<string> {
  const buf = await canvas.screenshot();
  return (buf as unknown as { toString(enc: 'base64'): string }).toString('base64');
}
async function nonBackground(page: Page, png: string): Promise<number> {
  return page.evaluate(async (p) => {
    const img = new Image();
    img.src = `data:image/png;base64,${p}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const A = new Uint32Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer.slice(0));
    const counts = new Map<number, number>();
    let bg = 0;
    let best = -1;
    for (const x of A) {
      const k = (counts.get(x) ?? 0) + 1;
      counts.set(x, k);
      if (k > best) {
        best = k;
        bg = x;
      }
    }
    let n = 0;
    for (const x of A) if (x !== bg) n++;
    return n;
  }, png);
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

test('opens ready: flyover junction paused at t = 0, network drawn, "Press Play" prompt; Play starts it', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue('junction4-flyover');
  await expect(page.getByText('No scenario loaded')).toHaveCount(0);
  const prompt = page.getByTestId('play-prompt');
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText('Press Play');
  expect(await simTime(page)).toBe(0);
  // the network is drawn: the canvas is not one flat colour (≥ 100 pixels differ from the
  // most common colour, a deliberately low bar for road outlines at any zoom)
  const png = await canvasPng(page.getByTestId('sim-canvas'));
  expect(await nonBackground(page, png)).toBeGreaterThanOrEqual(100);
  // nothing runs by itself
  await page.waitForTimeout(3000);
  expect(await simTime(page)).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect.poll(async () => simTime(page), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('Colour by: legend per mode and different pixels for Speed vs Class on a paused frame', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?test=1&autoplay=0');
  await waitHook(page);
  await hAdvance(page, 600); // vehicles on the map, paused
  const legend = page.getByTestId('legend');
  await option(page, 'Class').click();
  for (const c of defaultClasses().classes) await expect(legend).toContainText(c.label);
  const canvas = page.getByTestId('sim-canvas');
  const classPng = await canvasPng(canvas);
  await option(page, 'Speed').click();
  await expect(legend).toContainText('Stopped');
  await expect(legend).toContainText('Free flow');
  await expect.poll(async () => changedPixels(page, classPng, await canvasPng(canvas)), { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
  expect(errors).toEqual([]);
});

test('Experiments: summary after a run; diff chart with a variant', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await page.goto('/?autoplay=0');
  await page.getByRole('tab', { name: 'Experiments' }).or(page.getByRole('button', { name: 'Experiments', exact: true })).first().click();
  // §7.4: a variant comes from Compare → "Set as baseline" → a one-click variant (the default
  // preset has a flyover, so "Flyover off" is offered)
  await page.getByRole('radiogroup', { name: 'Experiment type' }).getByRole('radio', { name: 'Compare' }).check();
  await page.getByRole('button', { name: 'Set as baseline', exact: true }).click();
  await page.getByRole('button', { name: 'Flyover off', exact: true }).click();
  await page.getByLabel('Replications', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText(/(\d+) \/ \1/, { timeout: 240_000 });
  const summary = page.getByTestId('experiment-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/\b2\b/);
  await expect(summary).toContainText(/seed/i);
  await expect(summary).toContainText(/delay/i);
  const chart = page.getByTestId('compare-chart'); // §7.4: the per-scenario chart replaced diff-chart
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('role', 'img');
  expect(((await chart.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('3D: three.js loads lazily on first open; WebGL canvas; back to 2D', async ({ page }) => {
  const errors = watchErrors(page);
  const threeRequests: string[] = [];
  page.on('request', (r) => {
    if (/three|Scene3D/i.test(r.url())) threeRequests.push(r.url());
  });
  await page.goto('/?autoplay=0');
  await expect(page.getByTestId('sim-canvas')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(threeRequests).toEqual([]); // not in the initial bundle
  await option(page, '3D').click();
  const c3 = page.getByTestId('sim-canvas-3d');
  await expect(c3).toBeVisible({ timeout: 20_000 });
  expect(threeRequests.length).toBeGreaterThan(0);
  const webgl = await c3.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  });
  expect(webgl).toBe(true);
  await option(page, '2D').click();
  await expect(page.getByTestId('sim-canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Inspect: a vehicle shows class and km/h; empty ground clears the card', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?test=1&autoplay=0');
  await waitHook(page);
  await hAdvance(page, 600);
  const f = await hFrame(page);
  expect(f.count).toBeGreaterThan(0);
  const p = await hW2S(page, f.data[F_X]!, f.data[F_Y]!);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  const card = page.getByTestId('inspect-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('km/h');
  const labels = defaultClasses().classes.map((c) => c.label);
  const text = (await card.textContent()) ?? '';
  expect(labels.some((l) => text.includes(l))).toBe(true);
  // empty ground: the canvas corner, far from the junction's roads at the default view
  const box = (await page.getByTestId('sim-canvas').boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(card).toBeHidden();
  expect(errors).toEqual([]);
});

/* ---------- §6.3 item 6 / §6.4: Export run, CSVs, Node replay ---------- */

const TRIP_FIELDS = ['id', 'origin', 'destination', 'classId', 'tGen', 'tInsert', 'tExit', 'freeFlowS', 'delayS', 'diverted', 'unfinished'];
type Exported = {
  manifest: Record<string, unknown> & { finalStateHash: string; steps: number; seed: number };
  metrics: Record<string, number | null>;
  links: { id: string }[];
  trips: (Record<string, unknown> & { unfinished: boolean; tExit: number | null })[];
  series: Record<string, unknown>[];
};
async function readDownload(page: Page, button: string): Promise<{ name: string; text: string; path: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  const stream = (await download.createReadStream()) as unknown as AsyncIterable<Uint8Array>;
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of stream) text += dec.decode(chunk, { stream: true });
  return { name: download.suggestedFilename(), text, path: (await download.path())! };
}
const csvRows = (text: string) => text.trim().split(/\r?\n/);
const nodeMod = (name: string) => import(/* @vite-ignore */ `node:${name}`) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('Export run: enablement, RunExport schema, hashes, trips, metrics vs Node, CSVs', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const exportBtn = page.getByRole('button', { name: 'Export run' });
  // playing: disabled (revision 4: the app opens paused, so press Play first)
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => simTime(page), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(exportBtn).toBeDisabled();
  // paused at t = 0: disabled
  const id = 'corridor-lanedrop';
  await page.goto(`/?test=1&autoplay=0&preset=${id}`);
  await waitHook(page);
  await expect(exportBtn).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Trips CSV' })).toBeDisabled();
  // stepped and paused: enabled
  const N = 1500;
  const r = await hAdvance(page, N);
  await expect(exportBtn).toBeEnabled();
  const json = await readDownload(page, 'Export run');
  const preset = PRESETS[id]!;
  expect(json.name).toMatch(new RegExp(`^weave-run-${id}-seed${preset.seed}-t[\\d.]+\\.json$`));
  const raw = JSON.parse(json.text);
  expect(RunExport.safeParse(raw).success).toBe(true);
  const j = raw as Exported;
  expect(j.manifest.finalStateHash).toBe(r.hash);
  expect(j.manifest.steps).toBe(N);
  await expect(page.getByTestId('state-hash')).toContainText(j.manifest.finalStateHash);
  // trips: non-empty and including unfinished records (tExit null)
  expect(j.trips.length).toBeGreaterThan(0);
  expect(j.trips.some((t) => t.unfinished && t.tExit === null)).toBe(true);
  // metrics equal Node runSummary for the same scenario, seed and step count
  const sim = createSim({ scenario: preset, classes: defaultClasses() });
  sim.advance(N);
  const node = runSummary(sim, preset.warmupS ?? 300) as Record<string, number>;
  for (const [k, v] of Object.entries(node)) {
    const got = j.metrics[k];
    if (Number.isNaN(v)) expect(got, k).toBeNull();
    else expect(Math.abs((got as number) - v), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
  }
  const net = sim.network;
  expect(j.links.map((l) => l.id).sort()).toEqual([...net.links.map((l) => l.id), ...net.movements.map((m) => m.id)].sort());
  // CSVs: header in the §6.4 field order, one row per record
  const trips = await readDownload(page, 'Trips CSV');
  const tripLines = csvRows(trips.text);
  expect(tripLines[0]!.split(',')).toEqual(TRIP_FIELDS);
  expect(tripLines.length - 1).toBe(j.trips.length);
  const series = await readDownload(page, 'Series CSV');
  const seriesLines = csvRows(series.text);
  expect(seriesLines[0]!.split(',')).toEqual(Object.keys(j.series[0]!));
  expect(seriesLines.length - 1).toBe(j.series.length);
  expect(errors).toEqual([]);
});

test('run a preset briefly, stop, export, rerun in Node: the CLI reproduces the state hash', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.goto('/?autoplay=0&preset=junction4-signal');
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue('junction4-signal');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => simTime(page), { timeout: 120_000 }).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export run' })).toBeEnabled();
  const json = await readDownload(page, 'Export run');
  const raw = JSON.parse(json.text);
  expect(RunExport.safeParse(raw).success).toBe(true);
  const run = raw as Exported;
  // the CLI, from the repository root (Playwright runs in apps/web)
  const cp = await nodeMod('child_process');
  const path = await nodeMod('path');
  const proc = (globalThis as unknown as { process: { cwd(): string; execPath: string } }).process;
  const root = path.resolve(proc.cwd(), '../..');
  const res = cp.spawnSync(proc.execPath, ['packages/engine/bin/weave.mjs', '--scenario', json.path], { cwd: root, encoding: 'utf8' });
  expect(res.status, res.stderr).toBe(0);
  const out = JSON.parse(String(res.stdout).trim().split('\n').pop()!);
  expect(out.match).toBe(true);
  expect(out.stateHash).toBe(run.manifest.finalStateHash);
  expect(errors).toEqual([]);
});
