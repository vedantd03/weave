/**
 * Revision 4: the scenario panel (docs/MODEL.md §6.3 item 7) and 3D inspection (item 8).
 *
 * Contract assumptions (flagged): the OD table is a <details> element whose <summary> mentions
 * "OD"; the time-step select is labelled "Time step…"; the 2D/3D options are reachable by role
 * and name; weaveTest.frame() and weaveTest.worldToScreen3d(x, y, z) as in §6.3 item 8.
 */
import { expect, test, type Page } from '@playwright/test';
import { F_X, F_Y, F_Z, PRESETS, defaultClasses } from '@weave/engine';

type Hook = {
  advance(n: number): Promise<{ hash: string; t: number; count: number }>;
  frame(): Promise<{ data: number[]; count: number }>;
  worldToScreen3d(x: number, y: number, z: number): Promise<{ x: number; y: number }>;
};
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
const select = (page: Page) => page.getByRole('combobox', { name: 'Scenario' });
const option = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true }).or(page.getByRole('tab', { name, exact: true })).or(page.getByRole('button', { name, exact: true })).first();
const zoneLabel = (z: string) => z.replace(/^arm(\d+)_(in|out)$/, (_m, k: string) => `Arm ${Number(k) + 1}`);

test.describe('scenario panel (§6.3 item 7)', () => {
  test('every preset shows a non-empty one-line description', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    for (const id of Object.keys(PRESETS)) {
      await select(page).selectOption(id);
      const d = page.getByTestId('scenario-description');
      await expect(d, id).toBeVisible();
      expect(((await d.textContent()) ?? '').trim().length, id).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });

  test('"Demand (veh/h)" is the first field, before "Lateral model"', async ({ page }) => {
    await page.goto('/');
    const demand = await page.getByLabel('Demand (veh/h)', { exact: true }).elementHandle();
    const lateral = await page.getByLabel('Lateral model', { exact: true }).elementHandle();
    const follows = await page.evaluate(([a, b]) => Boolean(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING), [demand, lateral] as const);
    expect(follows).toBe(true);
  });

  test('Silk Board: demand note mentions 60% and 70%; the OD table is collapsed', async ({ page }) => {
    await page.goto('/?preset=silkboard');
    const note = page.getByTestId('demand-note');
    await expect(note).toContainText('60%');
    await expect(note).toContainText('70%');
    const od = page.locator('details').filter({ has: page.locator('summary', { hasText: /OD/ }) }).first();
    await expect(od).toBeAttached();
    expect(await od.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  });

  test('junction OD rows are labelled "Arm k → Arm m (veh/h)"', async ({ page }) => {
    await page.goto('/?preset=junction4-signal');
    const od = PRESETS['junction4-signal']!.od ?? [];
    expect(od.length).toBeGreaterThan(0);
    for (const row of od) {
      await expect(page.getByLabel(`${zoneLabel(row.origin)} → ${zoneLabel(row.destination)} (veh/h)`, { exact: true })).toBeAttached();
    }
  });

  test('"Box compliance" only where the network has a junction node', async ({ page }) => {
    for (const [id, present] of [
      ['ring-demo', false],
      ['corridor-lanedrop', false],
      ['junction4-signal', true],
      ['merge-onramp', true],
    ] as const) {
      await page.goto(`/?preset=${id}`);
      await expect(select(page)).toHaveValue(id);
      await expect(page.getByLabel('Box compliance')).toHaveCount(present ? 1 : 0);
    }
  });

  test('the Time step select offers exactly 0.1, 0.2 and 0.25 s', async ({ page }) => {
    await page.goto('/');
    const ts = page.getByLabel(/^Time step/);
    await expect(ts).toBeAttached(); // the form appears only after the worker is ready (evaluateAll does not wait)
    const values = await ts.locator('option').evaluateAll((os) => os.map((o) => Number((o as HTMLOptionElement).value)));
    expect(values).toEqual([0.1, 0.2, 0.25]);
  });
});

test('3D inspection: hover/tap a vehicle shows the card without any readPixels; empty sky clears it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __readPixels: number };
    w.__readPixels = 0;
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!C) continue;
      const orig = C.prototype.readPixels;
      C.prototype.readPixels = function (this: unknown, ...args: unknown[]) {
        w.__readPixels++;
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof orig;
    }
  });
  await page.goto('/?test=1&preset=junction4-flyover');
  await page.waitForFunction(() => Boolean((window as unknown as { weaveTest?: unknown }).weaveTest), undefined, { timeout: 15_000 });
  await page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.advance(600));
  await option(page, '3D').click();
  const c3 = page.getByTestId('sim-canvas-3d');
  await expect(c3).toBeVisible({ timeout: 20_000 });
  const f = await page.evaluate(async () => (window as unknown as { weaveTest: Hook }).weaveTest.frame());
  expect(f.count).toBeGreaterThan(0);
  const p = await page.evaluate(
    async ([x, y, z]) => (window as unknown as { weaveTest: Hook }).weaveTest.worldToScreen3d(x, y, z),
    [f.data[F_X]!, f.data[F_Y]!, f.data[F_Z]!] as const,
  );
  const touch = Boolean(test.info().project.use.hasTouch);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.move(p.x, p.y);
  const card = page.getByTestId('inspect-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('km/h');
  const text = (await card.textContent()) ?? '';
  expect(defaultClasses().classes.some((c) => text.includes(c.label))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __readPixels: number }).__readPixels)).toBe(0);
  // empty sky: just inside the top-left corner of the 3D canvas
  const box = (await c3.boundingBox())!;
  if (touch) await page.touchscreen.tap(box.x + 4, box.y + 4);
  else await page.mouse.click(box.x + 4, box.y + 4);
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __readPixels: number }).__readPixels)).toBe(0);
  expect(errors).toEqual([]);
});
