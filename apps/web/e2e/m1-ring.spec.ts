/**
 * M1 UI checks: ring demo plays and draws, Step advances exactly one dt, and the browser's
 * state hash equals the Node engine's hash for the same preset, seed and step count
 * (ADR-002: bit-identical results across JS engines).
 *
 * UI contract (M1):
 *  - <select aria-label="Scenario"> with option value "ring-demo"
 *  - buttons aria-label "Play" (→ "Pause" while running) and "Step"
 *  - data-testid: sim-canvas (<canvas>), sim-time (simulated seconds, as a decimal number),
 *    stat-vehicles (vehicle count), state-hash (hex)
 *  - with ?test=1: window.weaveTest.load(presetId, seed) and .advance(steps)
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PRESETS, createSim, defaultClasses } from '@weave/engine';

/** §6.3 item 1: the app now opens playing; tests that need a fixed, paused start add ?autoplay=0. */
const paused = (url: string) => url + (url.includes('?') ? '&' : '?') + 'autoplay=0';

interface WeaveTestHook {
  load(presetId: string, seed: number): Promise<void>;
  advance(steps: number): Promise<{ hash: string; t: number; count: number }>;
}

const RING = PRESETS['ring-demo']!;
/** dt of the preset, with the schema default 0.2 s (MODEL.md §0) when the preset omits it. */
const DT = RING.dtS ?? 0.2;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** First decimal number in a text, and how many decimals it was displayed with. */
function parseSeconds(text: string): { value: number; decimals: number } {
  const m = /-?\d+(?:\.(\d+))?/.exec(text);
  if (!m) throw new Error(`no number in sim-time text: "${text}"`);
  return { value: Number(m[0]), decimals: m[1]?.length ?? 0 };
}

async function simTime(page: Page): Promise<{ value: number; decimals: number }> {
  return parseSeconds((await page.getByTestId('sim-time').textContent()) ?? '');
}

async function openRing(page: Page, url = '/'): Promise<void> {
  await page.goto(paused(url));
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption('ring-demo');
  await expect(page.getByTestId('sim-canvas')).toBeVisible();
  // The ring has no demand: its vehicle count is fixed by initial placement (MODEL.md §1.7).
  const expected = createSim({ scenario: RING, classes: defaultClasses() }).vehicleCount();
  expect(expected).toBeGreaterThan(0);
  await expect(page.getByTestId('stat-vehicles')).toHaveText(new RegExp(`\\b${expected}\\b`), { timeout: 15_000 });
}

async function canvasPng(canvas: Locator): Promise<string> {
  const buf = await canvas.screenshot();
  // Typed without @types/node: the Buffer Playwright returns has toString('base64').
  return (buf as unknown as { toString(enc: 'base64'): string }).toString('base64');
}

/**
 * Decodes two PNG screenshots of the canvas in the page and compares them pixel by pixel.
 * The background is the most frequent colour of the first image. Using screenshots (not
 * getImageData on the live canvas) works for both 2D and WebGL canvases.
 */
async function comparePngs(page: Page, a: string, b: string) {
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
    const counts = new Map<number, number>();
    let bg = 0;
    let bgCount = -1;
    for (const p of A) {
      const k = (counts.get(p) ?? 0) + 1;
      counts.set(p, k);
      if (k > bgCount) {
        bgCount = k;
        bg = p;
      }
    }
    let nonBgA = 0;
    let nonBgB = 0;
    let changed = 0;
    for (let i = 0; i < A.length; i++) {
      if (A[i] !== bg) nonBgA++;
      if (B[i] !== bg) nonBgB++;
      if (A[i] !== B[i]) changed++;
    }
    return { pixels: A.length, sameSize: A.length === B.length, nonBgA, nonBgB, changed };
  }, [a, b] as const);
}

test('ring demo: Play advances simulated time and draws moving vehicles', async ({ page }) => {
  const errors = watchErrors(page);
  await openRing(page);
  const canvas = page.getByTestId('sim-canvas');
  const t0 = (await simTime(page)).value;
  const before = await canvasPng(canvas);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  // Time must advance while playing (by more than a few steps).
  await expect.poll(async () => (await simTime(page)).value, { timeout: 15_000 }).toBeGreaterThan(t0 + 10 * DT);
  const after = await canvasPng(canvas);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  const r = await comparePngs(page, before, after);
  expect(r.sameSize).toBe(true);
  // Something other than the background is drawn (road and vehicles) in both frames.
  expect(r.nonBgA).toBeGreaterThan(50);
  expect(r.nonBgB).toBeGreaterThan(50);
  // Vehicles moved: a car body (≈ 4 m × 1.7 m) is at least a few pixels at any sensible
  // zoom, and displacing it changes its old and new footprint. ≥ 10 changed pixels is a
  // deliberately low bar that a static picture (no vehicles, or frozen vehicles) cannot meet.
  expect(r.changed).toBeGreaterThanOrEqual(10);
  expect(errors).toEqual([]);
});

test('ring demo: Step advances exactly one dt', async ({ page }) => {
  const errors = watchErrors(page);
  await openRing(page);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible(); // paused after load
  const hash0 = (await page.getByTestId('state-hash').textContent())?.trim() ?? '';
  expect(hash0).toMatch(/^[0-9a-f]+$/i);

  for (let k = 0; k < 3; k++) {
    const t0 = await simTime(page);
    // The display rounds t to d decimals (d ≥ 1 needed to resolve dt = 0.2 s): each reading
    // is off by ≤ ½·10^-d, so a difference is within 10^-d of the true Δt = dt. With d ≥ 1
    // this still separates one step (0.2 s) from zero or two steps.
    expect(t0.decimals).toBeGreaterThanOrEqual(1);
    const tol = Math.pow(10, -t0.decimals) + 1e-9;
    await page.getByRole('button', { name: 'Step' }).click();
    await expect.poll(async () => (await simTime(page)).value).not.toBe(t0.value);
    const t1 = await simTime(page);
    expect(Math.abs(t1.value - t0.value - DT)).toBeLessThanOrEqual(tol);
  }
  await expect(page.getByTestId('state-hash')).not.toHaveText(hash0);
  expect(errors).toEqual([]);
});

test('cross-runtime determinism: browser state hash equals the Node engine hash', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(paused('/?test=1'));
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, {
    timeout: 15_000,
  });

  for (const seed of [1, 20261114]) {
    const node = createSim({ scenario: { ...RING, seed }, classes: defaultClasses() });

    const first = await page.evaluate(
      async ([s, n]) => {
        const hook = (window as unknown as { weaveTest: WeaveTestHook }).weaveTest;
        await hook.load('ring-demo', s);
        return hook.advance(n);
      },
      [seed, 300] as const,
    );
    node.advance(300);
    expect(first.hash).toBe(node.stateHash());
    expect(first.count).toBe(node.vehicleCount());
    expect(first.t).toBe(node.t);

    // advance() continues from the current state
    const second = await page.evaluate(
      async (n) => (window as unknown as { weaveTest: WeaveTestHook }).weaveTest.advance(n),
      450,
    );
    node.advance(450);
    expect(second.hash).toBe(node.stateHash());
    expect(second.count).toBe(node.vehicleCount());
    expect(second.t).toBe(node.t);
  }
  expect(errors).toEqual([]);
});
