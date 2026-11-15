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
import { F_X, F_Y, PRESETS, createSim, defaultClasses, runSummary } from '@weave/engine';

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

test('opens running on the flyover junction: vehicles appear and time advances without a click', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue('junction4-flyover');
  await expect(page.getByText('No scenario loaded')).toHaveCount(0);
  await expect
    .poll(async () => Number(/\d+/.exec((await page.getByTestId('stat-vehicles').textContent()) ?? '')?.[0] ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
  const t1 = await simTime(page);
  await expect.poll(async () => simTime(page), { timeout: 10_000 }).toBeGreaterThan(t1);
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
  await page.getByLabel('Replications', { exact: true }).fill('2');
  await page.getByLabel('Compare with', { exact: true }).selectOption({ label: 'Flyover on (retimed)' });
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText(/(\d+) \/ \1/, { timeout: 240_000 });
  const summary = page.getByTestId('experiment-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/\b2\b/);
  await expect(summary).toContainText(/seed/i);
  await expect(summary).toContainText(/delay/i);
  const chart = page.getByTestId('diff-chart');
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

test('Export run: enabled only when paused with t > 0; JSON matches Node runSummary and the footer hash', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const exportBtn = page.getByRole('button', { name: 'Export run' });
  // playing (default start): disabled
  await page.goto('/');
  await expect.poll(async () => simTime(page), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(exportBtn).toBeDisabled();
  // paused at t = 0: disabled
  const id = 'corridor-lanedrop';
  await page.goto(`/?test=1&autoplay=0&preset=${id}`);
  await waitHook(page);
  await expect(exportBtn).toBeDisabled();
  // stepped and paused: enabled
  const N = 1500;
  const r = await hAdvance(page, N);
  await expect(exportBtn).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);
  const preset = PRESETS[id]!;
  expect(download.suggestedFilename()).toMatch(new RegExp(`^weave-run-${id}-seed${preset.seed}-t[\\d.]+\\.json$`));
  const stream = (await download.createReadStream()) as unknown as AsyncIterable<Uint8Array>;
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of stream) text += dec.decode(chunk, { stream: true });
  const j = JSON.parse(text) as {
    manifest: Record<string, unknown>;
    metrics: Record<string, number | null>;
    links: { id: string }[];
    scenario: unknown;
    series: unknown[];
    diagnostics: Record<string, unknown>;
  };
  for (const k of ['buildSha', 'engineVersion', 'schemaVersion', 'classesHash', 'seed', 'simulatedTimeS', 'finalStateHash', 'exportedAt']) {
    expect(j.manifest, k).toHaveProperty(k);
  }
  expect(String(j.manifest.classesHash)).toMatch(/^[0-9a-f]{64}$/);
  expect(Number.isNaN(Date.parse(String(j.manifest.exportedAt)))).toBe(false);
  expect(j.manifest.seed).toBe(preset.seed);
  expect(j.manifest.simulatedTimeS).toBeCloseTo(r.t, 9);
  expect(j.manifest.finalStateHash).toBe(r.hash);
  await expect(page.getByTestId('state-hash')).toContainText(String(j.manifest.finalStateHash));
  for (const k of ['guardActivations', 'vehicleKm', 'guardPer1000VehKm', 'guardBySegment', 'lockedJunctions', 'reroutes', 'diversions']) {
    expect(j.diagnostics, k).toHaveProperty(k);
  }
  // metrics equal Node runSummary for the same scenario, seed and step count
  const sim = createSim({ scenario: preset, classes: defaultClasses() });
  sim.advance(N);
  const node = runSummary(sim, preset.warmupS ?? 300) as Record<string, number>;
  for (const [k, v] of Object.entries(node)) {
    const got = j.metrics[k];
    if (Number.isNaN(v)) expect(got === null || Number.isNaN(got as number), k).toBe(true);
    else expect(Math.abs((got as number) - v), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
  }
  // one entry per link plus each movement
  const net = sim.network;
  expect(j.links.map((l) => l.id).sort()).toEqual([...net.links.map((l) => l.id), ...net.movements.map((m) => m.id)].sort());
  expect(errors).toEqual([]);
});
