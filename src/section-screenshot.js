const path = require('path');

async function openSection(page) {
  console.log('\n✅ Clicking on Section');
  
  try {
    // First, try to find a section with no conflicts
    console.log('🔍 Looking for sections with no conflicts...');
    await page.waitForSelector('[aria-label="This section has no conflicts."]', { state: 'visible', timeout: 10000 });
    await page.click('[aria-label="This section has no conflicts."]');
    console.log('✅ Found and clicked on section with no conflicts');
  } catch (error) {
    console.log('⚠️ No sections without conflicts found, looking for sections with conflicts...');
    
    try {
      // Fallback: look for sections with conflicts
      await page.waitForSelector('[aria-label="This section has conflicts."]', { state: 'visible', timeout: 10000 });
      await page.click('[aria-label="This section has conflicts."]');
      console.log('✅ Found and clicked on section with conflicts');
    } catch (fallbackError) {
      console.log('❌ No sections found with either "no conflicts" or "conflicts" aria-labels');
      throw new Error('❌ No sections available for the selected term. Please run a merge for the current term and try again.');
    }
  }
  
  await page.waitForSelector('#section-modal-editor', { state: 'visible', timeout: 60000 });
} 

  async function createSection(page, searchTerm = 'a') {
    console.log('▶ Opening Add Section modal');
    // 1) Click the top “Add Section” button
    await page.click('button[data-test="add-section-btn"]');
    // wait for the create-section modal to appear
    await page.waitForSelector('div.modal-dialog', { state: 'visible', timeout: 60000 });
  
    console.log('▶ Activating course search dropdown');
    // 2) Click the async-course-select wrapper (only in the modal)
    const picker = page.locator('div.modal-dialog div[data-test="async-course-select"]');
    await picker.click();
  
    // 3) Fill *that* multiselect’s input
    const input = picker.locator('input.multiselect__input');
    await input.fill(searchTerm);
  
    console.log('▶ Waiting for results to load…');
    // 4) Wait for the *same* wrapper’s dropdown items, then click first
    const firstOption = picker.locator('.multiselect__content-wrapper li').first();
    await firstOption.waitFor({ state: 'visible', timeout: 60000 });
    await firstOption.click();
  
    console.log('▶ Submitting Add Section');
    // 5) Click the bottom “ADD SECTION” and wait for the new Section editor
    await Promise.all([
      page.click('button[data-test="add-section-button"]'),
      page.waitForSelector('button[data-test="save-section-btn"]', { state: 'visible', timeout: 60000 })
    ]);
  
    console.log('✅ Section editor is now open');
  }

async function captureModalBefore(page, outputDir, action) {
  console.log('\n✅ Section loaded');

  const hideBtn = page.locator('button[data-test="hide-sidebar-button"]');
  if (await hideBtn.isVisible()) {
    await hideBtn.click();
    await page.waitForTimeout(300);
  }

  const styleHandle = await page.addStyleTag({ content: `
    .modal-dialog,
    .modal-content,
    .modal-body { max-height: none !important; height: auto !important; }
  `});
  await page.waitForTimeout(100);

  await page.waitForSelector('button[data-test="save-section-btn"]', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(500);

  const dialog = page.locator('div.modal-dialog').filter({ has: page.locator('#section-modal-editor') });

  // Save screenshot
  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-before.png`);
  await dialog.screenshot({ path: screenshotPath });

  // Remove the injected CSS to restore normal scrollbars
  await page.evaluate((styleElement) => {
    if (styleElement && styleElement.remove) {
      styleElement.remove();
    }
  }, styleHandle);

  console.log(`\n✅ Screenshot saved to ${screenshotPath}`);
}

async function captureModalAfter(page, outputDir, action) {
  console.log('\n✅ Section loaded');

  const hideBtn = page.locator('button[data-test="hide-sidebar-button"]');
  if (await hideBtn.count() > 0) {
    if (await hideBtn.isVisible()) {
      await hideBtn.click();
      await page.waitForTimeout(300);
    }
  } else {
    console.log('⚠️ Could not find the hide sidebar button, continuing...');
  }

  const styleHandle = await page.addStyleTag({ content: `
    .modal-dialog,
    .modal-content,
    .modal-body { max-height: none !important; height: auto !important; }
  `});
  await page.waitForTimeout(100);

  await page.waitForSelector('button[data-test="save-section-btn"]', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(500);

  const dialog = page.locator('div.modal-dialog').filter({ has: page.locator('#section-modal-editor') });

  // Save screenshot
  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-after.png`);
  await dialog.screenshot({ path: screenshotPath });

  // Remove the injected CSS to restore normal scrollbars
  await page.evaluate((styleElement) => {
    if (styleElement && styleElement.remove) {
      styleElement.remove();
    }
  }, styleHandle);

  console.log(`\n✅ Screenshot saved to ${screenshotPath}`);
}

async function captureModalError(page, outputDir, action) {
  console.log('\nTaking Screenshot of the error for debugging');

  // Temporarily inject CSS for screenshot, then remove it
  const styleHandle = await page.addStyleTag({ content: `
    .modal-dialog,
    .modal-content,
    .modal-body { max-height: none !important; height: auto !important; }
  `});
  await page.waitForTimeout(100);

  const dialog = page.locator('div.modal-dialog').filter({ has: page.locator('#section-modal-editor') });

  // Save screenshot
  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-error.png`);
  await dialog.screenshot({ path: screenshotPath });

  // Remove the injected CSS to restore normal scrollbars
  await page.evaluate((styleElement) => {
    if (styleElement && styleElement.remove) {
      styleElement.remove();
    }
  }, styleHandle);

  console.log(`\n✅ Screenshot saved to ${screenshotPath}`);
}

module.exports = { openSection, createSection, captureModalBefore, captureModalAfter, captureModalError }; 