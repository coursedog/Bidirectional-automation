function loginUrl(baseDomain, productSlug) {
  const baseUrl  = `https://${baseDomain}`;
  return `${baseUrl}/#/login?continue=${encodeURIComponent(`/${productSlug}`)}`;
}

async function signIn(page, email, password, productSlug, env) {
  const domain = env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com';
  const url = loginUrl(domain, productSlug);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.fill('input[placeholder="Email"]', email);
  await Promise.all([
    page.click('button[data-test="next-button"]'),
    page.waitForSelector('input[placeholder="Enter Password"]')
  ]);
  await page.fill('input[placeholder="Enter Password"]', password);
  await Promise.all([
    page.click('button:has-text("Sign In")'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded' })
  ]);
}

module.exports = { signIn }; 