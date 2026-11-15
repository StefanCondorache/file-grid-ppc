import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

// Task 6h.0: one journey across the slices. The policy saved in 6d decides where the next upload of
// 6b goes; the file of 6c shows it and its trace; the audit trail of 6h.1 records both.
test.use({ reducedMotion: 'reduce' });

const FILE = 'test-e2e-avarie.pdf';

test('a policy change is followed by the next upload, which is traced and audited', async ({ page }) => {
  await loginAs(page, 'admin');

  // 6d: fault records move from S3 to FTP (version v4).
  await page.getByRole('link', { name: /Politici/ }).click();
  await page.getByRole('heading', { level: 2, name: 'Înregistrări defecte' }).locator('..').getByRole('link', { name: 'Modifică' }).click();
  await page.getByLabel('Storage principal').selectOption('ftp');
  await page.getByLabel('Storage de rezervă').selectOption('s3');
  await page.getByRole('button', { name: 'Revizuiește modificările' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Salvează' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Salvat · versiunea v4' })).toBeVisible();

  // 6b: the next fault record is uploaded with its metadata, hashed in the browser and confirmed.
  await page.getByRole('link', { name: 'Încărcare', exact: true }).click();
  await page.getByText('Înregistrare de avarie', { exact: true }).click();
  // The category is in the URL (router.replace is asynchronous): pick files once the screen shows it.
  await expect(page).toHaveURL(/category=fault/);
  await expect(page.getByRole('radio', { name: 'Înregistrare de avarie' })).toBeChecked();
  await page.locator('input[type=file]').first().setInputFiles({ name: FILE, mimeType: 'application/pdf', buffer: Buffer.alloc(64 * 1024, 7) });
  await page.getByLabel('Zonă').selectOption('banat');
  await page.getByLabel('Stație sau post de transformare').fill('Stația E2E Timișoara Nord');
  await page.getByLabel('Severitate').selectOption('high');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: /^Încarcă/ }).click();
  await page.getByRole('link', { name: 'Deschide fișierul' }).click({ timeout: 30_000 });

  // 6c: the file says where it is stored and under which policy, and opens its trace.
  await expect(page.getByRole('heading', { name: FILE })).toBeVisible();
  await expect(page.getByText(/pe FTP · politica v4/).first()).toBeVisible();
  await expectNoAxeViolations(page);
  await page.locator('a[href^="/traces/"]').first().click();
  await expect(page).toHaveURL(/\/traces\/.+/);

  // 6h.1: the auditor finds the policy change and the upload in the audit trail.
  await page.getByRole('button', { name: /Rol activ: Administrator/ }).click();
  await page.getByRole('menuitemradio', { name: 'Auditor' }).click();
  await page.getByRole('link', { name: /Jurnal de audit/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Modificare politică' }).first()).toBeVisible();
  await page.getByLabel('Acțiune').selectOption('upload');
  await expect(page).toHaveURL(/action=upload/);
  await expect(page.getByRole('row').filter({ hasText: FILE })).toHaveCount(1);
});
