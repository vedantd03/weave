import { expect, test } from '@playwright/test';

test('app shell loads, worker answers, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveTitle('Weave');
  await expect(page.getByTestId('worker-status')).toContainText('ready', { timeout: 15_000 });
  await expect(page.getByRole('main', { name: 'Simulation view' })).toBeVisible();

  // No horizontal page scroll at any viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  expect(errors).toEqual([]);
});
