import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA checks on the current page state (DoD item 5). */
export async function expectNoAxeViolations(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

export const ROLE_LABELS = {
  teren: 'Echipă de teren',
  dispecerat: 'Dispecerat',
  racordari: 'Angajat racordări',
  auditor: 'Auditor',
  admin: 'Administrator',
} as const;

/** Log in through the role dropdown (ADR-0022) with the mock password. */
export async function loginAs(page: Page, role: keyof typeof ROLE_LABELS, mockSettings?: Record<string, unknown>) {
  await page.goto('/login');
  if (mockSettings) {
    await page.evaluate((s) => window.localStorage.setItem('fg.mock', JSON.stringify(s)), mockSettings);
  }
  await page.getByLabel('Rol', { exact: true }).selectOption(role);
  await page.getByLabel('Parolă').fill('demo-2026');
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.getByText(`Rol activ: ${ROLE_LABELS[role]}`)).toBeVisible();
}
