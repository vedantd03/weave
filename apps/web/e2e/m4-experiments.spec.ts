/**
 * M4 UI checks: the experiment panel and its worker pool (docs/MODEL.md §5).
 *
 * UI contract (M4):
 *  - a tab or button "Experiments" opens the panel; number input "Replications" (default 10);
 *    select "Compare with" (None / Flyover off / Flyover on (same timings) / Flyover on (retimed)
 *    on flyover presets; "Signal plan as edited" after a plan edit); button "Run experiment";
 *    data-testid "experiment-progress" ("k / n"), "experiment-results" (a row per metric,
 *    columns mean ± 95% CI per variant and the paired difference with its CI); button
 *    "Download CSV".
 *  - window.weaveTest.runExperiment({ replications, compare }) returns the replicate results.
 * runExperiment resolves to { base, variant? } (§5.4), compare 'none' means no variant, and
 * replicate i uses seed scenario.seed + i with the default classes, so Node's runReplicate
 * reproduces it exactly. Assumptions (flagged): the hook's `compare` takes the value of the
 * "Compare with" option; for "Flyover on (retimed)" on a flyover preset, base = the preset with
 * the flyover disabled and variant = retimedFlyoverScenario(preset).
 */
import { expect, test, type Page } from '@playwright/test';
import { PRESETS, createSim, defaultClasses, retimedFlyoverScenario, runReplicate } from '@weave/engine';

