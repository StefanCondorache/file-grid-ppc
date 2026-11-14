import { expect, test } from '@playwright/test';
import { ROLE_LABELS, expectNoAxeViolations, loginAs } from './helpers';

test('beat 1: log in as admin and land on Garanții', async ({ page }) => {
  await loginAs(page, 'admin');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Garanții de business' })).toBeVisible();
  await expect(page.getByText('© 2026 FileGrid')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({ timeout: 15_000 });
  await expectNoAxeViolations(page);
});

test('beat 4 prerequisite: switch to racordari then auditor without logging out', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('button', { name: /Rol activ: Administrator/ }).click();
  await page.getByRole('menuitemradio', { name: 'Angajat racordări' }).click();
  await expect(page.getByRole('button', { name: /Rol activ: Angajat racordări/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Politici/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Rol activ: Angajat racordări/ }).click();
  await page.getByRole('menuitemradio', { name: 'Auditor' }).click();
  await expect(page.getByRole('button', { name: /Rol activ: Auditor/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Jurnal de audit/ })).toBeVisible();
});

test('session expiry warning appears and Rămân conectat extends it', async ({ page }) => {
  await loginAs(page, 'auditor', { idleTtlMs: 125_000 });
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText('Sesiunea expiră');
  // Final review #3: the countdown starts from the real remaining time (about 2:00), not a skewed value.
  await expect(dialog).toContainText(/expiră în (1:5\d|2:00)/);
  await expect(page.getByRole('button', { name: 'Rămân conectat' })).toBeFocused();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Rămân conectat' }).click();
  await expect(dialog).toBeHidden();
});

test('unauthenticated visits redirect to login and come back after it', async ({ page }) => {
  await page.goto('/?tab=demo');
  await expect(page).toHaveURL(/\/login\?next=/, { timeout: 15_000 });
  await page.getByLabel('Rol', { exact: true }).selectOption('dispecerat');
  await page.getByLabel('Parolă').fill('demo-2026');
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page).toHaveURL(/\/\?tab=demo$/);
});

test('shell is accessible in the dispecerat theme', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dispecerat'));
  await expectNoAxeViolations(page);
});

test('passwordless demo login: the role-only page is accessible and logs in', async ({ page }) => {
  // The mock knob mirrors FILEGRID_PASSWORDLESS_LOGIN=true; set before the page reads GET /auth/login-options.
  await page.addInitScript(() => window.localStorage.setItem('fg.mock', JSON.stringify({ passwordless: true })));
  await page.goto('/login');
  await expect(page.getByText('Mod demo: autentificare fără parolă.')).toBeVisible();
  await expect(page.getByLabel('Rol', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Parolă')).toHaveCount(0);
  await expectNoAxeViolations(page);
  await page.getByLabel('Rol', { exact: true }).selectOption('dispecerat');
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.getByText(`Rol activ: ${ROLE_LABELS.dispecerat}`)).toBeVisible();
});
