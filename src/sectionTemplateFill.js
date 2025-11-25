// sectionTemplateFill.js
// Reads a client's Section template JSON and fills the modal fields in Playwright.

const { captureModalError, captureModalAfter } = require('./section-screenshot');

const fs   = require('fs');
const path = require('path');
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
const { offerUserTakeover, waitForUserResponseWithTimeout } = require('./userTakeover');

// Diff generation state shared across the flow to ensure we always produce one diff per run
let __diffState = {
  before: null,
  context: null, // { schoolId, outputDir, action, dateStr }
  wrote: false,
};

// Capture the full-height relationship modal (edit or conflict) using CDP clip + padding
async function captureRelationshipModalFull(page, outputPath, isConflict = false) {
  try {
    const modal = isConflict
      ? page.locator('.modal-dialog').filter({ has: page.locator('h3.heading', { hasText: 'Relationship Conflicts' }) }).first()
      : page.locator('.modal-dialog').filter({ has: page.locator('text=Edit Relationship') }).first();

    await modal.waitFor({ state: 'visible', timeout: 10000 });
    // Reset modal-body scroll to top for consistent capture
    try {
      const body = modal.locator('.modal-body').first();
      if (await body.count() > 0) await body.evaluate(el => el.scrollTo(0, 0));
    } catch (_) {}

    // Capture the modal content element directly (exact container the user provided)
    const content = modal.locator('.modal-content').first();
    await content.waitFor({ state: 'visible', timeout: 5000 });
    await content.screenshot({ path: outputPath });
  } catch (err) {
    try { await page.screenshot({ path: outputPath, fullPage: true }); } catch (_) {}
  }
}

function getTimestamp() {
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
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
    // Fallback to strict equality if stringify fails
    return na === nb;
  }
}

