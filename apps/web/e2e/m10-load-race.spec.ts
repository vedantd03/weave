/**
 * Load race (MODEL.md §6.3 item 1, load registration): a load is registered the moment it is
 * requested, before any download; the start-up default never replaces a load already requested;
 * Play (header "Play", exact, and the play-prompt) is disabled from the request until that latest
 * load is ready.
 *
 * Deterministic: /data/silkboard.json is held by page.route on a promise the test releases (no
 * timers decide the race). "Time does not advance while held" is observed over 60 animation
 * frames, since the simulation is driven per frame (≈1 s at 60 Hz).
 *
 * Selectors (existing): combobox "Scenario", button "Play" (exact), data-testid play-prompt,
 * sim-time ("t = 0.0 s"), stat-vehicles (Live tab, the default).
 */
import { expect, test, type Page, type Route } from '@playwright/test';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
const num = (s: string | null) => Number(/-?\d+(?:\.\d+)?/.exec(s ?? '')?.[0] ?? NaN);
const simTime = async (page: Page) => num(await page.getByTestId('sim-time').textContent());
const frames = (page: Page, n: number) =>
  page.evaluate((k) => new Promise<void>((done) => {
    let i = 0;
    const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/** Hold every request for the silkboard network until release() is called. */
async function holdSilkboard(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const requested = new Promise<void>((r) => (hit = r));
  await page.route('**/data/silkboard.json', async (route: Route) => {
    hit();
    await gate;
    await route.continue();
  });
  return { requested, release };
}

/** While the load is held: Play disabled, prompt absent or disabled, and a Play attempt does nothing. */
async function expectBlocked(page: Page) {
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeDisabled();
  const prompt = page.getByTestId('play-prompt');
  if ((await prompt.count()) > 0) await expect(prompt).toBeDisabled();
  // a user clicking anyway (force bypasses the actionability wait) must not start a run
  await play.click({ force: true });
  if ((await prompt.count()) > 0) await prompt.click({ force: true });
  await frames(page, 60);
  await expect(page.getByTestId('sim-time')).toHaveText('t = 0.0 s');
  await expect(play).toBeDisabled();
}

async function expectPlays(page: Page) {
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeEnabled({ timeout: 60_000 });
  await play.click();
  // bound: Silk Board runs well above 1 sim-second per wall-second; 60 s is generous
  await expect.poll(() => simTime(page), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => num(await page.getByTestId('stat-vehicles').textContent()), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue('silkboard');
}

test.describe('load race (§6.3 item 1)', () => {
  test.setTimeout(180_000);

  test('selecting silkboard while its network downloads: Play disabled until ready, then plays silkboard', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({ timeout: 60_000 });
    const held = await holdSilkboard(page);
    await page.getByRole('combobox', { name: 'Scenario' }).selectOption('silkboard');
    await held.requested;
    await expectBlocked(page);
    held.release();
    await expectPlays(page);
    expect(errors).toEqual([]);
  });

  test('start-up with ?preset=silkboard: Play disabled while held; then silkboard (not the default) loads and plays', async ({ page }) => {
    const errors = watchErrors(page);
    const held = await holdSilkboard(page);
    await page.goto('/?preset=silkboard');
    await held.requested;
    await expectBlocked(page);
    held.release();
    await expect(page.getByRole('combobox', { name: 'Scenario' })).toHaveValue('silkboard', { timeout: 60_000 });
    await expectPlays(page);
    expect(errors).toEqual([]);
  });
});
