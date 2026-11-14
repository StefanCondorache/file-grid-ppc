import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './helpers';

test('healthz and the login page are reachable and accessible', async ({ page, request }) => {
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.text()).toBe('ok');

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Intră în cont' })).toBeVisible();
  await expect(page.getByText('Date simulate')).toBeVisible();
  await expectNoAxeViolations(page);
});
