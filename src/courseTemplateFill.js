const fs = require('fs');
const path = require('path');
const { offerUserTakeover, waitForUserResponseWithTimeout } = require('./userTakeover');

// Simple run-scoped logger that mirrors console output to Logs.md in the run folder
function ensureRunLogger(outputDir) {
  try {
    if (!outputDir) return;
    if (!global.__origConsole) {
      global.__origConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      };
      const forward = (method) => (...args) => {
        try {
          const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
          const ts = new Date().toISOString();
          const out = `[${ts}] ${line}\n`;
          const lf = (global.__runLogger && global.__runLogger.logFile) || null;
          if (lf) {
            fs.appendFileSync(lf, out, 'utf8');
          }
        } catch (_) {}
        try { global.__origConsole[method](...args); } catch (_) {}
      };
      console.log = forward('log');
      console.warn = forward('warn');
      console.error = forward('error');
      console.info = forward('info');
    }
    const logFile = path.join(outputDir, 'Logs.md');
    global.__runLogger = { logFile };
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, `# Logs for run\n\n`, 'utf8');
    }
  } catch (_) {}
}

// Record per-field skip reasons for later inclusion in diff comments
function recordSkipReason(qid, reason) {
  try {
    if (!qid) return;
    global.__fieldSkipReasons = global.__fieldSkipReasons || {};
    if (!global.__fieldSkipReasons[qid]) {
      global.__fieldSkipReasons[qid] = reason || 'Skipped';
      console.log(`SKIP_FIELD ${qid}: ${global.__fieldSkipReasons[qid]}`);
    }
  } catch (_) {}
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeForComparison(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForComparison);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, normalizeForComparison(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function isDeepEqual(a, b) {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  try {
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return na === nb;
  }
}

/**
 * Find the first suitable course in the courses table, searching through pages if needed
 * @param {Object} page - Playwright page object
 * @param {Object} browser - Playwright browser object (for user takeover)
 * @param {string} subfolder - Output directory for screenshots
 * @param {string} schoolId - School identifier
 * @param {string} action - Current action/test case being performed (for tracking)
 * @returns {Object|null} - The suitable course row element or null if not found
 */
async function findActiveCourse(page, browser = null, subfolder = null, schoolId = null, action = null) {
  let currentPage = 1;
  const maxPages = 20; // Safety limit to prevent infinite loops
  const validStatusKeywords = ['approv', 'releas', 'publish']; // Contains-based matching
  const exactStatusKeywords = ['active']; // Word boundary matching
  
  // Use global session-based course tracking
  const sessionUsedCourses = global.sessionUsedCourses || new Set();
  
  console.log(`📋 Session course tracking: ${sessionUsedCourses.size} courses already used`);
  
  while (currentPage <= maxPages) {
    console.log(`📄 Searching page ${currentPage} for suitable courses...`);
    
    // Wait for table to load
    await page.waitForSelector('[data-test="coursesTable"] tbody tr', { timeout: 10000 });
    await page.waitForTimeout(1000); // Allow content to fully render
    
    // Get all rows in the current page
    const rows = page.locator('[data-test="coursesTable"] tbody tr');
    const rowCount = await rows.count();
    
    console.log(`   ┣ Found ${rowCount} courses on page ${currentPage}`);
    
    // Check each row for suitable status
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      
      // Get all cells in the row to find course identifier and status
      const cells = row.locator('td');
      const cellCount = await cells.count();
      
      let courseCode = null;
      let statusFound = false;
      
      // First pass: get the Course Code from the first cell (as requested by user)
      if (cellCount > 0) {
        const firstCell = cells.nth(0);
        const firstCellText = await firstCell.textContent();
        if (firstCellText && firstCellText.trim()) {
          courseCode = firstCellText.trim();
          console.log(`   ┣ 🔍 Checking course with code: "${courseCode}"`);
        }
      }
      
      if (!courseCode) {
        console.log(`   ┣ ⚠️ Skipping row ${i + 1} - no course code found`);
        continue;
      }
      
      // For Workday schools, skip status validation entirely
      const skipStatusValidation = typeof schoolId === 'string' && schoolId.toLowerCase().includes('workday');
      if (skipStatusValidation) {
        console.log(`   ┣ ⏭️ Skipping status validation for schoolId "${schoolId}"`);
        // Still avoid reusing the same course in a single session
        if (sessionUsedCourses.has(courseCode)) {
          console.log(`   ┣ ⏭️ Skipping previously used course code "${courseCode}"`);
          continue;
        }
        console.log(`   ┗ ✅ Selected course "${courseCode}" without status check (Workday mode)`);
        sessionUsedCourses.add(courseCode);
        console.log(`   ┗ 📝 Tracked course code "${courseCode}" for test case "${action}" in session`);
        console.log(`   ┗ 📊 Session now has ${sessionUsedCourses.size} used course codes`);
        return row;
      }
      
      // Second pass: check for suitable status
      for (let j = 0; j < cellCount; j++) {
        const cell = cells.nth(j);
        const cellText = await cell.textContent();
        
        if (cellText) {
          const statusText = cellText.trim().toLowerCase();
          
          // Check for exact word boundary matches (e.g., "active" but not "inactive")
          const exactMatch = exactStatusKeywords.some(keyword => {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            return regex.test(statusText);
          });
          
          // Check for contains-based matches
          const containsMatch = validStatusKeywords.find(keyword => statusText.includes(keyword));
          
          if (exactMatch || containsMatch) {
            statusFound = true;
            const matchType = exactMatch ? 'exact' : 'contains';
            const matchedKeyword = exactMatch 
              ? exactStatusKeywords.find(keyword => new RegExp(`\\b${keyword}\\b`, 'i').test(statusText))
              : containsMatch;
            
            // Check if this course code was already used in this session
            console.log(`   ┣ 🔍 Checking if course code "${courseCode}" was already used...`);
            console.log(`   ┣ Used course codes in session: ${Array.from(sessionUsedCourses).join(', ') || 'none'}`);
            
            if (sessionUsedCourses.has(courseCode)) {
              console.log(`   ┣ ⏭️ Skipping previously used course code "${courseCode}" (status: "${cellText.trim()}")`);
              console.log(`   ┣ This course was used in a previous test case in this session`);
              continue; // Skip to next row
            }
            
              try {
                let hasCDSuffix = false;
                const bannedFragments = ['-C','-cd', '-cdt', '-cdte', '-cdtes', '-cdtest'];
                // Prefer the second cell as likely Short Title
                if (cellCount > 1) {
                  const secondCellTxt = (await cells.nth(1).textContent()) || '';
                  const s = secondCellTxt.toLowerCase();
                  if (bannedFragments.some(f => s.includes(f))) hasCDSuffix = true;
                }
                // If still not detected, scan all cells in the row as a fallback
                if (!hasCDSuffix) {
                  for (let k = 0; k < cellCount; k++) {
                    const t = (await cells.nth(k).textContent()) || '';
                    const tl = t.toLowerCase();
                    if (bannedFragments.some(f => tl.includes(f))) { hasCDSuffix = true; break; }
                  }
                }
                if (hasCDSuffix) {
                  console.log(`   ┣ ⏭️ Skipping course "${courseCode}" - row contains a CD test suffix (-CD, -CDt, -CDte, -CDtes, -CDtest)`);
                  break; // move to next row
                }
              } catch (_) {}
            
            console.log(`   ┗ ✅ Found suitable course "${courseCode}" (status: "${cellText.trim()}", matched "${matchedKeyword}" as ${matchType}) in row ${i + 1} on page ${currentPage}`);
            
            // Track this course selection in the session
            sessionUsedCourses.add(courseCode);
            console.log(`   ┗ 📝 Tracked course code "${courseCode}" for test case "${action}" in session`);
            console.log(`   ┗ 📊 Session now has ${sessionUsedCourses.size} used course codes`);
            
            return row;
          }
        }
      }
    }
    
    console.log(`   ┗ ❌ No suitable courses found on page ${currentPage}`);
    
    // Look for next page button (keyboard_arrow_right icon or other pagination buttons)
    const nextButton = page.locator('button[data-test="keyArrowRight"], button:has([data-test="keyArrowRight"]), button[aria-label*="next"], .pagination-next, [title*="Next"], button:has(.material-icons:text("keyboard_arrow_right"))');
    const nextButtonCount = await nextButton.count();
    
    if (nextButtonCount > 0) {
      const isNextEnabled = await nextButton.first().isEnabled().catch(() => false);
      const isNextVisible = await nextButton.first().isVisible().catch(() => false);
      
      if (isNextEnabled && isNextVisible) {
        console.log(`   ┣ Moving to next page...`);
        await nextButton.first().click();
        await page.waitForTimeout(2000); // Wait for page to load
        currentPage++;
      } else {
        console.log(`   ┗ 🚫 Next button is disabled or not visible - reached end of pages`);
        break;
      }
    } else {
      console.log(`   ┗ 🚫 No next button found - only one page or reached end`);
      break;
    }
  }
  
  // No suitable courses found after searching all pages
  console.log(`❌ No suitable courses found after searching ${currentPage - 1} pages`);
  console.log(`🔍 Searched for courses with status exactly matching: ${exactStatusKeywords.join(', ')} OR containing: ${validStatusKeywords.join(', ')}`);
  
  // Check if we have used courses and should reset the tracking for a retry
  if (sessionUsedCourses.size > 0) {
    console.log(`🔄 All ${sessionUsedCourses.size} suitable courses may have been used in this session. Resetting session tracking and retrying...`);
    sessionUsedCourses.clear();
    console.log(`✅ Session course tracking reset. Attempting to find courses again...`);
    // Recursive call with reset tracking
    return await findActiveCourse(page, browser, subfolder, schoolId, action);
  }
  
  if (browser && subfolder && schoolId) {
    console.log('\n🤝 Offering user intervention to manually select a course...');
    
    const allKeywords = [...exactStatusKeywords, ...validStatusKeywords];
    const takeoverResult = await offerUserTakeover(
      page, 
      browser, 
      subfolder, 
      'no-suitable-courses', 
      schoolId, 
      'course-selection',
      `No courses found with suitable status (exact: ${exactStatusKeywords.join(', ')}, contains: ${validStatusKeywords.join(', ')}) after searching ${currentPage - 1} pages`,
      null,
      true
    );
    
    if (takeoverResult.success) {
      // User manually selected a course - mark it as used in the session
      if (takeoverResult.selectedCourseCode) {
        sessionUsedCourses.add(takeoverResult.selectedCourseCode);
        console.log(`📝 Tracked manually selected course code "${takeoverResult.selectedCourseCode}" in session`);
      }
      return takeoverResult.row;
    } else {
      console.log('❌ User intervention failed or was declined');
      return null;
    }
  }
  
  return null;
}

/**
 * Main function to create a new course
 * @param {Object} page - Playwright page object
 * @param {string} subfolder - Output directory for screenshots and files
 * @param {string} schoolId - School identifier
 * @param {Object} browser - Playwright browser object
 */
async function createCourse(page, subfolder, schoolId, browser = null, formName = 'Propose New Course') {
  try {
    ensureRunLogger(subfolder);
    console.log(`\n📚 Starting course creation process...`);
    
    // Wait for courses table to load
    console.log('⏳ Waiting for courses table to load...');
    await page.waitForSelector('[data-test="coursesTable"]', { timeout: 30000 });
    console.log('✅ Courses table loaded successfully');
    
    // Click on the "Propose New Course" button
    console.log('🔍 Looking for Propose New Course button...');
    const proposeButton = page.locator('[data-test="proposeNewCourseBtn"]');
    await proposeButton.waitFor({ state: 'visible', timeout: 30000 });
    console.log('✅ Propose New Course button found');
    
    console.log('🖱️ Clicking Propose New Course button...');
    await proposeButton.click();
    console.log('✅ Propose New Course button clicked');
    
    // Wait for the "Add new course" modal to appear
    console.log('⏳ Waiting for Add new course modal...');
    await page.waitForSelector('text=Add new course', { timeout: 30000 });
    console.log('✅ Add new course modal appeared');
    
    // Click on the form selection dropdown (multiselect wrapper)
    console.log('🔍 Looking for form selection dropdown...');
    const formSelectWrapper = page.locator('.multiselect').filter({ hasText: 'Select form' });
    await formSelectWrapper.waitFor({ state: 'visible', timeout: 30000 });
    console.log('✅ Form selection dropdown found');
    
    console.log('🖱️ Clicking form selection dropdown...');
    await formSelectWrapper.click();
    await page.waitForTimeout(1000); // Wait for dropdown to open
    console.log('✅ Form selection dropdown opened');
    
    // Select the specified form option
    console.log(`🔍 Looking for "${formName}" option...`);
    const proposeOption = page.locator(`[aria-label="${formName}"]`);
    await proposeOption.waitFor({ state: 'visible', timeout: 30000 });
    console.log(`✅ "${formName}" option found`);
    
    console.log(`🖱️ Selecting "${formName}" option...`);
    await proposeOption.click();
    console.log(`✅ "${formName}" option selected`);
    
    // Click Submit button
    console.log('🔍 Looking for Submit button...');
    const submitButton = page.locator('button:has-text("SUBMIT")');
    await submitButton.waitFor({ state: 'visible', timeout: 30000 });
    console.log('✅ Submit button found');
    
    console.log('🖱️ Clicking Submit button...');
    await submitButton.click();
    console.log('✅ Submit button clicked');
    
    // Wait for the course proposal form to load (with fallback)
    console.log('⏳ Waiting for course proposal form to load...');
    
    // Check if rationale field is present
    const rationalePresent = await page.waitForSelector('[data-test="Rationale"]', { timeout: 3000 }).then(() => true).catch(() => false);
    
    if (rationalePresent) {
      await page.waitForTimeout(3000); // Additional wait for all form elements to load
      console.log('✅ Course proposal form with rationale loaded successfully');
      
      // Fill the rationale field
      console.log('📝 Filling rationale field...');
      try {
        const rationaleWrapper = page.locator('[data-test="Rationale"]');
        const rationaleField = rationaleWrapper.locator('input, textarea').first();
        
        // Check if we found an input field
        const inputCount = await rationaleField.count();
        if (inputCount === 0) {
          console.log('⚠️ No input/textarea found in rationale wrapper, trying alternative approach...');
          // Try to find by placeholder or label
          const altField = page.locator('input[placeholder*="rationale"], textarea[placeholder*="rationale"], input[placeholder*="Rationale"], textarea[placeholder*="Rationale"]').first();
          if (await altField.count() > 0) {
            await altField.clear();
            await altField.fill('Propose a new course test - Coursedog');
            console.log('✅ Rationale field filled via alternative method');
          } else {
            console.log('⚠️ Could not find rationale input field, skipping rationale step');
          }
        } else {
          await rationaleField.clear();
          await rationaleField.fill('Propose a new course test - Coursedog');
          console.log('✅ Rationale field filled');
        }
      } catch (rationaleError) {
        console.log(`⚠️ Error filling rationale field, skipping: ${rationaleError.message}`);
      }
    } else {
      console.log('⚠️ Rationale field not found, skipping rationale step and proceeding with form filling');
      await page.waitForTimeout(3000); // Give some time for form to load
    }
    
    // Take screenshot of the form before changes
    console.log('📸 Taking screenshot before changes...');
    const beforeScreenshotPath = path.join(subfolder, `${schoolId}-createCourse-form-before.png`);
    await page.screenshot({ 
      path: beforeScreenshotPath,
      fullPage: true 
    });
    console.log(`✅ Before screenshot saved: ${beforeScreenshotPath}`);
    
    // Read original course values
    console.log('📝 Reading original course values...');
    const beforeValues = await readCourseValues(page, schoolId);
    console.log('✅ Original course values captured');
    
    // Fill all form fields (no skip fields for creation)
    console.log('📋 Reading course template and filling all fields...');
    await fillCourseTemplate(page, schoolId, 'createCourse');
    console.log('✅ Course template filled');
    
    // Special handling for colleague_ethos schools - fill Credit Hours Min field
    if (schoolId.includes('colleague_ethos')) {
      console.log('🔍 [colleague_ethos] Looking for Credit Hours Min field...');
      await fillCreditHoursMinField(page);
    }
    
    // Read course values after changes
    console.log('📝 Reading course values after changes...');
    const afterValues = await readCourseValues(page, schoolId);
    console.log('✅ Modified course values captured');
    
    // Compare and save differences
    console.log('🔍 Comparing field differences...');
    await saveCourseFieldDifferences(beforeValues, afterValues, subfolder, schoolId, 'createCourse');
    console.log('✅ Field differences saved');
    
    // Take screenshot of the form after changes
    console.log('📸 Taking screenshot after changes...');
    const afterScreenshotPath = path.join(subfolder, `${schoolId}-createCourse-form-after.png`);
    await page.screenshot({ 
      path: afterScreenshotPath,
      fullPage: true 
    });
    console.log(`✅ After screenshot saved: ${afterScreenshotPath}`);
    
    // Attempt to save the course proposal
    const saveSuccess = await saveCourse(page, subfolder, schoolId, browser);
    if (saveSuccess) {
      console.log('🎉 Course creation and save process completed successfully');
    } else {
      console.log('⚠️ Course creation completed but save may have failed');
    }
    
    return saveSuccess; // Return actual save success status
    
  } catch (error) {
    console.error('❌ Error in createCourse:', error.message);
    throw error;
  }
}

/**
 * Screenshot the full course form (not just the visible viewport)
 * - Targets the top-level form[data-test="course-form-wrapper"].auto-form
 * - Temporarily expands the browser viewport via CDP to fit the form height
 * - Clips precisely to the form bounding box using its scrollHeight
 */
async function screenshotCourseForm(page, outputPath) {
  try {
    // Ensure containers are scrolled to the top for stable coordinates
    await page.evaluate(() => {
      try { window.scrollTo(0, 0); } catch (_) {}
      try { const main = document.querySelector('main#main.content'); if (main) main.scrollTo(0, 0); } catch (_) {}
      try { const content = document.querySelector('.content'); if (content) content.scrollTo(0, 0); } catch (_) {}
    });

    // Strong CSS to disable internal scrollbars and allow full height
    let styleHandle = null;
    try {
      styleHandle = await page.addStyleTag({ content: `
        /* Hide fixed chrome that can overlay */
        [data-test="app-navigation"], header, nav.app-navbar, .app-navbar { visibility: hidden !important; }
        /* Ensure main containers don't clip */
        html, body, .content, main#main, #app { overflow: visible !important; height: auto !important; }
        /* Make the course form expand fully */
        form[data-test="course-form-wrapper"].auto-form { max-height: none !important; height: auto !important; overflow: visible !important; }
        /* Nested auto-form wrappers inside cards should also expand */
        [data-test="course-form-wrapper"].auto-form { max-height: none !important; height: auto !important; overflow: visible !important; }
        .form-card, .card-body, .auto-form-row { max-height: none !important; height: auto !important; overflow: visible !important; }
      `});
      await page.waitForTimeout(100);
    } catch (_) {}

    // Target the top-level form element (not nested auto-form divs)
    const formHandle = page.locator('form[data-test="course-form-wrapper"].auto-form').first();
    await formHandle.waitFor({ state: 'visible', timeout: 30000 });

    // Walk ancestor chain and disable overflow scroll to allow full layout expansion
    await page.evaluate((formSelector) => {
      const form = document.querySelector(formSelector);
      if (!form) return;
      let el = form;
      while (el && el !== document.documentElement) {
        try {
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/i.test(cs.overflowY || '')) {
            el.setAttribute('data-__orig-overflow-y', el.style.overflowY || '');
            el.setAttribute('data-__orig-height', el.style.height || '');
            el.setAttribute('data-__orig-max-height', el.style.maxHeight || '');
            el.style.overflowY = 'visible';
            el.style.height = 'auto';
            el.style.maxHeight = 'none';
          }
        } catch (_) {}
        el = el.parentElement;
      }
      // Ensure html/body expand
      document.documentElement.style.height = 'auto';
      document.body.style.height = 'auto';
      // Nudge layout and force reflow
      // Scroll through the form once to trigger any lazy content
      try { form.scrollTo(0, form.scrollHeight); } catch (_) {}
      try { form.scrollTo(0, 0); } catch (_) {}
    }, 'form[data-test="course-form-wrapper"].auto-form');

    // Let layout settle after CSS adjustments
    await page.waitForTimeout(300);

    // Prefer element screenshot so Playwright can stitch beyond viewport
    await formHandle.screenshot({ path: outputPath });

    // Remove custom CSS
    try {
      await page.evaluate((styleEl) => { try { styleEl && styleEl.remove && styleEl.remove(); } catch (_) {} }, styleHandle);
    } catch (_) {}

  } catch (err) {
    // Fallback to full page if anything goes wrong
    try {
      await page.screenshot({ path: outputPath, fullPage: true });
    } catch (_) {}
  }
}

