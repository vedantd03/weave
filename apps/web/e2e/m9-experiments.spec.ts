/**
 * §7.4 Experiments for traffic studies. Runnable against the live site
 * (BASE_URL=https://weave-simulator.vercel.app); every design is small: junction4-signal,
 * 5 min duration, 1 min warm-up, 2 reps.
 *
 * Selector contract (assumptions, flagged in the report):
 *  - radio group "Experiment type" with radios Replicate / Compare / Sweep;
 *  - number inputs "Replications", "Duration per run (min)", "Warm-up per run (min)"; sweep: select "Parameter",
 *    number inputs "From", "To", "Steps";
 *  - buttons "Set as baseline", "Add as variant" (takes its name from the textbox "Variant name"), "Flyover on (same timings)", "Run experiment", "Cancel", "Export JSON", "Export CSV",
 *    "Import"; history entries have buttons "Open" and "Delete";
 *  - test ids experiment-estimate, experiment-progress, experiment-summary, compare-chart,
 *    sweep-chart, history-list; the sweep per-point table is a table named
 *    "Sweep points"; a paired difference row contains the word "paired".
 */
import { expect, test, type Page } from '@playwright/test';
import { ExperimentFile, PRESETS } from '@weave/engine';

const PRESET = 'junction4-signal';
const DEMAND = (PRESETS[PRESET]!.od ?? []).reduce((s, r) => s + r.rateVph, 0);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
async function openExperiments(page: Page, url = `/?preset=${PRESET}`) {
  await page.goto(url);
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue(PRESET);
  await page.getByRole('tab', { name: 'Experiments' }).or(page.getByRole('button', { name: 'Experiments', exact: true })).first().click();
  await expect(page.getByRole('button', { name: 'Run experiment' })).toBeVisible();
}
async function chooseType(page: Page, type: 'Replicate' | 'Compare' | 'Sweep') {
  await page.getByRole('radiogroup', { name: 'Experiment type' }).getByRole('radio', { name: type }).check();
}
async function smallRun(page: Page, reps = 2) {
  await page.getByLabel('Replications', { exact: true }).fill(String(reps));
  await page.getByLabel('Duration per run (min)', { exact: true }).fill('5');
  await page.getByLabel('Warm-up per run (min)', { exact: true }).fill('1');
}
async function runToEnd(page: Page) {
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await expect(page.getByTestId('experiment-progress')).toContainText(/([1-9]\d*) \/ \1/, { timeout: 240_000 });
  await expect(page.getByTestId('experiment-summary')).toBeVisible();
}
async function download(page: Page, button: string): Promise<{ text: string; path: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
  const stream = (await d.createReadStream()) as unknown as AsyncIterable<Uint8Array>;
  let text = '';
  const dec = new TextDecoder();
  for await (const c of stream) text += dec.decode(c, { stream: true });
  return { text, path: (await d.path())! };
}
async function setDemand(page: Page, v: number) {
  await page.getByLabel('Demand (veh/h)', { exact: true }).fill(String(v));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}
