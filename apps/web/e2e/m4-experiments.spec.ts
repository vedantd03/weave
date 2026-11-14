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
 * Assumptions (flagged): runExperiment resolves to { base: ReplicateResult[], variant?: … }
 * (or { results: … }), compare 'none' means no comparison, and replicate i uses seed
 * scenario.seed + i (§5.4), so Node's runReplicate reproduces it exactly.
 */
import { expect, test, type Page } from '@playwright/test';
import { PRESETS, defaultClasses, runReplicate } from '@weave/engine';

type Rep = { seed: number; metrics: Record<string, number> };
type Hook = { runExperiment(o: { replications: number; compare: string }): Promise<unknown> };
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

test('"Flyover on (retimed)" vs "Flyover off" shows a paired-difference column', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchErrors(page);
  await open(page, 'junction4-flyover');
  await page.getByLabel('Replications', { exact: true }).fill('2');
  await page.getByLabel('Compare with', { exact: true }).selectOption({ label: 'Flyover on (retimed)' });
  await page.getByRole('button', { name: 'Run experiment' }).click();
  const results = page.getByTestId('experiment-results');
  await expect(page.getByTestId('experiment-progress')).toContainText(/(\d+) \/ \1/, { timeout: 240_000 });
  await expect(results).toBeVisible();
  await expect(results.getByRole('columnheader', { name: /difference|Δ/i })).toBeVisible();
  // one row per metric
  expect(await results.getByRole('row').count()).toBeGreaterThanOrEqual(9 + 1);
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