type Rep = { seed: number; metrics: Record<string, number> };
type Hook = {
  runExperiment(o: { replications: number; compare: string }): Promise<unknown>;
  loadScenario(s: unknown): Promise<void>;
};
const JUNCTION = PRESETS['junction4-signal']!;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
async function open(page: Page, preset: string, url = '/') {
  await page.goto(url);
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption(preset);
  await page.getByRole('tab', { name: 'Experiments' }).or(page.getByRole('button', { name: 'Experiments', exact: true })).first().click();
  await expect(page.getByRole('button', { name: 'Run experiment' })).toBeVisible();
}
async function hookRun(page: Page, replications: number, compare = 'none'): Promise<Rep[]> {
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
  const r = (await page.evaluate(
    async ([n, c]) => (window as unknown as { weaveTest: Hook }).weaveTest.runExperiment({ replications: n, compare: c }),
    [replications, compare] as const,
  )) as { base?: Rep[]; results?: Rep[] };
  return (r.base ?? r.results)!;
}
function expectSameMetrics(a: Rep[], b: Rep[]) {
  expect(a.map((r) => r.seed)).toEqual(b.map((r) => r.seed));
  a.forEach((r, i) => {
    for (const [k, v] of Object.entries(r.metrics)) {
      const w = b[i]!.metrics[k]!;
      if (Number.isNaN(v)) expect(Number.isNaN(w), k).toBe(true);
      else expect(Math.abs(v - w), `${k} seed ${r.seed}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
    }
  });
}

test('panel: a 3-replication experiment runs to "3 / 3" and matches Node', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await open(page, 'junction4-signal', '/?test=1');
  await expect(page.getByLabel('Replications', { exact: true })).toHaveValue('10');
  await page.getByLabel('Replications', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText('3 / 3', { timeout: 240_000 });
  await expect(page.getByTestId('experiment-results')).toBeVisible();
  const browser = await hookRun(page, 3);
  const node = [0, 1, 2].map((i) => runReplicate({ scenario: JUNCTION, classes: defaultClasses() }, JUNCTION.seed + i) as Rep);
  expectSameMetrics(browser, node);
  expect(errors).toEqual([]);
});

test('the pool size does not change results (workers=1 vs workers=3)', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await open(page, 'junction4-signal', '/?test=1&workers=1');
  const one = await hookRun(page, 3);
  await open(page, 'junction4-signal', '/?test=1&workers=3');
  const three = await hookRun(page, 3);
  expect(three).toEqual(one);
  expect(errors).toEqual([]);
});

test('"Flyover on (retimed)" vs "Flyover off": paired-difference column; both variants match Node', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await open(page, 'junction4-flyover', '/?test=1');
  await page.getByLabel('Replications', { exact: true }).fill('2');
  const select = page.getByLabel('Compare with', { exact: true });
  await select.selectOption({ label: 'Flyover on (retimed)' });
  const value = await select.inputValue();
  await page.getByRole('button', { name: 'Run experiment' }).click();
  const results = page.getByTestId('experiment-results');
  await expect(page.getByTestId('experiment-progress')).toContainText(/(\d+) \/ \1/, { timeout: 240_000 });
  await expect(results).toBeVisible();
  await expect(results.getByRole('columnheader', { name: /difference|Δ/i })).toBeVisible();
  expect(await results.getByRole('row').count()).toBeGreaterThanOrEqual(9 + 1);

  // Node: base = flyover disabled, variant = retimedFlyoverScenario(preset)
  const fly = PRESETS['junction4-flyover']!;
  const params = fly.network.kind === 'generator' ? (fly.network.params as Record<string, unknown>) : {};
  const off = { ...fly, network: { kind: 'generator' as const, params: { ...params, flyover: { ...(params.flyover as object), enabled: false } } } } as typeof fly;
  const classes = defaultClasses();
  const retimed = retimedFlyoverScenario({ scenario: fly, classes });
  const r = (await page.evaluate(
    async ([c]) => (window as unknown as { weaveTest: Hook }).weaveTest.runExperiment({ replications: 2, compare: c }),
    [value] as const,
  )) as { base: Rep[]; variant?: Rep[] };
  expect(r.variant).toBeDefined();
  expectSameMetrics(r.base, [0, 1].map((i) => runReplicate({ scenario: off, classes }, fly.seed + i) as Rep));
  expectSameMetrics(r.variant!, [0, 1].map((i) => runReplicate({ scenario: retimed, classes }, fly.seed + i) as Rep));
  expect(errors).toEqual([]);
});

test('Download CSV gives a file with a header row', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await open(page, 'junction4-signal');
  await page.getByLabel('Replications', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText('2 / 2', { timeout: 240_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const stream = (await download.createReadStream()) as unknown as AsyncIterable<Uint8Array>;
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of stream) text += dec.decode(chunk, { stream: true });
  const lines = text.trim().split(/\r?\n/);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines[0]!).toMatch(/metric/i);
  expect(lines[0]!.split(',').length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('no horizontal overflow with the experiment panel open', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, 'junction4-signal');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

/*
 * Gridlocked runs (§5.2 `gridlocked`; UI: a "Gridlocked runs" row, data-testid "gridlocked-runs",
 * showing k / n per variant, and a role="status" warning when any run gridlocked).
 * Forced gridlock: the junction preset with a plan whose only phase protects nothing, so every
 * approach is red forever and the junction locks after 300 s (§3.4 item 6) within a 600 s run.
 * Assumption (flagged): an experiment runs on the scenario loaded through weaveTest.loadScenario.
 */
function shortJunction(allRed: boolean) {
  const node = createSim({ scenario: JUNCTION, classes: defaultClasses() }).network.signals[0]!.node;
  return {
    ...JUNCTION,
    durationS: 600,
    warmupS: 120,
    ...(allRed ? { signalOverrides: [{ node, amberS: 3, allRedS: 2, offsetS: 0, phases: [{ greenS: 60, protected: [] as string[] }] }] } : {}),
  } as typeof JUNCTION;
}
async function runLoaded(page: Page, scenario: unknown, replications: number) {
  await open(page, 'junction4-signal', '/?test=1');
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
  await page.evaluate(async (sc) => (window as unknown as { weaveTest: Hook }).weaveTest.loadScenario(sc), scenario);
  await page.getByLabel('Replications', { exact: true }).fill(String(replications));
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText(`${replications} / ${replications}`, { timeout: 240_000 });
}

test('gridlocked runs are counted per variant and flagged with a warning', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const sc = shortJunction(true);
  // premise (Node): this scenario really gridlocks
  expect((runReplicate({ scenario: sc, classes: defaultClasses() }, sc.seed) as Rep).metrics.gridlocked).toBe(1);
  await runLoaded(page, sc, 2);
  await expect(page.getByTestId('gridlocked-runs')).toContainText('2 / 2');
  await expect(page.getByRole('status').filter({ hasText: /gridlock/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test('no gridlock: the row reads 0 / n and no warning is shown', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await runLoaded(page, shortJunction(false), 2);
  await expect(page.getByTestId('gridlocked-runs')).toContainText('0 / 2');
  await expect(page.getByRole('status').filter({ hasText: /gridlock/i })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/*
 * Revision 2 (§5.2 queueGrowing / divertedTrips / guardPer1000VehKm, §5.3b): a
 * "queue-growing-runs" row with k / n per variant and a role="status" warning containing "queue"
 * when any run's entry queue is still growing; a "Diverted trips" metric row; the CSV lists
 * divertedTrips, queueGrowing and guardPer1000VehKm.
 * Oversaturated case: one 3.5 m lane at 6000 veh/h. Insertion needs gap ≥ s0 + v·T, so a lane
 * admits at most 1/T_min vehicles per second (< 6000 veh/h for every default class); the Node
 * premise checks queueGrowing = 1 on the exact scenario.
 */
function corridorScenario(rateVph: number) {
  return {
    version: 1 as const, id: 'q', name: 'queue test',
    network: { kind: 'generator' as const, params: { generator: 'corridor' as const, lengthM: 300, widthM: 3.5, lanes: 1, change: { kind: 'none' as const } } },
    od: [{ origin: 'in', destination: 'out', rateVph }],
    composition: { motorcycle: 0.56, car: 0.27, auto: 0.12, bus: 0.03, truck: 0.01, lcv: 0.01 },
    mode: 'lane' as const, durationS: 600, warmupS: 120, seed: 11,
  };
}

test('queue still growing: row k / n and a "queue" warning when oversaturated', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const sc = corridorScenario(6000);
  expect((runReplicate({ scenario: sc, classes: defaultClasses() }, sc.seed) as Rep).metrics.queueGrowing).toBe(1);
  await runLoaded(page, sc, 2);
  await expect(page.getByTestId('queue-growing-runs')).toContainText('2 / 2');
  await expect(page.getByRole('status').filter({ hasText: /queue/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test('queue not growing: row 0 / n and no "queue" warning in a light case', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  const sc = corridorScenario(300);
  expect((runReplicate({ scenario: sc, classes: defaultClasses() }, sc.seed) as Rep).metrics.queueGrowing).toBe(0);
  await runLoaded(page, sc, 2);
  await expect(page.getByTestId('queue-growing-runs')).toContainText('0 / 2');
  await expect(page.getByRole('status').filter({ hasText: /queue/i })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('results have a "Diverted trips" row; the CSV lists divertedTrips, queueGrowing and guardPer1000VehKm', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await runLoaded(page, corridorScenario(300), 2);
  const results = page.getByTestId('experiment-results');
  await expect(results.getByRole('row', { name: /Diverted trips/ })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  const stream = (await download.createReadStream()) as unknown as AsyncIterable<Uint8Array>;
  let text = '';
  const dec = new TextDecoder();
  for await (const chunk of stream) text += dec.decode(chunk, { stream: true });
  for (const id of ['divertedTrips', 'queueGrowing', 'guardPer1000VehKm']) expect(text, id).toContain(id);
  expect(errors).toEqual([]);
});
