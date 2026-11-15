import { expect, test, type Page } from '@playwright/test';
import { ROLE_LABELS } from './helpers';

/**
 * Task 6h.6: the demo script (docs/frontend/demo-script.md) as one unattended rehearsal, beat by beat.
 * On the mocks (default) every beat runs. With E2E_BASE_URL it runs against a deployed stack: uploads are
 * small `test-rehearsal-` files, and the demo actions (storm, S3 down, corruption, policy change) run only
 * with E2E_DEMO_ACTIONS=1, in a team rehearsal. E2E_VIDEO=on records it: the backup video.
 */
const REAL = Boolean(process.env.E2E_BASE_URL);
const DEMO_ACTIONS = !REAL || process.env.E2E_DEMO_ACTIONS === '1';
const STAMP = Date.now().toString(36);

test.use({ reducedMotion: 'reduce' });
test.setTimeout(6 * 60_000);

type Role = keyof typeof ROLE_LABELS;

async function logIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Rol', { exact: true }).selectOption('admin');
  const password = page.getByLabel('Parolă');
  // Passwordless demo login has no password field; the mocks use the demo password.
  if (await password.count()) await password.fill(process.env.E2E_PASSWORD ?? 'demo-2026');
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Garanții de business' })).toBeVisible();
}

async function switchRole(page: Page, to: Role) {
  await page.getByRole('button', { name: /^Rol activ:/ }).click();
  await page.getByRole('menuitemradio', { name: ROLE_LABELS[to] }).click();
  await expect(page.getByRole('button', { name: `Rol activ: ${ROLE_LABELS[to]}` })).toBeVisible();
}

/** Încărcare: category, file, metadata, Încarcă, then open the confirmed file from its queue item. */
async function upload(page: Page, title: string, name: string, mimeType: string, fill: () => Promise<void>) {
  await page.getByRole('link', { name: 'Încărcare', exact: true }).click();
  await page.getByText(title, { exact: true }).click();
  // The category lives in the URL (router.replace is asynchronous); the radio follows it, the default included.
  await expect(page.getByRole('radio', { name: title })).toBeChecked();
  await page.locator('input[type=file]').first().setInputFiles({ name, mimeType, buffer: Buffer.alloc(96 * 1024, 5) });
  await fill();
  await page.getByRole('button', { name: /^Încarcă/ }).click();
  await page.getByRole('listitem').filter({ hasText: name }).getByRole('link', { name: 'Deschide fișierul' }).click({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/files\/.+/);
}

/** Control room actions ask for confirmation; the confirm button repeats the action's label. */
async function confirmed(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
}

test('the 7-minute demo, beat by beat', async ({ page }) => {
  await test.step('1 · opening: the business guarantees board', async () => {
    await logIn(page);
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({ timeout: 15_000 });
  });

  await test.step('2 · drone video upload (teren)', async () => {
    await switchRole(page, 'teren');
    await upload(page, 'Video inspecție dronă', `test-rehearsal-${STAMP}.mp4`, 'video/mp4', async () => {
      await page.getByLabel('Linie / tronson').fill('LEA 110 kV Repetiție');
      await page.getByLabel('Zonă').selectOption('dobrogea');
    });
  });

  await test.step('3 · fault record (dispecerat)', async () => {
    await switchRole(page, 'dispecerat');
    await upload(page, 'Înregistrare de avarie', `test-rehearsal-${STAMP}.pdf`, 'application/pdf', async () => {
      await page.getByLabel('Zonă').selectOption('banat');
      await page.getByLabel('Stație sau post de transformare').fill('Stația Repetiție');
      await page.getByLabel('Severitate').selectOption('medium');
    });
  });

  await test.step('4 · connection document: masked, revealed by the auditor, audited', async () => {
    await switchRole(page, 'racordari');
    const request = `RC-REP-${STAMP}`;
    await upload(page, 'Document de racordare', `test-rehearsal-${STAMP}-cerere.pdf`, 'application/pdf', async () => {
      await page.getByLabel('Număr cerere').fill(request);
      await page.getByLabel('Tip document').selectOption('cerere');
      await page.getByLabel('Nume solicitant').fill('Ion Repetiție');
      await page.getByLabel('CNP').fill('1960101123456');
    });
    await expect(page.getByText('Ion Repetiție')).toHaveCount(0); // masked by default
    await switchRole(page, 'auditor');
    await page.getByRole('button', { name: 'Afișează datele personale' }).click();
    await page.getByRole('dialog').getByLabel('Motivul afișării').fill('Repetiție demo, verificare');
    await page.getByRole('dialog').getByRole('button', { name: 'Afișează', exact: true }).click();
    await expect(page.getByText('Ion Repetiție').first()).toBeVisible();
    await page.getByRole('link', { name: /Jurnal de audit/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Dezvăluire date personale' }).first()).toBeVisible();
  });

  await test.step('5 · storm and S3 down (control room, observability)', async () => {
    await switchRole(page, 'admin');
    await page.getByRole('link', { name: /Cameră de control/ }).click();
    if (!DEMO_ACTIONS) return;
    await confirmed(page, 'Pornește furtuna');
    await expect(page.getByText('Furtună activă').first()).toBeVisible({ timeout: 15_000 });
    await confirmed(page, 'Oprește S3');
    await page.getByRole('link', { name: /Observabilitate/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Observabilitate' })).toBeVisible();
    await page.getByRole('link', { name: /Cameră de control/ }).click();
    await confirmed(page, 'Pornește S3');
    await confirmed(page, 'Oprește furtuna');
  });

  await test.step('6 · integrity: a corrupted file is detected', async () => {
    if (!DEMO_ACTIONS) return;
    await page.getByLabel('Fișier', { exact: true }).selectOption({ index: 1 });
    await confirmed(page, 'Corupe fișierul');
    await page.getByRole('button', { name: 'Verifică integritatea' }).click();
    await expect(page.getByText(/Corupție detectată/).first()).toBeVisible({ timeout: 15_000 });
  });

  await test.step('7 · policy, live: fault records move to FTP', async () => {
    await page.getByRole('link', { name: /Politici/ }).click();
    await page.getByRole('heading', { level: 2, name: 'Înregistrări defecte' }).locator('..').getByRole('link', { name: 'Modifică' }).click();
    if (!DEMO_ACTIONS) return;
    await page.getByLabel('Storage principal').selectOption('ftp');
    await page.getByLabel('Storage de rezervă').selectOption('s3');
    await page.getByRole('button', { name: 'Revizuiește modificările' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Salvează' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Salvat · versiunea v\d+/ })).toBeVisible();
  });

  await test.step('8 · statistics with their interpretations', async () => {
    await page.getByRole('link', { name: /Statistici/ }).click();
    await expect(page.getByRole('heading', { name: 'Ce storage se potrivește fiecărei categorii?' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zi normală vs. zi de vârf' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ce spun datele despre rețea' })).toBeVisible();
  });
});
