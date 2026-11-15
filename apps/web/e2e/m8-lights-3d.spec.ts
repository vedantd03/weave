/**
 * 3D traffic lights (docs/MODEL.md §6.3 item 9; render only).
 *  - One light per movement with control 'signal' at a node that has a signal plan.
 *  - Colour = the movement's current signal code with the 2D colours:
 *    0 red #ef4444, 1 amber #f59e0b, 2 green #22c55e, 3 permissive #38bdf8.
 *  - Hook: weaveTest.signalLights3d() → [{ movement, colour }], weaveTest.signalLightPos3d(i)
 *    → page coordinates of light i; weaveTest.signals() → code per movement index.
 * Assumption (flagged): the "2D / 3D" option is reachable by role and name "3D".
 */
import { expect, test, type Page } from '@playwright/test';
import { PRESETS, createSim, cycleLength, defaultClasses } from '@weave/engine';

type Light = { movement: string; colour: string };
type Hook = {
  advance(n: number): Promise<{ hash: string; t: number; count: number }>;
  signals(): Promise<number[]>;
  signalLights3d(): Promise<Light[]>;
  signalLightPos3d(i: number): Promise<{ x: number; y: number }>;
};
const COLOUR: Record<number, string> = { 0: '#ef4444', 1: '#f59e0b', 2: '#22c55e', 3: '#38bdf8' };
const STATE = /\b(Red|Amber|Green|Permissive)\b/;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
const W = (page: Page) => ({
  advance: (n: number) => page.evaluate(async (k) => (window as unknown as { weaveTest: Hook }).weaveTest.advance(k), n),
  signals: () => page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.signals()),
  lights: () => page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.signalLights3d()),
  pos: (i: number) => page.evaluate(async (k) => (window as unknown as { weaveTest: Hook }).weaveTest.signalLightPos3d(k), i),
});
async function open3d(page: Page, preset: string) {
  await page.goto(`/?test=1&preset=${preset}`);
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
  await page
    .getByRole('radio', { name: '3D', exact: true })
    .or(page.getByRole('tab', { name: '3D', exact: true }))
    .or(page.getByRole('button', { name: '3D', exact: true }))
    .first()
    .click();
  await expect(page.getByTestId('sim-canvas-3d')).toBeVisible({ timeout: 20_000 });
}
/** Expected lights and the cycle length, from the Node network (overrides applied by createSim). */
function expected(preset: string) {
  const net = createSim({ scenario: PRESETS[preset]!, classes: defaultClasses() }).network;
  const plans = new Map(net.signals.map((p) => [p.node, p]));
  const ids = net.movements.filter((m) => m.control === 'signal' && plans.has(m.node)).map((m) => m.id);
  const override = (PRESETS[preset]!.signalOverrides ?? []) as unknown as Parameters<typeof cycleLength>[0][];
  const cycles = [...plans.values()].map((p) => cycleLength(override.find((o) => o.node === p.node) ?? p));
  return { net, ids, cycle: Math.max(...cycles) };
}

test('3D lights follow the signal plan over a full cycle', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const preset = 'junction4-signal';
  const { net, ids, cycle } = expected(preset);
  expect(ids.length).toBeGreaterThan(0);
  await open3d(page, preset);
  const w = W(page);
  const first = await w.lights();
  expect(first.map((l) => l.movement).sort()).toEqual([...ids].sort());
  const index = new Map(net.movements.map((m, i) => [m.id, i]));
  const seen = new Map<string, Set<string>>();
  const chunks = Math.ceil(cycle / 5) + 1; // 25 steps = 5 s at dt = 0.2 s; one extra chunk
  for (let k = 0; k < chunks; k++) {
    await w.advance(25);
    const [codes, lights] = [await w.signals(), await w.lights()];
    for (const l of lights) {
      const want = COLOUR[codes[index.get(l.movement)!]!]!;
      expect(l.colour.toLowerCase(), `${l.movement} at chunk ${k}`).toBe(want);
      if (!seen.has(l.movement)) seen.set(l.movement, new Set());
      seen.get(l.movement)!.add(l.colour.toLowerCase());
    }
  }
  expect([...seen.values()].some((s) => s.size >= 2)).toBe(true);
  const all = new Set([...seen.values()].flatMap((s) => [...s]));
  expect(all.has(COLOUR[0]!)).toBe(true);
  expect(all.has(COLOUR[2]!)).toBe(true);
  expect(errors).toEqual([]);
});

for (const preset of ['merge-onramp', 'ring-demo']) {
  test(`no 3D lights without signals (${preset})`, async ({ page }) => {
    const errors = watchErrors(page);
    await open3d(page, preset);
    expect(await W(page).lights()).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('inspecting a 3D light shows its movement and state, and the card follows the state', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const preset = 'junction4-signal';
  const { cycle } = expected(preset);
  await open3d(page, preset);
  const w = W(page);
  await w.advance(5);
  const lights = await w.lights();
  expect(lights.length).toBeGreaterThan(0);
  const p = await w.pos(0);
  const touch = Boolean(test.info().project.use.hasTouch);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.move(p.x, p.y);
  const card = page.getByTestId('inspect-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(lights[0]!.movement);
  const state0 = STATE.exec((await card.textContent()) ?? '')?.[1];
  expect(state0).toBeDefined();
  // step until light 0 changes colour (within one cycle), then the card's state must change too
  const c0 = lights[0]!.colour.toLowerCase();
  let changed = false;
  for (let k = 0; k < Math.ceil(cycle) + 1 && !changed; k++) { // 5 steps = 1 s per chunk
    await w.advance(5);
    changed = (await w.lights())[0]!.colour.toLowerCase() !== c0;
  }
  expect(changed).toBe(true);
  await expect.poll(async () => STATE.exec((await card.textContent()) ?? '')?.[1], { timeout: 5_000 }).not.toBe(state0);
  expect(errors).toEqual([]);
});
