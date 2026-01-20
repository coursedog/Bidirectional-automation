const fs = require('fs');
const path = require('path');

function loginUrl(baseDomain, productSlug) {
  const baseUrl = `https://${baseDomain}`;
  return `${baseUrl}/#/login?continue=${encodeURIComponent(`/${productSlug}`)}`;
}

async function signIn(page, email, password, productSlug, env, isApi) {
  if (!isApi) {
    // Fallback to creds.json if email/password not provided
    if (!email || !password) {
      try {
        const credsPath = path.join(__dirname, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          email = email || creds.email;
          password = password || creds.password;
        }
      } catch (_) { }
    }
  }

  const domain = env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com';
  const url = loginUrl(domain, productSlug);

  console.log('🔑 Signing in...');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Step 1: Enter email and proceed to password screen
  await page.fill('input[placeholder="Email"]', email);
  await page.click('button[data-test="next-button"]');

  // Wait for password field to appear (or timeout if email not found)
  try {
    await page.waitForSelector('input[placeholder="Enter Password"]', { state: 'visible', timeout: 5000 });
  } catch (error) {
    // If password field doesn't become visible, email was not found
    throw new Error(`Authentication failed: The email "${email}" was not found.\n    Action required: Verify the email address or register this user in the system.`);
  }

  // Step 2: Enter password and sign in
  await page.fill('input[placeholder="Enter Password"]', password);
  await page.click('button:has-text("Sign In")');

  // Wait for either navigation (success) or error message (failure)
  try {
    // Race between navigation and error message appearing
    await Promise.race([
      // Success case: navigation happens
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
      // Failure case: error message becomes visible
      page.locator('small.form-text.text-danger[data-test="invalid-password"]').waitFor({ state: 'visible', timeout: 8000 }).then(() => {
        throw new Error('PASSWORD_ERROR');
      })
    ]);

    // If we reach here, navigation succeeded
    console.log('✅ Successfully signed in');
  } catch (error) {
    // Check if it's our password error
    if (error.message === 'PASSWORD_ERROR') {
      throw new Error(`Authentication failed: Password is incorrect.\n    Action required: Verify your credentials and try again.`);
    }

    // Check if the error message is visible (in case race condition missed it)
    const passwordErrorVisible = await page.locator('small.form-text.text-danger[data-test="invalid-password"]').isVisible().catch(() => false);
    if (passwordErrorVisible) {
      throw new Error(`Authentication failed: Password is incorrect.\n    Action required: Verify your credentials and try again.`);
    }

    // If no specific error was detected, provide generic message
    throw new Error(`Authentication failed: Sign-in did not complete successfully.\n    Action required: Check your credentials and ensure the user has access to this school.`);
  }
}

/**
 * Dismiss the release notes popup if it appears after sign-in
 * @param {Object} page - Playwright page object
 */
async function dismissReleaseNotesPopup(page) {
  try {
    console.log('🔍 Checking for release notes popup...');

    // Target the button container instead of the SVG icon
    // Use waitFor with timeout to actually wait for popup to appear
    const releaseNotesPopup = page.locator('#popupClosePanel, #popupCloseBtn, [data-testid="popup-close-btn-icon"]').first();

    // Wait up to 3 seconds for the popup to appear
    await releaseNotesPopup.waitFor({ state: 'visible', timeout: 3000 });

    // If we get here, popup is visible
    console.log('📋 Release notes popup detected, dismissing...');
    await releaseNotesPopup.click();
    await page.waitForTimeout(500);
    console.log('✅ Release notes popup dismissed');
  } catch (error) {
    // Popup didn't appear within timeout - this is fine, continue
    if (error.message.includes('Timeout')) {
      console.log('✅ No release notes popup detected');
    } else {
      console.log('⚠️ Error checking for release notes popup:', error.message);
    }
  }
}

module.exports = { signIn, dismissReleaseNotesPopup }; 