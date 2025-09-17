async function goToProduct(page, productSlug, env) {
  const baseUrl = env === 'prd'
    ? 'https://app.coursedog.com'
    : 'https://staging.coursedog.com';

  await page.goto(`${baseUrl}/#/${productSlug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav[data-test="app-navigation"]', { timeout: 60000 });
  await page.waitForTimeout(5000);
}

module.exports = { goToProduct }; 