async function addVariant(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Variant name' }).fill(name);
  await page.getByRole('button', { name: 'Add as variant', exact: true }).click();
}
/** RFC 4180 rows: quoted fields may contain commas and doubled quotes (labels are quoted). */
function csvRows(text: string): string[][] {
  return text.trim().split(/\r?\n/).map((line) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}

test.describe('experiments (§7.4)', () => {
  test.setTimeout(300_000);

  test('Compare: baseline + "More demand" + one-click "Flyover on (same timings)"; paired differences', async ({ page }) => {
    const errors = watchErrors(page);
    await openExperiments(page);
    await chooseType(page, 'Compare');
    await page.getByRole('button', { name: 'Set as baseline', exact: true }).click();
    await setDemand(page, 3600);
    await addVariant(page, 'More demand');
    await expect(page.getByText(`Demand ${fmt(DEMAND)} → ${fmt(3600)}`)).toBeVisible();
    // one-click variants only offer changes: junction4-signal has no flyover, so "Flyover on (same timings)"
    await expect(page.getByRole('button', { name: 'Flyover off', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Flyover on (same timings)', exact: true }).click();
    await expect(page.getByText('Flyover off → on').first()).toBeVisible();
    await smallRun(page);
    await runToEnd(page);
    const results = page.getByTestId('experiment-summary').locator('..');
    await expect(results.getByText('More demand').first()).toBeVisible();
    await expect(page.getByText(/paired/i).first()).toBeVisible();
    await expect(page.getByTestId('compare-chart')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Sweep: demand scale 0.8 → 1.2 in 3 steps × 2 reps = 6 runs; chart, 3 points, identical seeds per point', async ({ page }) => {
    const errors = watchErrors(page);
    await openExperiments(page);
    await chooseType(page, 'Sweep');
    await page.getByRole('combobox', { name: 'Parameter', exact: true }).selectOption({ label: 'Demand scale' });
    await page.getByLabel('From', { exact: true }).fill('0.8');
    await page.getByLabel('To', { exact: true }).fill('1.2');
    await page.getByLabel('Steps', { exact: true }).fill('3');
    await smallRun(page);
    await expect(page.getByTestId('experiment-estimate')).toContainText(/\b6 runs\b/);
    await runToEnd(page);
    await expect(page.getByTestId('sweep-chart')).toBeVisible();
    const table = page.getByRole('table', { name: 'Sweep points' });
    await expect(table.locator('tbody tr')).toHaveCount(3);
    // seeds: identical at every point (§7.3)
    const csv = csvRows((await download(page, 'Export CSV')).text);
    const header = csv[0]!;
    const seedCol = header.findIndex((h) => /^seed$/i.test(h));
    const groupCol = header.findIndex((h) => /point|scenario|group/i.test(h));
    expect(seedCol).toBeGreaterThanOrEqual(0);
    expect(groupCol).toBeGreaterThanOrEqual(0);
    const byGroup = new Map<string, string[]>();
    for (const row of csv.slice(1)) byGroup.set(row[groupCol]!, [...(byGroup.get(row[groupCol]!) ?? []), row[seedCol]!]);
    expect(byGroup.size).toBe(3);
    const sets = [...byGroup.values()].map((s) => [...s].sort().join(','));
    expect(new Set(sets).size).toBe(1);
    expect(errors).toEqual([]);
  });

  test('Cancel stops a run without errors', async ({ page }) => {
    const errors = watchErrors(page);
    await openExperiments(page);
    await chooseType(page, 'Replicate');
    await page.getByLabel('Replications', { exact: true }).fill('20');
    await page.getByLabel('Duration per run (min)', { exact: true }).fill('60');
    await page.getByRole('button', { name: 'Run experiment' }).click();
    const progress = page.getByTestId('experiment-progress');
    await expect(progress).toContainText(/\d+ \/ 20/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    // the progress readout may be removed on cancel: read it without waiting (allTextContents)
    await page.waitForTimeout(500); // let an in-flight message settle
    const after = (await progress.allTextContents()).join('');
    await page.waitForTimeout(3000);
    const later = (await progress.allTextContents()).join('');
    expect(later).toBe(after); // no further progress
    expect(after).not.toMatch(/20 \/ 20/);
    await expect(page.getByRole('button', { name: 'Run experiment' })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('Import an exported experiment after reload and rerun: identical metrics; a run export reports "hash matches"', async ({ page }) => {
    const errors = watchErrors(page);
    await openExperiments(page);
    await chooseType(page, 'Replicate');
    await smallRun(page);
    await runToEnd(page);
    const first = await download(page, 'Export JSON');
    const f1 = ExperimentFile.parse(JSON.parse(first.text));
    expect(f1.results?.runs.length).toBe(2);
    await page.reload();
    await openExperiments(page);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import', exact: true }).click()]);
    await chooser.setFiles(first.path);
    await expect(page.getByTestId('experiment-progress')).toContainText(/([1-9]\d*) \/ \1/, { timeout: 240_000 });
    await expect(page.getByTestId('experiment-summary')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).toBeEnabled();
    const second = ExperimentFile.parse(JSON.parse((await download(page, 'Export JSON')).text));
    const r1 = f1.results!.runs;
    const r2 = second.results!.runs;
    expect(r2.map((r) => [r.group, r.seed])).toEqual(r1.map((r) => [r.group, r.seed]));
    r1.forEach((run, i) => {
      for (const [k, v] of Object.entries(run.metrics)) {
        const w = r2[i]!.metrics[k];
        if (v === null) expect(w, k).toBeNull();
        else expect(Math.abs((w as number) - v), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
      }
    });
    // a run export: step, pause, "Export run" (Live tab), import it in Experiments
    await page.getByRole('tab', { name: 'Live' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => Number(/-?\d+(?:\.\d+)?/.exec((await page.getByTestId('sim-time').textContent()) ?? '')?.[0] ?? 0), { timeout: 60_000 }).toBeGreaterThan(10);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const runFile = await download(page, 'Export run');
    await page.getByRole('tab', { name: 'Experiments' }).click();
    const [c2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import', exact: true }).click()]);
    await c2.setFiles(runFile.path);
    await expect(page.getByText(/hash matches/i)).toBeVisible({ timeout: 120_000 });
    expect(errors).toEqual([]);
  });

  test('URL round trip: after Apply the hash holds the scenario; a new page restores it at t = 0', async ({ page, context }) => {
    const errors = watchErrors(page);
    await page.goto(`/?preset=${PRESET}`);
    await expect(page.getByLabel('Demand (veh/h)', { exact: true })).toHaveValue(String(DEMAND));
    const before = await page.evaluate(() => location.hash); // the app may already carry the preset's #s=
    await setDemand(page, 3600);
    await expect.poll(() => page.evaluate(() => location.hash)).not.toBe(before);
    expect(await page.evaluate(() => location.hash)).toMatch(/^#s=/);
    const url = page.url();
    const p2 = await context.newPage();
    await p2.goto(url);
    await expect(p2.getByLabel('Demand (veh/h)', { exact: true })).toHaveValue('3600');
    expect(Number(/-?\d+(?:\.\d+)?/.exec((await p2.getByTestId('sim-time').textContent()) ?? '')?.[0])).toBe(0);
    expect(errors).toEqual([]);
  });

  test('History: a finished experiment is listed, reopens, and can be deleted', async ({ page }) => {
    const errors = watchErrors(page);
    await openExperiments(page);
    await chooseType(page, 'Replicate');
    await smallRun(page);
    await runToEnd(page);
    const list = page.getByTestId('history-list');
    const items = list.getByRole('listitem');
    await expect(items.first()).toBeVisible();
    const n = await items.count();
    await items.first().getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByTestId('experiment-summary')).toBeVisible();
    await items.first().getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(items).toHaveCount(n - 1);
    expect(errors).toEqual([]);
  });
});
