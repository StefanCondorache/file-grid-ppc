import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

// No colour transitions: axe must not sample a button halfway through the theme switch.
test.use({ reducedMotion: 'reduce' });

/** From the policy list to the fault records policy, through its card (as the presenter clicks). */
async function openFaultPolicy(page: Page, link: 'Modifică' | 'Vezi') {
  await page.getByRole('link', { name: /Politici/ }).click();
  await expect(page.getByRole('heading', { name: 'Politici de stocare' })).toBeVisible();
  const card = page.getByRole('heading', { level: 2, name: 'Înregistrări defecte' }).locator('..');
  await card.getByRole('link', { name: link }).click();
  await expect(page).toHaveURL(/\/policies\/fault_records$/);
}

test('beat 7: admin moves fault records to FTP live, with diff and confirm', async ({ page }) => {
  await loginAs(page, 'admin');
  await openFaultPolicy(page, 'Modifică');

  await page.getByLabel('Storage principal').selectOption('ftp');
  await page.getByLabel('Storage de rezervă').selectOption('s3');
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dispecerat'));
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  await page.getByRole('button', { name: 'Revizuiește modificările' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('listitem').filter({ hasText: /Storage principal/ })).toContainText(/S3 → FTP/);
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Salvează' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Salvat · versiunea v4' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^v4/ })).toBeVisible();
});

test('the auditor sees the policy read-only', async ({ page }) => {
  await loginAs(page, 'auditor');
  await openFaultPolicy(page, 'Vezi');
  await expect(page.getByText('Doar administratorul poate modifica politicile.')).toBeVisible();
  for (const select of await page.getByRole('combobox').all()) await expect(select).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Revizuiește modificările' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});