/**
 * Fill generic subfields for a complex field using its template config
 */
async function fillSubfieldsFromConfig(page, question, action = 'updateCourse') {
  try {
    const fields = question?.config?.fields || {};
    for (const [subKey, cfg] of Object.entries(fields)) {
      // Build a synthetic question for the subfield using template-provided types
      const subQuestion = {
        qid: `${question.qid}.${subKey}`,
        dataKey: `${question.qid}.${subKey}`,
        label: cfg.label || `${question.qid} ${subKey}`,
        questionType: cfg.inputType || cfg.type || 'text',
        type: cfg.inputType || cfg.type || 'text',
        isVisibleInForm: !cfg.hidden,
        hidden: cfg.hidden || false,
        required: !!cfg.required,
      };

      try {
        await fillCourseField(page, subQuestion, action);
      } catch (_) {}
    }
  } catch (err) {
    console.log(`   ┗ ⚠️ Error in fillSubfieldsFromConfig for ${question?.qid}: ${err.message}`);
  }
}

/**
 * Main function to update an existing course
 * @param {Object} page - Playwright page object
 * @param {string} subfolder - Output directory for screenshots and files
 * @param {string} schoolId - School identifier
 * @param {string} action - Action type ('updateCourse' or 'inactivateCourse')
 */
async function updateCourse(page, subfolder, schoolId, browser = null, action = 'updateCourse') {
  try {
    ensureRunLogger(subfolder);
    const actionName = action === 'inactivateCourse' ? 'course inactivation' : 'course update';
    console.log(`\n📚 Starting ${actionName} process...`);
    
    // Wait for courses table to load
    console.log('⏳ Waiting for courses table to load...');
    await page.waitForSelector('[data-test="coursesTable"]', { timeout: 30000 });
    console.log('✅ Courses table loaded successfully');
    
    // Find and click on the first suitable course, skipping any with SIS sync error banner
    console.log('🔍 Looking for suitable courses...');
    let attempts = 0;
    const maxAttempts = 30; // safety to avoid infinite loops across many pages
    while (true) {
      const suitableCourse = await findActiveCourse(page, browser, subfolder, schoolId, action);
      if (!suitableCourse) {
        throw new Error('No suitable courses found and user intervention was declined or failed');
      }
      if (suitableCourse.userSelected) {
        console.log('✅ User manually selected a course');
      } else {
        console.log('🖱️ Clicking on suitable course...');
        await suitableCourse.click();
        console.log('✅ Suitable course selected');
      }

      // After landing on the course page, give UI time to render banner, then check
      await page.waitForTimeout(4000);
      const syncErrorBanner = page.locator('[data-test="integrationSyncStatus"].alert-danger');
      const hasSyncError = (await syncErrorBanner.count()) > 0 && await syncErrorBanner.first().isVisible();
      if (hasSyncError) {
        console.log('⛔ Detected SIS sync error banner on selected course. Skipping this course...');
        // Never click back-to-list (it opens a confirmation modal). Use history back only.
        await page.goBack();
        await page.waitForSelector('[data-test="coursesTable"]', { timeout: 30000 });
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error('Exceeded maximum attempts while trying to avoid courses with SIS sync error banner');
        }
        continue; // try finding another course
      }

      // No sync error detected; proceed
      break;
    }
    
    // Validate and click the edit course button with retries for "proposal in flight"
    console.log('🔍 Validating edit course button (with retry for "proposal in flight")...');
    const maxEditRetries = 3;
    let editClicked = false;
    for (let attempt = 1; attempt <= maxEditRetries; attempt++) {
      const editButton = page.locator('[data-test="edit-course-btn"]');
      await editButton.waitFor({ state: 'visible', timeout: 30000 });
      const isEnabled = await editButton.isEnabled().catch(() => true);
      const hasDisabledAttr = (await editButton.getAttribute('disabled')) !== null;
      const className = (await editButton.getAttribute('class')) || '';
      const looksDisabled = !isEnabled || hasDisabledAttr || /disabled|btn-disabled/i.test(className);
      const hasProposalInFlight = await page.locator('text=/proposal\s+in\s+flight/i').first().isVisible().catch(() => false);

      if (!looksDisabled && !hasProposalInFlight) {
        console.log(`🖱️ Clicking edit course button (attempt ${attempt})...`);
        try {
          await editButton.click();
          editClicked = true;
          console.log('✅ Edit course button clicked');
          break;
        } catch (clickErr) {
          console.log(`⚠️ Click failed on attempt ${attempt}: ${clickErr.message}`);
        }
      } else {
        console.log(`⛔ Edit course button disabled or "proposal in flight" detected (attempt ${attempt}/${maxEditRetries}).`);
      }

      if (attempt < maxEditRetries) {
        console.log('🔄 Refreshing page and retrying...');
        await page.reload();
        await page.waitForSelector('[data-test="edit-course-btn"]', { timeout: 15000 });
        await page.waitForTimeout(500);
      }
    }

    if (!editClicked) {
      console.log('❌ Unable to click edit course button after retries');
      if (browser && subfolder && schoolId) {
        try {
          const userResponse = await waitForUserResponseWithTimeout(5);
          if (userResponse === 'yes') {
            const takeoverResult = await offerUserTakeover(
              page,
              browser,
              subfolder,
              'edit-course',
              schoolId,
              action,
              'Edit button disabled due to "proposal in flight". Please try manually.',
              null,
              true
            );
            if (!takeoverResult.success) {
              throw new Error('User declined or failed manual edit after proposal in flight');
            }
          } else {
            throw new Error('Edit course button disabled after retries');
          }
        } catch (_) {
          throw new Error('Edit course button disabled after retries');
        }
      } else {
        throw new Error('Edit course button disabled after retries');
      }
    }
    
    // Wait for the course modal to be fully loaded
    console.log('⏳ Waiting for course modal to load...');
    await page.waitForSelector('[data-test="course-form-wrapper"]', { timeout: 30000 });
    await page.waitForTimeout(3000); // Additional wait for all form elements to load
    console.log('✅ Course modal loaded successfully');
    
    // Take targeted screenshot of the course form wrapper before changes
    console.log('📸 Taking course form screenshot before changes...');
    const beforeScreenshotPath = path.join(subfolder, `${schoolId}-updateCourse-fullModal-before.png`);
    await screenshotCourseForm(page, beforeScreenshotPath);
    console.log(`✅ Before screenshot saved: ${beforeScreenshotPath}`);
    
    // Read original course values
    console.log('📝 Reading original course values...');
    const beforeValues = await readCourseValues(page, schoolId);
    console.log('✅ Original course values captured');
    
    // Read course template and fill fields
    console.log('📋 Reading course template and filling fields...');
    await fillCourseTemplate(page, schoolId, action);
    console.log('✅ Course template filled');
    
    // Read course values after changes
    console.log('📝 Reading course values after changes...');
    const afterValues = await readCourseValues(page, schoolId);
    console.log('✅ Modified course values captured');
    
    // Compare and save differences
    console.log('🔍 Comparing field differences...');
    await saveCourseFieldDifferences(beforeValues, afterValues, subfolder, schoolId, action);
    console.log('✅ Field differences saved');
    
    // Take targeted screenshot of the course form wrapper after changes
    console.log('📸 Taking course form screenshot after changes...');
    const afterScreenshotPath = path.join(subfolder, `${schoolId}-${action}-fullModal-after.png`);
    await screenshotCourseForm(page, afterScreenshotPath);
    console.log(`✅ After screenshot saved: ${afterScreenshotPath}`);
    
    // Attempt to save the course (if save functionality exists)
    const saveSuccess = await saveCourse(page, subfolder, schoolId, browser);
    if (saveSuccess) {
      console.log('🎉 Course update and save process completed successfully');
    } else {
      console.log('⚠️ Course update completed but save may have failed');
    }
    
    return saveSuccess; // Return actual save success status
    
  } catch (error) {
    console.error('❌ Error in updateCourse:', error.message);
    throw error;
  }
}

/**
 * Clean up human-readable field identifier to make it more consistent
 * @param {string} identifier - Raw field identifier
 * @returns {string} - Cleaned up identifier
 */
function cleanFieldIdentifier(identifier) {
  if (!identifier) return identifier;
  
  // Remove common prefixes/suffixes that don't add value
  let cleaned = identifier
    .replace(/^\s*[-•*]\s*/, '') // Remove leading bullets/dashes
    .replace(/\s*[-•*]\s*$/, '') // Remove trailing bullets/dashes
    .replace(/^\s*[0-9]+\.\s*/, '') // Remove leading numbers
    .replace(/^\s*[A-Z]\.\s*/, '') // Remove leading letters
    .trim();
  
  // Capitalize first letter for consistency
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  
  return cleaned;
}

/**
 * Read all current course field values
 * @param {Object} page - Playwright page object
 * @param {string} schoolId - School identifier
 * @returns {Object} - Object containing all course field values
 */
