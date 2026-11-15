import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, loginAs } from './helpers';

const DOCUMENT = 'Document racordare RC-2026-0412 (cerere)';
const DOCUMENT_ID = '5eed0000-0000-4000-8000-000000000013';
const REASON = 'Contestație client, dosar 1187';

test('an auditor reveals personal data, then finds it in the audit trail, filtered, after a reload', async ({ page }) => {
  // No colour transitions, so axe never samples a button mid-way through the theme switch.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginAs(page, 'auditor');

  await page.goto('/files?q=RC-2026-0412');
  await page.getByRole('link', { name: DOCUMENT }).click();
  await expect(page).toHaveURL(new RegExp(`/files/${DOCUMENT_ID}$`));
  await page.getByRole('button', { name: 'Afișează datele personale' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Motivul afișării').fill(REASON);
  await dialog.getByRole('button', { name: 'Afișează', exact: true }).click();
  await expect(page.getByText('Date personale afișate').first()).toBeVisible();

  await page.getByRole('link', { name: /Jurnal de audit/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Jurnal de audit' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'ID urmărire' })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByLabel('Acțiune').selectOption('reveal_pii');
  await page.getByLabel('ID fișier').fill(DOCUMENT_ID);
  await page.getByRole('button', { name: 'Aplică filtrele' }).click();
  await expect(page).toHaveURL(/action=reveal_pii/);
  await expect(page).toHaveURL(new RegExp(`fileId=${DOCUMENT_ID}`));
  const rows = page.getByRole('row').filter({ hasText: 'Dezvăluire date personale' });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(REASON);
  // The trace id of the reveal, as recorded (plain text: a reveal is audited, not a traced operation).
  await expect(rows.getByRole('cell').last()).toHaveText(/\S{8,}/);

  await page.reload();
  await expect(page.getByLabel('Acțiune')).toHaveValue('reveal_pii');
  await expect(page.getByRole('row').filter({ hasText: 'Dezvăluire date personale' })).toHaveCount(1);

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
  await expect(page.getByText(/Rolul activ \(Echipă de teren\)/)).toBeVisible();
  expect(auditCalls).toEqual([]);
  await expectNoAxeViolations(page);
});
