const path = require('path');

async function screenshotSectionModal(page, outputPath, rootSelector = 'div.modal-dialog') {
  // Make containers expand and avoid clipping/scrolling
  let styleHandle = null;
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
  try {
    styleHandle = await page.addStyleTag({ content: `
      html, body, .content, main#main, #app { overflow: visible !important; height: auto !important; }
      .modal-dialog, .modal-content, .modal-body { max-height: none !important; height: auto !important; overflow: visible !important; }
      #section-modal-editor { max-height: none !important; height: auto !important; overflow: visible !important; }
    `});
    await page.waitForTimeout(100);
  } catch (_) {}

  // Target the section editor specifically (avoids multiple dialogs strict-mode error)
  const editor = page.locator('#section-modal-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 60000 });

  // Let layout settle
  await page.waitForTimeout(200);

  // Preload lazy content: gently scroll through the editor to force render, then return to top
  try {
    const total = await editor.evaluate(el => el.scrollHeight);
    const step = 600;
    for (let y = 0; y <= total; y += step) {
      try { await editor.evaluate((el, pos) => el.scrollTo(0, pos), y); } catch (_) {}
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(250);
    try { await editor.evaluate(el => el.scrollTo(0, 0)); } catch (_) {}
  } catch (_) {}

  // Briefly wait for any loading placeholders/spinners inside the editor to disappear
  try {
    const loadingSel = '#section-modal-editor .spinner, #section-modal-editor [class*="skeleton"], #section-modal-editor [class*="loading"]';
    for (let i = 0; i < 6; i++) {
      const anyLoading = await page.locator(loadingSel).filter({ has: editor }).count().catch(() => 0);
      if (!anyLoading) break;
      await page.waitForTimeout(200);
    }
  } catch (_) {}

  // Compute content bounds based on visible children to avoid giant whitespace
  const metrics = await editor.evaluate((root) => {
    try { root.scrollTo(0, 0); } catch (_) {}
    // Nudge layout and trigger lazy content
    try { root.scrollTo(0, root.scrollHeight); } catch (_) {}
    try { root.scrollTo(0, 0); } catch (_) {}
    const elements = root.querySelectorAll('.form-card, .card, [data-test], .auto-form-row, section');
    let top = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let right = 0;
    let bottom = 0;
    elements.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      top = Math.min(top, rect.top + window.scrollY);
      left = Math.min(left, rect.left + window.scrollX);
      right = Math.max(right, rect.right + window.scrollX);
      bottom = Math.max(bottom, rect.bottom + window.scrollY);
    });
    if (!isFinite(top)) {
      const r = root.getBoundingClientRect();
      top = r.top + window.scrollY;
      left = r.left + window.scrollX;
      right = r.right + window.scrollX;
      bottom = r.bottom + window.scrollY;
    }
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return { top: Math.floor(top), left: Math.floor(left), width: Math.ceil(width), height: Math.ceil(height) };
  });

  const client = await page.context().newCDPSession(page);
  const MAX_HEIGHT = 12000;
  // Add padding to avoid left/right cuts and widen viewport for better composition
  const PADDING = 30;
  const clipHeight = Math.min(metrics.height + PADDING * 2, MAX_HEIGHT);
  const clipWidth = Math.max(metrics.width + PADDING * 2, 1400);
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: clipWidth,
      height: clipHeight,
      deviceScaleFactor: 1,
      mobile: false
    });
  } catch (_) {}

  await page.screenshot({
    path: outputPath,
    clip: {
      x: Math.max(0, metrics.left - PADDING),
      y: Math.max(0, metrics.top - PADDING),
      width: Math.min(clipWidth - 2, metrics.width + PADDING * 2),
      height: Math.min(clipHeight - 2, metrics.height + PADDING * 2)
    }
  });

  try { await client.send('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
  try { await page.evaluate((styleEl) => { try { styleEl && styleEl.remove && styleEl.remove(); } catch (_) {} }, styleHandle); } catch (_) {}
}

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

  await page.waitForSelector('button[data-test="save-section-btn"]', { state: 'visible', timeout: 60000 });
  // Extra buffer to ensure all dynamic content settles before capturing
  await page.waitForTimeout(1000);

  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-before.png`);
  await screenshotSectionModal(page, screenshotPath, 'div.modal-dialog');
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

  await page.waitForSelector('button[data-test="save-section-btn"]', { state: 'visible', timeout: 60000 });
  await page.waitForTimeout(300);
  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-after.png`);
  await screenshotSectionModal(page, screenshotPath, 'div.modal-dialog');
  console.log(`\n✅ Screenshot saved to ${screenshotPath}`);
}

async function captureModalError(page, outputDir, action) {
  console.log('\nTaking Screenshot of the error for debugging');

  const screenshotPath = path.join(outputDir, `${action}-section-modal-full-error.png`);
  await screenshotSectionModal(page, screenshotPath, 'div.modal-dialog');
  console.log(`\n✅ Screenshot saved to ${screenshotPath}`);
}

module.exports = { openSection, createSection, captureModalBefore, captureModalAfter, captureModalError };