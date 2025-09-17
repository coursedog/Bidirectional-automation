const fs = require('fs');
const path = require('path');

function loginUrl(baseDomain, productSlug) {
  const baseUrl  = `https://${baseDomain}`;
  return `${baseUrl}/#/login?continue=${encodeURIComponent(`/${productSlug}`)}`;
}

async function signIn(page, email, password, productSlug, env) {
  // Fallback to creds.json if email/password not provided
  if (!email || !password) {
    try {
      const credsPath = path.join(__dirname, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        email = email || creds.email;
        password = password || creds.password;
      }
    } catch (_) {}
  }
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