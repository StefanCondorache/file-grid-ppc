import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

// Task 6h.2-6h.4, final accessibility pass: every screen of the demo, WCAG 2.2 AA (axe), in the
// light theme and the dark "dispecerat" theme. No colour transitions while axe samples contrast.
test.use({ reducedMotion: 'reduce' });

const DOCUMENT_ID = '5eed0000-0000-4000-8000-000000000013';
const SCREENS: { path: string; heading: string | RegExp }[] = [
  { path: '/', heading: 'Garanții de business' },
  { path: '/meters', heading: 'Contoare live' },
  { path: '/observability', heading: 'Observabilitate' },
  { path: '/statistics', heading: 'Statistici' },
  { path: '/upload', heading: 'Încărcare' },
  { path: '/files', heading: 'Fișiere' },
  { path: `/files/${DOCUMENT_ID}`, heading: 'Fișiere' },
  { path: '/policies', heading: 'Politici' },
  { path: '/policies/fault_records', heading: 'Politici' },
  { path: '/audit', heading: 'Jurnal de audit' },
  { path: '/demo', heading: 'Cameră de control' },
];

async function both(page: Page) {
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dispecerat'));
  await expectNoAxeViolations(page);
}

for (const screen of SCREENS) {
  test(`${screen.path}: no WCAG 2.2 AA violation, light and dark`, async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1, name: screen.heading }).first()).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await both(page);
  });
}

test('a trace page: no WCAG 2.2 AA violation, light and dark', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto(`/files/${DOCUMENT_ID}`);
  await page.locator('a[href^="/traces/"]').first().click();
  await expect(page).toHaveURL(/\/traces\/.+/);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await both(page);
});

test('the login page and a phone-sized shell: no WCAG 2.2 AA violation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await expectNoAxeViolations(page);
  await loginAs(page, 'teren');
  await both(page);
});
