import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

test('auditor filters to PII reveals on a connection document; filters survive reload', async ({ page }) => {
  // No colour transitions, so axe never samples a button mid-way through the theme switch.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginAs(page, 'auditor');
  await page.getByRole('link', { name: /Jurnal de audit/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Jurnal de audit' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'ID urmărire' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByLabel('Acțiune').selectOption('reveal_pii');
  await page.getByLabel('ID fișier').fill('f-con-0412');
  await page.getByRole('button', { name: 'Aplică filtrele' }).click();
  await expect(page).toHaveURL(/action=reveal_pii/);
  await expect(page).toHaveURL(/fileId=f-con-0412/);

  const rows = page.getByRole('row').filter({ hasText: 'Afișare date personale' });
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Maria Ionescu' })).toContainText('Contestație client, dosar 1187');
  await expect(rows.filter({ hasText: 'Rol demo: Auditor' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Refuzat' })).toHaveCount(1);

  await page.reload();
  await expect(page.getByLabel('Acțiune')).toHaveValue('reveal_pii');
  await expect(page.getByRole('row').filter({ hasText: 'Afișare date personale' })).toHaveCount(3);
  const trace = page.getByRole('link', { name: '5c2e1f0a9b8d47c6a3e2f1d0c9b8a706' });
  await expect(trace).toHaveAttribute('href', '/traces/5c2e1f0a9b8d47c6a3e2f1d0c9b8a706');

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dispecerat'));
  await expectNoAxeViolations(page);
});

test('teren is forbidden and never requests the audit trail', async ({ page }) => {
  const auditCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/audit-events')) auditCalls.push(r.url());
  });
  await loginAs(page, 'teren');
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Nu ai acces la această pagină' })).toBeVisible();
  await expect(page.getByText('Doar auditorul și administratorul pot vedea jurnalul de audit.')).toBeVisible();
  expect(auditCalls).toEqual([]);
});