async function readCourseValues(page, schoolId) {
  try {
    const templateFile = getLatestCourseTemplateFile(schoolId);
    if (!templateFile) return {};
    const tpl = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
    const questions = tpl?.courseTemplate?.questions || {};
    const qids = Object.keys(questions);
    const values = { _hiddenFields: {} };

    for (const qid of qids) {
      try {
        const question = questions[qid];
        const wrapper = page.locator(`[data-test="${qid}"]`);
        const count = await wrapper.count();
        if (count === 0) {
          // Attempt to detect hidden via field container or card
          let hiddenByContainerOrCard = false;
          try {
            const fieldContainer = page.locator(`#field-${qid}`).first();
            if ((await fieldContainer.count()) > 0) {
              const isVisible = await fieldContainer.isVisible().catch(() => false);
              if (!isVisible) hiddenByContainerOrCard = true;
              else {
                const hiddenCard = fieldContainer.locator('xpath=ancestor::*[contains(@class, "form-card") and contains(@style, "display: none")]').first();
                if ((await hiddenCard.count()) > 0) hiddenByContainerOrCard = true;
              }
            } else {
              const card = page.locator(`.form-card[data-card-id*="${qid}"]`).first();
              if ((await card.count()) > 0) {
                const styleAttr = (await card.getAttribute('style')) || '';
                if (/display\s*:\s*none/i.test(styleAttr)) hiddenByContainerOrCard = true;
                if (!hiddenByContainerOrCard) {
                  try {
                    const header = card.locator('span[data-test^="display_"]').first();
                    if ((await header.count()) > 0) {
                      const text = (await header.textContent()) || '';
                      if (/hidden/i.test(text)) hiddenByContainerOrCard = true;
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}

          if (hiddenByContainerOrCard) {
            values._hiddenFields[qid] = true;
          }
          values[qid] = undefined;
          continue;
        }

        // Hidden detection: wrapper not visible, ancestor field-hidden or style display:none
        let hidden = false;
        try {
          const visible = await wrapper.first().isVisible();
          if (!visible) hidden = true;
        } catch (_) {}
        if (!hidden) {
          try {
            const hiddenAncestor = wrapper.locator('xpath=ancestor::*[contains(@class, "field-hidden") or contains(@style, "display: none")]').first();
            if ((await hiddenAncestor.count()) > 0) hidden = true;
          } catch (_) {}
        }
        if (!hidden) {
          try {
            const container = page.locator(`#field-${qid}`).first();
            if ((await container.count()) > 0) {
              const visibleContainer = await container.isVisible().catch(() => false);
              if (!visibleContainer) hidden = true;
              else {
                const cls = (await container.getAttribute('class')) || '';
                if (cls.includes('field-hidden')) hidden = true;
              }
            }
          } catch (_) {}
        }
        if (hidden) {
          values._hiddenFields[qid] = true;
          values[qid] = undefined;
          continue;
        }
        // Disabled detection: present but not editable (multiselect disabled or control disabled)
        try {
          let disabled = false;
          const multi = wrapper.locator('.multiselect, [class*="multiselect"]').first();
          if ((await multi.count()) > 0) {
            const classAttr = (await multi.getAttribute('class')) || '';
            const ariaDis = (await multi.getAttribute('aria-disabled')) === 'true';
            if (classAttr.includes('multiselect--disabled') || ariaDis) disabled = true;
            const multiInput = multi.locator('input').first();
            if ((await multiInput.count()) > 0) {
              const hasDisabled = (await multiInput.getAttribute('disabled')) !== null;
              const isEnabled = await multiInput.isEnabled().catch(() => true);
              if (hasDisabled || !isEnabled) disabled = true;
            }
          } else {
            const ctrl = wrapper.locator('input, textarea, select, [role="combobox"], [role="listbox"]').first();
            if ((await ctrl.count()) > 0) {
              const hasDisabled = (await ctrl.getAttribute('disabled')) !== null;
              const ariaDis = (await ctrl.getAttribute('aria-disabled')) === 'true';
              const isEnabled = await ctrl.isEnabled().catch(() => true);
              const cls = (await ctrl.getAttribute('class')) || '';
              if (hasDisabled || ariaDis || !isEnabled || /btn-disabled|disabled/i.test(cls)) disabled = true;
            } else {
              // Handle button-style date pickers: button > div.form-input-button__display[disabled]
              const displayEl = wrapper.locator('button .form-input-button__display, .form-input-button__display').first();
              if ((await displayEl.count()) > 0) {
                const hasDisabled = (await displayEl.getAttribute('disabled')) !== null;
                if (hasDisabled) disabled = true;
              }
            }
          }
          if (disabled) {
            values._disabledFields = values._disabledFields || {};
            values._disabledFields[qid] = true;
            // Capture visible text for display-only fields so diffs show actual value
            try {
              const displayTextEl = wrapper.locator('.form-input-button__display').first();
              if ((await displayTextEl.count()) > 0) {
                const txt = (await displayTextEl.textContent()) || '';
                values[qid] = txt.trim();
              }
            } catch (_) {}
          }
        } catch (_) {}

        // Capture nested complex field values with fully-qualified keys EARLY (before generic handlers/continues)
        try {
          if (question && question.questionType === 'instructionalMethods') {
            // instructionalMethods.id from selected tag/single
            try {
              const methodSelected = wrapper
                .locator('.multiselect .multiselect__tags .multiselect__tag, .multiselect .multiselect__single')
                .first();
              if ((await methodSelected.count()) > 0) {
                const txt = (await methodSelected.textContent()) || '';
                if (txt.trim() !== '') {
                  values[`${qid}.id`] = txt.trim();
                }
              }
            } catch (_) {}

            // instructionalMethods.contactHours and instructionalMethods.load
            try {
              const base = page.locator(`[data-test="${qid}"]`);
              let contact = base.locator('input[id*="contactHours"], input[name*="contactHours"], [data-test="contactHours"] input').first();
              if ((await contact.count()) === 0) {
                // Fallbacks for dynamic-field structure: instructionalMethods.<index>.customFields.contactHours
                const contactCandidates = [
                  'input[aria-describedby$=".customFields.contactHours"]',
                  '[id^="field-instructionalMethods."][id$=".customFields.contactHours"] input[type="number"]',
                  '[id^="field-instructionalMethods."][id$=".customFields.contactHours"] input'
                ];
                for (const sel of contactCandidates) {
                  const candidate = page.locator(sel).first();
                  if ((await candidate.count()) > 0) { contact = candidate; break; }
                }
              }
              if ((await contact.count()) > 0) {
                const v = await contact.inputValue().catch(() => '');
                if (v && v.trim() !== '') values[`${qid}.contactHours`] = v;
              }
            } catch (_) {}
            try {
              const base = page.locator(`[data-test="${qid}"]`);
              let load = base.locator('input[id*="load"], input[name*="load"], [data-test="load"] input').first();
              if ((await load.count()) === 0) {
                // Fallbacks for dynamic-field structure: instructionalMethods.<index>.customFields.load
                const loadCandidates = [
                  'input[aria-describedby$=".customFields.load"]',
                  '[id^="field-instructionalMethods."][id$=".customFields.load"] input[type="number"]',
                  '[id^="field-instructionalMethods."][id$=".customFields.load"] input'
                ];
                for (const sel of loadCandidates) {
                  const candidate = page.locator(sel).first();
                  if ((await candidate.count()) > 0) { load = candidate; break; }
                }
              }
              if ((await load.count()) > 0) {
                const v = await load.inputValue().catch(() => '');
                if (v && v.trim() !== '') values[`${qid}.load`] = v;
              }
            } catch (_) {}
          }

          if (question && question.questionType === 'credits' && question.config && question.config.fields) {
            // Iterate credit field types and subfields
            for (const [fieldType, fieldCfg] of Object.entries(question.config.fields)) {
              const subFields = fieldCfg && fieldCfg.fields ? Object.keys(fieldCfg.fields) : [];
              for (const subKey of subFields) {
                try {
                  const selectors = [
                    `input[aria-describedby*=\"credits.${fieldType}.${subKey}\"]`,
                    `input[name*=\"${fieldType}.${subKey}\"]`,
                    `input[id*=\"${fieldType}.${subKey}\"]`,
                    // Dot-delimited id wrappers like field-credits.creditHours.min
                    `[id=\"field-credits.${fieldType}.${subKey}\"] input`,
                    `[id^=\"field-credits.\"][id$=\".${fieldType}.${subKey}\"] input`,
                    // Legacy hyphenated fallbacks
                    `#field-credits-${fieldType}-${subKey} input[type=\"number\"]`,
                    `#field-${fieldType}-${subKey} input[type=\"number\"]`,
                    `[data-test*=\"${fieldType}\"] input[type=\"number\"]`
                  ];
                  let el = null;
                  for (const sel of selectors) {
                    const candidate = wrapper.locator(sel).first();
                    if ((await candidate.count()) > 0) { el = candidate; break; }
                  }
                  if (el) {
                    const val = await el.inputValue().catch(() => '');
                    if (val && val.trim() !== '') {
                      values[`${qid}.${fieldType}.${subKey}`] = val;
                    }
                  }
                } catch (_) {}
              }
            }
          }
        } catch (_) {}

        // Generic dynamic nested capture for any question with config.fields
        if (question && question.config && question.config.fields) {
          const collectLeafPaths = (fields, prefix = '') => {
            const paths = [];
            for (const [key, cfg] of Object.entries(fields)) {
              const current = prefix ? `${prefix}.${key}` : key;
              if (cfg && typeof cfg === 'object' && cfg.fields && typeof cfg.fields === 'object') {
                paths.push(...collectLeafPaths(cfg.fields, current));
              } else {
                paths.push(current);
              }
            }
            return paths;
          };

          const leafPaths = collectLeafPaths(question.config.fields);
          for (const leaf of leafPaths) {
            // Avoid duplicating .id for instructionalMethods since it's captured from display
            if ((question.questionType === 'instructionalMethods') && leaf.endsWith('.id')) continue;

            const genericSelectors = [
              `[id="field-${qid}.${leaf}"] input`,
              `[id^="field-${qid}."][id$=".${leaf}"] input`,
              `input[aria-describedby$="${qid}.${leaf}"]`,
              `input[aria-describedby$=".${leaf}"]`,
              `input[name$=".${leaf}"]`,
              `input[id$=".${leaf}"]`
            ];

            let nestedEl = null;
            for (const sel of genericSelectors) {
              const candidate = wrapper.locator(sel).first();
              if ((await candidate.count()) > 0) { nestedEl = candidate; break; }
            }
            if (!nestedEl) {
              for (const sel of genericSelectors) {
                const candidate = page.locator(sel).first();
                if ((await candidate.count()) > 0) { nestedEl = candidate; break; }
              }
            }
            if (nestedEl) {
              try {
                const v = await nestedEl.inputValue().catch(() => '');
                if (v && v.trim() !== '') {
                  values[`${qid}.${leaf}`] = v;
                }
              } catch (_) {}
            }
          }
        }

        // Multiselect
        const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
        if (isMultiselect) {
          const selected = await wrapper.locator('.multiselect__tags .multiselect__tag, .multiselect__single').allTextContents();
          values[qid] = selected.length <= 1 ? (selected[0] || '') : selected;
          continue;
        }

        // Input/select/textarea/contenteditable direct or nested
        let input;
        let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
        if (["input", "textarea", "select"].includes(tagName)) {
          input = wrapper.first();
        } else {
          input = wrapper.locator('input, textarea, select, [contenteditable="true"]');
        }
        const inputCount = await input.count();

        if (inputCount > 0) {
          const el = input.first();
          tagName = await el.evaluate(node => node.tagName.toLowerCase());
          // Contenteditable (WYSIWYG) block
          try {
            const ce = await el.getAttribute('contenteditable');
            if (ce === 'true') {
              const text = (await el.textContent()) || '';
              values[qid] = text.trim();
              continue;
            }
          } catch (_) {}
          if (tagName === 'input' || tagName === 'textarea') {
            values[qid] = await el.inputValue();
            continue;
          }
          if (tagName === 'select') {
            values[qid] = await el.inputValue();
            continue;
          }
        }

        // Yes/No buttons
        const yesNo = wrapper.locator('button[data-test="YesBtn"], button[data-test="NoBtn"]');
        const btnCount = await yesNo.count();
        if (btnCount === 2) {
          let selectedIdx = -1;
          for (let i = 0; i < 2; i++) {
            const btn = yesNo.nth(i);
            const cls = (await btn.getAttribute('class')) || '';
            if (cls.includes('btn-raised')) { selectedIdx = i; break; }
          }
          values[qid] = selectedIdx === -1 ? undefined : (selectedIdx === 0 ? 'Yes' : 'No');
          continue;
        }

        values[qid] = undefined;
      } catch (_) {
        values[qid] = undefined;
      }
    }

    return values;
  } catch (err) {
    console.error('❌ Error reading course values:', err.message);
    return {};
  }
}

/**
 * Fill course template based on the school's course template file
 * @param {Object} page - Playwright page object
 * @param {string} schoolId - School identifier
 * @param {string} action - Action type ('updateCourse' or 'inactivateCourse')
 */
async function fillCourseTemplate(page, schoolId, action = 'updateCourse') {
  try {
    // Get the latest course template file
    const templateFile = getLatestCourseTemplateFile(schoolId);
    if (!templateFile) {
      console.log('⚠️ No course template file found, skipping template fill');
      return;
    }
    
    console.log(`📋 Using template file: ${templateFile}`);
    const templateContent = fs.readFileSync(templateFile, 'utf8');
    const template = JSON.parse(templateContent);
    
    // Fill form fields based on template
    if (template && template.courseTemplate && template.courseTemplate.questions) {
      const questions = template.courseTemplate.questions;
      let questionKeys = Object.keys(questions);
      
      // Initialize field processing tracker to prevent duplicates
      const processedFields = new Set();
      global.sessionProcessedFields = processedFields; // Share across functions
      
      // Filter questions based on action type
      if (action === 'inactivateCourse') {
        questionKeys = questionKeys.filter(key => key === 'status' || key === 'effectiveEndDate');
        console.log(`📝 Found ${questionKeys.length} inactivation-specific questions in course template (status, effectiveEndDate)`);
      } else if (action === 'newCourseRevision') {
        questionKeys = questionKeys.filter(key => key === 'effectiveStartDate');
        console.log(`📝 Found ${questionKeys.length} revision-specific questions in course template (effectiveStartDate)`);
      } else if (action === 'createCourse') {
        console.log(`📝 Found ${questionKeys.length} questions in course template (all fields for creation)`);
      } else {
        console.log(`📝 Found ${questionKeys.length} questions in course template`);
      }
      
      let pageErrorCount = 0;
      // Initialize skip list for diff based on action
      const allQids = Object.keys(questions);
      let initialSkip = [];
      if (action === 'inactivateCourse') {
        initialSkip = allQids.filter(qid => qid !== 'status' && qid !== 'effectiveEndDate');
      } else if (action === 'newCourseRevision') {
        initialSkip = allQids.filter(qid => qid !== 'effectiveStartDate');
      } else if (action === 'createCourse') {
        initialSkip = [];
      } else {
        initialSkip = [];
      }
      global.__courseDiffSkipFields = initialSkip;
      const maxPageErrors = 3; // Stop after 3 page errors to prevent endless loops
      
      for (const questionKey of questionKeys) {
        const question = questions[questionKey];
        question.qid = questionKey; // Add qid for consistency
        
        try {
          // Special handling for complex field types with nested structures
          const complexFieldTypes = ['credits', 'components', 'topics', 'requisites', 'learningOutcomes', 'instructionalMethods'];
          const isComplexField = complexFieldTypes.includes(question.questionType) && question.config && question.config.fields;
          
          if (isComplexField) {
            console.log(`🏗️ Processing complex field with nested structure: ${questionKey} (${question.questionType})`);
            // For other complex fields, try to fill the main field but mark as processed to prevent nested processing
            await fillCourseField(page, question, action);
            // Fill any subfields generically from template definition
            if (question.config && question.config.fields) {
              await fillSubfieldsFromConfig(page, question, action);
            }
            processedFields.add(question.qid);
          } else {
            // Check if this field was already processed by nested field logic
            if (processedFields.has(question.qid)) {
              console.log(`⏭️ Skipping ${question.qid} - already processed as part of nested structure`);
              continue;
            }
            
            await fillCourseField(page, question, action);
          }
          await page.waitForTimeout(150); // Reduced delay between field fills
        } catch (error) {
          if (error.message.includes('Target page, context or browser has been closed') || 
              error.message.includes('Page closed') ||
              error.message.includes('Context closed')) {
            pageErrorCount++;
            console.log(`⚠️ Page/context error ${pageErrorCount}/${maxPageErrors}: ${error.message}`);
            
            if (pageErrorCount >= maxPageErrors) {
              console.log(`❌ Too many page errors, stopping course template fill`);
              throw new Error(`Page became unstable after ${pageErrorCount} errors`);
            }
          } else {
            console.log(`⚠️ Field error for ${questionKey}: ${error.message}`);
          }
        }
      }
      
      // Log summary of processed fields
      console.log(`\n📊 Field Processing Summary:`);
      console.log(`   ┣ Total fields in template: ${questionKeys.length}`);
      console.log(`   ┣ Fields processed: ${processedFields.size}`);
      console.log(`   ┗ Processed fields: ${Array.from(processedFields).join(', ')}`);
      
      // Clear the processed fields tracker
      global.sessionProcessedFields = null;
    }
    
  } catch (error) {
    console.error('❌ Error filling course template:', error.message);
    throw error;
  }
}

/**
 * Tooltip dismissal disabled per request; no-op
 * @param {Object} page - Playwright page object
 */
async function dismissVisibleTooltips(page) {
  // no-op
}

/**
 * Detect and dismiss the unsaved-changes warning modal if it is present.
 * Safely clicks "GO BACK TO EDITING" to continue editing.
 */
async function dismissUnsavedChangesModal(page) {
  try {
    const modal = page.locator('.stacked.modal, [role="dialog"]:has-text("Warning!")').first();
    if ((await modal.count()) > 0 && await modal.isVisible().catch(() => false)) {
      console.log('   ┣ ⚠️ Unsaved-changes modal detected — dismissing (Go Back To Editing)');
      const goBack = modal.locator('button:has-text("GO BACK TO EDITING"), button:has-text("Go Back To Editing"), button.btn-outline-primary');
      if ((await goBack.count()) > 0 && await goBack.first().isVisible().catch(() => false)) {
        await goBack.first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      } else {
        // Fallback: press Escape to close the dialog
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Fill nested credit fields for Jenzabar schools
 * @param {Object} page - Playwright page object
 * @param {Object} question - Question configuration with nested credit fields
 * @param {string} action - Action type ('updateCourse' or 'inactivateCourse')
 */
async function fillNestedCreditFields(page, question, action = 'updateCourse') {
  try {
    console.log(`🏦  Processing nested credit field: ${question.qid}`);
    
    if (!question.config || !question.config.fields) {
      console.log(`⚠️ No nested fields found in credits configuration`);
      return;
    }
    
    const creditFieldsConfig = question.config.fields;
    console.log(`📋 Found ${Object.keys(creditFieldsConfig).length} credit field types: ${Object.keys(creditFieldsConfig).join(', ')}`);
    
    // Track chosen values to keep relationships consistent (e.g., min <= max)
    const chosenValuesByType = {};

    // Process each credit field type (creditHours, contactHours, billingHours, etc.)
    for (const [fieldType, fieldConfig] of Object.entries(creditFieldsConfig)) {
      console.log(`\n🔍  Processing ${fieldType} field...`);
      
      // Skip hidden fields
      if (fieldConfig.hidden) {
        console.log(`   ⏭️ Skipping hidden field: ${fieldType}`);
        continue;
      }
      
      // Skip fields with restricted role visibility
      if (fieldConfig.rolesAllowedToSee && Array.isArray(fieldConfig.rolesAllowedToSee) && fieldConfig.rolesAllowedToSee.length === 0) {
        console.log(`   ⏭️ Skipping field with restricted visibility: ${fieldType}`);
        continue;
      }
      
      // Process nested subfields (min, max, value, operator) if they exist
      if (fieldConfig.fields && typeof fieldConfig.fields === 'object') {
        console.log(`   📋 Found ${Object.keys(fieldConfig.fields).length} subfields in ${fieldType}: ${Object.keys(fieldConfig.fields).join(', ')}`);
        
        for (const [subFieldKey, subFieldConfig] of Object.entries(fieldConfig.fields)) {
          console.log(`\n   🔍 Processing ${fieldType}.${subFieldKey}...`);
          
          // Skip hidden subfields
          if (subFieldConfig.hidden) {
            console.log(`      ⏭️ Skipping hidden subfield: ${fieldType}.${subFieldKey}`);
            continue;
          }
          
          // Skip subfields with restricted role visibility
          if (subFieldConfig.rolesAllowedToSee && Array.isArray(subFieldConfig.rolesAllowedToSee) && subFieldConfig.rolesAllowedToSee.length === 0) {
            console.log(`      ⏭️ Skipping subfield with restricted visibility: ${fieldType}.${subFieldKey}`);
            continue;
          }
          
          // Create a question-like object for the subfield
          const subFieldQuestion = {
            qid: `${fieldType}.${subFieldKey}`,
            dataKey: `${fieldType}.${subFieldKey}`,
            label: subFieldConfig.label || `${fieldType} ${subFieldKey}`,
            questionType: subFieldConfig.inputType || 'text',
            type: subFieldConfig.inputType || 'text',
            isVisibleInForm: !subFieldConfig.hidden,
            hidden: subFieldConfig.hidden || false,
            required: subFieldConfig.required || false,
            description: subFieldConfig.description || '',
            originalFieldType: fieldType, // Track parent field
            originalSubFieldKey: subFieldKey // Track subfield key
          };
          
          console.log(`      📝 Created subfield question: ${subFieldQuestion.qid} (${subFieldQuestion.questionType})`);
          
          try {
            // Compute a value with awareness of min/max ordering
            let intendedValue = null;
            const store = (chosenValuesByType[fieldType] = chosenValuesByType[fieldType] || {});
            if (subFieldQuestion.questionType === 'number') {
              if (subFieldKey === 'min') {
                intendedValue = generateCourseTestValue({ questionType: 'number', qid: `${fieldType}.${subFieldKey}`, originalFieldType: fieldType, originalSubFieldKey: subFieldKey });
                // Coerce to base numeric
                const match = String(intendedValue).match(/-?\d+(?:\.\d+)?/);
                intendedValue = match ? match[0] : '1';
                store.min = intendedValue;
              } else if (subFieldKey === 'max') {
                const minValue = store.min || '1';
                const minNum = parseFloat(minValue);
                let maxNum = isFinite(minNum) ? minNum + 1 : 2;
                intendedValue = String(maxNum);
                store.max = intendedValue;
              } else {
                intendedValue = generateCourseTestValue({ questionType: 'number', qid: `${fieldType}.${subFieldKey}`, originalFieldType: fieldType, originalSubFieldKey: subFieldKey });
                const match = String(intendedValue).match(/-?\d+(?:\.\d+)?/);
                intendedValue = match ? match[0] : '1';
                store[subFieldKey] = intendedValue;
              }
            }

            await fillCourseField(page, subFieldQuestion, action);
            // If numeric, re-target the numeric input and sanitize with the intended value
            if ((subFieldQuestion.questionType === 'number' || subFieldKey === 'min' || subFieldKey === 'max' || subFieldKey === 'value')) {
              try {
                const idLike = `[id*="${fieldType}"][id*="${subFieldKey}"] input[type="number"], input[id*="${fieldType}"][id*="${subFieldKey}"][type="number"], input[name*="${fieldType}.${subFieldKey}"][type="number"], #field-${fieldType}-${subFieldKey} input[type="number"]`;
                const numericInput = page.locator(idLike).first();
                if (await numericInput.count() > 0) {
                  const fillVal = intendedValue !== null ? intendedValue : String(generateCourseTestValue({ questionType: 'number', qid: `${fieldType}.${subFieldKey}`, originalFieldType: fieldType, originalSubFieldKey: subFieldKey }));
                  await fillNumberField(page, numericInput, fillVal);
                }
              } catch (_) {}
            }
            await page.waitForTimeout(150); // Small delay between subfield fills
          } catch (subFieldError) {
            console.log(`      ⚠️ Error filling subfield ${fieldType}.${subFieldKey}: ${subFieldError.message}`);
          }
        }
      } else {
        // Handle the field itself if it doesn't have nested subfields
        console.log(`   📝 Processing ${fieldType} as single field...`);
        
        const fieldQuestion = {
          qid: fieldType,
          dataKey: fieldType,
          label: fieldConfig.label || fieldType,
          questionType: fieldConfig.inputType || 'text',
          type: fieldConfig.inputType || 'text',
          isVisibleInForm: !fieldConfig.hidden,
          hidden: fieldConfig.hidden || false,
          required: fieldConfig.required || false,
          description: fieldConfig.description || '',
          originalFieldType: fieldType // Track parent field
        };
        
        try {
          await fillCourseField(page, fieldQuestion, action);
          // If numeric, re-target the numeric input and sanitize
          if (fieldQuestion.questionType === 'number') {
            try {
              const idLike = `[id*="${fieldType}"] input[type="number"], input[id*="${fieldType}"][type="number"], input[name*="${fieldType}"][type="number"]`;
              const numericInput = page.locator(idLike).first();
              if (await numericInput.count() > 0) {
                const safeVal = String(generateCourseTestValue({ questionType: 'number', qid: `${fieldType}`, originalFieldType: fieldType }));
                await fillNumberField(page, numericInput, safeVal);
              }
            } catch (_) {}
          }
          await page.waitForTimeout(200); // Small delay between field fills
        } catch (fieldError) {
          console.log(`   ⚠️ Error filling field ${fieldType}: ${fieldError.message}`);
        }
      }
    }
    
    console.log(`✅  Completed processing nested credit field: ${question.qid}`);
    
  } catch (error) {
    console.log(`❌  Error processing nested credit field ${question.qid}: ${error.message}`);
  }
}

/**
 * Fill a single course field based on question configuration
 * @param {Object} page - Playwright page object
 * @param {Object} question - Question configuration from template
 * @param {string} action - Action type ('updateCourse' or 'inactivateCourse')
 */
async function fillCourseField(page, question, action = 'updateCourse') {
  try {
    if (!question.qid || question.hidden || !question.isVisibleInForm) {
      try {
        const topLevel = String(question.qid || '').split('.')[0];
        if (topLevel) {
          global.__courseDiffSkipFields = global.__courseDiffSkipFields || [];
          if (!global.__courseDiffSkipFields.includes(topLevel)) {
            global.__courseDiffSkipFields.push(topLevel);
          }
          recordSkipReason(topLevel, `Skipped: Field set to be skipped for test case: ${action}`);
        }
      } catch (_) {}
      return; // Skip hidden, disabled or invisible questions
    }
    
    // Track processed fields to prevent duplicates
    const processedFields = global.sessionProcessedFields || new Set();
    
    // Check if this specific questionId was already processed
    if (processedFields.has(question.qid)) {
      console.log(`⏭️ Skipping ${question.qid} - already processed to prevent duplicate filling`);
      return;
    }
    
    // Mark this field as being processed
    processedFields.add(question.qid);
    
    // Skip certain fields that shouldn't be modified
    const skipFields = ['effectiveStartDate', 'effectiveEndDate', 'crsApprovalDate', 'crsStatusDate', 'subjectCode', 'courseNumber', 'crsApprovalAgencyIds', 'status', 'sisId', 'allowIntegration', 'firstAvailable', 'studentEligibilityReference', 'studentEligibilityRule'];
    
    // For inactivation, allow status and effectiveEndDate to be modified
    const isInactivationField = action === 'inactivateCourse' && (question.qid === 'status' || question.qid === 'effectiveEndDate');
    
    // For new course revision, allow effectiveStartDate to be modified
    const isRevisionField = action === 'newCourseRevision' && question.qid === 'effectiveStartDate';
    
    // For course creation, allow specific fields but always skip sisId
    const isCreationAction = action === 'createCourse';
    const alwaysSkipFields = ['sisId', 'effectiveEndDate']; // Fields that should NEVER be modified, except during inactivation/revision
    const creationAllowedFields = ['status', 'effectiveStartDate', 'effectiveEndDate', 'crsApprovalDate', 'crsStatusDate', 'subjectCode', 'courseNumber', 'firstAvailable']; // Fields allowed for creation
    
    // Always skip certain fields regardless of action, BUT allow inactivation/revision overrides
    if (alwaysSkipFields.includes(question.qid) && !isInactivationField && !isRevisionField) {
      console.log(`⏭️ Skipping always-protected field: ${question.qid}`);
      try {
        const topLevel = String(question.qid).split('.')[0];
        if (!global.__courseDiffSkipFields) global.__courseDiffSkipFields = [];
        if (!global.__courseDiffSkipFields.includes(topLevel)) {
          global.__courseDiffSkipFields.push(topLevel);
        }
        recordSkipReason(topLevel, `Skipped: Field set to be skipped for test case: ${action}`);
      } catch (_) {}
      return;
    }
    
    // Skip fields based on action type
    if (skipFields.includes(question.qid) && !isInactivationField && !isRevisionField && !(isCreationAction && creationAllowedFields.includes(question.qid))) {
      console.log(`⏭️ Skipping protected field: ${question.qid}`);
      try {
        // Mark top-level qid as skipped for diff table
        const topLevel = String(question.qid).split('.')[0];
        if (!global.__courseDiffSkipFields) global.__courseDiffSkipFields = [];
        if (!global.__courseDiffSkipFields.includes(topLevel)) {
          global.__courseDiffSkipFields.push(topLevel);
        }
        try { recordSkipReason(topLevel, `Skipped: Field set to be skipped for test case: ${action}`); } catch (_) {}
      } catch (_) {}
      return;
    }
    
    // Debug logging for field protection logic
    if (skipFields.includes(question.qid)) {
      console.log(`   ┣ 🔒 Field ${question.qid} is in skipFields list`);
      console.log(`   ┣ ┣ isInactivationField: ${isInactivationField}`);
      console.log(`   ┣ ┣ isRevisionField: ${isRevisionField}`);
      console.log(`   ┣ ┣ isCreationAction: ${isCreationAction}`);
      console.log(`   ┣ ┣ creationAllowedFields.includes(${question.qid}): ${creationAllowedFields.includes(question.qid)}`);
      console.log(`   ┣ ┗ Will skip: ${skipFields.includes(question.qid) && !isInactivationField && !isRevisionField && !(isCreationAction && creationAllowedFields.includes(question.qid))}`);
    }
    
    // Log special handling for specific action fields
    if (isInactivationField) {
      console.log(`🔄 [Inactivation] Processing inactivation-specific field: ${question.qid}`);
    } else if (isRevisionField) {
      console.log(`🔄 [Revision] Processing revision-specific field: ${question.qid}`);
    } else if (isCreationAction) {
      console.log(`🔄 [Creation] Processing creation field: ${question.qid}`);
    }
    
    console.log(`🔍 Looking for field: ${question.qid} (${question.label})`);
    console.log(`   ┣ Question type: ${question.questionType || question.type}`);
    console.log(`   ┣ Question ID: ${question.qid}`);
    console.log(`   ┣ Data key: ${question.dataKey}`);
    
    // Skip proactive tooltip dismissal for performance; handled only on blockage
    // If an unsaved-changes modal is present at any time, dismiss it proactively
    try { await dismissUnsavedChangesModal(page); } catch (_) {}
    
    // Special handling for inactivateCourse action
    if (action === 'inactivateCourse') {
      if (question.qid === 'status') {
        return await handleCourseStatusInactivation(page, question);
      } else if (question.qid === 'effectiveEndDate') {
        return await handleEffectiveEndDateInactivation(page, question);
      }
    }
    
    // Special handling for newCourseRevision action
    if (action === 'newCourseRevision') {
      if (question.qid === 'effectiveStartDate') {
        return await handleEffectiveStartDateRevision(page, question);
      }
    }
    
    // Special handling for createCourse action
    if (action === 'createCourse') {
      if (question.qid === 'status') {
        return await handleCourseStatusCreation(page, question);
      } else if (question.qid === 'effectiveStartDate') {
        return await handleEffectiveStartDateCreation(page, question);
      } else if (question.qid === 'effectiveEndDate' || question.qid === 'crsApprovalDate' || question.qid === 'crsStatusDate') {
        return await handleDateFieldCreation(page, question);
      } else if (question.qid === 'subjectCode' || question.qid === 'courseNumber') {
        // These fields should be filled during course creation
        console.log(`🔄 [Creation] Processing ${question.qid} field for course creation...`);
        // Continue with normal field filling logic
      }
    }
    
    // Try multiple strategies to find the field
    let fieldElement = null;
    let fieldStrategy = '';
    
    // Strategy 1: By data-test attribute (use only question.qid to prevent duplicates)
    let dataTestSelectors = [
      `[data-test="${question.qid}"]`,
      `input[data-test="${question.qid}"]`,
      `select[data-test="${question.qid}"]`,
      `textarea[data-test="${question.qid}"]`,
      `.multiselect[data-test="${question.qid}"]`,
      `div[data-test="${question.qid}"] .multiselect`,
      // Enhanced selectors to find the actual input within wrappers
      `#field-${question.qid} input`,
      `#field-${question.qid} select`,
      `#field-${question.qid} textarea`,
      `#field-${question.qid} .multiselect`,
      `div[id="field-${question.qid}"] input.form-control`,
      `div[id="field-${question.qid}"] input.multiselect__input`
    ];
    
    // For nested credit fields (e.g., creditHours.min), add additional selectors
    if (question.originalFieldType && question.originalSubFieldKey) {
      const parentField = question.originalFieldType;
      const subField = question.originalSubFieldKey;
      
      // Add selectors for nested structure like credits.creditHours.min
      dataTestSelectors.push(
        `[data-test="credits.${parentField}.${subField}"]`,
        `[data-test="${parentField}.${subField}"]`,
        `input[data-test="credits.${parentField}.${subField}"]`,
        `input[data-test="${parentField}.${subField}"]`,
        `[aria-describedby*="credits.${parentField}.${subField}"]`,
        `[aria-describedby*="${parentField}.${subField}"]`,
        `input[aria-describedby*="credits.${parentField}.${subField}"]`,
        `input[aria-describedby*="${parentField}.${subField}"]`,
        `input[name*="${parentField}.${subField}"]`,
        `input[id*="${parentField}.${subField}"]`
      );
      
      console.log(`   ┣ 🏦  Enhanced selectors for nested field: ${parentField}.${subField}`);
    }

    // Special selectors for WYSIWYG editors (e.g., description)
    try {
      const qType = question.questionType || question.type;
      if (qType === 'wysiwyg') {
        dataTestSelectors.push(
          `#field-${question.qid} [data-test="page-editor"] [contenteditable="true"]`,
          `#field-${question.qid} [data-test="page-editor"]`,
          `[data-test="page-editor"][aria-describedby="error-for-${question.qid}"]`,
          `#field-${question.qid} .editor__content [contenteditable="true"]`,
          `[id="field-${question.qid}"] [contenteditable="true"]`
        );
        console.log(`   ┣ 📝 Added WYSIWYG selectors for ${question.qid}`);
      }
    } catch (_) {}
    
    for (const selector of dataTestSelectors) {
      const element = page.locator(selector).first();
      if (await element.count() > 0) {
        // Check if the element is visible and enabled
        const isVisible = await element.isVisible().catch(() => false);
        const isEnabled = await element.isEnabled().catch(() => true); // Default to true for non-input elements
        
        if (isVisible && isEnabled) {
          fieldElement = element;
          fieldStrategy = `data-test: ${selector}`;
          console.log(`   ┣ ✅ Field found via data-test: ${selector}`);
          break;
        }
      }
    }
    
    // (Removed generic fallback to prevent writing to wrong fields)
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find field: ${question.qid} (${question.label})`);
      return;
    }
    
    console.log(`   ┗ ✅ Found field using: ${fieldStrategy}`);
    
    // IMPORTANT: Determine actual field type based on the found element, not assumptions
    const foundElementTagName = await fieldElement.evaluate(el => el.tagName.toLowerCase()).catch(() => 'unknown');
    const foundElementClass = await fieldElement.getAttribute('class') || '';
    const foundElementType = await fieldElement.getAttribute('type') || '';
    
    console.log(`   ┣ 🔍 Found element analysis: tag=${foundElementTagName}, class="${foundElementClass}", type="${foundElementType}"`);
    
    // ULTIMATE SAFETY CHECK: Never allow critical multiselect fields to go through regular field logic
    const criticalMultiselectFields = ['departments', 'attributes'];
    if (criticalMultiselectFields.includes(question.qid)) {
      // For update flows we DO want to modify these; only skip in non-update flows.
      const shouldSkipForSafety = action !== 'updateCourse' && action !== 'createCourse' && action !== 'newCourseRevision';
      if (shouldSkipForSafety) {
        console.log(`   ┣ 🚨 ${question.qid} field detected and action=${action}, skipping to avoid breaking existing data`);
        return;
      }
      // Fall through and handle as a normal multiselect (no early return)
    }
    
    // Check field type based on ACTUAL found element, not wrapper assumptions
    let isMultiselect = false;
    let isYesNoButtons = false;
    let isWysiwyg = (question.questionType || question.type) === 'wysiwyg';
    
    // Determine field type based on the actual element we found
    if (isWysiwyg) {
      // Ensure we target the contenteditable region for WYSIWYG
      const contentEditable = await fieldElement.locator('[contenteditable="true"]').first();
      if (await contentEditable.count() > 0) {
        fieldElement = contentEditable;
        console.log(`   ┣ ✅ Using contenteditable for WYSIWYG field`);
      } else {
        // If the found element itself is contenteditable, keep as is
        try {
          const ceAttr = await fieldElement.getAttribute('contenteditable');
          if (ceAttr !== 'true') {
            // Try to refine to editor content area
            const alt = fieldElement.locator('.editor__content [contenteditable="true"]').first();
            if (await alt.count() > 0) {
              fieldElement = alt;
              console.log(`   ┣ ✅ Refined to editor content area`);
            }
          }
        } catch (_) {}
      }
    } else if (foundElementClass.includes('multiselect__input')) {
      // This is definitely a multiselect input
      isMultiselect = true;
      console.log(`   ┣ ✅ Confirmed multiselect: element has multiselect__input class`);
    } else if (foundElementClass.includes('form-control') && foundElementTagName === 'input') {
      // This is a regular form input
      isMultiselect = false;
      console.log(`   ┣ ✅ Confirmed regular input: element has form-control class and is input tag`);
    } else if (foundElementTagName === 'input' && (foundElementType === 'text' || foundElementType === 'number')) {
      // Regular text or number input
      isMultiselect = false;
      console.log(`   ┣ ✅ Confirmed regular input: element is ${foundElementType} input`);
    } else {
      // Fallback: check if parent has multiselect structure
      const parentMultiselect = await fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').count() > 0;
      isMultiselect = parentMultiselect;
      console.log(`   ┣ 🔍 Fallback check: parent multiselect=${parentMultiselect}`);
    }
    
    // Check for Yes/No buttons
    isYesNoButtons = await fieldElement.locator('..').locator('button[data-test="YesBtn"], button[data-test="NoBtn"]').count() > 0;
    
    // Override logic for specific fields that we know should NOT be multiselects
    if (isMultiselect && (question.qid === 'courseNumber' || question.qid === 'name' || question.qid === 'longName' || question.qid === 'prerequisiteCode')) {
      console.log(`   ┣ 🔢 Override: ${question.qid} should be regular input, not multiselect`);
      
      // Force these to be treated as regular inputs
      isMultiselect = false;
      console.log(`   ┣ ✅ ${question.qid} forced to regular input mode`);
    }
    
    console.log(`   ┣ 🔍 Field type analysis: isMultiselect=${isMultiselect}, isYesNoButtons=${isYesNoButtons}, qid=${question.qid}`);
    
    // SPECIAL SAFETY CHECK: Always treat known multiselect fields as multiselect regardless of DOM structure
    const knownMultiselectFields = ['departments', 'attributes', 'gradeModes', 'subjectCode'];
    if (knownMultiselectFields.includes(question.qid)) {
      console.log(`   ┣ 🔒 Special safety check: ${question.qid} field detected, forcing multiselect handling...`);
      
      // For subjectCode, make sure we have the right element (could be wrapper or input)
      if (question.qid === 'subjectCode') {
        const wrapper = fieldElement.locator('..').locator('.multiselect').first();
        if (await wrapper.count() > 0) {
          console.log(`   ┣ 📝 Using multiselect wrapper for subjectCode`);
          fieldElement = wrapper;
        }
      }
      
      await fillMultiselectDropdown(page, fieldElement, question);
      return; // Exit early for known multiselect fields
    }
    
    // Handle multiselect fields immediately (no test value needed)
    if (isMultiselect) {
      console.log(`   ┣ Detected multiselect field, selecting from dropdown options...`);
      // If a warning modal is open, dismiss before interacting
      await dismissUnsavedChangesModal(page).catch(() => {});
      await fillMultiselectDropdown(page, fieldElement, question, action);
      return; // Exit early for multiselect fields
    }
    
    // Handle Yes/No button fields immediately (no test value needed)
    if (isYesNoButtons) {
      console.log(`   ┣ Detected Yes/No button field, selecting opposite value...`);
      await fillYesNoButtons(page, fieldElement, question);
      return; // Exit early for button fields
    }
    
    const tCapture0 = Date.now();
    // For regular fields, capture original value once
    const hadValueBefore = await checkFieldHasValue(fieldElement, question);
    let originalValue = null;
    if (hadValueBefore) {
      originalValue = await getFieldValue(fieldElement, question);
      console.log(`   ┗ 📝 Captured original value for ${question.qid}: ${JSON.stringify(originalValue)}`);
    }
    const tCapture = Date.now() - tCapture0;
    if (tCapture > 500) console.log(`   ┗ ⏱️ Value capture took ${tCapture}ms`);
    
    // Short-circuit if a field looks like it's stuck loading, but try to recover first
    {
      const tLoad0 = Date.now();
      let looksLoading = await checkFieldIsLoading(page, fieldElement);
      if (looksLoading) {
        // Do not attempt tooltip dismissals; just try a minimal scroll/nudge once
        try { await fieldElement.scrollIntoViewIfNeeded(); } catch (_) {}
        try { await page.mouse.move(5, 5); } catch (_) {}
        await page.waitForTimeout(150);
        looksLoading = await checkFieldIsLoading(page, fieldElement);
      }
      const tLoad = Date.now() - tLoad0;
      if (tLoad > 500) console.log(`   ┗ ⏱️ Loading-check took ${tLoad}ms`);
      if (looksLoading) {
        console.log(`   ┗ ⏭️ Still blocked after retry, skipping: ${question.qid}`);
        recordSkipReason(question.qid, 'Skipped: field blocked by overlay');
        return;
      }
    }
    
    // IMPORTANT: For capped text-like fields, only honor configured template maxLength.
    if ((question.questionType === 'text' || question.type === 'text' || question.questionType === 'textarea' || question.questionType === 'wysiwyg') && hadValueBefore) {
      try {
        const maxLenConfigured = getConfiguredMaxLength(question);
        if (maxLenConfigured && typeof originalValue === 'string' && originalValue.trim().length >= maxLenConfigured) {
          console.log(`   ┗ 🛑 Existing value at/over maxLength(${maxLenConfigured}); skipping modification to avoid validation error`);
          return;
        }
      } catch (_) {}
    }

    // Generate test value only for regular fields
    const existingValue = hadValueBefore ? originalValue : null;
    let testValue = generateCourseTestValue(question, existingValue);
    // Sanitize numeric values to avoid accidental exponent characters
    let finalTestValue = testValue;
    if ((question.questionType || question.type) === 'number') {
      const match = String(testValue).match(/-?\d+(?:\.\d+)?/);
      finalTestValue = match ? match[0] : '1';
    }
    if (!testValue && testValue !== false && testValue !== 0) {
      console.log(`   ┗ ⏭️ No test value generated for: ${question.qid}`);
      return;
    }
    
    // Enforce maxLength if applicable to prevent validation errors
    const tClamp0 = Date.now();
    try {
      let maxLen = null;
      const qType = question.questionType || question.type;
      // Only clamp text-like fields, using template-configured max only
      if (qType === 'text' || qType === 'textarea' || qType === 'wysiwyg') {
        maxLen = getConfiguredMaxLength(question);
      }
      if (maxLen && typeof finalTestValue === 'string' && finalTestValue.length > maxLen) {
        const suffix = '-CDtest';
        const base = finalTestValue.replace(/(?:-\s*CDtest\d*)?$/i, '');
        if (maxLen > suffix.length) {
          const room = maxLen - suffix.length;
          testValue = base.slice(0, room) + suffix;
        } else {
          // If maxLen is too small to include suffix, just hard clamp
          testValue = base.slice(0, maxLen);
        }
        finalTestValue = testValue;
        console.log(`   ┗ ✂️ Clamped value to maxLength(${maxLen}): ${finalTestValue}`);
      }
    } catch (_) {}
    const tClamp = Date.now() - tClamp0;
    if (tClamp > 300) console.log(`   ┗ ⏱️ MaxLength resolution took ${tClamp}ms`);

    console.log(`   ┗ 📝 Filling with: ${finalTestValue}`);
    
    // Check if page is still active before filling
    try {
      await page.waitForTimeout(100); // Small delay to ensure stability
      const isPageActive = await page.evaluate(() => !document.hidden).catch(() => false);
      if (!isPageActive) {
        console.log(`   ┗ ⚠️ Page is not active, skipping field fill`);
        return;
      }
    } catch (pageError) {
      console.log(`   ┗ ⚠️ Page check failed, skipping field: ${pageError.message}`);
      return;
    }
    
    // Fill the field based on its type for non-multiselect/button fields
    const tFill0 = Date.now();
    await fillFieldByType(page, fieldElement, question, finalTestValue);
    const tFill = Date.now() - tFill0;
    if (tFill > 700) console.log(`   ┗ ⏱️ Filling took ${tFill}ms for ${question.qid}`);

    // Verify value changed; if not, try an alternate deterministic value
    try {
      const qType = question.questionType || question.type;
      const shouldVerify = !(qType === 'text' || qType === 'textarea' || qType === 'wysiwyg');
      if (shouldVerify) {
        const tVerify0 = Date.now();
        let afterValue = await getFieldValue(fieldElement, question);
        const beforeStr = originalValue == null ? '' : String(originalValue).trim();
        const afterStr = afterValue == null ? '' : String(afterValue).trim();
        if (beforeStr === afterStr) {
          console.log(`   ┗ ⚠️ Value did not change for ${question.qid}, attempting alternate value`);
          let alternate = finalTestValue;
          if (typeof finalTestValue === 'string') {
            alternate = finalTestValue.replace(/(?:-\s*CDtest\d*)?$/i, '') + '-CDtest2';
          } else if (typeof finalTestValue === 'number') {
            alternate = Number(finalTestValue) + 1;
          } else if (typeof finalTestValue === 'boolean') {
            alternate = !finalTestValue;
          }
          await fillFieldByType(page, fieldElement, question, alternate);
        }
        const tVerify = Date.now() - tVerify0;
        if (tVerify > 500) console.log(`   ┗ ⏱️ Verification took ${tVerify}ms for ${question.qid}`);
      }
    } catch (_) {}
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling field ${question.qid}: ${error.message}`);
  }
}

/**
 * Fill a text field
 */
async function fillTextField(page, fieldElement, value) {
  try {
    // First check if the field is visible
    const isVisible = await fieldElement.isVisible().catch(() => false);
    if (!isVisible) {
      console.log(`   ┣ 👁️ Text field not visible, attempting to make it visible...`);
      
      // Try to scroll the element into view
      await fieldElement.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      
      // Try clicking on parent to activate
      const parent = fieldElement.locator('..').first();
      if (await parent.count() > 0) {
        await parent.click();
        await page.waitForTimeout(300);
      }
      
      // Check visibility again
      const isNowVisible = await fieldElement.isVisible().catch(() => false);
      if (!isNowVisible) {
        console.log(`   ┣ ⚠️ Text field still not visible after attempts, trying force interaction...`);
        // Continue anyway with force click
      }
    }
    
    await fieldElement.clear();
    await page.waitForTimeout(100);
    await fieldElement.fill(String(value));
  } catch (error) {
    console.log(`   ┣ 🔄 Primary fill method failed: ${error.message.split('\n')[0]}, trying alternative approach...`);
    try {
      // Try alternative approach for text fields
      await fieldElement.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(200);
      await fieldElement.press('Control+a');
      await page.keyboard.type(String(value));
    } catch (alternativeError) {
      console.log(`   ┣ ❌ Alternative fill method also failed: ${alternativeError.message.split('\n')[0]}`);
      
      // Last resort: try typing without clicking
      try {
        await fieldElement.press('Control+a');
        await page.keyboard.type(String(value));
        console.log(`   ┣ ✅ Last resort keyboard typing succeeded`);
      } catch (keyboardError) {
        console.log(`   ┣ ❌ All fill methods failed: ${keyboardError.message.split('\n')[0]}`);
        throw keyboardError;
      }
    }
  }
}

/**
 * Fill a textarea field
 */
async function fillTextAreaField(page, fieldElement, value) {
  try {
    await fieldElement.clear();
    await page.waitForTimeout(100);
    await fieldElement.fill(String(value));
  } catch (error) {
    // Try alternative approach for textareas
    await fieldElement.click();
    await fieldElement.press('Control+a');
    await page.keyboard.type(String(value));
  }
}

/**
 * Fill a WYSIWYG editor (ProseMirror) contenteditable field
 */
async function fillWysiwygField(page, fieldElement, value) {
  try {
    // Ensure we are on the contenteditable node
    let editor = fieldElement;
    try {
      const isCE = await editor.getAttribute('contenteditable');
      if (isCE !== 'true') {
        const ce = editor.locator('[contenteditable="true"]').first();
        if (await ce.count() > 0) editor = ce;
      }
    } catch (_) {}

    // Replace innerHTML and dispatch input/change events (no key nudges)
    await editor.evaluate((el, html) => {
      el.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = html;
      el.appendChild(p);
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch (_) {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }, String(value));
  } catch (error) {
    try {
      await fieldElement.click({ force: true });
      await fieldElement.press('Control+a');
      await page.keyboard.type(String(value));
    } catch (_) {}
  }
}

/**
 * Fill a number field
 */
async function fillNumberField(page, fieldElement, value) {
  try {
    // Ensure we operate on the actual input element
    let inputEl = fieldElement;
    try {
      const tagName = await fieldElement.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      if (tagName !== 'input') {
        const nested = fieldElement.locator('input[type="number"], input');
        if (await nested.count() > 0) {
          inputEl = nested.first();
        }
      }
    } catch (_) {}

    // Sanitize to a numeric string (no exponent letters)
    const sanitizeNumber = (raw) => {
      const str = String(raw);
      const match = str.match(/-?\d+(?:\.\d+)?/);
      return match ? match[0] : '1';
    };

    const toFill = sanitizeNumber(value);
    await inputEl.clear();
    await page.waitForTimeout(50);
    await inputEl.fill(toFill);
    // Verify no alpha characters snuck in; refix if needed
    const after = await inputEl.inputValue().catch(() => toFill);
    if (/[a-zA-Z]/.test(after || '')) {
      await inputEl.clear();
      await inputEl.fill(toFill);
    }
  } catch (error) {
    try {
      const sanitizeNumber = (raw) => {
        const str = String(raw);
        const match = str.match(/-?\d+(?:\.\d+)?/);
        return match ? match[0] : '1';
      };
      const toFill = sanitizeNumber(value);
      await fieldElement.click({ force: true });
      await inputEl.press('Control+a');
      await page.keyboard.type(toFill);
    } catch (_) {}
  }
}

/**
 * Fill a select/dropdown field (enhanced for course forms)
 */
async function fillSelectField(page, fieldElement, value, question = null) {
  try {
    // Check if it's part of a multiselect component structure
    const parentDiv = fieldElement.locator('..');
    const multiselect = parentDiv.locator('.multiselect').first();
    
    if (await multiselect.count() > 0) {
      // This is a multiselect component
      console.log(`   ┣ Detected multiselect component, checking if enabled...`);
      
      // Check if multiselect is disabled
      const isDisabled = await multiselect.getAttribute('class').then(className => 
        className && className.includes('multiselect--disabled')
      ).catch(() => false);
      
      if (isDisabled) {
        console.log(`   ┗ ⚠️ Multiselect is disabled, skipping: ${question.qid}`);
        return;
      }
      
      try {
        console.log(`   ┣ Clicking to open multiselect...`);
        
        // Try clicking with multiple strategies in case of tooltip interference
        let clickSuccessful = false;
        const clickStrategies = [
          { name: 'normal click', action: async () => { await multiselect.focus().catch(() => {}); await multiselect.click({ timeout: 5000 }); } },
          { name: 'force click', action: async () => { await multiselect.focus().catch(() => {}); await multiselect.click({ force: true, timeout: 5000 }); } },
          { name: 'click with scroll', action: async () => {
            await multiselect.scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            await multiselect.focus().catch(() => {});
            await multiselect.click({ timeout: 5000 });
          }}
        ];
        
        for (const strategy of clickStrategies) {
          try {
            console.log(`   ┣ Trying ${strategy.name}...`);
            await strategy.action();
            clickSuccessful = true;
            console.log(`   ┣ ✅ ${strategy.name} successful`);
            break;
          } catch (clickError) {
            console.log(`   ┣ ❌ ${strategy.name} failed: ${clickError.message.split('\n')[0]}`);
            // If an unsaved-changes modal is present, dismiss it and retry next strategy
            const dismissed = await dismissUnsavedChangesModal(page);
            if (dismissed) {
              console.log('   ┣ ✅ Dismissed warning modal, will retry next click strategy');
            }
          }
        }
        
        if (!clickSuccessful) {
          console.log(`   ┗ ❌ All click strategies failed for multiselect ${question.qid}`);
          return;
        }
        
        await page.waitForTimeout(500);
        
        // Look for available options, excluding error messages
        const allOptions = page.locator('.multiselect__option');
        const optionCount = await allOptions.count();
        
        if (optionCount > 0) {
          // Filter out options with "not found", "empty", "no departments" messages
          let selectedOption = null;
          
          for (let i = 0; i < optionCount; i++) {
            const option = allOptions.nth(i);
            const optionText = await option.textContent();
            const cleanText = optionText?.trim().toLowerCase() || '';
            
            // Skip options that are error messages or empty states
            if (cleanText.includes('no departments found') || 
                cleanText.includes('not found') || 
                cleanText.includes('list is empty') || 
                cleanText.includes('no elements found') ||
                cleanText === '') {
              continue;
            }
            
            // Check if option is visible and enabled
            const isVisible = await option.isVisible().catch(() => false);
            if (isVisible) {
              selectedOption = option;
              console.log(`   ┣ Found selectable option: "${optionText}"`);
              break;
            }
          }
          
          if (selectedOption) {
            try {
              // Try multiple click strategies to handle element interception
              await selectedOption.click({ timeout: 3000 });
              console.log(`   ┗ ✅ Selected option from multiselect`);
            } catch (clickError) {
              console.log(`   ┣ Direct click failed, trying alternative approach...`);
              try {
                // Try force click
                await selectedOption.click({ force: true, timeout: 3000 });
                console.log(`   ┗ ✅ Selected option with force click`);
              } catch (forceClickError) {
                console.log(`   ┗ ⚠️ Failed to click option: ${forceClickError.message}`);
                await page.keyboard.press('Escape');
              }
            }
          } else {
            console.log(`   ┗ ⚠️ No selectable options found in multiselect`);
            // Close the multiselect if no options found
            await page.keyboard.press('Escape');
          }
        } else {
          console.log(`   ┗ ⚠️ No options found in multiselect dropdown`);
          // Close the multiselect
          await page.keyboard.press('Escape');
        }
      } catch (multiselectError) {
        console.log(`   ┗ ⚠️ Error with multiselect interaction: ${multiselectError.message}`);
        // Try to close any open dropdowns
        try {
          await page.keyboard.press('Escape');
        } catch (escapeError) {
          // Ignore escape errors
        }
      }
    } else {
      // Regular select element
      const tagName = await fieldElement.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        const options = fieldElement.locator('option');
        const optionCount = await options.count();
        if (optionCount > 1) { // Skip first option (usually placeholder)
          await fieldElement.selectOption({ index: 1 });
          console.log(`   ┗ ✅ Selected option from regular select`);
        }
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling select field: ${error.message}`);
    // Try to close any open dropdowns
    try {
      await page.keyboard.press('Escape');
    } catch (escapeError) {
      // Ignore escape errors
    }
  }
}

/**
 * Fill a multiselect field
 */
async function fillMultiSelectField(page, fieldElement, value, question = null) {
  await fillSelectField(page, fieldElement, value, question);
}

/**
 * Fill a date field
 */
async function fillDateField(page, fieldElement, value) {
  try {
    console.log(`   ┣ 📅 Processing date field with value: ${value}`);
    
    // First, try to find actual input element within the wrapper
    const inputSelectors = [
      'input[type="text"]',
      'input[type="date"]', 
      'input',
      '.form-control',
      '[contenteditable="true"]'
    ];
    
    let actualInput = null;
    for (const selector of inputSelectors) {
      const input = fieldElement.locator(selector).first();
      if (await input.count() > 0) {
        const isVisible = await input.isVisible().catch(() => false);
        const isEnabled = await input.isEnabled().catch(() => true);
        if (isVisible && isEnabled) {
          actualInput = input;
          console.log(`   ┣ Found actual input using selector: ${selector}`);
          break;
        }
      }
    }
    
    // If no input found, look in parent/sibling elements
    if (!actualInput) {
      const parentInput = fieldElement.locator('..').locator('input').first();
      if (await parentInput.count() > 0) {
        const isVisible = await parentInput.isVisible().catch(() => false);
        const isEnabled = await parentInput.isEnabled().catch(() => true);
        if (isVisible && isEnabled) {
          actualInput = parentInput;
          console.log(`   ┣ Found input in parent element`);
        }
      }
    }
    
    if (actualInput) {
      try {
        console.log(`   ┣ Attempting to fill input with: ${value}`);
        await actualInput.clear();
        await actualInput.fill(value);
        console.log(`   ┗ ✅ Successfully filled date field`);
        return;
      } catch (fillError) {
        console.log(`   ┣ Direct fill failed, trying alternative approach...`);
        try {
          await actualInput.click();
          await inputBox.first().press('Control+a'); // Select all
          await page.keyboard.type(value);
          await page.keyboard.press('Tab'); // Move to next field
          console.log(`   ┗ ✅ Successfully typed date value`);
          return;
        } catch (typeError) {
          console.log(`   ┗ ❌ Both fill methods failed: ${typeError.message}`);
        }
      }
    }
    
    // Check if it's a date picker component
    const isDatePicker = await fieldElement.locator('..').locator('.form-input-button, .date-picker-button, button[class*="date"]').count() > 0;
    
    if (isDatePicker) {
      console.log(`   ┣ Detected custom date picker component`);
      // This is a custom date picker, try clicking the button
      const dateButton = fieldElement.locator('..').locator('button').first();
      if (await dateButton.count() > 0) {
        try {
          await dateButton.click();
          await page.waitForTimeout(500);
          // Look for date picker input that becomes visible
          const pickerInput = page.locator('.datepicker input, .date-picker input, .calendar input').first();
          if (await pickerInput.count() > 0) {
            await pickerInput.fill(value);
            await page.keyboard.press('Enter');
            console.log(`   ┗ ✅ Filled date picker input`);
          } else {
            // Close picker since we can't set the value
            await page.keyboard.press('Escape');
            console.log(`   ┗ ⚠️ Could not find date picker input, closed picker`);
          }
        } catch (pickerError) {
          console.log(`   ┗ ⚠️ Date picker interaction failed: ${pickerError.message}`);
          // Try to close any open picker
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } else {
      console.log(`   ┗ ⚠️ Could not find fillable date input - field may be read-only or have different structure`);
    }
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling date field: ${error.message}`);
  }
}

/**
 * Fill a checkbox field
 */
async function fillCheckboxField(page, fieldElement, value) {
  try {
    const isChecked = await fieldElement.isChecked();
    if (value && !isChecked) {
      await fieldElement.check();
    } else if (!value && isChecked) {
      await fieldElement.uncheck();
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling checkbox field: ${error.message}`);
  }
}

/**
 * Fill a components field (special course field type)
 */
async function fillComponentsField(page, fieldElement, value) {
  try {
    // Components field is often a special multiselect or custom component
    await fillSelectField(page, fieldElement, value);
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling components field: ${error.message}`);
  }
}

/**
 * Fill a yesNo field (used in Jenzabar nested credit fields)
 */
async function fillYesNoField(page, fieldElement, value, question = null) {
  try {
    console.log(`   ┣ 🏦  Processing yesNo field for: ${question?.qid || 'unknown'}`);
    
    // Look for Yes/No buttons in the parent wrapper
    const wrapper = fieldElement.locator('..');
    const yesButton = wrapper.locator('button[data-test="YesBtn"], button:has-text("Yes"), .btn:has-text("Yes")');
    const noButton = wrapper.locator('button[data-test="NoBtn"], button:has-text("No"), .btn:has-text("No")');
    
    const yesCount = await yesButton.count();
    const noCount = await noButton.count();
    
    if (yesCount === 0 && noCount === 0) {
      console.log(`   ┗ ⚠️ No Yes/No buttons found for yesNo field, trying checkbox approach...`);
      // Fallback to checkbox behavior
      await fillCheckboxField(page, fieldElement, value);
      return;
    }
    
    // Select button based on test value
    const shouldSelectYes = value === true || value === 'yes' || value === 'Yes';
    const buttonToClick = shouldSelectYes ? yesButton.first() : noButton.first();
    const buttonName = shouldSelectYes ? 'Yes' : 'No';
    
    if (await buttonToClick.count() > 0) {
      const isVisible = await buttonToClick.isVisible();
      const isEnabled = await buttonToClick.isEnabled();
      
      if (isVisible && isEnabled) {
        await buttonToClick.click();
        console.log(`   ┗ ✅ Selected ${buttonName} for yesNo field: ${question?.qid || 'unknown'}`);
      } else {
        console.log(`   ┗ ⚠️ ${buttonName} button not clickable for yesNo field: ${question?.qid || 'unknown'}`);
      }
    } else {
      console.log(`   ┗ ⚠️ ${buttonName} button not found for yesNo field: ${question?.qid || 'unknown'}`);
    }
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling yesNo field: ${error.message}`);
  }
}

/**
 * Handle course status inactivation by setting it to 'inactive'
 */
async function handleCourseStatusInactivation(page, question) {
  try {
    console.log(`🔄 [Inactivation] Processing status field for course inactivation...`);
    
    // Find the status field using the same strategies as regular fields
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find status field for inactivation`);
      return;
    }
    
    console.log(`   ┗ ✅ Found status field for inactivation`);
    
    // Check if it's a multiselect/dropdown or regular input
    const isMultiselect = await fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').count() > 0;
    
    if (isMultiselect) {
      console.log(`   ┣ Status field is multiselect, looking for 'inactive' option...`);
      const wrapper = fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').first();
      
      try {
        await wrapper.click();
        await page.waitForTimeout(1000);
        
        // Look for options containing 'inactive', 'inact', or similar
        const options = page.locator('.multiselect__content-wrapper li, [role="option"]');
        const optionCount = await options.count();
        
        let foundInactive = false;
        for (let i = 0; i < optionCount; i++) {
          const option = options.nth(i);
          const optionText = await option.textContent();
          const cleanText = optionText?.trim().toLowerCase() || '';
          
          if (cleanText.includes('inact') || cleanText.includes('cancel')) {
            await option.click();
            console.log(`   ┗ ✅ Selected inactive status: "${optionText}"`);
            foundInactive = true;
            break;
          }
        }
        
        if (!foundInactive) {
          console.log(`   ┗ ⚠️ Could not find inactive status option, selecting first available`);
          const firstOption = options.first();
          if (await firstOption.count() > 0) {
            await firstOption.click();
          }
        }
      } catch (error) {
        console.log(`   ┗ ❌ Error setting status to inactive: ${error.message}`);
      }
    } else {
      // Try to set as text input
      console.log(`   ┣ Status field is text input, setting to 'inactive'...`);
      try {
        await fieldElement.clear();
        await fieldElement.fill('inactive');
        console.log(`   ┗ ✅ Set status to 'inactive'`);
      } catch (error) {
        console.log(`   ┗ ❌ Error setting status text: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleCourseStatusInactivation: ${error.message}`);
  }
}

/**
 * Handle course status creation by setting it to 'Active'
 */
async function handleCourseStatusCreation(page, question) {
  try {
    console.log(`🔄 [Creation] Processing status field for course creation...`);
    
    // Find the status field using the same strategies as regular fields
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find status field for creation`);
      return;
    }
    
    console.log(`   ┗ ✅ Found status field for creation`);
    
    // Check if it's a multiselect/dropdown or regular input
    const isMultiselect = await fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').count() > 0;
    
    if (isMultiselect) {
      console.log(`   ┣ Status field is multiselect, looking for 'Active' option...`);
      const wrapper = fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').first();
      
      try {
        await wrapper.click();
        await page.waitForTimeout(1000);
        
        // Look for options containing 'active'
        const options = page.locator('.multiselect__content-wrapper li, [role="option"]');
        const optionCount = await options.count();
        
        let foundActive = false;
        for (let i = 0; i < optionCount; i++) {
          const option = options.nth(i);
          const optionText = await option.textContent();
          const cleanText = optionText?.trim().toLowerCase() || '';
          
          if (cleanText.includes('active')) {
            await option.click();
            console.log(`   ┗ ✅ Selected active status: "${optionText}"`);
            foundActive = true;
            break;
          }
        }
        
        if (!foundActive) {
          console.log(`   ┗ ⚠️ Could not find active status option, selecting first available`);
          const firstOption = options.first();
          if (await firstOption.count() > 0) {
            await firstOption.click();
          }
        }
      } catch (error) {
        console.log(`   ┗ ❌ Error setting status to active: ${error.message}`);
      }
    } else {
      // Try to set as text input
      console.log(`   ┣ Status field is text input, setting to 'Active'...`);
      try {
        await fieldElement.clear();
        await fieldElement.fill('Active');
        console.log(`   ┗ ✅ Set status to 'Active'`);
      } catch (error) {
        console.log(`   ┗ ❌ Error setting status text: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleCourseStatusCreation: ${error.message}`);
  }
}

/**
 * Handle effective start date creation by setting it to today's date
 */
async function handleEffectiveStartDateCreation(page, question) {
  try {
    console.log(`📅 [Creation] Processing effectiveStartDate field for course creation...`);
    
    // Find the effective start date field
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find effectiveStartDate field for creation`);
      return;
    }
    
    console.log(`   ┗ ✅ Found effectiveStartDate field for creation`);
    
    // Generate today's date in the format "Aug 19, 2025"
    const today = new Date();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[today.getMonth()];
    const day = today.getDate();
    const year = today.getFullYear();
    const todayFormatted = `${month} ${day}, ${year}`;
    
    console.log(`   ┣ Setting effectiveStartDate to today: ${todayFormatted}`);
    
    await fillDateFieldWithFormat(page, fieldElement, todayFormatted);
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleEffectiveStartDateCreation: ${error.message}`);
  }
}

/**
 * Handle date field creation by setting it to today's date in correct format
 */
async function handleDateFieldCreation(page, question) {
  try {
    console.log(`📅 [Creation] Processing date field ${question.qid} for course creation...`);
    
    // Find the date field
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find ${question.qid} field for creation`);
      return;
    }
    
    console.log(`   ┗ ✅ Found ${question.qid} field for creation`);
    
    // Generate today's date in the format "Aug 19, 2025"
    const today = new Date();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[today.getMonth()];
    const day = today.getDate();
    const year = today.getFullYear();
    const todayFormatted = `${month} ${day}, ${year}`;
    
    console.log(`   ┣ Setting ${question.qid} to today: ${todayFormatted}`);
    
    await fillDateFieldWithFormat(page, fieldElement, todayFormatted);
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleDateFieldCreation: ${error.message}`);
  }
}

/**
 * Fill Credit Hours Min field for colleague_ethos schools
 */
async function fillCreditHoursMinField(page) {
  try {
    console.log('   ┣ Searching for Credit Hours Min field...');
    
    // Try multiple selectors for Credit Hours Min field
    const selectors = [
      '[aria-describedby="error-for-credits.creditHours.min"]',
      'input[aria-describedby*="credits.creditHours.min"]',
      'input[name*="creditHours.min"]',
      'input[id*="creditHours.min"]',
      '[data-test*="creditHours"]',
      '[data-test*="credits"] input'
    ];
    
    let creditHoursField = null;
    let foundSelector = '';
    
    for (const selector of selectors) {
      const field = page.locator(selector).first();
      if (await field.count() > 0) {
        const isVisible = await field.isVisible().catch(() => false);
        const isEnabled = await field.isEnabled().catch(() => true);
        
        if (isVisible && isEnabled) {
          creditHoursField = field;
          foundSelector = selector;
          break;
        }
      }
    }
    
    if (!creditHoursField) {
      console.log('   ┗ ⚠️ Credit Hours Min field not found, skipping');
      return;
    }
    
    console.log(`   ┣ Found Credit Hours Min field using: ${foundSelector}`);
    
    // Generate random credit hours value (1-5)
    const randomCredits = Math.floor(Math.random() * 5) + 1;
    console.log(`   ┣ Filling Credit Hours Min with: ${randomCredits}`);
    
    try {
      await creditHoursField.clear();
      await creditHoursField.fill(randomCredits.toString());
      console.log(`   ┗ ✅ Successfully filled Credit Hours Min with: ${randomCredits}`);
    } catch (fillError) {
      console.log(`   ┣ Direct fill failed, trying typing...`);
      try {
        await creditHoursField.click();
        await creditHoursField.press('Control+a');
        await page.keyboard.type(randomCredits.toString());
        console.log(`   ┗ ✅ Successfully typed Credit Hours Min: ${randomCredits}`);
      } catch (typeError) {
        console.log(`   ┗ ❌ Failed to fill Credit Hours Min: ${typeError.message}`);
      }
    }
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in fillCreditHoursMinField: ${error.message}`);
  }
}

/**
 * Helper function to fill date field with proper format
 */
async function fillDateFieldWithFormat(page, fieldElement, dateValue) {
  // Look for actual input field within the element (could be nested)
  const inputField = fieldElement.locator('input[type="text"], input[type="date"], input').first();
  const inputCount = await inputField.count();
  
  if (inputCount > 0) {
    try {
      console.log(`   ┣ Found input field, attempting to fill with: ${dateValue}`);
      await inputField.clear();
      await inputField.fill(dateValue);
      await page.waitForTimeout(500);
      await inputField.press('Enter'); // Close any date picker
      console.log(`   ┗ ✅ Successfully set date to ${dateValue}`);
    } catch (inputError) {
      console.log(`   ┣ Input field fill failed, trying direct typing...`);
      try {
        await inputField.click();
        await inputField.press('Control+a'); // Select all
        await page.keyboard.type(dateValue);
        await inputField.press('Enter');
        console.log(`   ┗ ✅ Successfully typed date: ${dateValue}`);
      } catch (typeError) {
        console.log(`   ┗ ❌ Error typing date: ${typeError.message}`);
      }
    }
  } else {
    console.log(`   ┣ No input field found, trying to interact with wrapper element...`);
    try {
      // Try to click the element first to activate it
      await fieldElement.click();
      await page.waitForTimeout(500);
      
      // Try to type the date directly
      await fieldElement.press('Control+a'); // Select all existing content
      await page.keyboard.type(dateValue);
      await fieldElement.press('Enter');
      console.log(`   ┗ ✅ Successfully set date via typing: ${dateValue}`);
    } catch (directError) {
      console.log(`   ┗ ❌ Error setting date directly: ${directError.message}`);
    }
  }
}

/**
 * Handle effective start date revision by setting it to today's date
 */
async function handleEffectiveStartDateRevision(page, question) {
  try {
    console.log(`📅 [Revision] Processing effectiveStartDate field for course revision...`);
    
    // Find the effective start date field
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find effectiveStartDate field for revision`);
      return;
    }
    
    console.log(`   ┗ ✅ Found effectiveStartDate field for revision`);
    
    // Generate today's date in the format "Aug 19, 2025"
    const today = new Date();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[today.getMonth()];
    const day = today.getDate();
    const year = today.getFullYear();
    const todayFormatted = `${month} ${day}, ${year}`;
    
    console.log(`   ┣ Setting effectiveStartDate to today: ${todayFormatted}`);
    
    // Look for actual input field within the element (could be nested)
    const inputField = fieldElement.locator('input[type="text"], input[type="date"], input').first();
    const inputCount = await inputField.count();
    
    if (inputCount > 0) {
      try {
        console.log(`   ┣ Found input field, attempting to fill with: ${todayFormatted}`);
        await inputField.clear();
        await inputField.fill(todayFormatted);
        await page.waitForTimeout(500);
        await inputField.press('Enter'); // Close any date picker
        console.log(`   ┗ ✅ Successfully set effectiveStartDate to ${todayFormatted}`);
      } catch (inputError) {
        console.log(`   ┣ Input field fill failed, trying direct typing...`);
        try {
          await inputField.click();
          await inputField.press('Control+a'); // Select all
          await page.keyboard.type(todayFormatted);
          await inputField.press('Enter');
          console.log(`   ┗ ✅ Successfully typed effectiveStartDate: ${todayFormatted}`);
        } catch (typeError) {
          console.log(`   ┗ ❌ Error typing effectiveStartDate: ${typeError.message}`);
        }
      }
    } else {
      console.log(`   ┣ No input field found, trying to interact with wrapper element...`);
      try {
        // Try to click the element first to activate it
        await fieldElement.click();
        await page.waitForTimeout(500);
        
        // Try to type the date directly
        await fieldElement.press('Control+a'); // Select all existing content
        await page.keyboard.type(todayFormatted);
        await fieldElement.press('Enter');
        console.log(`   ┗ ✅ Successfully set effectiveStartDate via typing: ${todayFormatted}`);
      } catch (directError) {
        console.log(`   ┗ ❌ Error setting effectiveStartDate directly: ${directError.message}`);
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleEffectiveStartDateRevision: ${error.message}`);
  }
}

/**
 * Handle effective end date by setting it to today's date
 */
async function handleEffectiveEndDateInactivation(page, question) {
  try {
    console.log(`📅 [Inactivation] Processing effectiveEndDate field for course inactivation...`);
    
    // Find the effective end date field
    let fieldElement = await findFieldElement(page, question);
    
    if (!fieldElement) {
      console.log(`   ┗ ❌ Could not find effectiveEndDate field for inactivation`);
      return;
    }
    
    console.log(`   ┗ ✅ Found effectiveEndDate field for inactivation`);
    
    // Generate today's date in the format "Aug 19, 2025"
    const today = new Date();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[today.getMonth()];
    const day = today.getDate();
    const year = today.getFullYear();
    const todayFormatted = `${month} ${day}, ${year}`;
    
    console.log(`   ┣ Setting effectiveEndDate to today: ${todayFormatted}`);
    
    // Look for actual input field within the element (could be nested)
    const inputField = fieldElement.locator('input[type="text"], input[type="date"], input').first();
    const inputCount = await inputField.count();
    
    if (inputCount > 0) {
      try {
        console.log(`   ┣ Found input field, attempting to fill with: ${todayFormatted}`);
        await inputField.clear();
        await inputField.fill(todayFormatted);
        await page.waitForTimeout(500);
        await inputField.press('Enter'); // Close any date picker
        console.log(`   ┗ ✅ Successfully set effectiveEndDate to ${todayFormatted}`);
      } catch (inputError) {
        console.log(`   ┣ Input field fill failed, trying direct typing...`);
        try {
          await inputField.click();
          await inputField.press('Control+a'); // Select all
          await page.keyboard.type(todayFormatted);
          await inputField.press('Enter');
          console.log(`   ┗ ✅ Successfully typed effectiveEndDate: ${todayFormatted}`);
        } catch (typeError) {
          console.log(`   ┗ ❌ Error typing effectiveEndDate: ${typeError.message}`);
        }
      }
    } else {
      console.log(`   ┣ No input field found, trying to interact with wrapper element...`);
      try {
        // Try to click the element first to activate it
        await fieldElement.click();
        await page.waitForTimeout(500);
        
        // Try to type the date directly
        await fieldElement.press('Control+a'); // Select all existing content
        await page.keyboard.type(todayFormatted);
        await fieldElement.press('Enter');
        console.log(`   ┗ ✅ Successfully set effectiveEndDate via typing: ${todayFormatted}`);
      } catch (directError) {
        console.log(`   ┗ ❌ Error setting effectiveEndDate directly: ${directError.message}`);
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleEffectiveEndDateInactivation: ${error.message}`);
  }
}

/**
 * Helper function to find field element using existing strategies
 */
async function findFieldElement(page, question) {
  // Strategy 1: By data-test attribute
  const dataTestSelectors = [
    `[data-test="${question.qid}"]`,
    `[data-test="${question.dataKey}"]`,
    `input[data-test="${question.qid}"]`,
    `select[data-test="${question.qid}"]`,
    `textarea[data-test="${question.qid}"]`,
    `.multiselect[data-test="${question.qid}"]`,
    `div[data-test="${question.qid}"] .multiselect`
  ];
  
  for (const selector of dataTestSelectors) {
    const element = page.locator(selector).first();
    if (await element.count() > 0) {
      const isVisible = await element.isVisible().catch(() => false);
      const isEnabled = await element.isEnabled().catch(() => true);
      
      if (isVisible && isEnabled) {
        return element;
      }
    }
  }
  
  // Strategy 2: By field ID (improved to find actual input within container)
  const idSelectors = [
    `#field-${question.qid}`,
    `#field_${question.qid}`,
    `#field-${question.qid} input`,
    `#field-${question.qid} select`,
    `#field-${question.qid} textarea`,
    `#field-${question.qid} .multiselect__input`,
    `[id="field-${question.qid}"] input`,
    `[id="field-${question.qid}"] select`,
    `[id="field-${question.qid}"] textarea`,
    `[id="field-${question.qid}"] .multiselect__input`
  ];
  
  for (const selector of idSelectors) {
    const element = page.locator(selector).first();
    if (await element.count() > 0) {
      const isVisible = await element.isVisible().catch(() => false);
      const isEnabled = await element.isEnabled().catch(() => true);
      
      if (isVisible && isEnabled) {
        return element;
      }
    }
  }
  
  return null;
}

/**
 * Fill Yes/No button fields by selecting the opposite of the currently selected value
 */
async function fillYesNoButtons(page, fieldElement, question) {
  try {
    const qid = question.qid;
    
    // Look for Yes/No buttons in the parent wrapper
    const wrapper = fieldElement.locator('..');
    const yesButton = wrapper.locator('button[data-test="YesBtn"]');
    const noButton = wrapper.locator('button[data-test="NoBtn"]');
    
    const yesCount = await yesButton.count();
    const noCount = await noButton.count();
    
    if (yesCount === 0 || noCount === 0) {
      console.log(`   ┗ ⚠️ Yes/No buttons not found for ${qid} (Yes: ${yesCount}, No: ${noCount})`);
      return;
    }
    
    console.log(`   ┣ 🔘 Processing Yes/No buttons for ${qid}`);
    
    // Check which button is currently selected (has btn-raised class)
    const yesClass = await yesButton.first().getAttribute('class') || '';
    const noClass = await noButton.first().getAttribute('class') || '';
    
    const isYesSelected = yesClass.includes('btn-raised');
    const isNoSelected = noClass.includes('btn-raised');
    
    console.log(`   ┣ Current state - Yes selected: ${isYesSelected}, No selected: ${isNoSelected}`);
    
    // Determine which button to click (opposite of current selection)
    let buttonToClick = null;
    let buttonToClickName = '';
    
    if (isYesSelected && !isNoSelected) {
      // Yes is selected, click No
      buttonToClick = noButton.first();
      buttonToClickName = 'No';
    } else if (isNoSelected && !isYesSelected) {
      // No is selected, click Yes
      buttonToClick = yesButton.first();
      buttonToClickName = 'Yes';
    } else if (!isYesSelected && !isNoSelected) {
      // Neither is selected, click Yes by default
      buttonToClick = yesButton.first();
      buttonToClickName = 'Yes';
    } else {
      // Both appear selected (unusual case), click No
      buttonToClick = noButton.first();
      buttonToClickName = 'No';
    }
    
    // Check if the button to click is visible and enabled
    const isVisible = await buttonToClick.isVisible();
    const isEnabled = await buttonToClick.isEnabled();
    
    if (!isVisible) {
      console.log(`   ┗ 👁️ ${buttonToClickName} button for ${qid} not visible, skipping.`);
      return;
    }
    
    if (!isEnabled) {
      console.log(`   ┗ 🔒 ${buttonToClickName} button for ${qid} not enabled, skipping.`);
      return;
    }
    
    // Click the opposite button
    try {
      await buttonToClick.click();
      console.log(`   ┗ ✅ Clicked ${buttonToClickName} button for ${qid} (selecting opposite value)`);
    } catch (clickError) {
      console.log(`   ┗ ❌ Failed to click ${buttonToClickName} button for ${qid}: ${clickError.message}`);
    }
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling Yes/No buttons ${question.qid}: ${error.message}`);
  }
}

/**
 * Fill a multiselect dropdown by selecting the first available option
 * Similar to logic from sectionTemplateFill.js
 */
async function fillMultiselectDropdown(page, fieldElement, question, action = 'updateCourse') {
  try {
    const qid = question.qid;
    
    // Find the multiselect wrapper
    const wrapper = fieldElement.locator('..').locator('.multiselect, [class*="multiselect"]').first();
    
    if (await wrapper.count() === 0) {
      console.log(`   ┗ ⚠️ No multiselect wrapper found for ${qid}`);
      return;
    }
    
    // Check if multiselect is disabled
    const multiselectClass = await wrapper.getAttribute('class');
    if (multiselectClass && multiselectClass.includes('multiselect--disabled')) {
      console.log(`   ┗ 🚫 Multiselect for ${qid} is disabled, skipping.`);
      return;
    }
    
    // Check if multiselect is visible and enabled
    const isVisible = await wrapper.isVisible();
    const isEnabled = await wrapper.isEnabled();
    
    if (!isVisible) {
      console.log(`   ┗ 👁️ Multiselect for ${qid} not visible, skipping.`);
      return;
    }
    
    if (!isEnabled) {
      console.log(`   ┗ 🔒 Multiselect for ${qid} not enabled, skipping.`);
      return;
    }
    
    console.log(`   ┣ 🔽 Processing multiselect for ${qid}`);
    
    // If single-select and has existing value, clear it first to allow a new selection
    const isSingleSelect = await wrapper.locator('.multiselect__tag').count().then(c => c <= 1);
    const existingSingle = wrapper.locator('.multiselect__tag');
    const existingCount = await existingSingle.count();
    if (existingCount > 0 && isSingleSelect) {
      console.log(`   ┣ Clearing existing selection for ${qid} to set a new value...`);
      try {
        // Try clicking the tag remove icon
        const removeIcon = existingSingle.first().locator('.multiselect__tag-icon');
        if (await removeIcon.count() > 0) {
          await removeIcon.first().click({ timeout: 1500 });
          await page.waitForTimeout(400);
        }
      } catch (_) {}
    }
    
    try {
      // Click to open the multiselect
      await wrapper.click();
      await page.waitForTimeout(1000); // Wait for dropdown to render

      // Detect empty dropdowns rendered globally (portaled), not just scoped to wrapper
      try {
        const dropdowns = page.locator('.multiselect__content-wrapper');
        const ddCount = await dropdowns.count();
        let isEmptyMapping = false;
        for (let i = ddCount - 1; i >= 0; i--) {
          const dd = dropdowns.nth(i);
          const vis = await dd.isVisible().catch(() => false);
          if (!vis) continue;
          const emptyMsg = dd.locator('.multiselect__option', { hasText: 'List is empty.' });
          const noFoundMsg = dd.locator('.multiselect__option', { hasText: 'No elements found' });
          const emptyVisible = (await emptyMsg.count()) > 0 && await emptyMsg.first().isVisible().catch(() => false);
          const noFoundVisible = (await noFoundMsg.count()) > 0 && await noFoundMsg.first().isVisible().catch(() => false);
          const realOptions = dd.locator('li:not(.option--disabled):not(.multiselect__option--disabled), [role="option"]:not([aria-disabled="true"])');
          const realCount = await realOptions.count().catch(() => 0);
          if (emptyVisible || noFoundVisible || realCount === 0) { isEmptyMapping = true; break; }
        }
        if (isEmptyMapping) {
          const q = (question && question.qid) ? question.qid : 'unknown-field';
          const reason = 'Skipped: Empty attribute mappings (List is empty drop down)';
          console.log(`   ┗ 🚫 ${q} dropdown shows empty mapping — skipping field`);
          recordSkipReason(q, reason);
          await page.keyboard.press('Escape').catch(() => {});
          return;
        }
      } catch (_) {}
      
      // Universal remote-loading. For departments, retry letters if "No departments found" is shown
      const inputBox = wrapper.locator('.multiselect__input');
      if (await inputBox.count() > 0) {
        try {
          const inputStyle = await inputBox.first().getAttribute('style') || '';
          if (inputStyle.includes('width: 0px')) {
            console.log(`   ┣ Input box for multiselect ${qid} has width 0px, clicking to focus...`);
            await wrapper.click();
            await page.waitForTimeout(200);
          }
          const placeholderText = (await inputBox.first().getAttribute('placeholder') || '').trim();
          const shouldType = placeholderText && /type|search/i.test(placeholderText);
          if (shouldType) {
            console.log(`   ┣ Multiselect ${qid} input placeholder indicates typing: "${placeholderText}"`);
            // Build randomized fallback alphabet order
            const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
            for (let i = letters.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [letters[i], letters[j]] = [letters[j], letters[i]];
            }
            // Preferred set, randomized order per run
            const preferred = ['a','c','d','e','m','s','p'];
            for (let i = preferred.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [preferred[i], preferred[j]] = [preferred[j], preferred[i]];
            }
            const tried = new Set();
            const tryLetter = async (ch) => {
              console.log(`   ┃ Trying letter "${ch}" in multiselect input for ${qid}...`);
              await inputBox.first().fill(ch);
              await page.waitForTimeout(1200);
              const noResults = page.locator('.multiselect__option', { hasText: 'No departments found' });
              const noResVisible = (await noResults.count()) > 0 && await noResults.first().isVisible().catch(() => false);
              // Also verify if there are any real option elements rendered besides the no-results item
              const realOptions = page.locator('.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled)');
              const realCount = await realOptions.count();
              if (noResVisible) {
                console.log(`   ┃ No departments found for letter "${ch}" in ${qid}.`);
              }
              if (realCount === 0) {
                console.log(`   ┃ No real options found for letter "${ch}" in ${qid}.`);
              }
              if (noResVisible || realCount === 0) {
                return false; // need another letter
              }
              console.log(`   ┃ Options found for letter "${ch}" in ${qid}.`);
              return true;
            };

            let success = false;
            // Try preferred set first
            for (const ch of preferred) {
              if (tried.has(ch)) continue; tried.add(ch);
              success = await tryLetter(ch);
              if (success) {
                console.log(`   ┣ Found options for ${qid} using preferred letter "${ch}".`);
                break;
              } else {
                await inputBox.first().fill('');
                await page.waitForTimeout(300);
              }
            }
            // Try remaining random letters if still no results
            if (!success) {
              for (const ch of letters) {
                if (tried.has(ch)) continue; tried.add(ch);
                success = await tryLetter(ch);
                if (success) {
                  console.log(`   ┣ Found options for ${qid} using fallback letter "${ch}".`);
                  break;
                } else {
                  await inputBox.first().fill('');
                  await page.waitForTimeout(250);
                }
              }
            }
            if (!success) {
          console.log(`   ┗ 🚫 No options found for multiselect ${qid} after trying all letters.`);
          recordSkipReason(qid, 'Skipped: No attribute mappings found');
            }
          } else {
            console.log(`   ┣ Multiselect ${qid} input placeholder does not indicate typing (placeholder: "${placeholderText}"). Skipping letter typing.`);
          }
        } catch (err) {
          console.log(`   ┗ ⚠️ Error while trying to remote-load options for multiselect ${qid}: ${err && err.message ? err.message : err}`);
        }
      } else {
        console.log(`   ┣ No input box found for multiselect ${qid}.`);
      }
      
      // Check for options
      const options = page.locator('.multiselect__content-wrapper li, [role="option"]');
      const optionCount = await options.count();
      
      if (optionCount === 0) {
        console.log(`   ┗ 🚫 Multiselect for ${qid} has no options, skipping.`);
        recordSkipReason(qid, 'Skipped: Empty attribute mappings (List is empty drop down)');
        return;
      }

      // If only placeholders/disabled entries exist, treat as empty mapping
      try {
        const dd = page.locator('.multiselect__content-wrapper');
        const realOptions = dd.locator('li:not(.option--disabled):not(.multiselect__option--disabled), [role="option"]:not([aria-disabled="true"])');
        const realCount = await realOptions.count().catch(() => 0);
        if (realCount === 0) {
          recordSkipReason(qid, 'Skipped: Empty attribute mappings (List is empty drop down)');
          await page.keyboard.press('Escape').catch(() => {});
          return;
        }
      } catch (_) {}
      
      let selected = false;

      // Prefer non-disabled, non-selected options; choose randomly among them
      const candidateOptions = page.locator(
        '.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled):not(.option--selected):not(.multiselect__option--selected), ' +
        '[role="option"]:not([aria-disabled="true"]):not([aria-selected="true"])'
      );
      const candidateCount = await candidateOptions.count();

      const pool = candidateCount > 0 ? candidateOptions : options; // fallback to all options if filtering finds none
      const poolCount = candidateCount > 0 ? candidateCount : optionCount;

      // Build a randomized order of indices to try
      const indices = Array.from({ length: poolCount }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      for (let k = 0; k < indices.length; k++) {
        const idx = indices[k];
        const option = pool.nth(idx);
        const isVisible = await option.isVisible().catch(() => false);
        if (!isVisible) continue;
        try {
          // Skip "No departments found" placeholder rows
          try {
            const txt = (await option.textContent()) || '';
            if (txt.trim().toLowerCase().includes('no departments found')) {
              continue;
            }
          } catch (_) {}
          await option.click({ timeout: 1000 });
          console.log(`   ┗ ✅ Selected option index ${idx + 1} for multiselect ${qid}`);
          selected = true;
          break;
        } catch (_) {
          try {
            await option.click({ force: true, timeout: 1000 });
            console.log(`   ┗ ✅ Selected option (force) index ${idx + 1} for multiselect ${qid}`);
            selected = true;
            break;
          } catch (_) {
            continue;
          }
        }
      }
      
      if (!selected) {
        console.log(`   ┗ 🚫 Multiselect for ${qid} has options, but none are visible/selectable. Skipping.`);
        recordSkipReason(qid, 'Skipped: Options not selectable');
      }
      
    } catch (err) {
      console.log(`   ┗ ❌ Couldn't click multiselect for ${qid}, skipping. Reason: ${err.message}`);
      recordSkipReason(qid, `Skipped: ${err && err.message ? err.message : 'Unknown error'}`);
    }
    
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling multiselect dropdown ${question.qid}: ${error.message}`);
    try { recordSkipReason((question && question.qid) || 'unknown-field', `Skipped: ${error.message}`); } catch (_) {}
  }
}

/**
 * Get the current value of a field
 * @param {Object} fieldElement - The field element to check
 * @param {Object} question - Question configuration
 * @returns {string|number|boolean|null} - Current field value or null if can't be determined
 */
async function getFieldValue(fieldElement, question) {
  try {
    const questionType = question.questionType || question.type;
    
    switch (questionType) {
      case 'text':
      case 'textarea':
      case 'number':
        {
          // For contenteditable (WYSIWYG), inputValue won't work
          const isCE = await fieldElement.getAttribute('contenteditable').catch(() => null);
          if (isCE === 'true') {
            const text = await fieldElement.textContent().catch(() => '');
            return text && text.trim() !== '' ? text.trim() : null;
          }
          const inputValue = await fieldElement.inputValue().catch(() => '');
          return inputValue || null;
        }
        
      case 'select':
      case 'dropdown':
      case 'multiselect':
      case 'gradeModesMultiSelect':
        // Check for selected options in multiselect
        const parentDiv = fieldElement.locator('..');
        const selectedTags = parentDiv.locator('.multiselect__tag, .multiselect__single');
        const tagCount = await selectedTags.count();
        if (tagCount > 0) {
          // Check if any tag has actual content (not placeholder)
          for (let i = 0; i < tagCount; i++) {
            const tagText = await selectedTags.nth(i).textContent();
            if (tagText && tagText.trim() !== '' && !tagText.includes('Select')) {
              return tagText.trim();
            }
          }
        }
        return null;
        
      case 'checkbox':
      case 'boolean':
        return await fieldElement.isChecked().catch(() => null);
        
      default:
        {
          const isCE = await fieldElement.getAttribute('contenteditable').catch(() => null);
          if (isCE === 'true') {
            const text = await fieldElement.textContent().catch(() => '');
            return text && text.trim() !== '' ? text.trim() : null;
          }
          const value = await fieldElement.inputValue().catch(() => '');
          return value || null;
        }
    }
  } catch (error) {
    return null; // Return null if we can't get the value
  }
}

/**
 * Check if a field already has a value
 * @param {Object} fieldElement - The field element to check
 * @param {Object} question - Question configuration
 * @returns {boolean} - True if field has a value
 */
async function checkFieldHasValue(fieldElement, question) {
  try {
    const questionType = question.questionType || question.type;
    
    switch (questionType) {
      case 'text':
      case 'textarea':
      case 'number':
        {
          const isCE = await fieldElement.getAttribute('contenteditable').catch(() => null);
          if (isCE === 'true') {
            const text = await fieldElement.textContent().catch(() => '');
            return text && text.trim() !== '';
          }
          const inputValue = await fieldElement.inputValue().catch(() => '');
          return inputValue && inputValue.trim() !== '';
        }
        
      case 'select':
      case 'dropdown':
      case 'multiselect':
      case 'gradeModesMultiSelect':
        // Check for selected options in multiselect
        const parentDiv = fieldElement.locator('..');
        const selectedTags = parentDiv.locator('.multiselect__tag, .multiselect__single');
        const tagCount = await selectedTags.count();
        if (tagCount > 0) {
          // Check if any tag has actual content (not placeholder)
          for (let i = 0; i < tagCount; i++) {
            const tagText = await selectedTags.nth(i).textContent();
            if (tagText && tagText.trim() !== '' && !tagText.includes('Select')) {
              return true;
            }
          }
        }
        return false;
        
      case 'checkbox':
      case 'boolean':
        return await fieldElement.isChecked().catch(() => false);
        
      default:
        {
          const isCE = await fieldElement.getAttribute('contenteditable').catch(() => null);
          if (isCE === 'true') {
            const text = await fieldElement.textContent().catch(() => '');
            return text && text.trim() !== '';
          }
          const value = await fieldElement.inputValue().catch(() => '');
          return value && value.trim() !== '';
        }
    }
  } catch (error) {
    return false; // Assume no value if we can't check
  }
}

/**
 * Check if a field is in loading state
 * @param {Object} page - Playwright page object
 * @param {Object} fieldElement - The field element to check
 * @returns {boolean} - True if field is loading
 */
async function checkFieldIsLoading(page, fieldElement) {
  try {
    // Check for spinners in the field or its parent
    const parentDiv = fieldElement.locator('..');
    const spinners = parentDiv.locator('.multiselect__spinner, .spinner, .loading, [class*="spinner"], [class*="loading"]');
    const spinnerCount = await spinners.count();
    
    if (spinnerCount > 0) {
      // Check if any spinner is visible
      for (let i = 0; i < spinnerCount; i++) {
        const isVisible = await spinners.nth(i).isVisible().catch(() => false);
        if (isVisible) {
          return true;
        }
      }
    }
    
    // Do not check for tooltips/overlays
    
    return false;
  } catch (error) {
    return false; // Assume not loading if we can't check
  }
}

/**
 * Pre-fill any visible required fields that are currently empty
 * This scans labels that include a red "required" badge and attempts to find
 * the associated control. If empty, it fills a safe default based on type.
 * @param {Object} page - Playwright page object
 */
async function preFillRequiredEmptyFields(page) {
  try {
    console.log('🔎 Checking for empty required fields before save...');

    // Protected qids that must never be auto-filled during update/save
    const protectedQids = new Set([
      'subjectCode',
      'courseNumber',
      'sisId',
      'status',
      'effectiveStartDate',
      'effectiveEndDate',
      'crsApprovalDate',
      'crsStatusDate',
      'crsApprovalAgencyIds',
      'allowIntegration'
    ]);

    // Helper to get first visible & enabled element from a list of selectors
    const getFirstUsable = async (base) => {
      for (const sel of base) {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0) {
          const visible = await el.isVisible().catch(() => false);
          const enabled = await el.isEnabled().catch(() => true);
          if (visible && enabled) return el;
        }
      }
      return null;
    };

    // Helper to check if control has a value
    const controlIsEmpty = async (el) => {
      try {
        const tag = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
        const cls = (await el.getAttribute('class')) || '';
        const role = await el.getAttribute('role');

        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const v = await el.inputValue().catch(() => '');
          return !(v && v.trim() !== '');
        }

        if (cls.includes('multiselect') || role === 'combobox' || role === 'listbox') {
          const parent = el.locator('..');
          const selectedTags = parent.locator('.multiselect__tag, .multiselect__single');
          const count = await selectedTags.count();
          if (count > 0) {
            for (let i = 0; i < count; i++) {
              const txt = await selectedTags.nth(i).textContent();
              if (txt && txt.trim() !== '' && !txt.includes('Select')) return false;
            }
          }
          return true;
        }

        // Try nested input as fallback
        const nested = el.locator('input, textarea, select').first();
        if ((await nested.count()) > 0) {
          const v = await nested.inputValue().catch(() => '');
          return !(v && v.trim() !== '');
        }

        return true;
      } catch (_) {
        return false;
      }
    };

    // Helper to fill based on element structure
    const fillControl = async (el) => {
      const tag = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
      const cls = (await el.getAttribute('class')) || '';
      const typeAttr = (await el.getAttribute('type')) || '';
      const role = await el.getAttribute('role');

      // Try multiselect/select-like first
      if (cls.includes('multiselect') || role === 'combobox' || role === 'listbox') {
        try {
          await fillSelectField(page, el, 'auto-select', { qid: 'prefill' });
          return true;
        } catch (_) {}
      }

      if (tag === 'select') {
        try {
          await fillSelectField(page, el, 'auto-select', { qid: 'prefill' });
          return true;
        } catch (_) {}
      }

      if (tag === 'textarea') {
        await fillTextAreaField(page, el, 'Auto-filled to proceed - Coursedog test');
        return true;
      }

      if (tag === 'input') {
        if (typeAttr === 'number') {
          await fillNumberField(page, el, 1);
          return true;
        }
        if (typeAttr === 'date') {
          const today = new Date();
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
          await fillDateField(page, el, formatted);
          return true;
        }
        await fillTextField(page, el, 'Auto-filled to proceed - Coursedog test');
        return true;
      }

      // Date picker wrappers
      if (cls.includes('date') || cls.includes('datepicker') || cls.includes('date-picker')) {
        const today = new Date();
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
        await fillDateField(page, el, formatted);
        return true;
      }

      // Fallback: try nested input
      const nested = el.locator('input, textarea, select').first();
      if ((await nested.count()) > 0) {
        const nestedTag = await nested.evaluate(n => n.tagName.toLowerCase()).catch(() => '');
        if (nestedTag === 'textarea') {
          await fillTextAreaField(page, nested, 'Auto-filled to proceed - Coursedog test');
        } else if (nestedTag === 'select') {
          await fillSelectField(page, nested, 'auto-select', { qid: 'prefill' });
        } else {
          const nestedType = (await nested.getAttribute('type')) || '';
          if (nestedType === 'number') {
            await fillNumberField(page, nested, 1);
          } else if (nestedType === 'date') {
            const today = new Date();
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
            await fillDateField(page, nested, formatted);
          } else {
            await fillTextField(page, nested, 'Auto-filled to proceed - Coursedog test');
          }
        }
        return true;
      }

      return false;
    };

    const requiredLabels = page.locator('label:has(.badge.badge-danger), label:has-text("required")');
    const count = await requiredLabels.count();
    let filled = 0;

    for (let i = 0; i < count; i++) {
      const label = requiredLabels.nth(i);
      const forAttr = await label.getAttribute('for');

      let control = null;
      if (forAttr) {
        control = await getFirstUsable([
          `#${forAttr}`,
          `#${forAttr} input`,
          `#${forAttr} select`,
          `#${forAttr} textarea`,
          `#${forAttr} .multiselect`,
          `#${forAttr} [role="combobox"]`,
          `#${forAttr} [role="listbox"]`
        ]);
      }

      if (!control) {
        // Search nearby within the same container
        control = await getFirstUsable([
          'xpath=following::*[self::input or self::select or self::textarea or contains(@class, "multiselect") or @role="combobox" or @role="listbox"][1]'
        ]);
      }

      if (!control) continue;

      // Identify the closest data-test wrapper/qid to honor protected fields
      let qid = null;
      try {
        const wrapperWithDataTest = control.locator('xpath=ancestor-or-self::*[@data-test][1]').first();
        if ((await wrapperWithDataTest.count()) > 0) {
          qid = await wrapperWithDataTest.getAttribute('data-test');
        }
      } catch (_) {}
      if (qid && protectedQids.has(qid)) {
        console.log(`   ┗ ⏭️ Prefill skip for protected field: ${qid}`);
        continue;
      }

      // Skip if it already has a value
      const empty = await controlIsEmpty(control);
      if (!empty) continue;

      // Try to make visible if needed
      try { await control.scrollIntoViewIfNeeded(); } catch (_) {}

      try {
        const ok = await fillControl(control);
        if (ok) filled++;
      } catch (_) {}
    }

    console.log(`✅ Pre-filled ${filled} required field(s) before save`);
  } catch (error) {
    console.log(`⚠️ Error during preFillRequiredEmptyFields: ${error.message}`);
  }
}

