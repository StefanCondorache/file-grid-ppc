import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA checks on the current page state (DoD item 5). */
export async function expectNoAxeViolations(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
}