async function writeSectionDiff(beforeValues, afterValues, schoolId, outputDir, action, dateStr) {
  try {
    if (!beforeValues || !afterValues || !schoolId || !outputDir) return false;
    ensureRunLogger(outputDir);

    // Build qid -> label map from latest section template
    let labelByQid = {};
    try {
      const tplPath = getLatestSectionTemplateFile(schoolId);
      if (tplPath && fs.existsSync(tplPath)) {
        const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
        const questions = (tpl && tpl.sectionTemplate && tpl.sectionTemplate.questions) || {};
        for (const [qid, q] of Object.entries(questions)) {
          if (q && typeof q === 'object') {
            labelByQid[qid] = q.label || '';
          }
        }
      }
    } catch (_) {}

    const tableRows = [];
    const skipSet = new Set((__diffState && __diffState.context && Array.isArray(__diffState.context.skipFields)) ? __diffState.context.skipFields : []);

    // Load integrated fields and restrict diffs to SIS-integrated fields for sections
    let allowedTopLevels = null;
    try {
      const integratedPath = path.join(__dirname, 'integratedFields.json');
      if (fs.existsSync(integratedPath)) {
        const integrated = JSON.parse(fs.readFileSync(integratedPath, 'utf8')) || {};
        const sisKey = Object.keys(integrated)
          .filter(k => typeof k === 'string' && schoolId.endsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        const fields = sisKey && integrated[sisKey] && (integrated[sisKey].section || integrated[sisKey].sections);
        if (Array.isArray(fields)) {
          allowedTopLevels = new Set(fields.map(f => String(f).split('.')[0]));
        }
      }
    } catch (_) {}

    // Parse Logs.md to collect per-field error comments for ❌ rows
    const commentsByQid = new Map();
    try {
      const logFile = path.join(outputDir, 'Logs.md');
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

    for (const key of Object.keys(beforeValues).filter(k => !k.startsWith('_') && k !== '_disabledFields')) {
      const topLevelQuestionid = String(key).split('.')[0];
      if (allowedTopLevels && !allowedTopLevels.has(topLevelQuestionid)) continue;
      const hidden = (beforeValues._hiddenFields && beforeValues._hiddenFields[topLevelQuestionid]) || (afterValues._hiddenFields && afterValues._hiddenFields[topLevelQuestionid]);
      if (hidden) continue; // remove hidden fields from report entirely
      const disabled = (beforeValues._disabledFields && beforeValues._disabledFields[topLevelQuestionid]) || (afterValues._disabledFields && afterValues._disabledFields[topLevelQuestionid]);

      const rawBefore = beforeValues[key];
      const rawAfter = afterValues[key];
      const changed = !isDeepEqual(rawBefore, rawAfter);
      const beforeVal = rawBefore === undefined ? '' : rawBefore;
      const afterVal = rawAfter === undefined ? '' : rawAfter;
      const status = disabled ? '🔒' : (skipSet.has(topLevelQuestionid) ? '⏭️' : (changed ? '✅' : '❌'));
      const label = labelByQid[topLevelQuestionid] ? ` (${labelByQid[topLevelQuestionid]})` : '';
      const fieldDisplay = `${key}${label}`;
      let comment = '';
      if (status === '❌') {
        comment = commentsByQid.get(key) || commentsByQid.get(topLevelQuestionid) || '';
      }
      tableRows.push(`| ${fieldDisplay} | ${JSON.stringify(beforeVal)} | ${JSON.stringify(afterVal)} | ${status} | ${comment}`);
    }

    if (tableRows.length === 0) return false;

    const header = '| Field | Original | New | Status | Comments |\n| --- | --- | --- | --- | --- |';
    const legend = '⏭️ - Skipped field\n\n✅ - Updated field\n\n🔒 - Disabled field\n\n❌ - Unable to update (other reason)';
    const diffText = `${legend}\n\n${header}\n${tableRows.join('\n')}`;
    const diffFileName = `${schoolId}-${action}-field-differences-${dateStr || getTimestamp()}.txt`;
    const diffFilePath = path.join(outputDir, diffFileName);
    fs.writeFileSync(diffFilePath, diffText, 'utf8');
    console.log(`\nDifferences saved to: ${diffFilePath}`);
    __diffState.wrote = true;
    return true;
  } catch (err) {
    console.log(`⚠️  [Diff] Failed to write diff: ${err.message}`);
    return false;
  }
}

/**
 * Restarts the section template process with a new section after user intervention
 * @param {Object} page - Playwright page object
 * @param {string} outputDir - Output directory for screenshots and files
 * @param {string} action - Current action being performed
 * @param {string} schoolId - School identifier
 * @param {Object} browser - Playwright browser object
 * @returns {Promise<boolean>} - True if template process completed successfully
 */
async function restartSectionTemplateProcess(page, outputDir, action, schoolId, browser) {
  try {
    ensureRunLogger(outputDir);
    console.log('\n🔄 RESTARTING SECTION TEMPLATE PROCESS');
    console.log('═══════════════════════════════════════');
    
    // Fill the section template with the new section
    await fillBaselineTemplate(page, schoolId, action);
    
    // Handle meeting patterns if present
    const meetingBtn = page.locator('[data-test="set-meeting-pattern-btn"]');
    if (await meetingBtn.count() > 0) {
      console.log('📅 Processing meeting patterns for new section...');
      await validateAndResetMeetingPatterns(page, outputDir, action);
    }
    
    // Handle instructors if present
    const profExpand = page.locator('[data-test="expandInstructorDetails"]');
    if (await profExpand.count() > 0) {
      console.log('👤 Processing instructors for new section...');
      await validateAndResetProfessors(page, outputDir, action, null, '', null, '');
    }
    
    // Handle banner ethos schedule type if applicable
    if (schoolId.includes('banner_ethos')) {
      console.log('🏫 Processing Banner Ethos schedule type for new section...');
      await bannerEthosScheduleType(page);
    }
    
    // Attempt to save the new section
    console.log('💾 Attempting to save new section...');
    const saveResult = await saveSection(page, outputDir, action, browser, schoolId);
    
    if (saveResult) {
      console.log('✅ New section template process completed successfully');
      return true;
    } else {
      console.log('⚠️ New section template process completed but save failed');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error during section template restart:', error.message);
    return false;
  }
}

/**
 * Fills the Section modal fields based on a baseline template JSON.
 *
 * @param {import('playwright').Page} page    Playwright Page instance (modal must be open).
 * @param {string}               schoolId Identifier matching JSON file in Resources folder.
 */
async function fillBaselineTemplate(page, schoolId, action, outputDir = null, browser = null) {
  try { ensureRunLogger(outputDir); } catch (_) {}
  // Load the template JSON
  const jsonPath = getLatestSectionTemplateFile(schoolId);
  const raw      = fs.readFileSync(jsonPath, 'utf8');
  const { sectionTemplate } = JSON.parse(raw);

  // Fields to skip editing
  const skipFields = [
    'ethosId', 'callNumber', 'secBillingPeriodType', 'durationUnits', 'sectionNumber',
    'meetingPattern', 'professors', 'preferredRoomCapacity', 'preferredBuilding', 'preferredRoomFeatures',
    'startDate', 'endDate', 'sectionNumberBanner', 'bannerSectionNumber'
  ];
  // Fields to skip editing for update action
  if (action === 'update') {
    skipFields.push('status', 'statusCode', 'bannerSectionNumber');
  }
  
  // For inactivateSection action, only edit status and statusCode fields
  if (action === 'inactivateSection') {
    // Add all fields except status and statusCode to skip list
    const allFields = Object.keys(sectionTemplate.questions || {});
    for (const field of allFields) {
      if (field !== 'status' && field !== 'statusCode') {
        skipFields.push(field);
      }
    }
  }

  // Extract all questionIds
  const questionIds = Object.keys(sectionTemplate.questions || {});

  // Initialize global diff state for this run
  try {
    __diffState.before = await readSectionValues(page, schoolId);
    __diffState.context = { schoolId, outputDir, action, dateStr: getTimestamp(), skipFields };
    __diffState.wrote = false;
  } catch (_) {}

  // Add a small buffer to ensure fields load
  await page.waitForTimeout(1000);

  for (const qid of questionIds) {
    try {
      // Skip specific fields
      if (skipFields.includes(qid)) {
        console.log(`⏭️  Skipping restricted field: ${qid}`);
        continue;
      }

      // Special handling for status/statusCode when NOT update
      if (action !== 'update' && (qid === 'status' || qid === 'statusCode')) {
        // For inactivateSection, always edit these fields regardless of current value
        if (action === 'inactivateSection') {
          console.log(`🔄 [${qid}] Processing inactivation field (bypassing existing value check)...`);
          // Continue to the special inactivateSection handling below
        } else {
          // Locate the wrapper by data-test attribute
          const wrapper = page.locator(`[data-test="${qid}"]`);
          const wrapperCount = await wrapper.count();
          if (wrapperCount === 0) {
            console.log(`⚠️  [${qid}] No control found, skipping.`);
            continue;
          }
          // Check if this is a multiselect (has multiselect class or structure)
          const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
          if (isMultiselect) {
            // Check if a value is already selected
            const selectedOptions = await wrapper.locator('.multiselect__tags .multiselect__tag, .multiselect__single').allTextContents();
            if (selectedOptions.length > 0 && selectedOptions[0].trim() !== '') {
              console.log(`⏭️  [${qid}] Already has value '${selectedOptions[0]}', skipping edit.`);
              continue;
            }
            // Empty: prefer selecting an Active status if available
            const selectedActive = await selectActiveStatusIfEmpty(wrapper, page, qid);
            if (selectedActive) {
              console.log(`✅  [${qid}] Selected active status option.`);
              continue;
            }
            // No value selected, proceed to select first option as normal
          } else {
            // If the wrapper is itself an input/select, use it directly
            let input;
            let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
            if (["input", "textarea", "select"].includes(tagName)) {
              input = wrapper.first();
            } else {
              input = wrapper.locator('input, textarea, select');
            }
            const inputCount = await input.count();
            if (inputCount > 0) {
              const inputElement = input.first();
              let value = await inputElement.inputValue();
              if (value && value.trim() !== '') {
                console.log(`⏭️  [${qid}] Already has value '${value}', skipping edit.`);
                continue;
              }
              // If this is a select and empty, prefer selecting an Active status if available
              const inputTagName = await inputElement.evaluate(el => el.tagName.toLowerCase());
              if (inputTagName === 'select') {
                const selectedActive = await selectActiveStatusIfEmpty(wrapper, page, qid);
                if (selectedActive) {
                  console.log(`✅  [${qid}] Selected active status option (select).`);
                  continue;
                }
              }
              // No value, proceed to fill as normal
            } else {
              console.log(`⚠️  [${qid}] No input found, skipping.`);
              continue;
            }
          }
          // If we reach here, fall through to normal logic below to fill/select
        }
      }

      // Special handling for status/statusCode in inactivateSection action
      if (action === 'inactivateSection' && (qid === 'status' || qid === 'statusCode')) {
        console.log(`🔄 [${qid}] Processing inactivation field...`);
        
        // Locate the wrapper by data-test attribute
        const wrapper = page.locator(`[data-test="${qid}"]`);
        const wrapperCount = await wrapper.count();
        if (wrapperCount === 0) {
          console.log(`⚠️  [${qid}] No control found, skipping.`);
          continue;
        }
        
        // Check if this is a multiselect
        const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
        
        if (isMultiselect) {
          console.log(`🔽 [${qid}] Opening multiselect for inactivation options...`);
          try {
            await wrapper.click();
            await page.waitForTimeout(2000); // Wait for dropdown to render
            
            // Get all available options
            const options = wrapper.locator('.multiselect__content-wrapper li, [role="option"]');
            const optionCount = await options.count();
            
            if (optionCount === 0) {
              console.log(`🚫 [${qid}] No options available in multiselect.`);
              continue;
            }
            
            // Get all option texts
            const optionTexts = [];
            for (let i = 0; i < optionCount; i++) {
              const option = options.nth(i);
              try {
                const text = await option.textContent();
                optionTexts.push(text.trim());
              } catch (err) {
                optionTexts.push(`Option ${i + 1}`);
              }
            }
            
            console.log(`📋 [${qid}] Available options: [${optionTexts.join(', ')}]`);
            
            // Look for inactivation options in order: inact, ina, Cancel
            const inactivationKeywords = ['inact', 'ina', 'Cancel', 'C'];
            let selectedOption = null;
            let selectedIndex = -1;
            
            for (const keyword of inactivationKeywords) {
              for (let i = 0; i < optionTexts.length; i++) {
                if (optionTexts[i].toLowerCase().includes(keyword.toLowerCase())) {
                  selectedOption = optionTexts[i];
                  selectedIndex = i;
                  break;
                }
              }
              if (selectedOption) break;
            }
            
            if (selectedOption) {
              console.log(`✅ [${qid}] Found inactivation option: "${selectedOption}"`);
              const targetOption = options.nth(selectedIndex);
              if (await targetOption.isVisible()) {
                await targetOption.click();
                console.log(`   ┗ Selected: "${selectedOption}"`);
              } else {
                console.log(`⚠️  [${qid}] Target option not visible, trying keyboard navigation...`);
                // Fallback: use keyboard navigation
                const input = wrapper.locator('input.multiselect__input');
                if (await input.count() > 0) {
                  // Navigate to the option using arrow keys
                  for (let i = 0; i <= selectedIndex; i++) {
                    await input.first().press('ArrowDown');
                    await page.waitForTimeout(200);
                  }
                  await input.first().press('Enter');
                  console.log(`   ┗ Selected via keyboard: "${selectedOption}"`);
                }
              }
            } else {
              console.log(`⚠️  [${qid}] No suitable inactivation option found. Selecting first available option.`);
              const firstOption = options.first();
              if (await firstOption.isVisible()) {
                await firstOption.click();
                console.log(`   ┗ Selected first available option: "${optionTexts[0]}"`);
              }
            }
          } catch (err) {
            console.log(`❌ [${qid}] Error processing multiselect: ${err.message}`);
          }
        } else {
          // Handle regular select dropdown
          let input;
          let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
          if (tagName === 'select') {
            input = wrapper.first();
          } else {
            input = wrapper.locator('select');
          }
          
          const inputCount = await input.count();
          if (inputCount > 0) {
            console.log(`🔽 [${qid}] Processing select dropdown for inactivation...`);
            
            // Get all options
            const options = input.locator('option');
            const optionCount = await options.count();
            
            if (optionCount === 0) {
              console.log(`🚫 [${qid}] No options available in select.`);
              continue;
            }
            
            // Get all option texts
            const optionTexts = [];
            for (let i = 0; i < optionCount; i++) {
              const option = options.nth(i);
              try {
                const text = await option.textContent();
                optionTexts.push(text.trim());
              } catch (err) {
                optionTexts.push(`Option ${i + 1}`);
              }
            }
            
            console.log(`📋 [${qid}] Available options: [${optionTexts.join(', ')}]`);
            
            // Look for inactivation options in order: inact, ina, Cancel
            const inactivationKeywords = ['inact', 'ina', 'Cancel'];
            let selectedOption = null;
            let selectedIndex = -1;
            
            for (const keyword of inactivationKeywords) {
              for (let i = 0; i < optionTexts.length; i++) {
                if (optionTexts[i].toLowerCase().includes(keyword.toLowerCase())) {
                  selectedOption = optionTexts[i];
                  selectedIndex = i;
                  break;
                }
              }
              if (selectedOption) break;
            }
            
            if (selectedOption) {
              console.log(`✅ [${qid}] Found inactivation option: "${selectedOption}"`);
              await input.selectOption({ index: selectedIndex });
              console.log(`   ┗ Selected: "${selectedOption}"`);
            } else {
              console.log(`⚠️  [${qid}] No suitable inactivation option found. Selecting first available option.`);
              await input.selectOption({ index: 0 });
              console.log(`   ┗ Selected first available option: "${optionTexts[0]}"`);
            }
          } else {
            console.log(`⚠️  [${qid}] No select dropdown found.`);
          }
        }
        
        // Skip normal processing for this field
        continue;
      }

      // For Banner schools: auto-fill any *Hours fields from corresponding *HoursMin value
      // Examples:
      //   creditHours       <- creditHoursMin
      //   lectureHours      <- lectureHoursMin
      //   labHours          <- labHoursMin
      //   billingHours      <- billingHoursMin
      //   otherHours        <- otherHoursMin
      //   contactHours      <- contactHoursMin
      if (typeof schoolId === 'string' && schoolId.toLowerCase().includes('banner')) {
        const isHoursField = /Hours$/.test(qid) && !/(HoursMin|HoursMax|HoursOp)$/.test(qid);
        if (isHoursField) {
          try {
            const minQid = qid.replace(/Hours$/, 'HoursMin');
            const minWrapper = page.locator(`[data-test="${minQid}"]`);
            if (await minWrapper.count() > 0) {
              // Find the input element that holds the min value
              let minInput;
              try {
                const tag = await minWrapper.first().evaluate(el => el.tagName.toLowerCase());
                if (["input", "textarea", "select"].includes(tag)) {
                  minInput = minWrapper.first();
                } else {
                  minInput = minWrapper.locator('input');
                }
              } catch (_) {
                minInput = minWrapper.locator('input');
              }

              if (await minInput.count() > 0) {
                const minVal = await minInput.first().inputValue();
                if (minVal !== null && String(minVal).trim() !== '') {
                  const hoursWrapper = page.locator(`[data-test="${qid}"]`);
                  let hoursInput;
                  try {
                    const tag = await hoursWrapper.first().evaluate(el => el.tagName.toLowerCase());
                    if (["input", "textarea", "select"].includes(tag)) {
                      hoursInput = hoursWrapper.first();
                    } else {
                      hoursInput = hoursWrapper.locator('input');
                    }
                  } catch (_) {
                    hoursInput = hoursWrapper.locator('input');
                  }

                  if (await hoursInput.count() > 0 && (await hoursInput.first().isEnabled().catch(() => true))) {
                    try { await hoursInput.first().scrollIntoViewIfNeeded(); } catch (_) {}
                    await hoursInput.first().fill(String(minVal));
                    console.log(`   ┗ [${qid}] Auto-set from ${minQid} value "${minVal}" (banner)`);
                    // Skip default handling for this qid since we've set it explicitly
                    continue;
                  }
                }
              }
            }
          } catch (_) {}
        }
      }

      // Locate the wrapper by data-test attribute
      const wrapper = page.locator(`[data-test="${qid}"]`);
      const wrapperCount = await wrapper.count();
      //console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      //console.log(`🔎 [${qid}] Found ${wrapperCount} wrapper(s)`);
      if (wrapperCount > 0) {
        const html = await wrapper.first().evaluate(el => el.outerHTML);
        //console.log(`🧩 [${qid}] Wrapper HTML:`, html);
      }
      if (wrapperCount === 0) {
        console.log(`⚠️  [${qid}] No control found, skipping.`);
        continue;
      } 

      // Check if this is a multiselect (has multiselect class or structure)
      const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
      
      if (isMultiselect) {
        // Check if the multiselect is disabled by class
        let multiselectEl;
        let multiselectClass;
        const wrapperTag = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
        if (wrapperTag === 'div' && (await wrapper.first().getAttribute('class') || '').includes('multiselect')) {
          multiselectEl = wrapper.first();
          multiselectClass = await multiselectEl.getAttribute('class');
        } else {
          multiselectEl = wrapper.locator('.multiselect').first();
          multiselectClass = await multiselectEl.getAttribute('class');
        }
        
        // Check if multiselect is disabled by class
        if (multiselectClass && multiselectClass.includes('multiselect--disabled')) {
          console.log(`🚫 Multiselect for ${qid} is disabled, skipping.`);
          continue;
        }
        
        // Check if multiselect is visible and enabled
        const isVisible = await wrapper.first().isVisible();
        const isEnabled = await wrapper.first().isEnabled();
        
        if (!isVisible) {
          console.log(`👁️ [${qid}] Multiselect not visible, skipping.`);
          continue;
        }
        
        if (!isEnabled) {
          console.log(`🔒 [${qid}] Multiselect not enabled, skipping.`);
          continue;
        }
        
        // Handle multiselect: click to open and pick the first visible, unselected option
        console.log(`🔽 Processing multiselect for ${qid}`);
        try {
          await wrapper.click();
          await page.waitForTimeout(1000); // Wait for dropdown to render
          // Only attempt typing to remote-load options IF none are available yet
          {
            // Check if there are any candidate options already visible/enabled
            const existingCandidates = wrapper.locator('.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled), [role="option"]:not([aria-disabled="true"])');
            const existingCount = await existingCandidates.count();
            let hasVisibleCandidate = false;
            for (let i = 0; i < existingCount; i++) {
              try {
                if (await existingCandidates.nth(i).isVisible()) { hasVisibleCandidate = true; break; }
              } catch (_) {}
            }

            if (!hasVisibleCandidate) {
              const inputBox = wrapper.locator('.multiselect__input');
              if (await inputBox.count() > 0) {
                try {
                  const inputStyle = await inputBox.first().getAttribute('style') || '';
                  if (inputStyle.includes('width: 0px')) {
                    await wrapper.click();
                    await page.waitForTimeout(200);
                  }
                } catch (_) {}

                const placeholderText = (await inputBox.first().getAttribute('placeholder') || '').trim();
                const shouldType = placeholderText && /type|search/i.test(placeholderText);
                if (shouldType) {
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
                    try {
                      await inputBox.first().fill(ch);
                      await page.waitForTimeout(1200);
                      const realOptions = wrapper.locator('.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled), [role="option"]:not([aria-disabled="true"])');
                      const realCount = await realOptions.count();
                      for (let i = 0; i < realCount; i++) {
                        try { if (await realOptions.nth(i).isVisible()) { return true; } } catch (_) {}
                      }
                      return false;
                    } catch (_) {
                      return false;
                    }
                  };

                  let success = false;
                  for (const ch of preferred) {
                    if (tried.has(ch)) continue; tried.add(ch);
                    success = await tryLetter(ch);
                    if (success) break;
                    try { await inputBox.first().fill(''); } catch (_) {}
                    await page.waitForTimeout(250);
                  }
                  if (!success) {
                    for (const ch of letters) {
                      if (tried.has(ch)) continue; tried.add(ch);
                      success = await tryLetter(ch);
                      if (success) break;
                      try { await inputBox.first().fill(''); } catch (_) {}
                      await page.waitForTimeout(200);
                    }
                  }
                }
              }
            }
          }
          // Special logic for associatedClass: wait 3 seconds before selecting
          if (qid === 'associatedClass') {
            console.log(`⏳ Waiting 3 seconds for ${qid} dropdown to fully load...`);
            await page.waitForTimeout(3000); // Wait 3 seconds for associatedClass dropdown
            
            // Get the section number value to use for associatedClass
            const sectionNumberWrapper = page.locator('[data-test="sectionNumber"]');
            let sectionNumberValue = '';
            
            if (await sectionNumberWrapper.count() > 0) {
              try {
                // Check if the wrapper itself is an input element
                const tagName = await sectionNumberWrapper.first().evaluate(el => el.tagName.toLowerCase());
                if (tagName === 'input') {
                  // The wrapper itself is the input
                  sectionNumberValue = await sectionNumberWrapper.first().inputValue();
                  console.log(`📋 [associatedClass] Found section number value (direct input): "${sectionNumberValue}"`);
                } else {
                  // Look for input inside the wrapper
                  const sectionInput = sectionNumberWrapper.locator('input, textarea, select').first();
                  if (await sectionInput.count() > 0) {
                    sectionNumberValue = await sectionInput.inputValue();
                    console.log(`📋 [associatedClass] Found section number value (nested input): "${sectionNumberValue}"`);
                  } else {
                    console.log(`⚠️ [associatedClass] No input found in sectionNumber field (tag: ${tagName}).`);
                  }
                }
              } catch (err) {
                console.log(`⚠️ [associatedClass] Error reading sectionNumber: ${err.message}`);
              }
            } else {
              console.log(`⚠️ [associatedClass] sectionNumber field not found.`);
            }
            
            // If we found a section number value, input it directly as text
            if (sectionNumberValue && sectionNumberValue.trim() !== '') {
              console.log(`✏️ [associatedClass] Entering section number as text: "${sectionNumberValue}"`);
              
              try {
                // Find the input field within the multiselect and enter the text directly
                const inputField = wrapper.locator('input.multiselect__input, input[type="text"]').first();
                if (await inputField.count() > 0) {
                  await inputField.fill(sectionNumberValue);
                  await page.waitForTimeout(500); // Wait for input to register
                  // Press Enter or Tab to confirm the input
                  await inputField.press('Enter');
                  console.log(`✅ [associatedClass] Successfully entered section number: "${sectionNumberValue}"`);
                  // Mark as selected so we skip normal selection logic
                } else {
                  console.log(`⚠️ [associatedClass] Could not find input field in associatedClass dropdown.`);
                  // Fall through to normal selection logic
                }
              } catch (err) {
                console.log(`❌ [associatedClass] Error entering text: ${err.message}`);
                // Fall through to normal selection logic
              }
            } else {
              console.log(`⚠️ [associatedClass] No section number value found, using normal selection.`);
            }
          }
        } catch (err) {
          console.log(`❌ Couldn't click multiselect for ${qid}, skipping. Reason: ${err.message}`);
          continue;
        }
        // Wait for dropdown to appear and check for options
        const options = wrapper.locator('.multiselect__content-wrapper li, [role="option"]');
        const optionCount = await options.count();
        if (optionCount === 0) {
          console.log(`🚫 Multiselect for ${qid} has no options (list is empty), skipping.`);
          continue;
        }
        let selected = false;
        
        // Check if associatedClass already selected a value successfully
        if (qid === 'associatedClass') {
          // Check if an option is already selected after our special handling above
          const selectedOptions = wrapper.locator('.multiselect__tags .multiselect__tag, .multiselect__single');
          if (await selectedOptions.count() > 0) {
            const selectedText = await selectedOptions.first().textContent();
            if (selectedText && selectedText.trim() !== '') {
              console.log(`✅ [associatedClass] Already selected option: "${selectedText.trim()}", skipping normal selection.`);
              selected = true;
            }
          }
        }
        // Build randomized order of option indices
        const optionIndices = Array.from({ length: optionCount }, (_, i) => i);
        for (let i = optionIndices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [optionIndices[i], optionIndices[j]] = [optionIndices[j], optionIndices[i]];
        }

        for (let arrIdx = 0; arrIdx < optionIndices.length; arrIdx++) {
          const i = optionIndices[arrIdx];
          const option = options.nth(i);
          let visible = false;
          let optionClass = '';
          let spanClass = '';
          try {
            visible = await option.isVisible();
            optionClass = await option.getAttribute('class') || '';
            // Check child <span> class if not found on <li>
            if (!optionClass.includes('option--selected')) {
              const span = option.locator('span');
              spanClass = await span.first().getAttribute('class') || '';
            }
          } catch (err) {
            continue;
          }
          if (
            visible &&
            !optionClass.includes('option--selected') &&
            !spanClass.includes('option--selected')
          ) {
            try {
              await option.click();
              console.log(`✅ Selected option #${i+1} for multiselect ${qid}`);
              selected = true;
              break;
            } catch (err) {
              console.log(`❌ Couldn't select option #${i+1} for multiselect ${qid}, trying next. Reason: ${err.message}`);
              continue;
            }
          }
        }
        if (!selected) {
          let maxAttempts = 3;
          let attempt = 1;
          let found = false;
          while (attempt <= maxAttempts && !selected) {
            // Log all option texts for debugging
            let optionTexts = [];
            for (let i = 0; i < optionCount; i++) {
              const option = options.nth(i);
              try {
                const text = await option.textContent();
                optionTexts.push(text);
              } catch {}
            }
            if (attempt < maxAttempts) {
              console.log(`🚫 Multiselect for ${qid} has options, but none are visible/selectable. Option texts: [${optionTexts.join(', ')}] Trying one more time (attempt ${attempt + 1} of ${maxAttempts})...`);
              // Try to click the options again in case the UI changed
              await page.waitForTimeout(500);
              for (let i = 0; i < optionCount; i++) {
                const option = options.nth(i);
                let visible = false;
                let optionClass = '';
                let spanClass = '';
                try {
                  visible = await option.isVisible();
                  optionClass = await option.getAttribute('class') || '';
                  if (!optionClass.includes('option--selected')) {
                    const span = option.locator('span');
                    spanClass = await span.first().getAttribute('class') || '';
                  }
                } catch (err) {
                  continue;
                }
                if (
                  visible &&
                  !optionClass.includes('option--selected') &&
                  !spanClass.includes('option--selected')
                ) {
                  try {
                    await option.click();
                    console.log(`✅ Selected option #${i+1} for multiselect ${qid} (on retry attempt ${attempt + 1})`);
                    selected = true;
                    found = true;
                    break;
                  } catch (err) {
                    console.log(`❌ Couldn't select option #${i+1} for multiselect ${qid} (on retry), trying next. Reason: ${err.message}`);
                    continue;
                  }
                }
              }
              if (selected) break;
            } else {
              // Last attempt, print and skip
              console.log(`🚫 Multiselect for ${qid} has options, but none are visible/selectable. Option texts: [${optionTexts.join(', ')}] Skipping.`);
            }
            attempt++;
          }
        }
      } else {
        // If the wrapper is itself an input/textarea/select, use it directly
        let input;
        let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
        if (["input", "textarea", "select"].includes(tagName)) {
          input = wrapper.first();
          console.log(`🟢 [${qid}] Wrapper is itself a <${tagName}> element.`);
        } else {
          input = wrapper.locator('input, textarea, select');
        }
        const inputCount = await input.count();
        console.log(`🔎 [${qid}] Inputs found: ${inputCount}`);
        if (inputCount > 0) {
          const inputElement = input.first();
          // Debug: Check element state
          const isVisible = await inputElement.isVisible();
          const isEnabled = await inputElement.isEnabled();
          const inputType = await inputElement.getAttribute('type');
          tagName = await inputElement.evaluate(el => el.tagName.toLowerCase());
          console.log(`   ┣ Tag: <${tagName}> | Type: ${inputType} | Visible: ${isVisible} | Enabled: ${isEnabled}`);
          if (!isVisible) {
            console.log(`   ┗ 👁️  [${qid}] Element not visible, skipping.`);
            continue;
          }
          if (!isEnabled) {
            console.log(`   ┗ 🔒 [${qid}] Element not enabled, skipping.`);
            continue;
          }
          try {
            if (inputType === 'date' || 
                (tagName === 'input' && /date/i.test(await inputElement.getAttribute('placeholder') || '')) ||
                (tagName === 'input' && (await inputElement.getAttribute('class') || '').includes('datepicker'))) {
              
              // Handle date input with proper format detection
              const today = new Date();
              
              // Check current value to determine format preference
              const currentValue = await inputElement.inputValue();
              let dateStr;
              
              if (currentValue && currentValue.includes('-')) {
                // Use ISO format (YYYY-MM-DD) if current value uses dashes
                const year = today.getFullYear();
                const month = String(today.getMonth() + 1).padStart(2, '0');
                const day = String(today.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
              } else {
                // Use short month format (Jul 28, 2025) as default
                const options = { year: 'numeric', month: 'short', day: 'numeric' };
                dateStr = today.toLocaleDateString('en-US', options);
              }
              
              console.log(`   ┣ 📅 Processing date input for [${qid}]`);
              
              // Clear the field first
              await inputElement.clear();
              await page.waitForTimeout(400);
              
              // Fill the date
              await inputElement.fill(dateStr);
              await page.waitForTimeout(500); // Wait for calendar to open
              await inputElement.press('Enter'); // Close the calendar
              console.log(`   ┗ ✅ Filled date input for [${qid}] with ${dateStr}`);
            } else if (tagName === 'select') {
              // Handle select dropdown
              console.log(`   ┣ 📋 Processing select for [${qid}]`);
              await inputElement.selectOption({ index: 0 }); // Select first option
              console.log(`   ┗ ✅ Selected first option for select [${qid}]`);
            } else if (inputType === 'checkbox') {
              // Handle checkbox
              console.log(`   ┣ ☑️  Processing checkbox for [${qid}]`);
              await inputElement.check();
              console.log(`   ┗ ✅ Checked checkbox for [${qid}]`);
            } else if (inputType === 'radio') {
              // Handle radio button
              console.log(`   ┣ 🔘 Processing radio for [${qid}]`);
              await inputElement.check();
              console.log(`   ┗ ✅ Selected radio for [${qid}]`);
            } else if (inputType === 'number' || qid === 'duration') {
              // Handle number input or duration (always fill with a number)
              console.log(`   ┣ 🔢 Processing number input for [${qid}]`);
              await inputElement.fill('15');
              console.log(`   ┗ ✅ Filled number input for [${qid}]`);
            } else {
              // Handle text input/textarea (append instead of replace)
              console.log(`   ┣ ✏️  Processing text input for [${qid}]`);
              let currentValue = await inputElement.inputValue();
              let newValue = currentValue + '-CDtest';
              // If this is sectionName, enforce max 30 characters
              if (qid === 'sectionName') {
                if (newValue.length > 30) {
                  newValue = newValue.slice(0, 30);
                  console.log(`   ┃ [sectionName] Value trimmed to 30 characters.`);
                }
              }
              await inputElement.fill(newValue);
              console.log(`   ┗ ✅ Appended to text input for [${qid}]`);
            }
          } catch (error) {
            console.log(`   ┗ ❌ Couldn't edit field [${qid}], skipping it. Reason: ${error.message}`);
            continue;
          }
        } else {
          // Look for Yes/No buttons inside the wrapper
          const yesNoButtons = wrapper.locator('button[data-test="YesBtn"], button[data-test="NoBtn"]');
          const btnCount = await yesNoButtons.count();
          if (btnCount === 2) {
            let selectedIdx = -1;
            let unselectedIdx = -1;
            for (let i = 0; i < 2; i++) {
              const btn = yesNoButtons.nth(i);
              const btnClass = await btn.getAttribute('class') || '';
              if (btnClass.includes('btn-raised')) {
                selectedIdx = i;
              } else {
                unselectedIdx = i;
              }
            }
            if (unselectedIdx !== -1) {
              // Check if the unselected button is visible before trying to click it
              const unselectedBtn = yesNoButtons.nth(unselectedIdx);
              const isVisible = await unselectedBtn.isVisible();
              const isEnabled = await unselectedBtn.isEnabled();
              
              if (!isVisible) {
                console.log(`   ┗ 👁️  [${qid}] Unselected Yes/No button not visible, skipping.`);
              } else if (!isEnabled) {
                console.log(`   ┗ 🔒 [${qid}] Unselected Yes/No button not enabled, skipping.`);
              } else {
                try {
                  await unselectedBtn.click();
                  console.log(`   ┗ ✅ Clicked unselected Yes/No button for [${qid}]`);
                } catch (err) {
                  console.log(`   ┗ ❌ Couldn't click unselected Yes/No button for [${qid}]. Reason: ${err.message}`);
                }
              }
            } else {
              console.log(`   ┗ ⚠️  Both Yes/No buttons for [${qid}] appear selected or unselected, skipping.`);
            }
          } else {
            console.log(`⚠️  [${qid}] No input or Yes/No button group found, skipping.`);
          }
        }
      }
    } catch (outerError) {
      console.log(`❌ Couldn't edit field ${qid}, skipping it. Reason: ${outerError.message}`);
      continue;
    }
  }
  
  // Save the section if this is an action that doesn't have professors/meetings and we have the required parameters
  if ((action === 'createNoMeetNoProf' || action === 'inactivateSection') && outputDir && browser) {
    console.log('📸 [Template Fill] Taking "after" screenshot before save...');
    await captureModalAfter(page, outputDir, action);
    
    // Generate diff before saving
    try {
      const afterValuesForFill = await readSectionValues(page, schoolId);
      await writeSectionDiff(__diffState.before, afterValuesForFill, schoolId, outputDir, action, __diffState.context?.dateStr);
    } catch (err) {
      console.log(`⚠️ [Template Fill] Could not generate diff: ${err.message}`);
    }

    console.log(`💾 [Template Fill] Saving section after template fill (${action})...`);
    const saveSuccess = await saveSection(page, outputDir, action, browser, schoolId);
    return saveSuccess;
  }
  
  return true; // Return success if no saving needed
}

// Pre-fill any visible required fields that are currently empty (sections)
async function preFillRequiredEmptySectionFields(page) {
  try {
    console.log('🔎 [Sections] Checking for empty required fields before save...');

    // Protect critical or sensitive fields from auto-fill for sections
    const protectedQids = new Set([
      'ethosId',
      'callNumber',
      'secBillingPeriodType',
      'durationUnits',
      'sectionNumber',
      'meetingPattern',
      'professors',
      'preferredRoomCapacity',
      'preferredBuilding',
      'preferredRoomFeatures',
      'startDate',
      'endDate',
      'sectionNumberBanner',
      'bannerSectionNumber',
      'minCreditHours',
      'sisId',
      'allowIntegration'
    ]);

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

    const fillControl = async (el) => {
      const tag = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
      const cls = (await el.getAttribute('class')) || '';
      const typeAttr = (await el.getAttribute('type')) || '';
      const role = await el.getAttribute('role');

      // Multiselect/select-like
      if (cls.includes('multiselect') || role === 'combobox' || role === 'listbox') {
        try {
          await selectDropdownIfEmpty(el, 'Required field');
          return true;
        } catch (_) {}
      }

      if (tag === 'select') {
        try {
          const options = el.locator('option');
          const count = await options.count();
          if (count > 1) {
            await el.selectOption({ index: 1 });
            return true;
          }
        } catch (_) {}
      }

      if (tag === 'textarea') {
        try { await el.fill('Auto-filled to proceed - Coursedog test'); } catch (_) {}
        return true;
      }

      if (tag === 'input') {
        if (typeAttr === 'number') {
          try { await el.fill('1'); } catch (_) {}
          return true;
        }
        if (typeAttr === 'date') {
          try {
            const today = new Date();
            const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
            await el.fill(formatted);
            try { await el.press('Enter'); } catch (_) {}
          } catch (_) {}
          return true;
        }
        try { await el.fill('Auto-filled to proceed - Coursedog test'); } catch (_) {}
        return true;
      }

      if (cls.includes('date') || cls.includes('datepicker') || cls.includes('date-picker')) {
        try {
          const nested = el.locator('input[type="text"], input[type="date"], input').first();
          if ((await nested.count()) > 0) {
            const today = new Date();
            const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
            await nested.fill(formatted);
            try { await nested.press('Enter'); } catch (_) {}
            return true;
          }
        } catch (_) {}
      }

      const nested = el.locator('input, textarea, select').first();
      if ((await nested.count()) > 0) {
        const nestedTag = await nested.evaluate(n => n.tagName.toLowerCase()).catch(() => '');
        if (nestedTag === 'textarea') {
          try { await nested.fill('Auto-filled to proceed - Coursedog test'); } catch (_) {}
        } else if (nestedTag === 'select') {
          try {
            const options = nested.locator('option');
            const count = await options.count();
            if (count > 1) { await nested.selectOption({ index: 1 }); }
          } catch (_) {}
        } else {
          const nestedType = (await nested.getAttribute('type')) || '';
          if (nestedType === 'number') {
            try { await nested.fill('1'); } catch (_) {}
          } else if (nestedType === 'date') {
            try {
              const today = new Date();
              const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              const formatted = `${monthNames[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;
              await nested.fill(formatted);
              try { await nested.press('Enter'); } catch (_) {}
            } catch (_) {}
          } else {
            try { await nested.fill('Auto-filled to proceed - Coursedog test'); } catch (_) {}
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
        control = await getFirstUsable([
          'xpath=following::*[self::input or self::select or self::textarea or contains(@class, "multiselect") or @role="combobox" or @role="listbox"][1]'
        ]);
      }

      if (!control) continue;

      // Identify closest data-test wrapper to respect protections
      let qid = null;
      try {
        const wrapperWithDataTest = control.locator('xpath=ancestor-or-self::*[@data-test][1]').first();
        if ((await wrapperWithDataTest.count()) > 0) {
          qid = await wrapperWithDataTest.getAttribute('data-test');
        }
      } catch (_) {}
      if (qid && protectedQids.has(qid)) {
        console.log(`   ┗ ⏭️ [Sections] Prefill skip for protected field: ${qid}`);
        continue;
      }

      const empty = await controlIsEmpty(control);
      if (!empty) continue;

      try { await control.scrollIntoViewIfNeeded(); } catch (_) {}

      try {
        const ok = await fillControl(control);
        if (ok) filled++;
      } catch (_) {}
    }

    console.log(`✅ [Sections] Pre-filled ${filled} required field(s) before save`);
  } catch (error) {
    console.log(`⚠️ [Sections] Error during preFillRequiredEmptySectionFields: ${error.message}`);
  }
}

async function saveSection(page, outputDir, action, browser = null, schoolId = '') {
  try { ensureRunLogger(outputDir); } catch (_) {}
  await page.waitForTimeout(1500);
  const saveBtn = page.locator('button[data-test="save-section-btn"]');

  if (await saveBtn.count() > 0) {
    // Attempt to pre-fill any empty required fields before checking disabled state
    try { await preFillRequiredEmptySectionFields(page); } catch (_) {}
    // Check if save button is disabled
    const isDisabled = await saveBtn.first().getAttribute('disabled') !== null;
    if (isDisabled) {
      console.log('❌ Save Section button is disabled. Section cannot be saved.');
      console.log('📸 Taking screenshot for error details...');
      await captureModalError(page, outputDir);
      console.log('💡 Please check the screenshot for validation errors or missing required fields.');
      
      // Check if the disabled state is due to instructor double booking
      const pageContent = await page.content();
      const doubleBookingError = pageContent.includes('instructor is already assigned to another section') || 
                                 pageContent.includes('already assigned to another section');
      
      if (doubleBookingError) {
        console.log('🔍 [Double Bookings] Detected instructor double booking preventing save!');
        console.log('🔄 [Double Bookings] Attempting to resolve by setting Ignore Double Bookings to Yes...');
        
        const ignoreSuccess = await ignoreDoubleBookings(page);
        if (ignoreSuccess) {
          console.log('✅ [Double Bookings] Successfully set Ignore Double Bookings for all professors.');
          console.log('🔄 [Double Bookings] Checking if save button is now enabled...');
          
          // Wait a moment and check if save button is now enabled
          await page.waitForTimeout(2000);
          const saveButtonAfterFix = page.locator('button[data-test="save-section-btn"]');
          const isStillDisabled = await saveButtonAfterFix.first().getAttribute('disabled') !== null;
          
          if (!isStillDisabled) {
            console.log('🎉 [Double Bookings] Save button is now enabled! Calling saveSection to handle the save...');
            
            // Call the existing saveSection function to handle save properly with conflict modals
            const saveResult = await saveSection(page, outputDir, action, browser, schoolId);
            if (saveResult) {
              console.log('🎉 [Double Bookings] Section saved successfully after resolving double booking!');
              return true;
            } else {
              console.log('⚠️ [Double Bookings] Section still has errors after resolving double booking.');
            }
          } else {
            console.log('⚠️ [Double Bookings] Save button is still disabled after resolving double booking.');
          }
        } else {
          console.log('❌ [Double Bookings] Failed to set Ignore Double Bookings.');
        }
      }
      
      // Offer user takeover for disabled save button (either non-double-booking errors or failed double-booking fix)
      if (browser && schoolId) {
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const errorMessage = doubleBookingError ? 
            'Save button is disabled - double booking error (attempted auto-fix failed)' :
            'Save button is disabled - validation errors or missing fields';
          const takeoverResult = await offerUserTakeover(page, browser, outputDir, 'section-save', schoolId, action, errorMessage, null, true);
          
          if (takeoverResult.success) {
            if (takeoverResult.sectionChanged) {
              console.log(`🔄 User switched to different section: "${takeoverResult.newSectionId}"`);
              console.log('🔄 Restarting section template process with new section...');
              
              // Restart the entire section template fill process with the new section
              return await restartSectionTemplateProcess(page, outputDir, action, schoolId, browser);
            } else if (takeoverResult.sectionSaved) {
              console.log('✅ User intervention successful - section saved manually (modal closed)');
              return true;
            } else {
              console.log('✅ User intervention successful - section saved manually');
              return true;
            }
          }
        }
      }
      
      return false;
    }

    if (await saveBtn.first().isVisible()) {
      await saveBtn.first().click();
      await page.waitForTimeout(3500); // Wait for conflict modal to appear

      // Robustly handle conflict modal
      const saveAnywayBtn = page.locator('button[data-test="save_anyway"]');
      if (await saveAnywayBtn.count() > 0 && await saveAnywayBtn.first().isVisible()) {
        console.log('⚠️ Conflict modal detected! Taking screenshot of entire page...');
        
        // Take screenshot of the entire page when conflict modal is detected
        const conflictScreenshotPath = path.join(outputDir, `${action}-section-conflictModal.png`);
        await page.screenshot({ path: conflictScreenshotPath, fullPage: true });
        console.log(`📸 Conflict modal screenshot saved to: ${conflictScreenshotPath}`);
        
        await saveAnywayBtn.first().click();
        console.log('   ┗ Clicked "Save Anyway" button in conflict modal.');
        await page.waitForTimeout(1000); // Wait for modal to process
      }

      // Before checking for errors, ensure we write a diff at least once per run if possible
      try {
        if (!__diffState.wrote && schoolId && outputDir) {
          if (!__diffState.before) {
            try { __diffState.before = await readSectionValues(page, schoolId); } catch (_) {}
          }
          const afterVals = await readSectionValues(page, schoolId);
          const ts = (__diffState.context?.dateStr) || getTimestamp();
          await writeSectionDiff(__diffState.before, afterVals, schoolId, outputDir, action, ts);
        }
      } catch (diffErr) {
        console.log(`⚠️ [Save] Diff attempt before error check failed: ${diffErr.message}`);
      }

      // take screenshot if save section returns UI errors
      const errorIcon = await page.$('.material-icons.pr-2');
      if (errorIcon) {
        console.log('❌ Error detected after saving section!');
        await captureModalError(page, outputDir);
        
        // Check if the error is related to instructor double booking
        const pageContent = await page.content();
        const doubleBookingError = pageContent.includes('instructor is already assigned to another section') || 
                                   pageContent.includes('already assigned to another section') ||
                                   pageContent.includes('instructor.*already.*assigned');
        
        if (doubleBookingError) {
          console.log('🔍 [Double Bookings] Detected instructor double booking error!');
          console.log('🔄 [Double Bookings] Attempting to resolve by setting Ignore Double Bookings to Yes...');
          
          const ignoreSuccess = await ignoreDoubleBookings(page);
          if (ignoreSuccess) {
            console.log('✅ [Double Bookings] Successfully set Ignore Double Bookings for all professors.');
            console.log('🔄 [Double Bookings] Attempting to save section again...');
            
            // Call the existing saveSection function to handle save properly with conflict modals
            console.log('🔄 [Double Bookings] Calling saveSection to handle the retry save...');
            const retryResult = await saveSection(page, outputDir, action, browser, schoolId);
            if (retryResult) {
              console.log('🎉 [Double Bookings] Section saved successfully after resolving double booking!');
              return true;
            } else {
              console.log('⚠️ [Double Bookings] Section still has errors after resolving double booking.');
            }
          } else {
            console.log('❌ [Double Bookings] Failed to set Ignore Double Bookings.');
          }
        }
        
        // Offer user takeover for post-save errors (either non-double-booking errors or failed double-booking fix)
        if (browser && schoolId) {
          const userResponse = await waitForUserResponseWithTimeout(5);
          if (userResponse === 'yes') {
            const errorMessage = doubleBookingError ? 
              'Error detected after attempting to save section (double booking error - attempted auto-fix failed)' :
              'Error detected after attempting to save section';
            const takeoverResult = await offerUserTakeover(page, browser, outputDir, 'section-save', schoolId, action, errorMessage, null, true);
            
            if (takeoverResult.success) {
              if (takeoverResult.sectionChanged) {
                console.log(`🔄 User switched to different section: "${takeoverResult.newSectionId}"`);
                console.log('🔄 Restarting section template process with new section...');
                
                // Restart the entire section template fill process with the new section
                return await restartSectionTemplateProcess(page, outputDir, action, schoolId, browser);
              } else if (takeoverResult.sectionSaved) {
                console.log('✅ User intervention successful - section saved manually (modal closed)');
                return true;
              } else {
                console.log('✅ User intervention successful - section saved manually');
                return true;
              }
            }
          }
        }
        
        return false;
      } else {
        console.log('✅ No error detected after saving section.');
      }
      
      // Check for API error notification
      const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
      if (apiError) {
        console.log('❌ API error detected, section save failed due to template issue');
        return false;
      }
      
      console.log(`✅ Saved Section`);
      return true;
    } else {
      console.log(`❌ Could not find or click the Save Section button.`);
      return false;
    }
  } else {
    console.log(`❌ Could not find the Save Section button.`);
    return false;
  }
}

async function validateAndResetMeetingPatterns(page, outputDir, action) {
  try { ensureRunLogger(outputDir); } catch (_) {}
  console.log('🔎 [Meeting Patterns] Locating Meeting Patterns & Rooms section...');
  const meetingPatternSection = page.locator('[data-card-id="times"]');
  let found = false;
  let deletedCount = 0;
  
  // Keep trying to delete patterns until none remain
  while (true) {
    // Try multiple selectors to find meeting patterns based on actual HTML structure
    let patternLocator = meetingPatternSection.locator('[aria-label^="Meeting Pattern"]');
    let count = await patternLocator.count();
    let patternType = 'aria-label';
    
    // If no patterns found with aria-label, try custom time patterns
    if (count === 0) {
      patternLocator = meetingPatternSection.locator('[data-test="custom_time"]');
      count = await patternLocator.count();
      patternType = 'custom_time';
      console.log(`🔍 [Meeting Patterns] Trying custom_time selector - found ${count} pattern(s)`);
    }
    
    // If still none, try timeblock patterns
    if (count === 0) {
      patternLocator = meetingPatternSection.locator('[data-test="timeblock"]');
      count = await patternLocator.count();
      patternType = 'timeblock';
      console.log(`🔍 [Meeting Patterns] Trying timeblock selector - found ${count} pattern(s)`);
    }
    
    // If still none, try table rows as fallback
    if (count === 0) {
      patternLocator = meetingPatternSection.locator('.tr.row.bg-white').filter({ hasNot: page.locator('.thead') });
      count = await patternLocator.count();
      patternType = 'table-row';
      console.log(`🔍 [Meeting Patterns] Trying table row selector - found ${count} row(s)`);
    }
    
    if (count > 0) {
      found = true;
      console.log(`🗑️ [Meeting Patterns] Found ${count} Meeting Pattern(s) using ${patternType} selector, attempting deletion...`);
      
      try {
        // Always target the first pattern (they renumber after deletion)
        const firstPattern = patternLocator.first();
        
        // More aggressive pattern detection for delete button based on actual HTML
        let deleteSuccess = false;
        
        // Strategy 1: Look for delete_block button (original structure)
        let deleteBtn = meetingPatternSection.locator('button[data-test="delete_block"]').first();
        if (await deleteBtn.count() > 0 && await deleteBtn.isVisible()) {
          await deleteBtn.click();
          deleteSuccess = true;
          console.log(`   ┗ Deleted Meeting Pattern ${deletedCount + 1} (delete_block)`);
        }
        
        // Strategy 2: Look for delete_meeting_pattern_X button (after deletion structure)
        if (!deleteSuccess) {
          deleteBtn = meetingPatternSection.locator('button[data-test^="delete_meeting_pattern"]').first();
          if (await deleteBtn.count() > 0 && await deleteBtn.isVisible()) {
            await deleteBtn.click();
            deleteSuccess = true;
            console.log(`   ┗ Deleted Meeting Pattern ${deletedCount + 1} (delete_meeting_pattern)`);
          }
        }
        
        // Strategy 3: Try aria-label based deletion
        if (!deleteSuccess) {
          deleteBtn = meetingPatternSection.locator('button[aria-label*="Delete Meeting Pattern"]').first();
          if (await deleteBtn.count() > 0 && await deleteBtn.isVisible()) {
            await deleteBtn.click();
            deleteSuccess = true;
            console.log(`   ┗ Deleted Meeting Pattern ${deletedCount + 1} (aria-label)`);
          }
        }
        
        // Strategy 4: Hover on pattern and try delete button
        if (!deleteSuccess) {
          try {
            await firstPattern.hover();
            await page.waitForTimeout(300);
            deleteBtn = meetingPatternSection.locator('button[data-test="delete_block"], button[data-test^="delete_meeting_pattern"]').first();
            if (await deleteBtn.count() > 0 && await deleteBtn.isVisible()) {
              await deleteBtn.click();
              deleteSuccess = true;
              console.log(`   ┗ Deleted Meeting Pattern ${deletedCount + 1} (hover + delete)`);
            }
          } catch (hoverError) {
            console.log(`   ┃ Hover failed`);
          }
        }
        
        // Strategy 5: Try any button with remove icon or delete text
        if (!deleteSuccess) {
          deleteBtn = meetingPatternSection.locator('button:has(.material-icons:has-text("remove_circle")), button:has-text("Delete")').first();
          if (await deleteBtn.count() > 0 && await deleteBtn.isVisible()) {
            await deleteBtn.click();
            deleteSuccess = true;
            console.log(`   ┗ Deleted Meeting Pattern ${deletedCount + 1} (remove icon)`);
          }
        }
        
        if (deleteSuccess) {
          deletedCount++;
          await page.waitForTimeout(1200); // Longer wait for UI to fully update and DOM changes
          
          // Verify deletion worked by checking multiple pattern detection methods
          const ariaCount = await meetingPatternSection.locator('[aria-label^="Meeting Pattern"]').count();
          const customCount = await meetingPatternSection.locator('[data-test="custom_time"]').count();
          const timeblockCount = await meetingPatternSection.locator('[data-test="timeblock"]').count();
          const maxCount = Math.max(ariaCount, customCount, timeblockCount);
          
          console.log(`   ┗ After deletion: ${maxCount} pattern(s) remaining (aria:${ariaCount}, custom:${customCount}, timeblock:${timeblockCount})`);
          
          if (maxCount >= count) {
            console.log(`   ⚠️ Pattern count didn't decrease - deletion may have failed`);
            break; // Prevent infinite loop
          }
        } else {
          console.log(`   ┗ ⚠️ No delete button found for Meeting Pattern, stopping deletion`);
          break;
        }
      } catch (error) {
        console.log(`   ┗ ⚠️ Error deleting Meeting Pattern: ${error.message}`);
        break;
      }
    } else {
      // No more patterns found
      break;
    }
  }
  
  if (!found) {
    console.log('ℹ️ [Meeting Patterns] No existing meeting patterns found.');
  } else {
    console.log(`✅ [Meeting Patterns] Deleted ${deletedCount} meeting pattern(s)`);
  }

  // 2. If no patterns found, or after all are deleted, add a new one
  console.log('🔍 [Meeting Patterns] Looking for add button...');
  
  let addTimeBtn;
  let buttonFound = false;
  let buttonName = '';
  
  // Try different button variations in order of preference
  const buttonSelectors = [
    { selector: 'button[data-test="AddMeetingPattern"]', name: 'AddMeetingPattern', scope: 'section' },
    { selector: 'button[data-test="AddMeetingPattern"]', name: 'AddMeetingPattern', scope: 'global' },
    { selector: 'button[data-test="add_time"]', name: 'add_time', scope: 'section' },
    { selector: 'button[data-test="add_time"]', name: 'add_time', scope: 'global' },
    { selector: 'button[data-test="AddTime"]', name: 'AddTime', scope: 'section' },
    { selector: 'button[data-test="AddTime"]', name: 'AddTime', scope: 'global' }
  ];
  
  for (const btnConfig of buttonSelectors) {
    if (btnConfig.scope === 'section') {
      addTimeBtn = meetingPatternSection.locator(btnConfig.selector);
    } else {
      addTimeBtn = page.locator(btnConfig.selector);
    }
    
    const count = await addTimeBtn.count();
    if (count > 0 && await addTimeBtn.first().isVisible()) {
      buttonFound = true;
      buttonName = `${btnConfig.name} (${btnConfig.scope})`;
      console.log(`✅ [Meeting Patterns] Found ${buttonName} button`);
      break;
    }
  }
  
  if (buttonFound && addTimeBtn) {
    console.log(`➕ [Meeting Patterns] Adding a new meeting pattern using ${buttonName}...`);
    await addTimeBtn.first().click();
    await page.waitForTimeout(500);
    console.log('   ┗ Adding new meeting pattern.');
    
    // Check for "Select Meeting Pattern" modal
    const selectPatternModal = page.locator('h5.font-weight-semi-bold', { hasText: 'Select Meeting Pattern' });
    if (await selectPatternModal.count() > 0 && await selectPatternModal.first().isVisible()) {
      console.log('🟦 [Meeting Patterns] "Select Meeting Pattern" modal detected. Clicking USE CUSTOM TIMES...');
      const useCustomTimesBtn = page.locator('button.btn.btn-secondary', { hasText: 'USE CUSTOM TIMES' });
      if (await useCustomTimesBtn.count() > 0 && await useCustomTimesBtn.first().isVisible()) {
        await useCustomTimesBtn.first().click();
        await page.waitForTimeout(500);
        console.log('   ┗ Clicked USE CUSTOM TIMES.');
      } else {
        console.log('⚠️ [Meeting Patterns] Could not find USE CUSTOM TIMES button.');
      }
    }
  } else {
    console.log('⚠️ [Meeting Patterns] Could not find any add button variant.');
    console.log('🔍 [Meeting Patterns] Tried: AddMeetingPattern, add_time, AddTime (both section and global scope)');
    // Log the HTML for troubleshooting
    const html = await meetingPatternSection.innerHTML();
    console.log('Meeting Patterns section HTML:', html);
    return; // Exit early if no add button found
  }

  // 3. Click Monday - wait for day buttons to appear after adding pattern
  await page.waitForTimeout(1000); // Wait for day buttons to load
  const mondayBtn = meetingPatternSection.locator('button[data-test="day_button_1"][aria-label="Toggle Monday"]');
  if (await mondayBtn.count() > 0) {
    console.log('📅 [Meeting Patterns] Selecting Monday...');
    await mondayBtn.first().click();
    await page.waitForTimeout(300);
    console.log('   ┗ Monday selected.');
  } else {
    console.log('⚠️ [Meeting Patterns] Could not find Monday button.');
    // Log available day buttons for debugging
    const dayButtons = meetingPatternSection.locator('button[data-test*="day_button"]');
    const dayButtonCount = await dayButtons.count();
    console.log(`   ┗ Found ${dayButtonCount} day buttons total.`);
  }

  // 4. Click room select to open modal (fix: use div.room-select-modal)
  const roomSelectBtn = meetingPatternSection.locator('[data-test=\"room-select-modal\"]');
  if (await roomSelectBtn.count() > 0 && await roomSelectBtn.first().isVisible()) {
    console.log('🏫 [Meeting Patterns] Opening room select modal...');
    await roomSelectBtn.first().click();
    // Wait for assign-room-modal
    const assignRoomModal = page.locator('[data-test="assign-room-modal"]');
    await assignRoomModal.waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ┗ Room select modal opened.');
    // Click first item in the list
    await page.waitForTimeout(9000); // Wait for rooms list to load
    await assignRoomModal.first().press('Enter');
    console.log('🏷️ [Meeting Patterns] Selecting first room in the list...');
  }

  // 5. Click set details
  const setDetailsBtn = meetingPatternSection.locator('button[data-test="set_details"]');
  if (await setDetailsBtn.isVisible()) {
    console.log('⚙️ [Meeting Patterns] Opening "Set Details" modal...');
    await setDetailsBtn.click();
    // Wait for "Meeting Patterns Additional Information" modal
    const detailsModal = page.locator('.app-heading', { hasText: 'Meeting Patterns Additional Information' });
    await detailsModal.waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ┗ "Meeting Patterns Additional Information" modal opened.');
    await page.waitForTimeout(1000);
    
    // Note: "before" screenshot moved to meetAndProfDetails()
    const modalContent = page.locator('[data-test="meeting-patterns-details-modal"]');
    const meetingDialog = modalContent.locator('xpath=ancestor::div[contains(@class,"modal-dialog")]').first();

    await page.waitForTimeout(1000);
    // Check for ANY multiselect dropdown in the meeting pattern details modal
    const allDropdowns = page.locator('[data-test="meeting-patterns-details-modal"] .multiselect');
    if (await allDropdowns.count() > 0) {
      console.log(`🎓 [Meeting Patterns] Found ${await allDropdowns.count()} dropdown(s) in modal, validating and updating only empty dropdowns...`);
      
      // Try each dropdown but only update if empty
      for (let i = 0; i < await allDropdowns.count(); i++) {
        const dropdown = allDropdowns.nth(i);
        if (await dropdown.isVisible()) {
          console.log(`   ┣ Validating dropdown #${i + 1}...`);
          await selectDropdownIfEmpty(dropdown, `Meeting Pattern Dropdown #${i + 1}`, page);
        }
      }
    } else {
      console.log('ℹ️ [Meeting Patterns] No dropdowns found in the modal.');
    }
    

    // Close the modal
    const closeBtn = meetingDialog.locator('button[data-test="close-modal-btn"]');

    // Save screenshot of the modal content instead of whole page
    await page.waitForTimeout(1000);
    const screenshotAfter = path.join(outputDir, `${action}-section-MeetingPattern-Details-After.png`);
    await modalContent.screenshot({ path: screenshotAfter });

    console.log(`\n✅ Screenshot saved to ${screenshotAfter}`);
    if (await closeBtn.count() > 0) {
      console.log('❌ [Meeting Patterns] Closing "Set Details" modal...');
      try {
        // Check if close button is visible and enabled
        const isVisible = await closeBtn.first().isVisible();
        const isEnabled = await closeBtn.first().isEnabled();
        
        if (isVisible && isEnabled) {
          await closeBtn.first().click();
          await page.waitForTimeout(500);
          console.log('   ┗ "Set Details" modal closed via close button.');
        } else {
          console.log('⚠️ [Meeting Patterns] Close button not visible or enabled. Trying fallback methods...');
          
          const fallbackClose = meetingDialog.locator('button[aria-label="Close modal"]');
          if (await fallbackClose.count() > 0) {
            await fallbackClose.first().click();
            await page.waitForTimeout(500);
            console.log('   ┗ "Set Details" modal closed via close icon.');
          } else {
            console.log(`   ┗ Close icon not available; trying escape key.`);
            try {
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
              console.log('   ┗ "Set Details" modal closed via escape key.');
            } catch (err2) {
              console.log(`   ┗ Error using escape key: ${err2.message}`);
              console.log('   ┗ Could not close modal using any method.');
            }
          }
        }
      } catch (err) {
        console.log(`❌ [Meeting Patterns] Error closing modal: ${err.message}`);
        console.log('   ┗ Trying fallback methods...');
        
        const fallbackClose = meetingDialog.locator('button[aria-label="Close modal"]');
        if (await fallbackClose.count() > 0) {
          await fallbackClose.first().click();
          await page.waitForTimeout(500);
          console.log('   ┗ "Set Details" modal closed via fallback close icon.');
        } else {
          console.log(`   ┗ Close icon fallback also missing, trying escape key.`);
          try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            console.log('   ┗ "Set Details" modal closed via escape key fallback.');
          } catch (escapeErr) {
            console.log(`   ┗ Escape key fallback also failed: ${escapeErr.message}`);
            console.log('   ┗ Could not close modal using any method.');
          }
        }
      }
    } else {
      console.log('⚠️ [Meeting Patterns] Could not find close button for "Set Details" modal.');
      console.log('   ┗ Trying fallback methods...');
      
      const fallbackClose = meetingDialog.locator('button[aria-label="Close modal"]');
      if (await fallbackClose.count() > 0) {
        await fallbackClose.first().click();
        await page.waitForTimeout(500);
        console.log('   ┗ "Set Details" modal closed via fallback close icon.');
      } else {
        console.log(`   ┗ Close icon fallback missing, trying escape key.`);
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          console.log('   ┗ "Set Details" modal closed via escape key fallback.');
        } catch (escapeErr) {
          console.log(`   ┗ Escape key fallback also failed: ${escapeErr.message}`);
          console.log('   ┗ Could not close modal using any method.');
        }
      }
    }
  } else {
    console.log('⚠️ [Meeting Patterns] Could not find "Set Details" button.');
  }
}

/**
 * Function to set Ignore Double Bookings to Yes for all professors
 * @param {Object} page - Playwright page object
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function ignoreDoubleBookings(page) {
  try {
    console.log('🔄 [Double Bookings] Starting Ignore Double Bookings process...');
    
    // Locate the professors card
    const professorsCard = page.locator('#field-professors');
    if (await professorsCard.count() === 0) {
      console.log('⚠️ [Double Bookings] Professors card not found.');
      return false;
    }
    
    console.log('✅ [Double Bookings] Found professors card.');
    
    // Click on "Set Instructor Roles & Details" button
    const setDetailsBtn = page.locator('button[data-test="openInstructorsMetaDetailsModal"]');
    if (await setDetailsBtn.count() === 0 || !await setDetailsBtn.first().isVisible()) {
      console.log('⚠️ [Double Bookings] "Set Instructor Roles & Details" button not found or not visible.');
      return false;
    }
    
    console.log('🖱️ [Double Bookings] Clicking "Set Instructor Roles & Details" button...');
    await setDetailsBtn.first().click();
    await page.waitForTimeout(2000);
    
    // Wait for the modal to open
    const modal = page.locator('[data-test="instructorsMetaDetailsModal"]');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    console.log('✅ [Double Bookings] Instructor details modal opened.');
    
    // Find all accordion buttons to expand professor details
    const accordionButtons = modal.locator('.flex-1.d-flex.accordion-style--left');
    const buttonCount = await accordionButtons.count();
    console.log(`📋 [Double Bookings] Found ${buttonCount} professor accordion(s).`);
    
    if (buttonCount === 0) {
      console.log('⚠️ [Double Bookings] No professor accordions found in modal.');
      await closeInstructorModal(page);
      return false;
    }
    
    // Process each professor accordion to set Ignore Double Bookings to Yes
    for (let i = 0; i < buttonCount; i++) {
      console.log(`🔍 [Double Bookings] Processing professor ${i + 1}/${buttonCount}...`);
      
      try {
        // Step 1: First try to find the Ignore Double Bookings field (accordion likely already expanded)
        console.log(`   🔍 Looking for Ignore Double Bookings field for professor ${i + 1}...`);
        
        const ignoreBookingsFieldset = modal.locator('fieldset[data-test="professors.ignoreDoubleBookings"]');
        let fieldsetFound = false;
        
        try {
          await ignoreBookingsFieldset.waitFor({ state: 'visible', timeout: 2000 });
          const fieldsetCount = await ignoreBookingsFieldset.count();
          fieldsetFound = fieldsetCount > 0;
        } catch (waitError) {
          // Field not immediately visible, will try expanding accordion
        }
        
        // Step 2: If field not found, try expanding the accordion
        if (!fieldsetFound) {
          console.log(`   🔽 Ignore Double Bookings field not visible, expanding professor accordion ${i + 1}...`);
          const accordionBtn = accordionButtons.nth(i);
          await accordionBtn.click();
          await page.waitForTimeout(1500); // Wait for accordion to fully expand
          
          // Try to find the field again after expanding
          try {
            await ignoreBookingsFieldset.waitFor({ state: 'visible', timeout: 3000 });
            const fieldsetCount = await ignoreBookingsFieldset.count();
            fieldsetFound = fieldsetCount > 0;
          } catch (waitError2) {
            console.log(`   ⚠️ Ignore Double Bookings fieldset still not found after expanding accordion for professor ${i + 1}`);
            continue;
          }
        }
        
        if (!fieldsetFound) {
          console.log(`   ⚠️ Ignore Double Bookings fieldset not found for professor ${i + 1}`);
          continue;
        }
        
        console.log(`   📋 Found Ignore Double Bookings fieldset for professor ${i + 1}`);
        
        // Step 3: Get the YES button within this fieldset
        const yesButton = ignoreBookingsFieldset.locator('button[data-test="YesBtn"]');
        
        try {
          await yesButton.waitFor({ state: 'visible', timeout: 3000 });
        } catch (buttonWaitError) {
          console.log(`   ⚠️ YES button not visible for professor ${i + 1}`);
          continue;
        }
        
        if (await yesButton.count() === 0) {
          console.log(`   ⚠️ YES button not found in fieldset for professor ${i + 1}`);
          continue;
        }
        
        // Step 4: Click on the YES button if not already active
        const buttonClass = await yesButton.getAttribute('class') || '';
        const isAlreadyActive = buttonClass.includes('btn-raised');
        
        console.log(`   🔍 YES button class: "${buttonClass}", already active: ${isAlreadyActive}`);
        
        if (!isAlreadyActive) {
          console.log(`   🖱️ Clicking YES button for professor ${i + 1}...`);
          await yesButton.click();
          await page.waitForTimeout(1000);
          
          // Step 5: Validate YesBtn is now raised
          const updatedButtonClass = await yesButton.getAttribute('class') || '';
          const isNowActive = updatedButtonClass.includes('btn-raised');
          
          if (isNowActive) {
            console.log(`   ✅ Successfully set Ignore Double Bookings to YES for professor ${i + 1}`);
          } else {
            console.log(`   ❌ Failed to activate YES button for professor ${i + 1}. Class: "${updatedButtonClass}"`);
          }
        } else {
          console.log(`   ℹ️ Ignore Double Bookings already set to YES for professor ${i + 1}`);
        }
        
      } catch (error) {
        console.log(`   ❌ Error processing professor ${i + 1}: ${error.message}`);
        continue;
      }
    }
    
    console.log('✅ [Double Bookings] Completed setting Ignore Double Bookings for all professors.');
    
    // Close the modal
    console.log('🚪 [Double Bookings] Closing instructor details modal...');
    const closeBtn = modal.locator('button[data-test="close-modal-btn"]');
    if (await closeBtn.count() > 0 && await closeBtn.first().isVisible()) {
      await closeBtn.first().click();
      await page.waitForTimeout(1000);
      await page.waitForSelector('[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
      console.log('   ✅ Modal closed via footer successfully.');
    } else {
      const xClose = modal.locator('button[aria-label="Close modal"], button[data-test="close-x-btn"], button[data-test="closeby-x-btn"], .modal-header .close');
      if (await xClose.count() > 0 && await xClose.first().isVisible()) {
        await xClose.first().click();
        await page.waitForTimeout(1000);
        await page.waitForSelector('[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
        console.log('   ✅ Modal closed via header X successfully.');
      } else {
        // Fallback: overlay click, then escape
        const overlay = page.locator('div.modal-dimness').last();
        if (await overlay.count() > 0 && await overlay.first().isVisible()) {
          try { await overlay.first().click(); await page.waitForTimeout(1000); } catch (_) {}
          console.log('   ✅ Modal close attempted via overlay.');
        } else {
          try { await page.keyboard.press('Escape'); await page.waitForTimeout(1000); } catch (_) {}
          console.log('   ✅ Modal close attempted via Escape.');
        }
      }
    }
    
    console.log('🎉 [Double Bookings] Ignore Double Bookings process completed successfully.');
    return true;
    
  } catch (error) {
    console.error(`❌ [Double Bookings] Error in ignoreDoubleBookings function: ${error.message}`);
    // Try to close any open modal before returning
    try {
      await closeInstructorModal(page);
    } catch (closeError) {
      // Silent fail on close attempt
    }
    return false;
  }
}

/**
 * Helper function to close instructor modal
 * @param {Object} page - Playwright page object
 * @param {Object} browser - Browser object (optional, for API error check)
 * @param {string} schoolId - School identifier (optional, for API error check)
 * @param {string} outputDir - Output directory (optional, for API error check)
 * @param {string} action - Action being performed (optional, for API error check)
 */
async function closeInstructorModal(page, browser = null, schoolId = null, outputDir = null, action = null) {
  console.log('   ┗ Closing instructor modal...');
  try {
    // Prefer scoped footer close, then header close, then overlay, then escape
    const content = page.locator('[data-test="instructorsMetaDetailsModal"]');
    const modalDialog = content.locator('xpath=ancestor::div[contains(@class,"modal-dialog")]').first();
    const footerClose = modalDialog.locator('.modal-footer button[data-test="close-modal-btn"]');
    if (await footerClose.count() > 0 && await footerClose.first().isVisible()) {
      await footerClose.first().click();
      await page.waitForTimeout(500);
    } else {
      const xClose = modalDialog.locator('button[aria-label="Close modal"], button[data-test="close-x-btn"], button[data-test="closeby-x-btn"], .modal-header .close');
      if (await xClose.count() > 0 && await xClose.first().isVisible()) {
        await xClose.first().click();
        await page.waitForTimeout(500);
      } else {
        const overlay = page.locator('div.modal-dimness').last();
        if (await overlay.count() > 0 && await overlay.first().isVisible()) {
          try { await overlay.first().click(); await page.waitForTimeout(500); } catch (_) {}
        } else {
          try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch (_) {}
        }
      }
    }
    
    console.log('   ┗ Instructor modal closed successfully.');
    
    // Check for API error after closing modal (if parameters provided)
    if (browser && schoolId && outputDir && action) {
      const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
      if (apiError) {
        console.log('❌ API error detected after closing instructor modal');
        return true; // Return true to indicate error was found
      }
    }
    
    return false; // Return false to indicate no error
  } catch (err) {
    console.log(`   ┗ Error closing instructor modal: ${err.message}`);
    return false;
  }
}

/**
 * Check for API error notification after save and handle it
 * @param {Page} page - Playwright page object
 * @param {string} outputDir - Output directory for screenshots
 * @param {Object} browser - Browser object for user takeover
 * @param {string} schoolId - School identifier
 * @param {string} action - Action being performed
 * @returns {Promise<boolean>} - True if error was found and handled, false if no error
 */
async function checkForApiError(page, outputDir, browser, schoolId, action) {
  try {
    console.log('🔍 Checking for API error notification...');
    await page.waitForTimeout(2000); // Wait 2 seconds for notification to appear
    
    const errorNotification = page.locator('div.notif.notif--error[data-test="apiErrorNotification"]');
    const errorCount = await errorNotification.count();
    
    if (errorCount > 0 && await errorNotification.first().isVisible()) {
      console.log('⚠️ API error notification detected!');
      
      // Click the details button to see more information
      const detailsButton = errorNotification.locator('button.btn.btn-light.notif__details-btn');
      if (await detailsButton.count() > 0) {
        console.log('🔍 Clicking details button to view error information...');
        await detailsButton.first().click();
        await page.waitForTimeout(1500); // Wait for modal to appear
        
        // Look for the error details modal
        const modalDialog = page.locator('.modal-dialog, [role="dialog"]');
        if (await modalDialog.count() > 0 && await modalDialog.first().isVisible()) {
          console.log('📋 Error details modal opened');
          
          // Take screenshot of the error modal
          const errorModalScreenshot = path.join(outputDir, `${action}-api-error-modal.png`);
          await page.screenshot({ path: errorModalScreenshot, fullPage: true });
          console.log(`📸 Error modal screenshot saved to: ${errorModalScreenshot}`);
          
          // Extract error details from the modal
          let responseStatus = 'Not found';
          let responseData = 'Not found';
          
          try {
            // Look for the textarea containing the error logs
            const errorTextarea = page.locator('textarea.notif__logs, textarea.form-control.notif__logs').first();
            if (await errorTextarea.count() > 0) {
              // Try multiple methods to get the textarea content
              let errorText = await errorTextarea.textContent().catch(() => '');
              
              // If textContent is empty, try inputValue
              if (!errorText || errorText.trim() === '') {
                errorText = await errorTextarea.inputValue().catch(() => '');
              }
              
              // If still empty, try getting the value attribute
              if (!errorText || errorText.trim() === '') {
                errorText = await errorTextarea.getAttribute('value').catch(() => '');
              }
              
              if (errorText && errorText.trim() !== '') {
                console.log(`📋 Successfully extracted error text (${errorText.length} characters)`);
                
                // Extract Response Status
                const statusMatch = errorText.match(/Response Status:\s*(\d+)/i);
                if (statusMatch) {
                  responseStatus = statusMatch[1];
                }
                
                // Extract Response Data (everything after "Response Data:" up to end or next field)
                const dataMatch = errorText.match(/Response Data:\s*(.+?)(?=\n[A-Z][a-z]+:|$)/is);
                if (dataMatch) {
                  responseData = dataMatch[1].trim();
                }
              } else {
                console.log(`⚠️ Could not extract text from error textarea`);
              }
            }
          } catch (err) {
            console.log(`⚠️ Error extracting details from textarea: ${err.message}`);
          }
          
          // Log the template issue
          console.log('\n❌ ═══════════════════════════════════════════════════════');
          console.log('❌ TEMPLATE ISSUE DETECTED');
          console.log('❌ ═══════════════════════════════════════════════════════');
          console.log(`Response Status: ${responseStatus}`);
          console.log(`Response Data: ${responseData}`);
          console.log('Please fix the error and try again.');
          console.log('❌ ═══════════════════════════════════════════════════════\n');
        }
      }
      
      // Offer user takeover to fix the issue
      if (browser && schoolId) {
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(
            page, 
            browser, 
            outputDir, 
            'api-error', 
            schoolId, 
            action, 
            'API error detected after save - template validation issue', 
            null, 
            true
          );
          if (takeoverResult.success) {
            console.log('✅ User intervention successful - issue resolved');
            return false; // Return false to indicate error was handled
          }
        }
      }
      
      // User declined or timeout - return true to indicate error was found
      console.log('⚠️ API error detected, skipping merge report polling');
      return true;
    }
    
    console.log('✅ No API error notification detected');
    return false; // No error found
    
  } catch (error) {
    console.log(`⚠️ Error while checking for API error notification: ${error.message}`);
    return false; // Continue normally if check fails
  }
}

async function validateAndResetProfessors(page, outputDir, action, browser = null, schoolId = '', beforeValues = null, dateStr = '') {
  console.log('🔎 [Professors] Locating Instructors card...');
  const instructorsCard = page.locator('[data-card-id="instructors"]');

  // Remove all existing professors
  let foundAny = false;
  while (true) {
    const profSection = instructorsCard.locator('[data-test^="added_professor_"]');
    const count = await profSection.count();
    if (count > 0) {
      foundAny = true;
      // Always operate on the first professor
      const removeBtn = instructorsCard.locator('button[data-test^="remove_professor_"]');
      if (await removeBtn.count() > 0 && await removeBtn.first().isVisible()) {
        await removeBtn.first().click();
        console.log(`🗑️ [Professors] Removed a professor`);
        await page.waitForTimeout(500);
      } else {
        console.log(`⚠️ [Professors] Remove button not found or not visible for professor`);
        break;
      }
    } else {
      break;
    }
  }
  if (!foundAny) {
    console.log('ℹ️ [Professors] No professors found to remove.');
  } else {
    console.log(`✅ [Professors] All professors removed`);
  }

  // Add a new professor
  const addProfBtn = instructorsCard.locator('button.btn.btn-primary', { hasText: 'INSTRUCTOR' });
  if (await addProfBtn.count() > 0 && await addProfBtn.first().isVisible()) {
    await addProfBtn.first().click();
    console.log('➕ [Professors] Clicked add instructor button.');
    await page.waitForTimeout(7000); // Wait for modal to open
    
    // Check for API error immediately after opening instructor modal
    if (browser && schoolId && outputDir) {
      const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
      if (apiError) {
        console.log('❌ API error detected after opening instructor modal');
        await closeInstructorModal(page); // Close modal without API check (already checked)
        return false;
      }
    }
    
    // Check for "No instructors found." message
    const noInstructorsText = page.locator('.text-muted', { hasText: 'No instructors found.' });
    if (await noInstructorsText.count() > 0 && await noInstructorsText.first().isVisible()) {
      console.log('⚠️ [Professors] No instructors found for this department');
      
      // Try to toggle to search all instructors instead of closing
      console.log('   ┣ Attempting to toggle search to all instructors...');
      
      // Try multiple approaches to find and click the toggle
      let toggleClicked = false;
      
              // Approach 1: Try the checkbox directly with force click
        const sameDepartmentCheck = page.locator('[data-test="same-department-check"]');
        if (await sameDepartmentCheck.count() > 0) {
          try {
            await sameDepartmentCheck.click({ force: true });
            console.log('   ┣ ✅ Toggled same-department-check (force click) to search all instructors');
            toggleClicked = true;
          } catch (forceError) {
            // Silent fallback - try other approaches
          }
        }
      
      // Approach 2: Try clicking the label or switch container
      if (!toggleClicked) {
        const switchLabels = [
          'span.bmd-switch-track', // The "All Instructors" toggle track
          '.bmd-switch-track',
          'label:has([data-test="same-department-check"])',
          '.switch:has([data-test="same-department-check"])',
          '.md-switch-track:has([data-test="same-department-check"])',
          'span:has([data-test="same-department-check"])'
        ];
        
        for (const labelSelector of switchLabels) {
          const labelElement = page.locator(labelSelector);
          if (await labelElement.count() > 0) {
            try {
              const isVisible = await labelElement.first().isVisible();
              if (isVisible) {
                await labelElement.first().click();
                console.log(`   ┣ ✅ Toggled via label/container (${labelSelector}) to search all instructors`);
                toggleClicked = true;
                break;
              }
            } catch (labelError) {
              // Silent fallback - continue to next selector
            }
          }
        }
      }
      
      // Approach 3: Try finding by text content and specific switch patterns
      if (!toggleClicked) {
        const textBasedSelectors = [
          'span.bmd-switch-track:has-text("All Instructors")', // Most specific
          '.bmd-switch-track:has-text("All Instructors")',
          'text=All Instructors',
          '*:has-text("All Instructors")'
        ];
        
        for (const textSelector of textBasedSelectors) {
          const textElement = page.locator(textSelector).first();
          if (await textElement.count() > 0) {
            try {
              const isVisible = await textElement.isVisible();
              if (isVisible) {
                await textElement.click();
                console.log(`   ┣ ✅ Toggled via text selector (${textSelector}) to search all instructors`);
                toggleClicked = true;
                break;
              }
            } catch (textError) {
              // Silent fallback - continue to next selector
            }
          }
        }
      }
      
      if (toggleClicked) {
        await page.waitForTimeout(8000); // Wait for the instructor list to reload
        
        // Check for API error immediately after the wait (while notification is still visible)
        if (browser && schoolId && outputDir) {
          const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
          if (apiError) {
            console.log('❌ API error detected while loading instructors');
            await closeInstructorModal(page); // Close modal without API check (already checked)
            return false;
          }
        }
        
        // Check if instructors are now available
        const instructorListUpdated = page.locator('.text-muted', { hasText: 'No instructors found.' });
        const stillNoInstructors = await instructorListUpdated.count() > 0 && await instructorListUpdated.first().isVisible();
        
        if (!stillNoInstructors) {
          console.log('   ┣ ✅ Instructors now available after toggling to all instructors');
          // Continue with instructor selection - don't return here
        } else {
          console.log('   ┣ ⚠️ Still no instructors found even after toggling to all instructors');
          // Close modal and check for API error
          const apiError = await closeInstructorModal(page, browser, schoolId, outputDir, action);
          if (apiError) {
            return false;
          }
          return;
        }
      } else {
        console.log('   ┣ ⚠️ Could not find or click the all instructors toggle, closing modal');
        // Close modal and check for API error
        const apiError = await closeInstructorModal(page, browser, schoolId, outputDir, action);
        if (apiError) {
          return false;
        }
        return;
      }
    }
    
    // Try multiple approaches to find and select a professor
    
    console.log('🔍 [Professors] Searching for professors in modal...');
    await page.waitForTimeout(2000);

    let professorSelected = false;

    // Preferred: click the Conflicts label inside the first professor row
    try {
      const firstProfessorRow = page.locator('.modal-dialog section[data-test^="add_professor_"]').first();
      if (await firstProfessorRow.count() > 0) {
        const conflictsLabel = firstProfessorRow.locator('[data-test="conflicts-label"]');
        const conflictsCount = await conflictsLabel.count();
        console.log(`   ┣ Looking for [data-test="conflicts-label"] in first professor row (found ${conflictsCount})`);
        if (conflictsCount > 0) {
          try { await conflictsLabel.first().evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch {}
          try {
            await conflictsLabel.first().evaluate(el => el.click());
            professorSelected = true;
            console.log('👤 [Professors] Selected professor via click on conflicts label.');
            await page.waitForTimeout(1000);
          } catch (e1) {
            try {
              await conflictsLabel.first().click({ force: true });
              professorSelected = true;
              console.log('👤 [Professors] Selected professor via force click on conflicts label.');
              await page.waitForTimeout(1000);
            } catch (e2) {
              // continue to broader conflicts label search below
            }
          }
        }
      }

      // If not selected yet, try any visible conflicts label within the modal
      if (!professorSelected) {
        const anyConflictsLabel = page.locator('.modal-dialog [data-test="conflicts-label"]').first();
        if (await anyConflictsLabel.count() > 0) {
          try { await anyConflictsLabel.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch {}
          try {
            await anyConflictsLabel.evaluate(el => el.click());
            professorSelected = true;
            console.log('👤 [Professors] Selected professor via modal conflicts label.');
            await page.waitForTimeout(1000);
          } catch (e3) {
            try {
              await anyConflictsLabel.click({ force: true });
              professorSelected = true;
              console.log('👤 [Professors] Selected professor via force click on modal conflicts label.');
              await page.waitForTimeout(1000);
            } catch (e4) {
              // leave professorSelected as false; other strategies will follow
            }
          }
        }
      }
    } catch (_) {}
    
    // First, try to click an "Add Set" button directly
    const addSetButtons = page.locator('button:text("Add Set")');
    const addSetCount = await addSetButtons.count();
    console.log(`   ┣ Found ${addSetCount} "Add Set" buttons`);
    
    if (addSetCount > 0) {
      try {
        await addSetButtons.first().click();
        console.log('👤 [Professors] Clicked "Add Set" button for first professor.');
        professorSelected = true;
        await page.waitForTimeout(1000);
      } catch (error) {
        console.log(`   ┗ Failed to click "Add Set" button: ${error.message}`);
      }
    }
    
    // If "Add Set" didn't work, try robust button-targeted selectors first
    if (!professorSelected) {
      const addButtonsTryOrder = [
        '.modal-dialog button[data-test^="add_professor_"]',
        '.modal-dialog button:has-text("Add Set")',
      ];

      for (const btnSelector of addButtonsTryOrder) {
        const addBtns = page.locator(btnSelector);
        const btnCount = await addBtns.count();
        if (btnCount === 0) continue;

        console.log(`   ┣ Trying add button selector: ${btnSelector} (found ${btnCount})`);
        const addBtn = addBtns.first();
        try {
          // Ensure button is in view
          try { await addBtn.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch {}

          // Strategy 1: JS click to bypass overlay intercepts
          try {
            await addBtn.evaluate(el => el.click());
            professorSelected = true;
            console.log('👤 [Professors] Selected professor via JS click on add button.');
          } catch (e1) {
            // Strategy 2: Force click
            try {
              await addBtn.click({ force: true });
              professorSelected = true;
              console.log('👤 [Professors] Selected professor via force click on add button.');
            } catch (e2) {
              // Strategy 3: Focus + Enter
              try {
                await addBtn.focus();
                await page.keyboard.press('Enter');
                professorSelected = true;
                console.log('👤 [Professors] Selected professor via keyboard on focused add button.');
              } catch (e3) {
                console.log(`   ┗ All click strategies failed for ${btnSelector}: ${e3.message}`);
              }
            }
          }

          if (professorSelected) {
            await page.waitForTimeout(1000);
            break;
          }
        } catch (btnErr) {
          console.log(`   ┗ Error interacting with add button: ${btnErr.message}`);
        }
      }
    }

    // Fallback: try clicking container rows (last resort)
    if (!professorSelected) {
      const professorSelectors = [
        'section[data-test^="add_professor_"]',
        '.modal-dialog section:has(button)',
        '.modal-dialog .row:has(button)'
      ];

      for (const selector of professorSelectors) {
        console.log(`   ┣ Trying selector: ${selector}`);
        const professors = page.locator(selector);
        const count = await professors.count();
        console.log(`   ┗ Found ${count} elements`);

        if (count > 0) {
          try {
            const firstProf = professors.first();
            if (await firstProf.isVisible()) {
              // Try to click an inner button if available
              const innerBtn = firstProf.locator('button');
              if (await innerBtn.count() > 0) {
                try {
                  await innerBtn.first().evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
                } catch {}
                try {
                  await innerBtn.first().evaluate(el => el.click());
                  professorSelected = true;
                  console.log('👤 [Professors] Selected professor via inner button in row.');
                } catch (ib1) {
                  try {
                    await innerBtn.first().click({ force: true });
                    professorSelected = true;
                    console.log('👤 [Professors] Selected professor via force click on inner button.');
                  } catch (ib2) {
                    // Fall back to row click as very last attempt
                    await firstProf.click({ force: true });
                    professorSelected = true;
                    console.log('👤 [Professors] Selected professor via force click on row.');
                  }
                }
              } else {
                await firstProf.click({ force: true });
                professorSelected = true;
                console.log('👤 [Professors] Selected first professor in modal via container.');
              }
              await page.waitForTimeout(1000);
              break;
            }
          } catch (error) {
            console.log(`   ┗ Click failed with ${selector}: ${error.message}`);
            continue;
          }
        }
      }
    }
    
    if (!professorSelected) {
      console.log('⚠️ [Professors] Could not select any professor. Attempting to close modal...');
      // Try to close the modal to prevent UI blocking
      const closeSelectors = ['button:text("CANCEL")', 'button:text("Cancel")', '.modal-header button[aria-label="Close"]'];
      for (const closeSelector of closeSelectors) {
        const closeBtn = page.locator(closeSelector);
        if (await closeBtn.count() > 0) {
          try {
            await closeBtn.first().click();
            console.log(`🚪 [Professors] Closed professor modal using: ${closeSelector}`);
            await page.waitForTimeout(1000);
            
            // Check for API error before returning
            if (browser && schoolId && outputDir) {
              const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
              if (apiError) {
                console.log('❌ API error detected after closing professor modal');
                return false;
              }
            }
            return; // Exit the function
          } catch (error) {
            continue;
          }
        }
      }
      
      // Check for API error before final return
      if (browser && schoolId && outputDir) {
        const apiError = await checkForApiError(page, outputDir, browser, schoolId, action);
        if (apiError) {
          console.log('❌ API error detected, modal could not be closed');
          return false;
        }
      }
      return; // Exit if modal couldn't be closed
    }
      // Click openInstructorsMetaDetailsModal button
      const openDetailsBtn = page.locator('button[data-test="openInstructorsMetaDetailsModal"]');
      if (await openDetailsBtn.count() > 0 && await openDetailsBtn.first().isVisible()) {
        await openDetailsBtn.first().click();
        console.log('⚙️ [Professors] Opened instructor details modal.');
        // Wait for modal dialog
        const modal = page.locator('div.modal-dialog');
        const detailsModal = modal.locator('h3.app-heading', { hasText: 'Set Instructor Roles & Details' });
        await detailsModal.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(1000);
        // Expand professor details
        const profDetails = modal.locator('span.btn.btn-dark.pl-0.py-3.font-weight-bold.text-capitalize');
        if (await profDetails.count() > 0 && await profDetails.first().isVisible()) {
          await profDetails.first().click();
          console.log('👤 [Professors] Expanded on Professor details.');
          await page.waitForTimeout(1000);
          
          // Note: "before" screenshot moved to meetAndProfDetails()
        } else {
          console.log('⚠️ [Professors] Could not find expand button.');
        }
        // Select meeting: Check if already has value first
        console.log('📅 [Professors] Validating meeting dropdown...');
        const meetingDropdown = modal.locator('.multiselect:has(input[placeholder="Set Instr. Meeting"])');
        if (await meetingDropdown.count() > 0) {
          await selectDropdownIfEmpty(meetingDropdown.first(), 'Instructor Meeting', modal);
        } else {
          // Fallback: try the old method for highlighted options if dropdown structure is different
          const highlightedOption = modal.locator('.multiselect__option--highlight').first();
          if (await highlightedOption.count() > 0 && await highlightedOption.isVisible()) {
            await highlightedOption.click();
            console.log('📅 [Professors] Set first meeting option (highlighted).');
          } else {
            console.log('⚠️ [Professors] Meeting dropdown not found with expected structure.');
          }
        }
        // Select instructional method: Check if already has value first
        console.log('🎓 [Professors] Validating instructional method dropdown...');
        const instrMethodDropdown = modal.locator('.multiselect:has(input[placeholder="Set Instr. Instructional Method"])');
        if (await instrMethodDropdown.count() > 0) {
          await selectDropdownIfEmpty(instrMethodDropdown.first(), 'Instructional Method', modal);
        } else {
          console.log('⚠️ [Professors] Instructional method dropdown not found with expected structure.');
        }
        
        // Fallback: Try all available dropdowns if the specific ones weren't handled (limit to 5 to avoid UI issues)
        console.log('🔄 [Professors] Validating all remaining dropdowns as fallback...');
        const allDropdowns = modal.locator('.multiselect');
        const dropdownCount = await allDropdowns.count();
        const maxDropdowns = Math.min(dropdownCount, 5); // Limit to 5 dropdowns maximum
        console.log(`   ┣ Found ${dropdownCount} total dropdown(s) in modal, processing first ${maxDropdowns}`);
        
        for (let i = 0; i < maxDropdowns; i++) {
          const dropdown = allDropdowns.nth(i);
          if (await dropdown.isVisible()) {
            // Check if dropdown is disabled
            const classAttr = await dropdown.getAttribute('class');
            const isDisabled = classAttr?.includes('multiselect--disabled');
            if (isDisabled) {
              console.log(`   ┗ Dropdown #${i + 1} is disabled, skipping.`);
              continue;
            }
            
            console.log(`   ┣ Validating dropdown #${i + 1}...`);
            await selectDropdownIfEmpty(dropdown, `Professor Dropdown #${i + 1}`, modal);
          }
        }
        
        if (dropdownCount > 5) {
          console.log(`   ┗ Skipped ${dropdownCount - 5} additional dropdowns to avoid UI timeout issues.`);
        }
        // Close the modal
        const modalFooter = modal.locator('.modal-footer');
        const closeBtn = modalFooter.locator('button[data-test="close-modal-btn"]');
        if (await closeBtn.count() > 0) {
          console.log('❌ [Instructional Method] Attempting to close instructor details modal (scoped to modal footer)...');
          await page.waitForTimeout(500);
          const isVisible = await closeBtn.first().isVisible();
          const isEnabled = await closeBtn.first().isEnabled();
          console.log(`Close button (footer) visible: ${isVisible}, enabled: ${isEnabled}`);

          await page.waitForTimeout(1000);

          // Take screenshot of the modal content instead of whole page
          const modalContent = page.locator('[data-test="instructorsMetaDetailsModal"]');
          const screenshotAfter = path.join(outputDir, `${action}-section-Instructor-Details-After.png`);
          await modalContent.screenshot({ path: screenshotAfter });
        
          console.log(`\n✅ Screenshot saved to ${screenshotAfter}`);
          if (isVisible && isEnabled) {
            await closeBtn.first().click();
            await page.waitForTimeout(500);
            // Wait for modal to disappear
            await page.waitForSelector('div[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
            console.log('   ┗ "instructor details" modal closed.');
          } else {
            console.log('⚠️ [Instructional Method] Close button in modal footer not visible or not enabled. Attempting to click outside modal as fallback...');
            // Fallback: click outside the modal to close
            const body = page.locator('body');
            await body.click({ position: { x: 10, y: 10 } });
            await page.waitForTimeout(500);
            await page.waitForSelector('div[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
            console.log('   ┗ Fallback: Clicked outside modal to close it.');
          }
        } else {
          console.log('⚠️ [Instructional Method] Close button in modal footer not found. Attempting to click outside modal as fallback...');
         
          const body = page.locator('body');
          await body.click({ position: { x: 10, y: 10 } });
          await page.waitForTimeout(500);
          await page.waitForSelector('div[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
          console.log('   ┗ Fallback: Clicked outside modal to close it.');
        }
      } else {
        console.log('⚠️ [Professors] Could not find openInstructorsMetaDetailsModal button.');
        if (!professorSelected) {
          // Only attempt to close selection modal if no professor was selected
          console.log('🚪 [Professors] Attempting to close professor assignment modal (no professor selected)...');
          const closeSelectors = ['button:text("CANCEL")', 'button:text("Cancel")', '.modal-header button[aria-label="Close"]'];
          for (const closeSelector of closeSelectors) {
            const closeBtn = page.locator(closeSelector);
            if (await closeBtn.count() > 0) {
              try {
                await closeBtn.first().click();
                console.log(`🚪 [Professors] Closed professor assignment modal using: ${closeSelector}`);
                await page.waitForTimeout(1000);
                break;
              } catch (error) {
                continue;
              }
            }
          }
        } else {
          console.log('ℹ️ [Professors] Skipping modal close because a professor was selected and the modal should auto-close.');
        }
      }
  } else {
    console.log('⚠️ [Professors] Could not find add instructor button.');
  }
  
  // Save the section if browser and schoolId are provided (indicating this is the final step)
  if (browser && schoolId) {
    // Capture modal after screenshot and compare field differences before saving
    console.log('📸 [Professors] Taking "after" screenshot before save...');
    await captureModalAfter(page, outputDir, action);

    try {
      // If no beforeValues provided, use the global diff state or fetch now
      let effectiveBefore = beforeValues;
      if (!effectiveBefore) {
        if (!__diffState.before && schoolId) {
          try { __diffState.before = await readSectionValues(page, schoolId); } catch (_) {}
        }
        effectiveBefore = __diffState.before;
      }

      const afterValues = await readSectionValues(page, schoolId);
      const ts = dateStr || (__diffState.context?.dateStr) || getTimestamp();
      await writeSectionDiff(effectiveBefore, afterValues, schoolId, outputDir, action, ts);
    } catch (err) {
      console.log(`⚠️ [Professors] Could not generate diff before save: ${err.message}`);
    }
    
    // Check for API error notification before attempting to save
    const apiErrorBeforeSave = await checkForApiError(page, outputDir, browser, schoolId, action);
    if (apiErrorBeforeSave) {
      console.log('❌ API error detected during professor setup, cannot save section');
      return false;
    }
    
    console.log('💾 [Professors] Saving section after professor setup...');
    const saveSuccess = await saveSection(page, outputDir, action, browser, schoolId);
    return saveSuccess;
  }
  
  return true; // Return success if no saving needed
}

/**
 * Opens Meeting Pattern and Instructor Details modals to capture "before" screenshots, then closes them
 * Moves the responsibility of taking the "before" screenshots out of the reset functions
 * @param {import('playwright').Page} page
 * @param {string} outputDir
 * @param {string} action
 */
async function meetAndProfDetails(page, outputDir, action) {
  try {
    const sectionModalSelector = '#section-modal-editor';
    const logSectionModalState = async (context) => {
      try {
        const modal = page.locator(sectionModalSelector).first();
        const visible = await modal.isVisible().catch(() => false);
        console.log(`📌 [${context}] Section modal visible after close attempt? ${visible}`);
      } catch (err) {
        console.log(`📌 [${context}] Section modal visibility check failed: ${err.message}`);
      }
    };

    // Meeting Patterns Details
    console.log('🔎 [Details] Locating Meeting Patterns & Rooms section for details screenshot...');
    const meetingPatternSection = page.locator('[data-card-id="times"]');
    const setDetailsBtn = meetingPatternSection.locator('button[data-test="set_details"]');
    if (await setDetailsBtn.count() > 0 && await setDetailsBtn.first().isVisible()) {
      console.log('⚙️ [Details] Opening "Set Details" modal...');
      await setDetailsBtn.first().click();
      const detailsModalTitle = page.locator('.app-heading', { hasText: 'Meeting Patterns Additional Information' });
      await detailsModalTitle.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      const modalContent = page.locator('[data-test="meeting-patterns-details-modal"]');
      const mpBeforePath = path.join(outputDir, 'MeetingPattern-Details-Before.png');
      try { await modalContent.screenshot({ path: mpBeforePath }); console.log(`✅ Saved: ${mpBeforePath}`); } catch (_) {}
      // Close modal
    const closeBtn = modalContent.locator('button[data-test="close-modal-btn"]');
    if (await closeBtn.count() > 0 && await closeBtn.first().isVisible() && await closeBtn.first().isEnabled()) {
      await closeBtn.first().click();
      await page.waitForTimeout(500);
      await logSectionModalState('MeetingDetails');
    } else {
      // Fallback close
      console.log('⚠️ [Meeting Patterns] Primary close button missing, trying scoped fallbacks...');
      const dialog = modalContent.locator('xpath=ancestor::div[contains(@class,"modal-dialog")]').first();
      const fallbackClose = dialog.locator('button[aria-label="Close modal"], button[data-test="close-x-btn"]');
      if (await fallbackClose.count() > 0 && await fallbackClose.first().isVisible()) {
        await fallbackClose.first().click();
        await page.waitForTimeout(500);
        console.log('   ┗ "Set Details" modal closed via fallback icon.');
      } else {
        console.log('   ┗ No scoped close icon found, attempting Escape key.');
        try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch (_) {}
      }
      await logSectionModalState('MeetingDetails');
    }
    } else {
      console.log('ℹ️ [Details] Meeting Patterns details button not found.');
    }

    // Instructor Details
    console.log('🔎 [Details] Locating Instructors card for details screenshot...');
    const instructorsCard = page.locator('[data-card-id="instructors"]');
    const openDetailsBtn = page.locator('button[data-test="openInstructorsMetaDetailsModal"]');
    if (await openDetailsBtn.count() > 0 && await openDetailsBtn.first().isVisible()) {
      await openDetailsBtn.first().click();
      const modalContent = page.locator('[data-test="instructorsMetaDetailsModal"]');
      const modal = modalContent.locator('xpath=ancestor::div[contains(@class,"modal-dialog")]').first();
      const detailsModal = modal.locator('h3.app-heading', { hasText: 'Set Instructor Roles & Details' });
      await detailsModal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      // Expand accordion if present
      const profDetails = modal.locator('span.btn.btn-dark.pl-0.py-3.font-weight-bold.text-capitalize');
      try { if (await profDetails.count() > 0 && await profDetails.first().isVisible()) { await profDetails.first().click(); await page.waitForTimeout(300); } } catch (_) {}
      // modalContent already declared above
      const instrBeforePath = path.join(outputDir, 'section-Instructor-Details-Before.png');
      try { await modalContent.screenshot({ path: instrBeforePath }); console.log(`✅ Saved: ${instrBeforePath}`); } catch (_) {}
      // Close modal (prefer footer close)
      const closeBtn = modalContent.locator('.modal-footer button[data-test="close-modal-btn"]');
      if (await closeBtn.count() > 0 && await closeBtn.first().isVisible()) {
        console.log('   ┗ Found footer close button, clicking...');
        await closeBtn.first().click();
        await page.waitForTimeout(500);
        await page.waitForSelector('div[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
        await logSectionModalState('InstructorsDetails');
      } else {
        // Fallback close
        console.log('⚠️ [Instructors] Footer close missing, trying scoped fallbacks...');
        const fallbackClose = modal.locator('button[aria-label="Close modal"], button[data-test="close-x-btn"], button[data-test="closeby-x-btn"], .modal-header .close');
        if (await fallbackClose.count() > 0 && await fallbackClose.first().isVisible()) {
          await fallbackClose.first().click();
          await page.waitForTimeout(500);
          console.log('   ┗ Instructor modal closed via fallback icon.');
        } else {
          // Try overlay click as a last resort, then escape
          const overlay = page.locator('div.modal-dimness').last();
          if (await overlay.count() > 0 && await overlay.first().isVisible()) {
            console.log('   ┗ No icon found; attempting overlay click to close topmost modal.');
            try { await overlay.first().click(); await page.waitForTimeout(500); } catch (_) {}
          } else {
            console.log('   ┗ Overlay not present; attempting Escape key.');
            try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch (_) {}
          }
        }
        await page.waitForSelector('div[data-test="instructorsMetaDetailsModal"]', { state: 'detached', timeout: 5000 }).catch(() => {});
        await logSectionModalState('InstructorsDetails');
      }
    } else {
      console.log('ℹ️ [Details] Instructor details button not found.');
    }

    return true;
  } catch (err) {
    console.log(`⚠️ [Details] Error in meetAndProfDetails: ${err.message}`);
    return false;
  }
}

/**
 * Reads all current values from the Section modal fields based on the baseline template JSON.
 * @param {import('playwright').Page} page Playwright Page instance (modal must be open).
 * @param {string} schoolId Identifier matching JSON file in Resources folder.
 * @returns {Promise<Object>} Object mapping questionId to current value.
 */
async function readSectionValues(page, schoolId) {
  const path = require('path');
  const fs = require('fs');
  // Load the template JSON to get the question IDs
  const jsonPath = getLatestSectionTemplateFile(schoolId);
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const { sectionTemplate } = JSON.parse(raw);
  const questionIds = Object.keys(sectionTemplate.questions || {});
  const values = { _hiddenFields: {} };

  for (const qid of questionIds) {
    try {
      const wrapper = page.locator(`[data-test="${qid}"]`);
      const wrapperCount = await wrapper.count();
      if (wrapperCount === 0) {
        // Attempt to detect hidden via field container or card
        let hiddenByContainerOrCard = false;
        try {
          const fieldContainer = page.locator(`#field-${qid}`).first();
          if ((await fieldContainer.count()) > 0) {
            const isVisible = await fieldContainer.isVisible().catch(() => false);
            if (!isVisible) hiddenByContainerOrCard = true;
            else {
              // Check ancestor .form-card for display none
              const hiddenCard = fieldContainer.locator('xpath=ancestor::*[contains(@class, "form-card") and contains(@style, "display: none")]').first();
              if ((await hiddenCard.count()) > 0) hiddenByContainerOrCard = true;
            }
          } else {
            // Try to locate card by data-card-id matching qid
            const card = page.locator(`.form-card[data-card-id*="${qid}"]`).first();
            if ((await card.count()) > 0) {
              const styleAttr = (await card.getAttribute('style')) || '';
              if (/display\s*:\s*none/i.test(styleAttr)) hiddenByContainerOrCard = true;
              // Check header display_ text for "hidden"
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
      // Hidden detection: not visible, parent field-wrapper hidden, or container with display:none
      let hidden = false;
      try {
        const visible = await wrapper.first().isVisible();
        if (!visible) hidden = true;
      } catch (_) {}
      if (!hidden) {
        try {
          // Check closest ancestor with class field-wrapper having field-hidden
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
          if (classAttr.includes('multiselect--disabled')) disabled = true;
          const multiInput = multi.locator('input').first();
          if ((await multiInput.count()) > 0) {
            const hasDisabled = (await multiInput.getAttribute('disabled')) !== null;
            const isEnabled = await multiInput.isEnabled().catch(() => true);
            if (hasDisabled || !isEnabled) disabled = true;
          }
        } else {
          // First, check for input/textarea/select as usual
          const ctrl = wrapper.locator('input, textarea, select').first();
          if ((await ctrl.count()) > 0) {
            const hasDisabled = (await ctrl.getAttribute('disabled')) !== null;
            const isEnabled = await ctrl.isEnabled().catch(() => true);
            if (hasDisabled || !isEnabled) disabled = true;
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
          // Also try to capture the visible text for display-only fields so diffs show actual value
          try {
            const displayTextEl = wrapper.locator('.form-input-button__display').first();
            if ((await displayTextEl.count()) > 0) {
              const txt = (await displayTextEl.textContent()) || '';
              values[qid] = txt.trim();
            }
          } catch (_) {}
        }
      } catch (_) {}
      // Check if this is a multiselect
      const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
      if (isMultiselect) {
        // Get selected option(s) text
        const selectedOptions = await wrapper.locator('.multiselect__tags .multiselect__tag, .multiselect__single').allTextContents();
        values[qid] = selectedOptions.length === 1 ? selectedOptions[0] : selectedOptions;
      } else {
        // If the wrapper is itself an input/textarea/select, use it directly
        let input;
        let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
        if (["input", "textarea", "select"].includes(tagName)) {
          input = wrapper.first();
        } else {
          input = wrapper.locator('input, textarea, select');
        }
        const inputCount = await input.count();
        if (inputCount > 0) {
          const inputElement = input.first();
          tagName = await inputElement.evaluate(el => el.tagName.toLowerCase());
          if (tagName === 'input' || tagName === 'textarea') {
            values[qid] = await inputElement.inputValue();
          } else if (tagName === 'select') {
            values[qid] = await inputElement.inputValue();
          } else {
            values[qid] = undefined;
          }
        } else {
          // Look for Yes/No buttons inside the wrapper
          const yesNoButtons = wrapper.locator('button[data-test="YesBtn"], button[data-test="NoBtn"]');
          const btnCount = await yesNoButtons.count();
          if (btnCount === 2) {
            let selectedIdx = -1;
            for (let i = 0; i < 2; i++) {
              const btn = yesNoButtons.nth(i);
              const btnClass = await btn.getAttribute('class') || '';
              if (btnClass.includes('btn-raised')) {
                selectedIdx = i;
                break;
              }
            }
            if (selectedIdx !== -1) {
              values[qid] = selectedIdx === 0 ? 'Yes' : 'No';
            } else {
              values[qid] = undefined;
            }
          } else {
            values[qid] = undefined;
          }
        }
      }
    } catch (err) {
      values[qid] = undefined;
    }
  }
  return values;
}

// Utility to get the latest section template file for a schoolId
function getLatestSectionTemplateFile(schoolId) {
  const resourcesDir = path.resolve(__dirname, 'Resources');
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Resources directory does not exist: ${resourcesDir}`);
  }
  const files = fs.readdirSync(resourcesDir);
  const matchingFiles = files
    .filter(f => f.startsWith(`${schoolId}-sectionTemplate-`) && f.endsWith('.json'))
    .sort();
  if (matchingFiles.length === 0) {
    throw new Error(`No section template file found for schoolId: ${schoolId}`);
  }
  return path.join(resourcesDir, matchingFiles[matchingFiles.length - 1]);
}

async function bannerEthosScheduleType(page) {
  console.log('🎓 [Banner Ethos] Starting Schedule Type management...');
  
  // Look for the Schedule-Type section
  const scheduleTypeSection = page.locator('[data-test="Schedule-Type"]');
  if (await scheduleTypeSection.count() === 0) {
    console.log('⚠️ [Banner Ethos] Schedule-Type section not found, skipping.');
    return;
  }
  
  console.log('✅ [Banner Ethos] Found Schedule-Type section.');
  
  // Determine number of instructional method fields by id pattern
  const methodFields = scheduleTypeSection.locator('[id^="field-instructionalMethods."][id$=".id"]');
  let methodCount = await methodFields.count();
  console.log(`📊 [Banner Ethos] Found ${methodCount} instructional method field(s).`);

  // If more than one exists (e.g., id="field-instructionalMethods.1.id"), remove extras until only index 0 remains
  if (methodCount > 1) {
    console.log('🗑️ [Banner Ethos] Multiple instructional methods detected. Removing extras until only index 0 remains...');
    // Loop while more than one exists
    while (methodCount > 1) {
      // Prefer removing the last item by legend if available, else fallback to last delete button
      let removed = false;
      try {
        const lastLegend = page.locator('.field-box-legend').last();
        if (await lastLegend.count() > 0) {
          const container = lastLegend.locator('..');
          const deleteBtn = container.locator('button.btn.btn-danger');
          if (await deleteBtn.count() > 0 && await deleteBtn.last().isVisible()) {
            await deleteBtn.last().click();
            removed = true;
          }
        }
      } catch (_) {}

      if (!removed) {
        // Fallback: click the last visible delete button in the Schedule-Type section
        const anyDelete = scheduleTypeSection.locator('button.btn.btn-danger');
        if (await anyDelete.count() > 0) {
          try {
            await anyDelete.last().click();
            removed = true;
          } catch (_) {}
        }
      }

      if (!removed) {
        console.log('⚠️ [Banner Ethos] Could not find a delete button to remove extra item.');
        break;
      }

      await page.waitForTimeout(1000);
      methodCount = await methodFields.count();
      console.log(`   ┗ After removal, instructional method fields: ${methodCount}`);
    }
    if (methodCount === 1) {
      console.log('✅ [Banner Ethos] Reduced to a single instructional method (index 0).');
    }
  } else if (methodCount === 0) {
    console.log('ℹ️ [Banner Ethos] No instructional methods found, creating one...');
    const addNewBtn = page.locator('button:has-text("Add New Instructional Method")');
    if (await addNewBtn.count() > 0 && await addNewBtn.first().isVisible()) {
      console.log('➕ [Banner Ethos] Clicking "Add New Instructional Method" button...');
      await addNewBtn.first().click();
      await page.waitForTimeout(2000);
      console.log('   ┗ New Instructional Method added.');
    } else {
      console.log('⚠️ [Banner Ethos] "Add New Instructional Method" button not found.');
      return;
    }
  } else {
    console.log('✅ [Banner Ethos] Exactly one instructional method present.');
  }
  
  // After ensuring we have exactly one Schedule Type Item, select from multiselect
  console.log('🔽 [Banner Ethos] Selecting from multiselect field...');
  
  const multiselectField = page.locator('#field-instructionalMethods\\.0\\.id');
  if (await multiselectField.count() > 0) {
    console.log('📋 [Banner Ethos] Found multiselect field, opening dropdown...');
    
    try {
      await multiselectField.click();
      await page.waitForTimeout(2500); // Wait for dropdown to open
      
      // Look for dropdown options
      const options = page.locator('.multiselect__content-wrapper li, [role="option"]');
      const optionCount = await options.count();
      
      if (optionCount > 0) {
        console.log(`📋 [Banner Ethos] Found ${optionCount} option(s) in dropdown.`);
        
        // Find the first available (not selected/disabled) option
        let selectedOption = false;
        
        for (let i = 0; i < optionCount; i++) {
          const option = options.nth(i);
          
          try {
            const isVisible = await option.isVisible();
            if (!isVisible) {
            //  console.log(`   ┗ Option ${i + 1} not visible, skipping.`);
              continue;
            }
            
            // Check if option is already selected or disabled
            const optionClass = await option.getAttribute('class') || '';
            const isSelected = optionClass.includes('option--selected') || optionClass.includes('multiselect__option--selected');
            const isDisabled = optionClass.includes('option--disabled') || optionClass.includes('multiselect__option--disabled');
            
            if (isSelected) {
              console.log(`   ┗ Option ${i + 1} is already selected, skipping.`);
              continue;
            }
            
            if (isDisabled) {
              console.log(`   ┗ Option ${i + 1} is disabled, skipping.`);
              continue;
            }
            
            // Try to click this available option
            await option.click();
            console.log(`✅ [Banner Ethos] Selected option ${i + 1} from multiselect.`);
            selectedOption = true;
            break;
            
          } catch (err) {
            console.log(`   ┗ Error checking option ${i + 1}: ${err.message}, trying next.`);
            continue;
          }
        }
        
        if (!selectedOption) {
          console.log('⚠️ [Banner Ethos] No available options found, trying keyboard navigation fallback...');
          
          // Fallback: try keyboard navigation
          const input = multiselectField.locator('input.multiselect__input');
          if (await input.count() > 0) {
            await input.first().press('ArrowDown');
            await page.waitForTimeout(200);
            await input.first().press('Enter');
            console.log('✅ [Banner Ethos] Selected option via keyboard navigation fallback.');
          } else {
            console.log('❌ [Banner Ethos] All options unavailable and keyboard fallback failed.');
          }
        }
      } else {
        console.log('⚠️ [Banner Ethos] No options found in multiselect dropdown.');
      }
    } catch (err) {
      console.log(`❌ [Banner Ethos] Error interacting with multiselect: ${err.message}`);
    }
  } else {
    console.log('⚠️ [Banner Ethos] Multiselect field #field-instructionalMethods.0.id not found.');
  }
  
  console.log('✅ [Banner Ethos] Schedule Type management completed.');
}

/**
 * Helper function to check if a dropdown/multiselect already has a selected value
 * @param {Locator} dropdown - The dropdown/multiselect element
 * @returns {Promise<boolean>} - True if dropdown has a selected value, false otherwise
 */
async function hasSelectedValue(dropdown) {
  try {
    // Check for selected value in multiselect (look for selected tag)
    const selectedTag = dropdown.locator('.multiselect__tag, .multiselect__single');
    if (await selectedTag.count() > 0) {
      const tagText = await selectedTag.first().textContent();
      return tagText && tagText.trim().length > 0;
    }
    
    // Check for placeholder text change (some dropdowns change placeholder when selected)
    const placeholder = dropdown.locator('.multiselect__placeholder');
    if (await placeholder.count() > 0) {
      const isVisible = await placeholder.first().isVisible();
      // If placeholder is not visible, it likely means something is selected
      return !isVisible;
    }
    
    // Check for input value
    const input = dropdown.locator('input');
    if (await input.count() > 0) {
      const inputValue = await input.first().inputValue();
      return inputValue && inputValue.trim().length > 0;
    }
    
    return false;
  } catch (error) {
    console.log(`   ┗ Error checking dropdown value: ${error.message}`);
    return false;
  }
}

/**
 * Helper function to safely select dropdown option only if not already selected
 * @param {Locator} dropdown - The dropdown/multiselect element
 * @param {string} dropdownName - Name for logging purposes
 * @param {Page|Locator} context - The page or modal context for searching options
 * @returns {Promise<boolean>} - True if selection was attempted, false if already had value
 */
async function selectDropdownIfEmpty(dropdown, dropdownName, context = null) {
  try {
    // First check if dropdown already has a value
    const hasValue = await hasSelectedValue(dropdown);
    if (hasValue) {
      console.log(`   ┗ ${dropdownName} already has a selected value, skipping.`);
      return false;
    }
    
    console.log(`   ┗ ${dropdownName} is empty, attempting to select first option...`);
    
    // Proceed with selection using optimized strategies
    let clickSuccess = false;
    
    // Strategy 1: Try JavaScript click first (more reliable with modal overlays)
    try {
      await dropdown.evaluate(el => el.click());
      clickSuccess = true;
      console.log(`   ┃ JavaScript click successful`);
    } catch (jsClickErr) {
      console.log(`   ┃ JavaScript click failed: ${jsClickErr.message}`);
    }
    
    // Strategy 2: If JavaScript click fails, try regular click with force
    if (!clickSuccess) {
      try {
        await dropdown.click({ force: true, timeout: 5000 });
        clickSuccess = true;
        console.log(`   ┃ Force click successful`);
      } catch (clickErr) {
        console.log(`   ┃ Force click failed: ${clickErr.message}`);
      }
    }
    
    if (!clickSuccess) {
      console.log(`   ┗ All click strategies failed for ${dropdownName}, skipping.`);
      return false;
    }
    
    await dropdown.page().waitForTimeout(500); // Wait for dropdown to open
    
    // Try to select the first option
    const searchContext = context || dropdown.page();
    const firstOption = searchContext.locator('.multiselect_content_wrapper .multiselect_element:not([style*="display: none"])').first();
    if (await firstOption.count() > 0 && await firstOption.isVisible()) {
      await firstOption.click();
      console.log(`   ┗ Successfully selected first option for ${dropdownName}`);
      return true;
    } else {
      // Fallback: try using keyboard navigation
      const multiInput = dropdown.locator('input.multiselect__input');
      if (await multiInput.count() > 0) {
        await multiInput.first().press('ArrowDown');
        await dropdown.page().waitForTimeout(200);
        await multiInput.first().press('Enter');
        console.log(`   ┗ Successfully selected option for ${dropdownName} (keyboard fallback)`);
        return true;
      } else {
        console.log(`   ┗ No options found for ${dropdownName}`);
        return false;
      }
    }
  } catch (error) {
    console.log(`   ┗ Error selecting dropdown ${dropdownName}: ${error.message}`);
    return false;
  }
}

/**
 * Helper to prefer selecting an Active status (and avoid inactive-like) when empty
 * Works with both multiselect and native select controls contained in wrapper
 * @param {import('playwright').Locator} wrapper
 * @param {import('playwright').Page} page
 * @param {string} qid
 * @returns {Promise<boolean>} - true if selection made, false otherwise
 */
async function selectActiveStatusIfEmpty(wrapper, page, qid) {
  try {
    // Safety guard: only operate on status fields
    if (!(qid === 'status' || qid === 'statusCode')) {
      return false;
    }
    const isMultiselect = await wrapper.locator('.multiselect, [class*="multiselect"]').count() > 0;
    const negativeKeywords = ['inactive', 'inact', 'deactive', 'deactivate', 'cancel', 'canceled', 'cancelled', 'closed', 'suspend', 'suspended'];
    const isNegative = (text) => {
      const t = (text || '').toLowerCase();
      return negativeKeywords.some(k => t.includes(k));
    };
    const isPositiveActive = (text) => {
      const t = (text || '').toLowerCase();
      return t.includes('active') && !isNegative(t);
    };

    if (isMultiselect) {
      try {
        await wrapper.click();
      } catch {}
      await page.waitForTimeout(800);
      const options = wrapper.locator('.multiselect__content-wrapper li, [role="option"]');
      const count = await options.count();
      if (count === 0) return false;

      // Build list with indices
      const texts = [];
      for (let i = 0; i < count; i++) {
        try {
          const txt = await options.nth(i).textContent();
          texts.push((txt || '').trim());
        } catch {
          texts.push('');
        }
      }

      // Prefer exact "Active", then exact "A", then any containing active but not negative
      let targetIndex = texts.findIndex(t => (t || '').trim().toLowerCase() === 'active');
      if (targetIndex === -1) targetIndex = texts.findIndex(t => (t || '').trim().toLowerCase() === 'a');
      if (targetIndex === -1) targetIndex = texts.findIndex(t => isPositiveActive(t));
      if (targetIndex !== -1) {
        const target = options.nth(targetIndex);
        if (await target.isVisible()) {
          await target.click();
          return true;
        }
        // Keyboard fallback
        const input = wrapper.locator('input.multiselect__input');
        if (await input.count() > 0) {
          for (let i = 0; i <= targetIndex; i++) {
            await input.first().press('ArrowDown');
            await page.waitForTimeout(150);
          }
          await input.first().press('Enter');
          return true;
        }
      }
      return false;
    } else {
      // Try native select inside wrapper
      let selectEl;
      let tagName = await wrapper.first().evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        selectEl = wrapper.first();
      } else {
        selectEl = wrapper.locator('select').first();
      }
      if (await selectEl.count() === 0) return false;

      const options = selectEl.locator('option');
      const optionCount = await options.count();
      if (optionCount === 0) return false;

      const texts = [];
      for (let i = 0; i < optionCount; i++) {
        try {
          const txt = await options.nth(i).textContent();
          texts.push((txt || '').trim());
        } catch {
          texts.push('');
        }
      }
      let targetIndex = texts.findIndex(t => (t || '').trim().toLowerCase() === 'active');
      if (targetIndex === -1) targetIndex = texts.findIndex(t => (t || '').trim().toLowerCase() === 'a');
      if (targetIndex === -1) targetIndex = texts.findIndex(t => isPositiveActive(t));
      if (targetIndex !== -1) {
        await selectEl.selectOption({ index: targetIndex });
        return true;
      }
      return false;
    }
  } catch (err) {
    console.log(`   ┗ Error selecting active status for [${qid}]: ${err.message}`);
    return false;
  }
}

/**
 * Helper function to add course and sections to a relationship
 * @param {Page} page - Playwright page object
 * @param {boolean} addSecondSection - false = edit mode (current + 1), true = create mode (2 sections)
 */
async function addCourseAndSections(page, addSecondSection = false) {
  console.log(`🎯 [Relationships] Starting intelligent course and section validation...`);
  
  let targetSections;
  
  if (addSecondSection) {
    // Create mode: always target 2 sections
    targetSections = 2;
    console.log(`📝 [Create Mode] Target is ${targetSections} section(s)`);
  } else {
    // Edit mode: count current sections and add 1 more
    const currentSectionCount = await countAddedSections(page);
    targetSections = currentSectionCount + 1;
    console.log(`📝 [Edit Mode] Found ${currentSectionCount} existing section(s), target is ${targetSections} (current + 1)`);
  }
  const maxCourseAttempts = 15;
  let coursesTriedCount = 0;
  
  while (coursesTriedCount < maxCourseAttempts) {
    // Check current section count at the start of each loop
    const currentSectionCount = await countAddedSections(page);
    console.log(`📊 [Relationships] Current sections added: ${currentSectionCount}/${targetSections}`);
    
    if (currentSectionCount >= targetSections) {
      console.log(`🎉 [Relationships] Target of ${targetSections} sections reached! Stopping course search.`);
      break;
    }
    
    coursesTriedCount++;
    console.log(`\n🔄 [Relationships] Course attempt ${coursesTriedCount}/${maxCourseAttempts} (need ${targetSections - currentSectionCount} more section(s))`);
    
    // Step 1: Find and select a random course
    const courseSelected = await selectRandomCourse(page, coursesTriedCount);
    if (!courseSelected) {
      console.log(`❌ [Relationships] Failed to select course on attempt ${coursesTriedCount}`);
      continue;
    }
    
    // Step 2: Validate section count for the selected course
    const sectionCount = await validateSectionCount(page);
    console.log(`📊 [Relationships] Course has ${sectionCount} section(s) available`);
    
    if (sectionCount === 0) {
      console.log(`⚠️ [Relationships] Course has no sections - trying different course...`);
      await clearCourseSelection(page);
      continue;
    }
    
    // Calculate how many sections we still need
    const sectionsNeeded = targetSections - currentSectionCount;
    const sectionsToAdd = Math.min(sectionCount, sectionsNeeded);
    
    console.log(`🎯 [Relationships] Planning to add ${sectionsToAdd} section(s) from this course (need ${sectionsNeeded}, course has ${sectionCount})`);
    
    // Add sections one by one up to what we need
    for (let i = 1; i <= sectionsToAdd; i++) {
      console.log(`➕ [Relationships] Adding section ${i} of ${sectionsToAdd} from current course...`);
      const sectionAdded = await addSingleSection(page, i);
      
      if (!sectionAdded) {
        console.log(`❌ [Relationships] Failed to add section ${i}, moving to next course`);
        break;
      }
      
      // Check if we've reached our target after each section
      const updatedSectionCount = await countAddedSections(page);
      console.log(`📊 [Relationships] Updated total: ${updatedSectionCount}/${targetSections} sections`);
      
      if (updatedSectionCount >= targetSections) {
        console.log(`✅ [Relationships] Target reached! Added ${updatedSectionCount} sections total.`);
        return; // Exit the function immediately when target is reached
      }
    }
    
    // If we've exhausted this course's sections but still need more, continue to next course
    const finalCurrentCount = await countAddedSections(page);
    if (finalCurrentCount < targetSections) {
      console.log(`🔄 [Relationships] Still need ${targetSections - finalCurrentCount} more section(s), searching for another course...`);
      // Note: Don't clear course selection here, just continue to next iteration
    }
  }
  
  // Final validation and warning if we couldn't reach the target
  const finalSectionCount = await countAddedSections(page);
  if (finalSectionCount < targetSections) {
    console.log(`⚠️ [Relationships] WARNING: Only added ${finalSectionCount} section(s), target was ${targetSections}`);
    console.log(`⚠️ [Relationships] Tried ${coursesTriedCount} courses but couldn't find enough sections.`);
  } else {
    console.log(`🎉 [Relationships] SUCCESS! Added ${finalSectionCount} section(s) meeting target of ${targetSections}`);
  }
}

/**
 * Select a random course with retry mechanism
 */
async function selectRandomCourse(page, attemptNumber) {
  const courseSelect = page.locator('[data-test="course-select"]');
  if (await courseSelect.count() === 0) {
    console.log('⚠️ [Relationships] Course select component not found.');
    return false;
  }
  
  // Generate a truly random letter for each attempt
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const letterIndex = Math.floor(Math.random() * letters.length);
  const currentLetter = letters[letterIndex];
  
  console.log(`🔍 [Relationships] Searching courses with letter '${currentLetter}'...`);
  
  try {
    // Click on the multiselect to open it
    await courseSelect.first().click();
    await page.waitForTimeout(1000);
    
    // Find the actual input field within the multiselect
    const courseInput = courseSelect.locator('input.multiselect__input');
    if (await courseInput.count() > 0) {
      await courseInput.first().fill(currentLetter);
      await page.waitForTimeout(4000); // Wait for results to load
      
      // Check if we have any course options available
      const courseOptions = page.locator('.multiselect__content .multiselect__element');
      const optionCount = await courseOptions.count();
      
      if (optionCount > 0) {
        // Select a random course from available options
        const randomIndex = Math.floor(Math.random() * Math.min(optionCount, 3)); // Use first 3 options
        await courseInput.first().press('Enter'); // Select first course
        console.log(`   ✅ Selected course (${optionCount} options available)`);
        await page.waitForTimeout(1500); // Wait for course to load sections
        return true;
      } else {
        console.log(`   ❌ No courses found with letter '${currentLetter}'`);
        return false;
      }
    }
  } catch (error) {
    console.log(`   ❌ Error selecting course: ${error.message}`);
    return false;
  }
  
  return false;
}

/**
 * Validate how many sections are available for the selected course
 */
async function validateSectionCount(page) {
  await page.waitForTimeout(1500); // Wait for sections to load
  
  const sectionSelect = page.locator('[data-test="section-select"]');
  if (await sectionSelect.count() === 0) {
    console.log('⚠️ [Relationships] Section select not found');
    return 0;
  }
  
  try {
    // Click to open section dropdown
    await sectionSelect.first().click();
    await page.waitForTimeout(1000);
    
    // Count available section options
    const sectionOptions = page.locator('.multiselect__content .multiselect__element:not(.multiselect__element--disabled)');
    const sectionCount = await sectionOptions.count();
    
    // Close the dropdown
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    return sectionCount;
  } catch (error) {
    console.log(`⚠️ [Relationships] Error validating sections: ${error.message}`);
    return 0;
  }
}

/**
 * Add a single section (specified by position number)
 */
async function addSingleSection(page, sectionNumber) {
  console.log(`➕ [Relationships] Adding section #${sectionNumber}...`);
  
  const sectionSelect = page.locator('[data-test="section-select"]');
  if (await sectionSelect.count() === 0) {
    console.log('⚠️ [Relationships] Section select not found');
    return false;
  }
  
  try {
    // Click to open section dropdown
    await sectionSelect.first().click();
    await page.waitForTimeout(1000);
    
    // Prefer selecting the first acceptable option (from requested index onward) that does NOT contain a CD test suffix
    const bannedFragments = ['-cd', '-cdt', '-cdte', '-cdtes', '-cdtest'];
    const sectionOptions = page.locator('.multiselect__content .multiselect__element:not(.multiselect__element--disabled)');
    const optionCount = await sectionOptions.count();
    let selectedOption = false;
    const startIdx = Math.max(0, sectionNumber - 1);

    for (let idx = startIdx; idx < optionCount; idx++) {
      const option = sectionOptions.nth(idx);
      let isVisible = false;
      try { isVisible = await option.isVisible(); } catch (_) {}
      if (!isVisible) continue;
      let text = '';
      try { text = (await option.textContent()) || ''; } catch (_) { text = ''; }
      const tl = text.toLowerCase();
      const hasBanned = bannedFragments.some(f => tl.includes(f));
      if (hasBanned) {
        console.log(`   ┣ ⏭️ Skipping section option ${idx + 1} due to CD suffix: "${text.trim()}"`);
        continue;
      }
      try {
        await option.click();
        selectedOption = true;
        console.log(`   ✅ Selected section option ${idx + 1}: "${text.trim()}"`);
        break;
      } catch (_) {
        // Try next
      }
    }

    // Fallback to original keyboard navigation if none acceptable found
    if (!selectedOption) {
      console.log('   ┣ ⚠️ No acceptable section option found by text; falling back to keyboard selection');
      for (let i = 1; i < sectionNumber; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      console.log(`   ✅ Section #${sectionNumber} selected (fallback)`);
    }
    
    // Click add section button
    const addSectionBtn = page.locator('[data-test="add-section"]');
    if (await addSectionBtn.count() > 0) {
      await addSectionBtn.first().click();
      await page.waitForTimeout(500);
      console.log(`   ✅ Section #${sectionNumber} added to relationship`);
      return true;
    } else {
      console.log('⚠️ [Relationships] Add section button not found');
      return false;
    }
  } catch (error) {
    console.log(`❌ [Relationships] Error adding section: ${error.message}`);
    return false;
  }
}

/**
 * Count how many sections have been added to the relationship
 */
async function countAddedSections(page) {
  const addedSections = page.locator('[data-test="added-section"]');
  const count = await addedSections.count();
  return count;
}

/**
 * Clear the current course selection to try a different one
 */
async function clearCourseSelection(page) {
  console.log('🧹 [Relationships] Clearing course selection...');
  
  const courseSelect = page.locator('[data-test="course-select"]');
  if (await courseSelect.count() > 0) {
    try {
      await courseSelect.first().click();
      await page.waitForTimeout(500);
      
      // Clear the input
      const courseInput = courseSelect.locator('input.multiselect__input');
      if (await courseInput.count() > 0) {
        await courseInput.first().fill('');
        await page.waitForTimeout(500);
      }
      
      // Press escape to close
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      
      console.log('   ✅ Course selection cleared');
    } catch (error) {
      console.log(`⚠️ [Relationships] Error clearing course selection: ${error.message}`);
    }
  }
}

/**
 * Validate if the relationship modal has error status
 * @param {Page} page - Playwright page object
 * @param {Locator} modal - The modal locator
 * @returns {Object} - {isValid: boolean, reason: string}
 */
async function validateRelationshipStatus(page, modal) {
  console.log('🔍 [Relationships] Validating relationship status...');
  
  try {
    // Check for integration status text
    const statusElement = modal.locator('[data-test="integration-status-text"]');
    
    if (await statusElement.count() > 0) {
      const statusText = await statusElement.textContent();
      console.log(`📊 [Relationships] Found status: "${statusText}"`);
      
      if (statusText && statusText.toLowerCase().includes('error')) {
        console.log('❌ [Relationships] Selected a relationship with error, trying a new one');
        return {
          isValid: false,
          reason: `Relationship has error status: ${statusText}`
        };
      } else {
        console.log('✅ [Relationships] Relationship status is valid');
        return {
          isValid: true,
          reason: 'No error status detected'
        };
      }
    } else {
      console.log('ℹ️ [Relationships] No integration status found, assuming valid');
      return {
        isValid: true,
        reason: 'No status element found'
      };
    }
  } catch (error) {
    console.log(`⚠️ [Relationships] Error validating status: ${error.message}`);
    return {
      isValid: true,
      reason: 'Error during validation, assuming valid'
    };
  }
}

/**
 * Select the next valid relationship from the table
 * @param {Page} page - Playwright page object
 * @param {Locator} tbody - The table body locator
 * @returns {Object} - {success: boolean, message: string}
 */
async function selectNextValidRelationship(page, tbody) {
  console.log('🔍 [Relationships] Looking for next valid relationship...');
  
  try {
    const relationshipRows = tbody.locator('tr[tabindex="0"]');
    const totalRows = await relationshipRows.count();
    console.log(`📊 [Relationships] Found ${totalRows} relationship row(s) in table`);
    
    if (totalRows <= 1) {
      return {
        success: false,
        message: 'No additional relationships available'
      };
    }
    
    // Try clicking the second relationship (index 1)
    const secondRelationshipRow = relationshipRows.nth(1);
    if (await secondRelationshipRow.count() > 0) {
      console.log('📝 [Relationships] Clicking on next relationship to edit...');
      await secondRelationshipRow.click();
      await page.waitForTimeout(2000); // Wait for modal to load
      
      return {
        success: true,
        message: 'Successfully selected next relationship'
      };
    } else {
      return {
        success: false,
        message: 'Second relationship row not found'
      };
    }
  } catch (error) {
    console.log(`❌ [Relationships] Error selecting next relationship: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

async function relationshipsFill(baseDomain, page, outputDir, action, schoolId, isSecondRun = false, browser = null) {
  console.log(`🔗 [Relationships] Starting ${action} process...`);
  
  // Navigate to relationships page
  const relationshipsLink = page.locator('li[data-test="routeToRelationships"]');
  if (await relationshipsLink.count() > 0 && await relationshipsLink.first().isVisible()) {
    console.log('🔗 [Relationships] Clicking on Relationships navigation link...');
    await relationshipsLink.first().click();
    console.log('🔗 [Relationships] Loading Relationships page...');
  } else {
    console.log('❌ [Relationships] Relationships navigation link not found or not visible.');
    return false;
  }
  
  // Check for existing relationships - wait for table to load instead of using timeouts
  console.log('🔗 [Relationships] Waiting for relationships table to load...');
  
  try {
    // Wait for the relationships table to be present and visible
    await page.waitForSelector('[data-test="RelationshipsTable"]', { 
      state: 'visible', 
      timeout: 30000 // 30 second timeout as fallback
    });
    console.log('🔗 [Relationships] Relationships table loaded successfully.');
  } catch (timeoutErr) {
    console.log('⚠️ [Relationships] Relationships table did not load within timeout. Proceeding anyway...');
  }
  
  // Check for existing relationships table
  const relationshipsTable = page.locator('[data-test="RelationshipsTable"]');
  if (await relationshipsTable.count() > 0) {
    const tbody = relationshipsTable.locator('tbody');
    const noRelationshipsText = tbody.locator('[aria-label="There aren\'t any Relationships in this view right now."]');
    
    // Handle action-specific logic
    if (action === 'editRelationships') {
      if (await noRelationshipsText.count() > 0) {
        console.log('ℹ️ [Edit Relationships] No existing relationships found to edit.');
        return false;
      } else {
        console.log('ℹ️ [Edit Relationships] Existing relationships found, editing first one...');
        // Force edit mode by setting isSecondRun = false
        isSecondRun = false;
      }
    } else if (action === 'createRelationships') {
      console.log('ℹ️ [Create Relationships] Proceeding to create new relationship...');
      // Force create mode by setting isSecondRun = true (skips edit logic)
      isSecondRun = true;
    } else {
      // Legacy support for old 'relationships' action (backwards compatibility)
      console.log('🔗 [Relationships] Using legacy combined edit+create flow...');
      if (await noRelationshipsText.count() > 0) {
        console.log('ℹ️ [Relationships] No existing relationships found, proceeding to create new one.');
      } else if (!isSecondRun) {
        console.log('ℹ️ [Relationships] Existing relationships found, editing first one...');
      } else {
        console.log('ℹ️ [Relationships] Second run - skipping edit of existing relationships, proceeding to create new one.');
      }
    }
  } else {
    console.log('⚠️ [Relationships] Relationships table not found, proceeding anyway.');
  }
  
  // Continue with the existing relationship logic based on isSecondRun flag

  if (await relationshipsTable.count() > 0) {
    const tbody = relationshipsTable.locator('tbody');
    const noRelationshipsText = tbody.locator('[aria-label="There aren\'t any Relationships in this view right now."]');
    
    if (await noRelationshipsText.count() > 0) {
      console.log('ℹ️ [Relationships] No existing relationships found, proceeding to create new one.');
    } else if (!isSecondRun) {
      console.log('ℹ️ [Relationships] Existing relationships found, editing first one...');
      
      // Click on the first relationship row
      const firstRelationshipRow = tbody.locator('tr[tabindex="0"]').first();
      if (await firstRelationshipRow.count() > 0) {
        console.log('📝 [Relationships] Clicking on first relationship to edit...');
        await firstRelationshipRow.first().click();
        await page.waitForTimeout(2000); // Wait for edit modal to load
        
        // Wait for edit relationship modal
        const editModal = page.locator('.modal-dialog');
        await editModal.waitFor({ state: 'visible', timeout: 10000 });
        console.log('   ┗ Edit relationship modal opened.');
        
        // Validate if relationship has error status
        const errorValidationResult = await validateRelationshipStatus(page, editModal);
        if (!errorValidationResult.isValid) {
          console.log('🔄 [Relationships] Invalid relationship detected, trying next one...');
          
          // Close the current modal
          const closeModalBtn = page.locator('button[aria-label="Close modal"]');
          if (await closeModalBtn.count() > 0) {
            await closeModalBtn.click();
            await page.waitForTimeout(1000);
            console.log('   ┗ Closed modal with error relationship.');
          }
          
          // Try to find and click the next relationship
          const nextRelationshipResult = await selectNextValidRelationship(page, tbody);
          if (!nextRelationshipResult.success) {
            console.log('❌ [Relationships] No valid relationships found for editing.');
            return false;
          }
          
          // Wait for the new modal to open
          await editModal.waitFor({ state: 'visible', timeout: 10000 });
          console.log('   ┗ New edit relationship modal opened.');
        }
        
        // Take full-height screenshot before editing
        console.log('📸 [Relationships] Taking full-height screenshot before editing...');
        const screenshotBefore = path.join(outputDir, `${action}-update-modal-before.png`);
        await captureRelationshipModalFull(page, screenshotBefore);
        console.log(`   ┗ Screenshot saved to ${screenshotBefore}`);
        
        // Capture original values
        console.log('📝 [Relationships] Capturing original relationship values...');
        const originalValues = {};
        
        const relationshipNameInput = page.locator('input[placeholder="Set relationship name"]');
        if (await relationshipNameInput.count() > 0) {
          originalValues.relationshipName = await relationshipNameInput.first().inputValue();
        }
        
        const maxEnrollmentInput = page.locator('input[placeholder="Set combined max enrollment"]');
        if (await maxEnrollmentInput.count() > 0) {
          originalValues.maxEnrollment = await maxEnrollmentInput.first().inputValue();
        }
        
        const notesTextarea = page.locator('textarea[placeholder="Set relationship notes"]');
        if (await notesTextarea.count() > 0) {
          originalValues.notes = await notesTextarea.first().inputValue();
        }
        
        console.log('   ┗ Original values captured for comparison.');
        
        // Edit relationship name
        if (await relationshipNameInput.count() > 0) {
          console.log('✏️ [Relationships] Editing relationship name...');
          await relationshipNameInput.first().fill(originalValues.relationshipName + '-CDtest');
          console.log('   ┗ Relationship name updated.');
        } else {
          console.log('⚠️ [Relationships] Relationship name input not found.');
        }
        
        // Edit combined max enrollment
        if (await maxEnrollmentInput.count() > 0) {
          console.log('🔢 [Relationships] Updating combined max enrollment...');
          await maxEnrollmentInput.first().fill('60');
          console.log('   ┗ Combined max enrollment updated to 60.');
        } else {
          console.log('⚠️ [Relationships] Combined max enrollment input not found.');
        }
        
        // Edit relationship notes
        if (await notesTextarea.count() > 0) {
          console.log('📝 [Relationships] Editing relationship notes...');
          await notesTextarea.first().fill(originalValues.notes + '-CDtest');
          console.log('   ┗ Relationship notes updated.');
        } else {
          console.log('⚠️ [Relationships] Relationship notes textarea not found.');
        }
        
        // Capture new values after editing
        console.log('📝 [Relationships] Capturing new relationship values...');
        const newValues = {};
        
        if (await relationshipNameInput.count() > 0) {
          newValues.relationshipName = await relationshipNameInput.first().inputValue();
        }
        
        if (await maxEnrollmentInput.count() > 0) {
          newValues.maxEnrollment = await maxEnrollmentInput.first().inputValue();
        }
        
        if (await notesTextarea.count() > 0) {
          newValues.notes = await notesTextarea.first().inputValue();
        }
        
        console.log('   ┗ New values captured for comparison.');
        
        // Compare and create diff file (markdown table)
        console.log('📊 [Relationships] Creating relationship field differences...');
        const tableRows = [];
        for (const key of Object.keys(originalValues)) {
          const beforeVal = originalValues[key] ?? '';
          const afterVal = newValues[key] ?? '';
          const changed = beforeVal !== afterVal;
          const status = changed ? '✅' : '❌';
          tableRows.push(`| ${key} | ${JSON.stringify(beforeVal)} | ${JSON.stringify(afterVal)} | ${status} |`);
        }
        
        if (tableRows.length > 0) {
          const header = '| Field | Original | New | Status | Comments |\n| --- | --- | --- | --- | --- |';
          const diffText = `${header}\n${tableRows.join('\n')}`;
          console.log('\n=== Relationship Field Differences (Table) ===\n' + diffText);
          const now = new Date();
          const pad = n => n.toString().padStart(2, '0');
          const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
          const diffFileName = `${schoolId}-update-field-differences-${dateStr}.txt`;
          const diffFilePath = path.join(outputDir, diffFileName);
          fs.writeFileSync(diffFilePath, diffText, 'utf8');
          console.log(`\nDifferences saved to: ${diffFilePath}`);
        } else {
          console.log('\nNo relationship field differences detected.');
        }
        
        // Add course and section to the relationship (reusing create logic)
        console.log('🔗 [Relationships] Adding course and section to edited relationship...');
        await addCourseAndSections(page);
        console.log('   ┗ Course and section addition completed for edit.');
        
        // Take full-height screenshot after editing and adding course/section
        console.log('📸 [Relationships] Taking full-height screenshot after editing...');
        const screenshotAfter = path.join(outputDir, `${action}-update-modal-after.png`);
        await captureRelationshipModalFull(page, screenshotAfter);
        console.log(`   ┗ Screenshot saved to ${screenshotAfter}`);

        // Click save relationship button
        const saveRelationshipBtn = page.locator('[data-test="save-relationship"]');
        if (await saveRelationshipBtn.count() > 0 && await saveRelationshipBtn.first().isVisible()) {
          console.log('💾 [Relationships] Saving edited relationship...');
          await saveRelationshipBtn.first().click();
          await page.waitForTimeout(5000); // Wait 5 seconds for potential conflict modal to appear

          // Check for conflict modal
          const conflictModal = page.locator('.modal-dialog');
          const conflictModalTitle = page.locator('h3.heading', { hasText: 'Relationship Conflicts' });
          
          if (await conflictModalTitle.count() > 0 && await conflictModalTitle.first().isVisible()) {
            console.log('⚠️ [Relationships] Conflict modal detected during edit! Taking screenshot...');
            
            // Take full screenshot of the conflict modal
            const conflictScreenshotPath = path.join(outputDir, `${action}-conflictModal.png`);
            await captureRelationshipModalFull(page, conflictScreenshotPath, true);
            console.log(`   ┗ Conflict modal screenshot saved to ${conflictScreenshotPath}`);
            
            // Click "Save Anyway" button if available
            const saveAnywayBtn = page.locator('button[data-test="save_anyway"]');
            if (await saveAnywayBtn.count() > 0 && await saveAnywayBtn.first().isVisible()) {
              console.log('   ┗ Clicking "Save Anyway" button...');
              await saveAnywayBtn.first().click();
              await page.waitForTimeout(1000); // Wait for modal to process
              console.log('   ┗ Relationship saved despite conflicts.');
            } else {
              console.log('   ┗ No "Save Anyway" button found in conflict modal.');
            }
          } else {
            console.log('   ┗ No conflict modal detected, waiting for relationship modal to close...');
            
            // Wait for the edit relationship modal to close
            try {
              await page.waitForSelector('input[placeholder="Set relationship name"]', { state: 'detached', timeout: 10000 });
              console.log('   ┗ Edit relationship modal closed successfully.');
            } catch (timeoutErr) {
              console.log('⚠️ [Relationships] Edit modal did not close within timeout. Checking if still visible...');
              
              // Check if edit modal is still visible by looking for the relationship name input
              const editModalStillVisible = await page.locator('input[placeholder="Set relationship name"]').count() > 0;
              if (editModalStillVisible) {
                console.log('   ┗ Edit modal is still visible. Trying to close manually...');
                
                // Try clicking outside the modal
                try {
                  const body = page.locator('body');
                  await body.click({ position: { x: 10, y: 10 } });
                  await page.waitForTimeout(500);
                  console.log('   ┗ Attempted to close modal by clicking outside.');
                } catch (clickErr) {
                  console.log(`   ┗ Error clicking outside modal: ${clickErr.message}`);
                }
                
                // Try escape key as fallback
                try {
                  await page.keyboard.press('Escape');
                  await page.waitForTimeout(500);
                  console.log('   ┗ Attempted to close modal with escape key.');
                } catch (escapeErr) {
                  console.log(`   ┗ Error using escape key: ${escapeErr.message}`);
                }
                
                // Final check if edit modal is still there
                const finalModalCheck = await page.locator('input[placeholder="Set relationship name"]').count() > 0;
                if (finalModalCheck) {
                  console.log('⚠️ [Relationships] Edit modal still visible after fallback attempts. Proceeding anyway...');
                } else {
                  console.log('   ┗ Edit modal closed via fallback methods.');
                }
              } else {
                console.log('   ┗ Edit modal is no longer visible.');
              }
            }
          }
          
          // Additional wait to ensure everything is settled
          await page.waitForTimeout(2000);
          console.log('   ┗ Edit relationship save process completed.');
        } else {
          console.log('❌ [Relationships] Save relationship button not found or not visible.');
          
          // Offer user takeover for missing save button
          if (browser && schoolId) {
            const userResponse = await waitForUserResponseWithTimeout(5);
            if (userResponse === 'yes') {
              const takeoverResult = await offerUserTakeover(page, browser, outputDir, 'relationship-save', schoolId, action, 'Save relationship button not found or not visible', null, true);
              if (takeoverResult.success) {
                console.log('✅ User intervention successful - relationship saved manually');
                if (takeoverResult.sectionChanged) {
                  console.log('ℹ️ Section change detected, but relationship operations continue normally');
                }
                return 'edit_completed';
              }
            }
          }
        }
                
               
        // If this is the first run and we successfully edited a relationship, 
        // start the merge report polling and then run the flow again to create a new relationship
        if (!isSecondRun) {
          console.log('🔄 [Relationships] First run completed (edit). Starting second run to create new relationship...');
          return 'edit_completed'; // Special return value to indicate edit was completed
        } else {
          return true; // Exit early since we edited an existing relationship on second run
        }
              } else {
          console.log('⚠️ [Relationships] No relationship rows found to edit.');
        }
      } else {
        console.log('ℹ️ [Relationships] Second run - skipping edit of existing relationships, proceeding to create new one.');
      }
    } else {
      console.log('⚠️ [Relationships] Relationships table not found, proceeding anyway.');
    }
  
  // Click Add Relationship button
  await page.waitForTimeout(2000); // Wait for previous page to load
  const addRelationshipBtn = page.locator('button.btn.btn-primary', { hasText: 'Add Relationship' });
  if (await addRelationshipBtn.count() > 0 && await addRelationshipBtn.first().isVisible()) {
    console.log('➕ [Relationships] Clicking Add Relationship button...');
    await addRelationshipBtn.first().click();
    await page.waitForTimeout(2000); // Wait for modal to load
  } else {
    console.log('❌ [Relationships] Add Relationship button not found or not visible.');
    return false;
  }
  
  // Wait for modal dialog
  const modalDialog = page.locator('.modal-dialog');
  await modalDialog.waitFor({ state: 'visible', timeout: 10000 });
  console.log('   ┗ Relationship modal opened.');
  
  // Fill relationship name
  const relationshipNameInput = page.locator('input[placeholder="Set relationship name"]');
  if (await relationshipNameInput.count() > 0) {
    console.log('✏️ [Relationships] Filling relationship name...');
    await relationshipNameInput.first().fill('-CDtest');
    console.log('   ┗ Relationship name filled.');
  } else {
    console.log('⚠️ [Relationships] Relationship name input not found.');
  }
  
  // Fill combined max enrollment
  const maxEnrollmentInput = page.locator('input[placeholder="Set combined max enrollment"]');
  if (await maxEnrollmentInput.count() > 0) {
    console.log('🔢 [Relationships] Filling combined max enrollment...');
    await maxEnrollmentInput.first().fill('50');
    console.log('   ┗ Combined max enrollment filled.');
  } else {
    console.log('⚠️ [Relationships] Combined max enrollment input not found.');
  }
  
  // Select relationship type
  const relationshipSelect = page.locator('.multiselect', { hasText: 'Select relationship' });
  if (await relationshipSelect.count() > 0) {
    console.log('🔽 [Relationships] Opening relationship type dropdown...');
    await relationshipSelect.first().click();
    await page.waitForTimeout(500);
    
    // Look for 'Same Time Same Day Same Room' option
    const sameTimeOption = page.locator('.multiselect__content-wrapper li', { hasText: 'Same Time Same Day Same Room' });
    if (await sameTimeOption.count() > 0) {
      await sameTimeOption.first().click();
      console.log('   ┗ Relationship type selected: Same Time Same Day Same Room');
    } else {
      console.log('⚠️ [Relationships] "Same Time Same Day Same Room" option not found, selecting first available option.');
      const firstOption = page.locator('.multiselect__content-wrapper li').first();
      if (await firstOption.count() > 0) {
        await firstOption.first().click();
        console.log('   ┗ First available relationship type selected.');
      }
    }
  } else {
    console.log('⚠️ [Relationships] Relationship type dropdown not found.');
  }
  
  // Fill relationship notes
  const notesTextarea = page.locator('textarea[placeholder="Set relationship notes"]');
  if (await notesTextarea.count() > 0) {
    console.log('📝 [Relationships] Filling relationship notes...');
    await notesTextarea.first().fill('-CDtest');
    console.log('   ┗ Relationship notes filled.');
  } else {
    console.log('⚠️ [Relationships] Relationship notes textarea not found.');
  }
  
  // Add course and sections to relationship (with second section for create mode)
  await addCourseAndSections(page, true);
  
  // Take screenshot of the modal
  console.log('📸 [Relationships] Taking screenshot of relationship modal...');
  const screenshotPath = path.join(outputDir, `${action}-create-modal.png`);
  await modalDialog.screenshot({ path: screenshotPath });
  console.log(`   ┗ Screenshot saved to ${screenshotPath}`);
  
  // Click save relationship button
  const saveRelationshipBtn = page.locator('[data-test="save-relationship"]');
  if (await saveRelationshipBtn.count() > 0 && await saveRelationshipBtn.first().isVisible()) {
    console.log('💾 [Relationships] Saving relationship...');
    await saveRelationshipBtn.first().click();
    await page.waitForTimeout(5000); // Wait for potential conflict modal to appear

    // Check for conflict modal and handle it
    const conflictModal = page.locator('.modal-dialog');
    const conflictModalTitle = page.locator('h3.heading', { hasText: 'Relationship Conflicts' });
    
    if (await conflictModalTitle.count() > 0 && await conflictModalTitle.first().isVisible()) {
      console.log('⚠️ [Relationships] Conflict modal detected! Taking screenshot...');
      
      // Take screenshot of the conflict modal
      const conflictScreenshotPath = path.join(outputDir, `${action}-conflictModal.png`);
      await conflictModal.first().screenshot({ path: conflictScreenshotPath });
      console.log(`   ┗ Conflict modal screenshot saved to ${conflictScreenshotPath}`);
      
      // Click "Save Anyway" button if available
      const saveAnywayBtn = page.locator('button[data-test="save_anyway"]');
      if (await saveAnywayBtn.count() > 0 && await saveAnywayBtn.first().isVisible()) {
        console.log('   ┗ Clicking "Save Anyway" button...');
        await saveAnywayBtn.first().click();
        await page.waitForTimeout(1000); // Wait for modal to process
        console.log('   ┗ Relationship saved despite conflicts.');
      } else {
        console.log('   ┗ No "Save Anyway" button found in conflict modal.');
      }
    } else {
      console.log('   ┗ No conflict modal detected, relationship saved normally.');
    }
    
    // Wait for the relationship modal to close before finalizing
    console.log('⏳ [Relationships] Waiting for relationship modal to close...');
    try {
      // Wait for the modal dialog to disappear (timeout after 10 seconds)
      await page.waitForSelector('.modal-dialog', { state: 'detached', timeout: 10000 });
      console.log('   ┗ Relationship modal closed successfully.');
    } catch (timeoutErr) {
      console.log('⚠️ [Relationships] Modal did not close within timeout. Checking if still visible...');
      
      // Check if modal is still visible
      const modalStillVisible = await page.locator('.modal-dialog').count() > 0;
      if (modalStillVisible) {
        console.log('   ┗ Modal is still visible. Trying to close manually...');
        
        // Try clicking outside the modal
        try {
          const body = page.locator('body');
          await body.click({ position: { x: 10, y: 10 } });
          await page.waitForTimeout(500);
          console.log('   ┗ Attempted to close modal by clicking outside.');
        } catch (clickErr) {
          console.log(`   ┗ Error clicking outside modal: ${clickErr.message}`);
        }
        
        // Try escape key as fallback
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          console.log('   ┗ Attempted to close modal with escape key.');
        } catch (escapeErr) {
          console.log(`   ┗ Error using escape key: ${escapeErr.message}`);
        }
        
        // Final check if modal is still there
        const finalModalCheck = await page.locator('.modal-dialog').count() > 0;
        if (finalModalCheck) {
          console.log('⚠️ [Relationships] Modal still visible after fallback attempts. Proceeding anyway...');
        } else {
          console.log('   ┗ Modal closed via fallback methods.');
        }
      } else {
        console.log('   ┗ Modal is no longer visible.');
      }
    }
    
    // Additional wait to ensure everything is settled
    await page.waitForTimeout(2000);
    console.log('   ┗ Relationship save process completed.');
    return true;
  } else {
    console.log('❌ [Relationships] Save relationship button not found or not visible.');
    
    // Offer user takeover for missing save button
    if (browser && schoolId) {
      const userResponse = await waitForUserResponseWithTimeout(5);
      if (userResponse === 'yes') {
        const takeoverResult = await offerUserTakeover(page, browser, outputDir, 'relationship-save', schoolId, action, 'Save relationship button not found or not visible', null, true);
        if (takeoverResult.success) {
          console.log('✅ User intervention successful - relationship saved manually');
          if (takeoverResult.sectionChanged) {
            console.log('ℹ️ Section change detected, but relationship operations continue normally');
          }
          return true;
        }
      }
    }
    
    return false;
  }
}


module.exports = { 
  fillBaselineTemplate, 
  saveSection, 
  validateAndResetMeetingPatterns, 
  validateAndResetProfessors, 
  readSectionValues, 
  relationshipsFill, 
  bannerEthosScheduleType,
  meetAndProfDetails,
  ensureRunLogger,
  checkForApiError
};