/**
 * Fill field based on its type and question configuration
 * @param {Object} page - Playwright page object
 * @param {Object} fieldElement - The field element to fill
 * @param {Object} question - Question configuration from template
 * @param {*} testValue - Value to fill
 */
async function fillFieldByType(page, fieldElement, question, testValue) {
  const questionType = question.questionType || question.type;
  
  // Check if field is disabled
  const isDisabled = await fieldElement.isDisabled().catch(() => false);
  if (isDisabled) {
    console.log(`   ┗ ⏭️ Field is disabled, skipping`);
    return;
  }
  
  try {
    switch (questionType) {
      case 'text':
        await fillTextField(page, fieldElement, testValue);
        break;
        
      case 'textarea':
        await fillTextAreaField(page, fieldElement, testValue);
        break;

      case 'wysiwyg':
        await fillWysiwygField(page, fieldElement, testValue);
        break;
        
      case 'number':
        await fillNumberField(page, fieldElement, testValue);
        break;
        
      case 'courseNumber':
        await fillTextField(page, fieldElement, testValue);
        break;
        
      case 'select':
      case 'dropdown': {
        const t0 = Date.now();
        await fillSelectField(page, fieldElement, testValue, question);
        const elapsed = Date.now() - t0;
        if (elapsed > 3000) {
          console.log(`   ┗ ⏱️ Select handling took ${elapsed}ms for ${question.qid}`);
        }
        break;
      }
        
      case 'multiselect': {
        const t0 = Date.now();
        await fillMultiSelectField(page, fieldElement, testValue, question);
        const elapsed = Date.now() - t0;
        if (elapsed > 3000) {
          console.log(`   ┗ ⏱️ Multiselect handling took ${elapsed}ms for ${question.qid}`);
        }
        break;
      }
        
      case 'date':
        await fillDateField(page, fieldElement, testValue);
        break;
        
      case 'checkbox':
      case 'boolean':
        await fillCheckboxField(page, fieldElement, testValue);
        break;
        
      case 'components':
        // Special handling for course components
        await fillComponentsField(page, fieldElement, testValue);
        break;

      // Removed special-case handling for 'instructionalMethods' to avoid double writes; handled via fillSubfieldsFromConfig
        
      case 'gradeModesMultiSelect':
        // Special handling for grade modes multiselect (often has existing values)
        await fillSelectField(page, fieldElement, testValue, question);
        break;
        
      case 'yesNo':
        // Special handling for yesNo input type (used in Jenzabar credits fields)
        await fillYesNoField(page, fieldElement, testValue, question);
        break;
        
      default:
        // Default to text field
        await fillTextField(page, fieldElement, testValue);
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling field of type ${questionType}: ${error.message}`);
  }
}

/**
 * Generate a test value based on question configuration
 * @param {Object} question - Question configuration from template
 * @param {string|null} existingValue - Existing field value if any
 * @returns {string|number|boolean} - Generated test value
 */
function generateCourseTestValue(question, existingValue = null) {
  // Section-style value policy: prefer appending "-CDtest" to existing values,
  // use deterministic numbers/dates, avoid randomization.
  const questionType = question.questionType || question.type;
  const qid = question.qid;
  const label = question.label || '';
  // Read optional max length from template config validations
  let configuredMaxLength = null;
  try {
    const maybe = question && question.config && question.config.validations && question.config.validations.maxLength;
    if (typeof maybe === 'number' && Number.isFinite(maybe) && maybe > 0) {
      configuredMaxLength = Math.floor(maybe);
    }
  } catch (_) {}
  const clampToMax = (value) => {
    if (configuredMaxLength && typeof value === 'string') {
      return value.length > configuredMaxLength ? value.slice(0, configuredMaxLength) : value;
    }
    return value;
  };

  switch (questionType) {
    case 'wysiwyg':
      if (existingValue && String(existingValue).trim() !== '') {
        const base = String(existingValue).trim().replace(/(?:-\s*CDtest)+$/i, '');
        return `${base} -CDtest`;
      }
      return 'Automated test description -CDtest';

    case 'text':
      if (existingValue && String(existingValue).trim() !== '') {
        const base = String(existingValue).trim().replace(/(?:-\s*CDtest)+$/i, '');
        const appended = `${base}-CDtest`;
        // Only clamp when an explicit configured max length exists
        if (configuredMaxLength) {
          return clampToMax(appended);
        }
        return appended;
      }
      // New value when empty
      if (qid === 'name' || /short\s*title/i.test(label)) {
        const v = 'Test Course -CDtest';
        return configuredMaxLength ? clampToMax(v) : v;
      }
      if (qid === 'longName' || /long\s*title/i.test(label)) {
        const v = 'Test Course Long Title -CDtest';
        return clampToMax(v);
      }
      return clampToMax('Test -CDtest');

    case 'textarea':
      if (existingValue && String(existingValue).trim() !== '') {
        const trimmed = String(existingValue).trim();
        // Avoid multiple suffixes across runs
        const deduped = trimmed.replace(/(?:-\s*CDtest)+$/i, '');
        // Also guard against embedded repeated spaces/dashes
        const once = `${deduped}-CDtest`;
        return clampToMax(once);
      }
      if (qid === 'description' || /description/i.test(label)) {
        return clampToMax('Automated test description -CDtest');
      }
      return clampToMax('Test description -CDtest');

    case 'number':
      // Keep nested credit fields deterministic
      if (question.originalFieldType && question.originalSubFieldKey) {
        const sub = question.originalSubFieldKey;
        if (sub === 'min') return 2;
        if (sub === 'max') return 5;
        if (sub === 'value') return 3;
        return 1;
      }
      if (qid === 'duration') return 15;
      return 15;

    case 'courseNumber':
      return 112; // deterministic 3-digit-like example similar to section policy of fixed numbers

    case 'date': {
      const today = new Date();
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = monthNames[today.getMonth()];
      const day = today.getDate();
      const year = today.getFullYear();
      return `${month} ${day}, ${year}`;
    }

    case 'checkbox':
    case 'boolean':
    case 'yesNo':
      return true;

    case 'select':
    case 'dropdown':
    case 'multiselect':
    case 'components':
      return 'auto-select';

    default:
      return 'Test Value -CDtest';
  }
}

/**
 * Derive effective maxLength from template config or DOM attribute
 */
async function getEffectiveMaxLength(page, fieldElement, question) {
  try {
    // ONLY use template-provided validation for text-like fields
    const cfgMax = getConfiguredMaxLength(question);
    if (cfgMax) return cfgMax;

    // Fallback to DOM maxlength attribute only for number inputs
    try {
      const maxAttr = await fieldElement.getAttribute('maxlength');
      const n = maxAttr != null ? parseInt(String(maxAttr), 10) : NaN;
      if (!isNaN(n) && n > 0) return n;
    } catch (_) {}
  } catch (_) {}
  return null;
}

async function inferMaxLengthFromDom(page, fieldElement) {
  // Do not parse DOM hints — too slow and inconsistent.
  return null;
}

async function resolveMaxLength(page, fieldElement, question) {
  // Only use configured template max or simple DOM maxlength; no DOM scraping.
  const maxLen = await getEffectiveMaxLength(page, fieldElement, question);
  return maxLen || null;
}

function getConfiguredMaxLength(question) {
  try {
    const v = question && question.config && question.config.validations && question.config.validations.maxLength;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : null;
  } catch (_) { return null; }
}

/**
 * Get the latest course template file for a school
 * @param {string} schoolId - School identifier
 * @returns {string|null} - Path to the latest template file or null if not found
 */
function getLatestCourseTemplateFile(schoolId) {
  try {
    const resourcesDir = path.join(__dirname, 'Resources');
    if (!fs.existsSync(resourcesDir)) {
      return null;
    }
    
    const files = fs.readdirSync(resourcesDir);
    const courseTemplateFiles = files.filter(file => 
      file.includes(schoolId) && 
      file.includes('courseTemplate') && 
      file.endsWith('.json')
    );
    
    if (courseTemplateFiles.length === 0) {
      return null;
    }
    
    // Sort by date (newest first) based on filename timestamp
    courseTemplateFiles.sort((a, b) => {
      const dateA = a.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      const dateB = b.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      if (dateA && dateB) {
        return dateB[1].localeCompare(dateA[1]);
      }
      return b.localeCompare(a);
    });
    
    return path.join(resourcesDir, courseTemplateFiles[0]);
  } catch (error) {
    console.error('❌ Error finding course template file:', error.message);
    return null;
  }
}

/**
 * Save field differences between before and after values
 * @param {Object} beforeValues - Values before changes
 * @param {Object} afterValues - Values after changes
 * @param {string} subfolder - Output directory
 * @param {string} schoolId - School identifier
 */
async function saveCourseFieldDifferences(beforeValues, afterValues, subfolder, schoolId, action) {
  try {
    ensureRunLogger(subfolder);
    const tableRows = [];
    // Load template once to map qids -> labels
    let labelByQid = {};
    try {
      const tplFile = getLatestCourseTemplateFile(schoolId);
      if (tplFile && fs.existsSync(tplFile)) {
        const tpl = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
        const questions = (tpl && tpl.courseTemplate && tpl.courseTemplate.questions) || {};
        for (const [qid, q] of Object.entries(questions)) {
          if (q && typeof q === 'object') {
            labelByQid[qid] = q.label || '';
          }
        }
      }
    } catch (_) {}
    const allKeys = new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)]);
    // Include disabled and explicitly skipped fields as rows even if not captured as value keys
    try {
      const addDisabled = (obj) => { if (obj && obj._disabledFields) { Object.keys(obj._disabledFields).forEach(k => allKeys.add(k)); } };
      addDisabled(beforeValues);
      addDisabled(afterValues);
      const skipPrim = (global.__courseDiffSkipFields && Array.isArray(global.__courseDiffSkipFields)) ? global.__courseDiffSkipFields : [];
      for (const k of skipPrim) allKeys.add(k);
    } catch (_) {}
    
    // Remove internal meta keys from comparison
    allKeys.delete('_fieldIdentifiers');
    allKeys.delete('_hiddenFields');
    allKeys.delete('_disabledFields');
    
    const skipSet = new Set((global.__courseDiffSkipFields && Array.isArray(global.__courseDiffSkipFields)) ? global.__courseDiffSkipFields : []);

    // Load integrated fields and restrict diffs to SIS-integrated fields for this entity
    let allowedTopLevels = null;
    try {
      const integratedPath = path.join(__dirname, 'integratedFields.json');
      if (fs.existsSync(integratedPath)) {
        const integrated = JSON.parse(fs.readFileSync(integratedPath, 'utf8')) || {};
        const sisKey = Object.keys(integrated)
          .filter(k => typeof k === 'string' && schoolId.endsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        const fields = sisKey && integrated[sisKey] && integrated[sisKey].course;
        if (Array.isArray(fields)) {
          allowedTopLevels = new Set(fields.map(f => String(f).split('.')[0]));
        }
      }
    } catch (_) {}

    // Parse Logs.md to collect per-field error comments (e.g., "Could not find field: ...")
    const commentsByQid = new Map();
    try {
      const logFile = path.join(subfolder, 'Logs.md');
      if (fs.existsSync(logFile)) {
        const logContent = fs.readFileSync(logFile, 'utf8');
        const regex = /Could not find field:\s*([^\(\n]+)\s*\(([^\)]+)\)/g;
        let match;
        while ((match = regex.exec(logContent)) !== null) {
          const rawQid = (match[1] || '').trim();
          const rawLabel = (match[2] || '').trim();
          const msg = `❌ Could not find field: ${rawQid} (${rawLabel})`;
          if (rawQid) {
            commentsByQid.set(rawQid, msg);
            const top = String(rawQid).split('.')[0];
            if (top && !commentsByQid.has(top)) commentsByQid.set(top, msg);
          }
        }
      }
    } catch (_) {}

    for (const key of allKeys) {
      const topLevelQuestionid = String(key).split('.')[0];
      const isDisabled = (beforeValues._disabledFields && beforeValues._disabledFields[topLevelQuestionid]) || (afterValues._disabledFields && afterValues._disabledFields[topLevelQuestionid]);
      const isInSkipSet = skipSet.has(topLevelQuestionid);
      if (allowedTopLevels && !allowedTopLevels.has(topLevelQuestionid) && !isDisabled && !isInSkipSet) continue;
      const isHidden = (beforeValues._hiddenFields && beforeValues._hiddenFields[topLevelQuestionid]) || (afterValues._hiddenFields && afterValues._hiddenFields[topLevelQuestionid]);
      if (isHidden) continue; // per requirement, hide UI-hidden fields entirely
      const rawBefore = beforeValues[key];
      const rawAfter = afterValues[key];
      const beforeValue = rawBefore === undefined ? '' : rawBefore;
      const afterValue = rawAfter === undefined ? '' : rawAfter;

      // Build technical info if available
      let technicalInfo = '';
      if (beforeValues._fieldIdentifiers && beforeValues._fieldIdentifiers[key]) {
        const identifiers = beforeValues._fieldIdentifiers[key];
        if (identifiers.dataTest || identifiers.id) {
          technicalInfo = ` (${identifiers.dataTest || identifiers.id})`;
        }
      } else if (afterValues._fieldIdentifiers && afterValues._fieldIdentifiers[key]) {
        const identifiers = afterValues._fieldIdentifiers[key];
        if (identifiers.dataTest || identifiers.id) {
          technicalInfo = ` (${identifiers.dataTest || identifiers.id})`;
        }
      }
      const changed = !isDeepEqual(rawBefore, rawAfter);
      const status = isDisabled ? '🔒' : (isInSkipSet ? '⏭️' : (changed ? '✅' : '❌'));
      // Include label in parentheses (if top-level qid match)
      const label = labelByQid[topLevelQuestionid] ? ` (${labelByQid[topLevelQuestionid]})` : '';
      const fieldLabel = `${key}${label}${technicalInfo}`;
      const commentParts = [];
      // Include error details from logs only when unable to update
      if (status === '❌') {
        const fromLogs = commentsByQid.get(key) || commentsByQid.get(topLevelQuestionid) || '';
        if (fromLogs) commentParts.push(fromLogs);
      }
      // Only include disabled reason when status indicates disabled
      if (status === '🔒') {
        commentParts.push('Field disabled for editing');
      }
      // Only include skip reasons when status indicates skipped
      if (status === '⏭️') {
        try {
          if (global.__fieldSkipReasons) {
            const direct = global.__fieldSkipReasons[key];
            const top = global.__fieldSkipReasons[topLevelQuestionid];
            const reason = direct || top;
            if (reason) commentParts.push(reason);
          }
        } catch (_) {}
        commentParts.push(`Field set to be skipped for test case: ${action}`);
      }
      // Dedupe and normalize reasons (strip leading "Skipped: ")
      const normalizeReason = (txt) => String(txt || '').replace(/^Skipped:\s*/i, '').trim();
      const unique = [];
      const seen = new Set();
      for (const part of commentParts.filter(Boolean)) {
        const norm = normalizeReason(part);
        if (!norm) continue;
        if (!seen.has(norm)) {
          seen.add(norm);
          unique.push(norm);
        }
      }
      const comment = unique.join('; ');
      tableRows.push(`| ${fieldLabel} | ${JSON.stringify(beforeValue)} | ${JSON.stringify(afterValue)} | ${status} | ${comment}`);
    }

    if (tableRows.length > 0) {
      const header = '| Field | Original | New | Status | Comments |\n| --- | --- | --- | --- | --- |';
      const legend = '⏭️ - Skipped field\n\n✅ - Updated field\n\n🔒 - Disabled field\n\n❌ - Unable to update (other reason)';
      const diffText = `${legend}\n\n${header}\n${tableRows.join('\n')}`;
      console.log('\n=== Course Field Differences (Table) ===\n' + diffText);
      
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      
      const diffFileName = `${schoolId}-${action}-field-differences-${dateStr}.txt`;
      const diffFilePath = path.join(subfolder, diffFileName);
      fs.writeFileSync(diffFilePath, diffText, 'utf8');
      console.log(`💾 Field differences saved to: ${diffFilePath}`);
    } else {
      console.log('\n✅ No field differences detected.');
    }
    
  } catch (error) {
    console.error('❌ Error saving course field differences:', error.message);
  }
}

/**
 * Attempt to save the course with takeover functionality
 * @param {Object} page - Playwright page object
 * @param {string} subfolder - Output directory for screenshots
 * @param {string} schoolId - School identifier
 * @param {Object} browser - Playwright browser object
 * @returns {boolean} - True if save was successful
 */
async function saveCourse(page, subfolder, schoolId, browser = null) {
  try {
    console.log('💾 Attempting to save course...');
    
    // Look for common save button selectors
    const saveSelectors = [
      '[data-test="save-course-btn"]',
      '[data-test="save-btn"]',
      'button:has-text("Save")',
      'button:has-text("SAVE")',
      '.btn-primary:has-text("Save")',
      '.btn-success:has-text("Save")'
    ];
    
    let saveButton = null;
    for (const selector of saveSelectors) {
      const button = page.locator(selector).first();
      if (await button.count() > 0 && await button.isVisible()) {
        saveButton = button;
        console.log(`✅ Found save button with selector: ${selector}`);
        break;
      }
    }
    
    if (!saveButton) {
      console.log('⚠️ No save button found - course changes may not be saved');
      
      // Offer user takeover for missing save button
      if (browser && schoolId) {
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(page, browser, subfolder, 'course-save', schoolId, 'updateCourse', 'No save button found for course', null, true);
          if (takeoverResult.success) {
            if (takeoverResult.sectionSaved) {
              console.log('✅ User intervention successful - course saved manually (modal closed)');
            } else {
              console.log('✅ User intervention successful - course saved manually');
            }
            if (takeoverResult.sectionChanged) {
              console.log('ℹ️ Course/section change detected during intervention');
            }
            return true;
          }
        }
      }
      
      return false;
    }
    
    // Check if save button is disabled
    const isDisabled = await saveButton.getAttribute('disabled') !== null;
    if (isDisabled) {
      console.log('❌ Save button is disabled');
      
      // Offer user takeover for disabled save button
      if (browser && schoolId) {
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(page, browser, subfolder, 'course-save', schoolId, 'updateCourse', 'Save button is disabled', null, true);
          if (takeoverResult.success) {
            if (takeoverResult.sectionSaved) {
              console.log('✅ User intervention successful - course saved manually (modal closed)');
            } else {
              console.log('✅ User intervention successful - course saved manually');
            }
            if (takeoverResult.sectionChanged) {
              console.log('ℹ️ Course/section change detected during intervention');
            }
            return true;
          }
        }
      }
      
      return false;
    }
    
    // Before clicking save, attempt to pre-fill any empty required fields
    try {
      await preFillRequiredEmptyFields(page);
    } catch (_) {}

    // Click the save button
    await saveButton.click();
    console.log('🔄 Save button clicked, checking for immediate form errors...');
    await page.waitForTimeout(1500);

    // Check for specific form errors banner that appears after clicking save
    const formErrorsBanner = page.locator('#form-errors-summary.alert.alert-danger[role="alert"]');
    if ((await formErrorsBanner.count()) > 0 && await formErrorsBanner.first().isVisible()) {
      console.log('❌ Form errors banner detected after save click');
      // Take error screenshot
      const bannerErrorScreenshotPath = path.join(subfolder, `${schoolId}-updateCourse-course-save-error.png`);
      await page.screenshot({ 
        path: bannerErrorScreenshotPath,
        fullPage: true 
      });
      console.log(`📸 Error screenshot saved: ${bannerErrorScreenshotPath}`);
      
      // Offer user takeover so they can correct errors and continue
      if (browser && schoolId) {
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(page, browser, subfolder, 'course-save', schoolId, 'updateCourse', 'Form errors displayed after attempting to save course', null, true);
          if (takeoverResult.success) {
            if (takeoverResult.sectionSaved) {
              console.log('✅ User intervention successful - course saved manually (modal closed)');
            } else {
              console.log('✅ User intervention successful - course saved manually');
            }
            if (takeoverResult.sectionChanged) {
              console.log('ℹ️ Course/section change detected during intervention');
            }
            return true;
          }
        }
      }
      return false;
    }

    // Continue allowing time for other banners to show
    await page.waitForTimeout(2000);
    
    // Explicitly treat green success integration banner as a successful save
    const successSyncBanner = page.locator('[data-test="integrationSyncStatus"].alert-success');
    if ((await successSyncBanner.count()) > 0 && await successSyncBanner.first().isVisible()) {
      console.log('✅ Integration status banner indicates successful sync; treating save as successful');
      return true;
    }

    // Check for any error indicators
    const errorSelectors = [
      '[data-test="integrationSyncStatus"].alert-danger',
      '.alert-danger',
      '.invalid-feedback',
      '.is-invalid'
    ];
    
    for (const errorSelector of errorSelectors) {
      const errorElement = page.locator(errorSelector);
      if (await errorElement.count() > 0 && await errorElement.isVisible()) {
        console.log('❌ Error detected after save attempt');
        
        // Take error screenshot
        const errorScreenshotPath = path.join(subfolder, `${schoolId}-updateCourse-save-error.png`);
        await page.screenshot({ 
          path: errorScreenshotPath,
          fullPage: true 
        });
        console.log(`📸 Error screenshot saved: ${errorScreenshotPath}`);
        
        // Offer user takeover for save errors
        if (browser && schoolId) {
          const userResponse = await waitForUserResponseWithTimeout(5);
          if (userResponse === 'yes') {
            const takeoverResult = await offerUserTakeover(page, browser, subfolder, 'course-save', schoolId, 'updateCourse', 'Error detected after attempting to save course', null, true);
            if (takeoverResult.success) {
              if (takeoverResult.sectionSaved) {
                console.log('✅ User intervention successful - course saved manually (modal closed)');
              } else {
                console.log('✅ User intervention successful - course saved manually');
              }
              if (takeoverResult.sectionChanged) {
                console.log('ℹ️ Course/section change detected during intervention');
              }
              return true;
            }
          }
        }
        
        return false;
      }
    }
    
    console.log('✅ Course appears to have been saved successfully');
    return true;
    
  } catch (error) {
    console.error('❌ Error during course save:', error.message);
    
    // Offer user takeover for unexpected errors
    if (browser && schoolId) {
      const userResponse = await waitForUserResponseWithTimeout(5);
      if (userResponse === 'yes') {
        const takeoverResult = await offerUserTakeover(page, browser, subfolder, 'course-save', schoolId, 'updateCourse', `Unexpected error during save: ${error.message}`, null, true);
        if (takeoverResult.success) {
          if (takeoverResult.sectionSaved) {
            console.log('✅ User intervention successful - course saved manually (modal closed)');
          } else {
            console.log('✅ User intervention successful - course saved manually');
          }
          if (takeoverResult.sectionChanged) {
            console.log('ℹ️ Course/section change detected during intervention');
          }
          return true;
        }
      }
    }
    
    return false;
  }
}

module.exports = {
  createCourse,
  updateCourse,
  readCourseValues,
  fillCourseTemplate,
  getLatestCourseTemplateFile,
  saveCourseFieldDifferences,
  saveCourse
};
