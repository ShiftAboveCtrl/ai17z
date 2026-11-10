import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`memory inspection and correction at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByText('Launch discussion')).toBeVisible();
    await expect(page.getByText('Heron launches Friday.')).toBeVisible();
    await expect(page.getByText('knowledge base: matches "Heron"')).toBeVisible();
    await expect(page.getByText('No retrieval reason recorded.').first()).toBeVisible();
    expect((await page.getByRole('searchbox', { name: 'Search memories' }).boundingBox())!.width).toBeGreaterThanOrEqual(160);
    await page.screenshot({ path: `.screenshots/memory-${width}-top.png` });
    await page.locator('#memory li').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.screenshots/memory-${width}-sources.png` });
    await page.getByRole('button', { name: 'Next memories' }).click();
    await expect(page.getByText('Heron fact 44', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous memories' }).click();
    await page.getByRole('button', { name: 'Pin memory', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Unpin memory', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Unpin memory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unpin memory', exact: true })).toHaveCount(0);
    const cancelled = page.waitForEvent('dialog');
    const cancelClick = page.getByRole('button', { name: 'Delete memory' }).first().click();
    const dialog = await cancelled;
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('permanently');
    await dialog.dismiss();
    await cancelClick;
    await expect(page.getByText('Heron launches Friday.')).toBeVisible();
    page.on('dialog', (confirmation) => confirmation.accept());
    await page.evaluate(() => fetch('/api/agents/test/memories/fail-next'));
    await page.getByRole('button', { name: 'Delete memory' }).first().click();
    await expect(page.getByRole('alert')).toContainText('Memory service unavailable');
    await expect(page.getByText('Heron launches Friday.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete memory' }).first().click();
    await expect(page.getByText('Heron launches Friday.')).toHaveCount(0);
    await page.getByRole('button', { name: /USER/ }).click();
    await page.getByRole('searchbox', { name: 'Search memories' }).fill('Heron fact 43');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText('Heron fact 43', { exact: true })).toBeVisible();
    await expect(page.locator('#memory li')).toHaveCount(1);
    expect(await page.locator('#memory').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const target = await page.getByRole('button', { name: 'Pin memory', exact: true }).boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(errors).toEqual([]);
  });
}

test('retries a failed read and returns to the preceding page after deleting the final page', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByText('Launch discussion')).toBeVisible();
  await page.evaluate(() => fetch('/api/agents/test/memories/fail-read'));
  await page.getByRole('button', { name: /USER/ }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot load memories');
  await page.getByRole('button', { name: 'Retry memories' }).click();
  await expect(page.locator('#memory li')).toHaveCount(8);
  await page.getByRole('button', { name: /USER/ }).click();
  await page.getByRole('button', { name: 'Next memories' }).click();
  for (const remaining of [5, 4, 3, 2, 1]) {
    await expect(page.locator('#memory li')).toHaveCount(remaining);
    await page.getByRole('button', { name: 'Delete memory' }).first().click();
  }
  await expect(page.locator('#memory li')).toHaveCount(40);
  await expect(page.getByText('Showing 1 to 40 of 40')).toBeVisible();
});
