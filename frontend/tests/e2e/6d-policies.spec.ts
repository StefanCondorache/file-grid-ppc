import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

// No colour transitions: axe must not sample a button halfway through the theme switch.
test.use({ reducedMotion: 'reduce' });

test('beat 7: admin moves fault records to FTP live, with diff and confirm', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.getByRole('link', { name: /Politici/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Politici de stocare' })).toBeVisible();
  await page.getByRole('link', { name: 'Înregistrări de avarii' }).click();

  await page.getByLabel('Storage principal').selectOption('ftp');
  await page.getByLabel('Storage de rezervă').selectOption('s3');
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dispecerat'));
  await expectNoAxeViolations(page);
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  await page.getByRole('button', { name: 'Revizuiește modificările' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('row', { name: /Storage principal S3 FTP/ })).toBeVisible();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Confirmă și salvează' }).click();

  await expect(page.getByText('Salvat · versiunea v4')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /^v4/ })).toContainText('Storage principal: S3 → FTP');
});

test('the auditor sees the policy read-only', async ({ page }) => {
  await loginAs(page, 'auditor');
  await page.goto('/policies/fault_records');
  await expect(page.getByText('Doar vizualizare: numai administratorul poate modifica politicile.')).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revizuiește modificările' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

// Needs the upload screen of slice 6b; enabled after 6b is merged (cross-slice check in Task 6h.0).
test.skip('beat 7: the next fault upload lands on FTP with policy v4', async () => {
  // change faults primary S3 → FTP, upload a fault, detail shows "Stocat pe FTP · politica v4".
});
