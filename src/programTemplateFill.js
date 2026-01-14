const fs = require('fs');
const path = require('path');
const { saveCourse, screenshotCourseForm } = require('./courseTemplateFill');
const { ensureRunLogger } = require('./sectionTemplateFill');
const { offerUserTakeover, waitForUserResponseWithTimeout } = require('./userTakeover');

const DEFAULT_PROGRAM_FORM_NAME = 'Propose New Program';

async function createProgram(page, subfolder, schoolId, browser = null, formName = DEFAULT_PROGRAM_FORM_NAME) {
  try {
    ensureRunLogger(subfolder);
    console.log('\n🎯 Starting Program creation...');
    await page.waitForSelector('[data-test="proposeNewProgramBtn"]', { timeout: 30000 });
    const proposeButton = page.locator('[data-test="proposeNewProgramBtn"]').first();
    await proposeButton.click();

    await selectProgramForm(page, formName);

    const submitButton = page.locator('[data-test="submitNewProgramBtn"]').first();
    await submitButton.waitFor({ state: 'visible', timeout: 30000 });
    await submitButton.click();

    await waitForProgramForm(page);
    await ensureSpecializationEntry(page);
    await fillProgramTemplate(page, schoolId, 'createProgram');
    await enforcePeopleSoftRequirements(page);

    const createScreenshotPath = path.join(subfolder, `${schoolId}-createProgram-form-before.png`);
    await captureProgramScreenshot(page, 'Taking screenshot before saving program proposal...', createScreenshotPath);

    // Try to submit the program proposal
    const submitted = await submitProgram(page, subfolder, schoolId, browser);
    if (submitted) {
      console.log('✅ Program creation and submission completed successfully.');
      return true;
    }

    // If submit didn't work, fall back to saveCourse
    console.log('⚠️ Submit Proposal not available, trying regular save...');
    const saved = await saveCourse(page, subfolder, schoolId, browser);
    if (saved) {
      console.log('✅ Program creation flow completed successfully via save.');
    } else {
      console.log('⚠️ Program creation finished but saving failed.');
    }
    return saved;
  } catch (error) {
    console.error('❌ Error in createProgram:', error.message);
    throw error;
  }
}

async function updateProgram(page, subfolder, schoolId, browser = null) {
  try {
    ensureRunLogger(subfolder);
    console.log('\n📝 Starting Program update...');
    await findAndOpenActiveProgram(page);
    await clickEditProgram(page);

    await waitForProgramForm(page);
    await ensureSpecializationEntry(page);
    const updateBeforeScreenshotPath = path.join(subfolder, `${schoolId}-updateProgram-form-before.png`);
    await captureProgramScreenshot(page, 'Taking screenshot before modifying program...', updateBeforeScreenshotPath);
    await fillProgramTemplate(page, schoolId, 'updateProgram');
    await enforcePeopleSoftRequirements(page);
    const updateAfterScreenshotPath = path.join(subfolder, `${schoolId}-updateProgram-form-after.png`);
    await captureProgramScreenshot(page, 'Taking screenshot after modifying program...', updateAfterScreenshotPath);

    // Try to submit the program proposal
    const submitted = await submitProgram(page, subfolder, schoolId, browser);
    if (submitted) {
      console.log('✅ Program update and submission completed successfully.');
      return true;
    }

    // If submit didn't work, fall back to saveCourse
    console.log('⚠️ Submit Proposal not available, trying regular save...');
    const saved = await saveCourse(page, subfolder, schoolId, browser);
    if (saved) {
      console.log('✅ Program update flow completed successfully via save.');
    } else {
      console.log('⚠️ Program update finished but saving failed.');
    }
    return saved;
  } catch (error) {
    console.error('❌ Error in updateProgram:', error.message);
    throw error;
  }
}

async function selectProgramForm(page, formName) {
  // Wait for the "Add new program" modal to appear and animation to settle
  console.log('⏳ Waiting for Add new program modal...');
  await page.waitForSelector('text=Add new program', { timeout: 30000 });
  await page.waitForTimeout(500); // Allow modal animation to complete
  console.log('✅ Add new program modal appeared');

  // Click on the form selection dropdown using the data-test attribute for specificity
  console.log('🔍 Looking for form selection dropdown...');
  const formSelectContainer = page.locator('[data-test="newProgramFormSelect"]');
  await formSelectContainer.waitFor({ state: 'visible', timeout: 30000 });

  const formSelectWrapper = formSelectContainer.locator('.multiselect').first();
  await formSelectWrapper.waitFor({ state: 'visible', timeout: 30000 });
  console.log('✅ Form selection dropdown found');

  console.log('🖱️ Clicking form selection dropdown...');
  await formSelectWrapper.click();
  await page.waitForTimeout(1000); // Wait for dropdown to open
  console.log('✅ Form selection dropdown opened');

  // Select the specified form option
  console.log(`🔍 Looking for "${formName}" option...`);
  const exactOption = page.locator(`[aria-label="${formName}"]`).first();
  if ((await exactOption.count()) > 0 && (await exactOption.isVisible())) {
    console.log(`✅ "${formName}" option found`);
    console.log(`🖱️ Selecting "${formName}" option...`);
    await exactOption.click();
    console.log(`✅ "${formName}" option selected`);
    return;
  }

  const fuzzyOption = page.locator('.multiselect__option').filter({ hasText: formName }).first();
  if ((await fuzzyOption.count()) > 0 && (await fuzzyOption.isVisible())) {
    console.log(`✅ Found option matching "${formName}" (fuzzy)`);
    await fuzzyOption.click();
    console.log(`✅ Option selected`);
    return;
  }

  console.log(`⚠️ Could not find "${formName}", selecting first available option...`);
  const fallback = page.locator('.multiselect__option').first();
  if ((await fallback.count()) > 0 && (await fallback.isVisible())) {
    await fallback.click();
    console.log('✅ Fallback option selected');
  }
}

async function waitForProgramForm(page) {
  await page.waitForSelector('fieldset[data-test="splitOwnership"]', { timeout: 30000 });
  await page.waitForSelector('main#main.form-wrapper, form.auto-form', { timeout: 30000 }).catch(() => { });
  await page.waitForTimeout(2000);
}

async function enforcePeopleSoftRequirements(page) {
  await ensureProgramDepartmentOwnershipSetup(page);
}

async function ensureProgramDepartmentOwnershipSetup(page) {
  await ensureSplitOwnershipYes(page);
  await ensureDepartmentOwnershipYes(page);
  await ensureTwoDepartments(page);
  await ensureDepartmentOwnershipPercentages(page);
}

async function ensureSplitOwnershipYes(page) {
  const yesBtn = page.locator('#field-splitOwnership button[data-test="YesBtn"]').first();
  if ((await yesBtn.count()) > 0 && (await yesBtn.isVisible())) {
    await yesBtn.click();
  }
}

async function ensureTwoDepartments(page) {
  const field = page.locator('#field-departments');
  if ((await field.count()) === 0) return;
  const tags = field.locator('.multiselect__tags .multiselect__tag');
  const wrapper = field.locator('.multiselect').first();
  if ((await wrapper.count()) === 0) return;

  let selected = await tags.count();
  if (selected >= 2) {
    console.log('ℹ️ Departments already have at least two entries');
    return;
  }

  const toAdd = Math.max(0, 2 - selected); // if empty -> 2, if 1 -> 1
  for (let i = 0; i < toAdd; i++) {
    const added = await addOneDepartment(page, wrapper);
    await page.waitForTimeout(300);
    selected = await tags.count();
    if (!added) break;
    if (selected >= 2) break;
  }

  if (selected < 2) {
    console.log('⚠️ Unable to add enough departments automatically');
  }
}

async function addOneDepartment(page, wrapper) {
  try {
    await wrapper.scrollIntoViewIfNeeded().catch(() => { });
    await wrapper.click({ timeout: 8000 }).catch(async () => {
      await wrapper.click({ force: true, timeout: 8000 });
    });

    const input = wrapper.locator('.multiselect__input').first();
    const hasInput = (await input.count()) > 0;

    const searchTerms = ['sa', 'ma', 'de', 'ad', 'en', 'sc', 'bu', 'a', 'e', 'm', 's'];
    if (hasInput) {
      for (const term of searchTerms) {
        await input.fill(term).catch(() => { });
        await page.waitForTimeout(1200);

        const optionSpans = wrapper.locator(
          '.multiselect__content-wrapper li.multiselect__element span.multiselect__option:not(.multiselect__option--disabled):not(.multiselect__option--selected)'
        );
        const count = await optionSpans.count();
        for (let i = 0; i < count; i++) {
          const opt = optionSpans.nth(i);
          const txt = ((await opt.textContent()) || '').trim();
          const lower = txt.toLowerCase();
          if (!txt) continue;
          if (lower.includes('search to find') || lower.includes('no departments') || lower.includes('list is empty')) continue;
          await opt.click({ timeout: 5000 }).catch(async () => {
            await opt.click({ force: true, timeout: 5000 });
          });
          await page.keyboard.press('Escape').catch(() => { });
          return true;
        }
      }
    }

    // Fallback: try clicking first available option without typing
    const fallbackOptions = wrapper.locator(
      '.multiselect__content-wrapper li.multiselect__element span.multiselect__option:not(.multiselect__option--disabled):not(.multiselect__option--selected)'
    );
    if ((await fallbackOptions.count()) > 0) {
      await fallbackOptions.first().click({ timeout: 5000 }).catch(async () => {
        await fallbackOptions.first().click({ force: true, timeout: 5000 });
      });
      await page.keyboard.press('Escape').catch(() => { });
      return true;
    }

    await page.keyboard.press('Escape').catch(() => { });
    return false;
  } catch (_) {
    await page.keyboard.press('Escape').catch(() => { });
    return false;
  }
}

async function ensureDepartmentOwnershipYes(page) {
  const field = page.locator('#field-departmentOwnership');
  if ((await field.count()) === 0) return;
  const yesBtn = field.locator('button[data-test="YesBtn"]').first();
  const noBtn = field.locator('button[data-test="NoBtn"]').first();
  const yesVisible = (await yesBtn.count()) > 0 && await yesBtn.isVisible().catch(() => false);
  const noVisible = (await noBtn.count()) > 0 && await noBtn.isVisible().catch(() => false);

  if (yesVisible) {
    await yesBtn.click();
  } else if (noVisible) {
    await noBtn.click();
    await page.waitForTimeout(100);
    if ((await yesBtn.count()) > 0 && await yesBtn.isVisible().catch(() => false)) {
      await yesBtn.click();
    }
  }
}

async function findAndOpenActiveProgram(page) {
  await page.waitForSelector('div.common-configurable-table table tbody tr', { timeout: 30000 });
  const rows = page.locator('div.common-configurable-table table tbody tr');
  const total = await rows.count();
  for (let i = 0; i < total; i++) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    const cellCount = await cells.count();
    let status = '';
    for (let j = 0; j < cellCount; j++) {
      const text = (await cells.nth(j).textContent()) || '';
      if (text.trim().toLowerCase() === 'active') {
        status = text.trim();
        break;
      }
    }
    if (status !== 'Active') continue;
    await row.click();
    await page.waitForTimeout(3000);
    const successBanner = page.locator('[data-test="integrationSyncStatus"].alert-success');
    if ((await successBanner.count()) > 0 && await successBanner.first().isVisible()) {
      return;
    }
    await page.goBack();
    await page.waitForSelector('div.common-configurable-table table tbody tr', { timeout: 30000 });
  }
  throw new Error('No Active program with a successful SIS-sync banner was found');
}

async function clickEditProgram(page) {
  const editButton = page.locator('[data-test="edit-program-btn"]').first();
  await editButton.waitFor({ state: 'visible', timeout: 30000 });
  await editButton.click();
  await page.waitForTimeout(2000);
}

async function ensureSpecializationEntry(page) {
  const field = page.locator('#field-specializations');
  if ((await field.count()) === 0) return;
  const noSpecial = field.locator('text=No Program Specializations');
  if ((await noSpecial.count()) > 0) {
    const addButton = field.locator('button:has-text("NEW SPECIALIZATION")').first();
    if ((await addButton.count()) > 0) {
      await addButton.click();
      await page.waitForTimeout(1000);
    }
  }
}

async function ensureDepartmentOwnershipPercentages(page) {
  try {
    // Only set percentages if we truly have 2+ departments selected
    const deptField = page.locator('#field-departments');
    const deptTags = deptField.locator('.multiselect__tags .multiselect__tag');
    const deptCount = (await deptTags.count().catch(() => 0)) || 0;
    if (deptCount < 2) {
      console.log('ℹ️ Skipping ownership percentages: need at least 2 departments selected');
      return;
    }

    const field = page.locator('#field-departmentOwnership');
    if ((await field.count()) === 0) return;
    const addButton = field.locator('button:has-text("add")').first();
    if ((await addButton.count()) === 0) return;

    await addButton.scrollIntoViewIfNeeded().catch(() => { });
    await addButton.click({ timeout: 8000 }).catch(async () => {
      await addButton.click({ force: true, timeout: 8000 });
    });

    // Modal can be rendered as a standard bootstrap-like dialog (modal-dialog/modal-content)
    const modal = page
      .locator('div.modal-dialog')
      .filter({ hasText: 'Set Percent Ownership' })
      .first();
    const visible = await modal.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (!visible) {
      console.log('⚠️ Percent ownership modal did not appear; skipping');
      return;
    }

    const inputs = modal.locator('input[type="number"]');
    const target = Math.min(await inputs.count(), 2);
    for (let i = 0; i < target; i++) {
      const input = inputs.nth(i);
      await input.fill('50').catch(() => { });
      await page.waitForTimeout(100);
    }

    const close = modal.locator('button:has-text("Close"), button:has-text("CLOSE"), button[data-test="closeby-x-btn"]').first();
    if ((await close.count()) > 0) {
      await close.click().catch(async () => {
        await close.click({ force: true });
      });
    } else {
      await page.keyboard.press('Escape').catch(() => { });
    }
    await page.waitForTimeout(500);
  } catch (error) {
    console.log(`⚠️ ensureDepartmentOwnershipPercentages failed: ${error.message}`);
  }
}

async function fillProgramTemplate(page, schoolId, action = 'createProgram') {
  try {
    const templateFile = getLatestProgramTemplateFile(schoolId);
    if (!templateFile) {
      console.log('⚠️ No program template file found, skipping template fill');
      return;
    }

    console.log(`📋 Using program template file: ${templateFile}`);
    const content = fs.readFileSync(templateFile, 'utf8');
    const template = JSON.parse(content);
    const questions = (template && template.programTemplate && template.programTemplate.questions) || {};

    // Protected fields that should not be modified
    const skipFields = [
      'degreeMaps', 'requisites', 'learningOutcomes',
      'files', 'catalogImageUrl', 'catalogFullDescription', 'catalogDisplayName', 'catalogDescription',
      'departmentOwnership', 'effectiveEndDate', 'sisId', 'allowIntegration',
      'status', 'programCode' // programCode is like courseNumber - shouldn't auto-fill
    ];

    const processed = new Set();
    let processedCount = 0;
    let skippedCount = 0;

    console.log(`📝 Found ${Object.keys(questions).length} questions in program template`);

    for (const [qid, question] of Object.entries(questions)) {
      // Skip hidden fields
      if (question.hidden || question.isVisibleInForm === false) {
        skippedCount++;
        continue;
      }

      // Skip protected fields
      if (skipFields.includes(qid)) {
        console.log(`⏭️ Skipping protected field: ${qid}`);
        skippedCount++;
        continue;
      }

      // Skip already processed
      if (processed.has(qid)) continue;

      const questionCopy = Object.assign({ qid }, question);

      try {
        await fillProgramField(page, questionCopy, action);
        processedCount++;
      } catch (fieldError) {
        console.log(`⚠️ Error processing field ${qid}: ${fieldError.message}`);
      }

      processed.add(qid);
      await page.waitForTimeout(150);
    }

    await fillSpecializationsCard(page);

    console.log(`\n📊 Program Template Fill Summary:`);
    console.log(`   ┣ Total fields: ${Object.keys(questions).length}`);
    console.log(`   ┣ Processed: ${processedCount}`);
    console.log(`   ┗ Skipped: ${skippedCount}`);
    console.log('✅ Program template fields processed');
  } catch (error) {
    console.error('❌ Error filling program template:', error.message);
    throw error;
  }
}

async function fillSpecializationsCard(page) {
  try {
    const card = page.locator('#field-specializations');
    if ((await card.count()) === 0) return;

    const accordionButton = card.locator('button.common-accordion').first();
    if ((await accordionButton.count()) > 0) {
      const expanded = await accordionButton.getAttribute('aria-expanded');
      if (expanded !== 'true') {
        await accordionButton.click();
        await page.waitForTimeout(500);
      }
    }

    const specIndex = 0;
    const qidBase = `specializations.${specIndex}`;
    const textFields = [
      { field: 'code', value: 'Spec-Code-CD' },
      { field: 'name', value: 'Specialization Name -CDtest' },
      { field: 'longName', value: 'Specialization Long Name -CDtest' },
      { field: 'transcriptDescription', value: 'Transcript Description -CDtest' },
      { field: 'diplomaDescription', value: 'Diploma Description -CDtest' }
    ];

    for (const entry of textFields) {
      const selector = `#field-specializations\\.${specIndex}\\.${entry.field}`;
      const wrapper = page.locator(selector).first();
      if ((await wrapper.count()) === 0) continue;
      await fillTextField(page, wrapper, entry.value, { qid: `${qidBase}.${entry.field}` });
      await page.waitForTimeout(100);
    }

    const multiFields = [
      'tags',
      'type',
      'status',
      'cipCode',
      'hegisCode',
      'firstTermValid',
      'lastAdmitTerm',
      'defaultOfRequirementTerm',
      'transcriptLevel'
    ];

    for (const fieldName of multiFields) {
      const wrapper = page.locator(`#field-specializations\\.${specIndex}\\.${fieldName}`).first();
      if ((await wrapper.count()) === 0) continue;
      await fillMultiSelectField(page, wrapper, { qid: `${qidBase}.${fieldName}` });
      await page.waitForTimeout(100);
    }

    const yesNoFields = ['evaluateSubplan', 'printOnTranscript', 'printOnDiploma'];
    for (const fieldName of yesNoFields) {
      const wrapper = page.locator(`#field-specializations\\.${specIndex}\\.${fieldName}`);
      if ((await wrapper.count()) === 0) continue;
      const fieldset = wrapper.locator('fieldset').first();
      const target = (await fieldset.count()) > 0 ? fieldset : wrapper.first();
      await fillYesNoField(page, target, { qid: `${qidBase}.${fieldName}` });
      await page.waitForTimeout(100);
    }

    const dateFields = ['effectiveStartDate', 'lastProspectDate'];
    const dateValue = formatFriendlyDate();
    for (const fieldName of dateFields) {
      const wrapper = page.locator(`#field-specializations\\.${specIndex}\\.${fieldName}`).first();
      if ((await wrapper.count()) === 0) continue;
      await fillDateField(page, wrapper, dateValue);
      await page.waitForTimeout(100);
    }
  } catch (error) {
    console.log(`⚠️ Specialization card fill skipped: ${error.message}`);
  }
}

async function fillProgramField(page, question, action) {
  const qid = question.qid;
  console.log(`🔍 Processing program field: ${qid}`);

  // Handle effectiveStartDate specially (set to today's date)
  if (qid === 'effectiveStartDate') {
    await handleEffectiveStartDateForProgram(page, question);
    return;
  }

  const field = await findProgramField(page, qid);
  if (!field) {
    console.log(`   ┗ ⚠️ Field not found: ${qid}`);
    return;
  }

  // Determine actual field type based on DOM structure (similar to courseTemplateFill)
  const foundElementTagName = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => 'unknown');
  const foundElementClass = await field.getAttribute('class') || '';

  // Check for multiselect structure
  let isMultiselect = false;
  let isYesNoButtons = false;

  if (foundElementClass.includes('multiselect') || foundElementClass.includes('multiselect__input')) {
    isMultiselect = true;
  } else {
    // Check parent for multiselect wrapper
    const parentMultiselect = await field.locator('..').locator('.multiselect, [class*="multiselect"]').count();
    if (parentMultiselect > 0) {
      isMultiselect = true;
    }
  }

  // Check for Yes/No buttons
  const yesNoBtns = await field.locator('..').locator('button[data-test="YesBtn"], button[data-test="NoBtn"]').count();
  if (yesNoBtns >= 2) {
    isYesNoButtons = true;
  }

  console.log(`   ┣ Field type analysis: tag=${foundElementTagName}, isMultiselect=${isMultiselect}, isYesNoButtons=${isYesNoButtons}`);

  // Handle based on detected type (prioritize DOM detection over template type)
  if (isMultiselect) {
    console.log(`   ┣ Detected multiselect field, selecting from dropdown...`);
    await fillMultiSelectField(page, field, question);
    return;
  }

  if (isYesNoButtons) {
    console.log(`   ┣ Detected Yes/No button field...`);
    await fillYesNoField(page, field, question);
    return;
  }

  // For regular fields, use template type
  const questionType = question.questionType || question.type || question.inputType || 'text';
  let value = generateProgramTestValue(questionType, qid);

  // Enforce maxLength for text-like fields to prevent validation errors
  if (questionType === 'text' || questionType === 'textarea' || questionType === 'wysiwyg') {
    const maxLen = getConfiguredMaxLength(question);
    if (maxLen && typeof value === 'string' && value.length > maxLen) {
      const suffix = '-CD';
      if (maxLen > suffix.length) {
        const room = maxLen - suffix.length;
        value = value.slice(0, room) + suffix;
      } else {
        value = value.slice(0, maxLen);
      }
      console.log(`   ┣ ✂️ Clamped value to maxLength(${maxLen}): ${value}`);
    }
  }

  switch (questionType) {
    case 'textarea':
    case 'text':
    case 'wysiwyg':
    case 'number':
      await fillTextField(page, field, value, question);
      break;
    case 'date':
      await fillDateField(page, field, value);
      break;
    case 'select':
    case 'dropdown':
      await fillSelectField(page, field, question);
      break;
    case 'multiselect':
      await fillMultiSelectField(page, field, question);
      break;
    case 'boolean':
    case 'checkbox':
    case 'yesNo':
      await fillYesNoField(page, field, question);
      break;
    default:
      await fillTextField(page, field, value, question);
      break;
  }
}

async function findProgramField(page, qid) {
  const escaped = qid.replace(/\./g, '\\.');
  const selectors = [
    // Direct data-test matches
    `[data-test="${qid}"]`,
    `input[data-test="${qid}"]`,
    `select[data-test="${qid}"]`,
    `textarea[data-test="${qid}"]`,
    `.multiselect[data-test="${qid}"]`,
    `div[data-test="${qid}"] .multiselect`,
    // Field wrapper with nested inputs
    `#field-${escaped}`,
    `#field-${escaped} input`,
    `#field-${escaped} select`,
    `#field-${escaped} textarea`,
    `#field-${escaped} .multiselect`,
    `#field-${escaped} .multiselect__input`,
    `[id="field-${qid}"] input`,
    `[id="field-${qid}"] select`,
    `[id="field-${qid}"] textarea`,
    `[id="field-${qid}"] .multiselect`,
    // Specific multiselect wrapper patterns (for cipCode, departments, etc.)
    `#field-${escaped} .common-multiselect .multiselect`,
    `[id="field-${qid}"] .common-multiselect .multiselect`,
    `#field-${escaped} [class*="multiselect"]`,
    // WYSIWYG editors
    `#field-${escaped} [data-test="page-editor"] [contenteditable="true"]`,
    `#field-${escaped} .editor__content [contenteditable="true"]`,
    `[id="field-${qid}"] [contenteditable="true"]`
  ];

  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      if ((await element.count()) > 0) {
        const isVisible = await element.isVisible().catch(() => false);
        const isEnabled = await element.isEnabled().catch(() => true);
        if (isVisible && isEnabled) {
          console.log(`   ┣ Found field ${qid} using selector: ${selector}`);
          return element;
        }
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function fillTextField(page, field, value, question = null) {
  try {
    const qid = question?.qid || 'unknown';

    // Check if field itself is the input
    const tagName = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

    let target = null;
    if (tagName === 'input' || tagName === 'textarea') {
      target = field;
    } else {
      // Check for contenteditable (WYSIWYG)
      const ceAttr = await field.getAttribute('contenteditable').catch(() => null);
      if (ceAttr === 'true') {
        target = field;
      } else {
        // Look for nested input/textarea/contenteditable
        const candidates = field.locator('input, textarea, [contenteditable="true"]');
        if ((await candidates.count()) > 0) {
          target = candidates.first();
        }
      }
    }

    if (!target) {
      console.log(`   ┗ ⚠️ No editable element found for ${qid}, skipping text fill.`);
      return;
    }

    // Check if it's contenteditable (WYSIWYG)
    const isCE = await target.getAttribute('contenteditable').catch(() => null);
    if (isCE === 'true') {
      // Handle WYSIWYG editor
      await target.evaluate((el, html) => {
        el.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = html;
        el.appendChild(p);
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch (_) { }
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { }
      }, String(value));
      console.log(`   ┗ ✅ Filled WYSIWYG field: ${qid}`);
      return;
    }

    // Regular input/textarea
    await target.clear();
    await page.waitForTimeout(100);
    await target.fill(String(value));
    console.log(`   ┗ ✅ Filled text field: ${qid}`);
  } catch (error) {
    console.log(`   ┗ ⚠️ Text fill failed: ${error.message}`);
    // Try alternative approach
    try {
      await field.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(200);
      await field.press('Control+a');
      await page.keyboard.type(String(value));
      console.log(`   ┗ ✅ Filled via keyboard typing`);
    } catch (_) { }
  }
}

async function fillSelectField(page, field, question = null) {
  const qid = question?.qid || 'unknown';

  const tag = await field.evaluate(node => node.tagName.toLowerCase()).catch(() => null);
  if (tag === 'select') {
    await field.selectOption({ index: 1 }).catch(() => { });
    console.log(`   ┗ ✅ Selected option from native select: ${qid}`);
    return;
  }

  // Delegate to multiselect handler for consistency
  await fillMultiSelectField(page, field, question);
}

async function fillMultiSelectField(page, field, question = null) {
  const qid = question?.qid || 'unknown';

  try {
    // Find the multiselect wrapper
    let wrapper = null;
    const fieldClass = await field.getAttribute('class') || '';
    const fieldTag = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

    if (fieldClass.includes('multiselect') && !fieldClass.includes('multiselect__')) {
      wrapper = field;
    } else if (fieldTag === 'div' && fieldClass.includes('common-multiselect')) {
      // common-multiselect wrapper - find the actual multiselect inside
      wrapper = field.locator('.multiselect').first();
    } else {
      // Try to find multiselect within the field
      const nested = field.locator('.multiselect').first();
      if ((await nested.count()) > 0) {
        wrapper = nested;
      } else {
        // Try going up to parent and looking for multiselect
        wrapper = field.locator('..').locator('.multiselect').first();
        if ((await wrapper.count()) === 0) {
          // Try going up one more level
          wrapper = field.locator('../..').locator('.multiselect').first();
        }
      }
    }

    if (!wrapper || (await wrapper.count()) === 0) {
      console.log(`   ┗ ⚠️ No multiselect wrapper found for ${qid}`);
      return;
    }

    // Check if multiselect is disabled
    const multiselectClass = await wrapper.getAttribute('class') || '';
    if (multiselectClass.includes('multiselect--disabled')) {
      console.log(`   ┗ 🚫 Multiselect for ${qid} is disabled, skipping.`);
      return;
    }

    // Check visibility
    const isVisible = await wrapper.isVisible().catch(() => false);
    if (!isVisible) {
      console.log(`   ┗ 👁️ Multiselect for ${qid} not visible, skipping.`);
      return;
    }

    console.log(`   ┣ 🔽 Opening multiselect dropdown for ${qid}...`);

    // Click to open the multiselect
    await wrapper.click();
    await page.waitForTimeout(1000); // Wait for dropdown to render

    // Check for remote-loading input (type to search)
    const inputBox = wrapper.locator('.multiselect__input');
    if ((await inputBox.count()) > 0) {
      const placeholderText = (await inputBox.first().getAttribute('placeholder') || '').trim();
      // Check if this is a searchable multiselect (has placeholder or input is visible)
      const inputVisible = await inputBox.first().isVisible().catch(() => false);
      const shouldType = inputVisible && (placeholderText && /type|search|select|enter/i.test(placeholderText));

      // Also check if dropdown has any options already or is empty
      await page.waitForTimeout(500);
      const existingOptions = page.locator('.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled)');
      const existingCount = await existingOptions.count();

      if (shouldType || existingCount === 0) {
        console.log(`   ┣ Multiselect ${qid} requires typing to search (placeholder: "${placeholderText}")...`);
        // Try common letters/numbers to trigger options
        const searchTerms = ['a', 'c', 'e', 'm', 's', '1', '01', 'comp', 'bus', 'ed'];
        let found = false;

        for (const term of searchTerms) {
          await inputBox.first().fill(term);
          await page.waitForTimeout(1500); // Wait for async load

          const realOptions = page.locator('.multiselect__content-wrapper li:not(.option--disabled):not(.multiselect__option--disabled)');
          const realCount = await realOptions.count();

          // Check for "no results" messages
          const noResults = page.locator('.multiselect__option--disabled', { hasText: /no.*found|list is empty|no element/i });
          const noResVisible = (await noResults.count()) > 0 && await noResults.first().isVisible().catch(() => false);

          if (realCount > 0 && !noResVisible) {
            console.log(`   ┣ Found ${realCount} options with search term "${term}"`);
            found = true;
            break;
          }

          // Clear and try next term
          await inputBox.first().fill('');
          await page.waitForTimeout(300);
        }

        if (!found) {
          console.log(`   ┗ 🚫 No options found for multiselect ${qid} after trying search terms.`);
          await page.keyboard.press('Escape').catch(() => { });
          return;
        }
      }
    }

    // Wait a bit for options to render
    await page.waitForTimeout(500);

    // Find selectable options (not disabled, not already selected)
    const candidateOptions = page.locator(
      '.multiselect__content-wrapper li.multiselect__element:not(.option--disabled):not(.multiselect__option--disabled)'
    );
    let candidateCount = await candidateOptions.count();

    // Fallback: try broader selector
    if (candidateCount === 0) {
      const fallbackOptions = page.locator('.multiselect__content-wrapper li:not(.option--disabled)');
      candidateCount = await fallbackOptions.count();
      if (candidateCount > 0) {
        console.log(`   ┣ Using fallback option selector, found ${candidateCount} options`);
      }
    }

    if (candidateCount === 0) {
      console.log(`   ┗ 🚫 No selectable options found for ${qid}`);
      await page.keyboard.press('Escape').catch(() => { });
      return;
    }

    console.log(`   ┣ Found ${candidateCount} candidate options for ${qid}`);

    // Try to select first visible, valid option
    let selected = false;
    const optionsList = page.locator('.multiselect__content-wrapper li.multiselect__element, .multiselect__content-wrapper li:not(.multiselect__option--disabled)');
    const totalOptions = await optionsList.count();

    for (let i = 0; i < totalOptions && !selected; i++) {
      const option = optionsList.nth(i);
      const isOptionVisible = await option.isVisible().catch(() => false);

      if (!isOptionVisible) continue;

      // Skip placeholder/no-results messages and disabled options
      const txt = (await option.textContent()) || '';
      const optionClass = await option.getAttribute('class') || '';

      if (optionClass.includes('--disabled') || optionClass.includes('--selected')) {
        continue;
      }

      if (txt.trim().toLowerCase().includes('no ') ||
        txt.trim().toLowerCase().includes('not found') ||
        txt.trim().toLowerCase().includes('list is empty') ||
        txt.trim() === '') {
        continue;
      }

      try {
        await option.click({ timeout: 2000 });
        console.log(`   ┗ ✅ Selected option for ${qid}: "${txt.trim().slice(0, 50)}${txt.trim().length > 50 ? '...' : ''}"`);
        selected = true;
      } catch (clickError) {
        try {
          await option.click({ force: true, timeout: 2000 });
          console.log(`   ┗ ✅ Selected option (force) for ${qid}: "${txt.trim().slice(0, 30)}..."`);
          selected = true;
        } catch (_) {
          continue;
        }
      }
    }

    if (!selected) {
      console.log(`   ┗ 🚫 Could not select any option for ${qid}`);
    }

    // Close dropdown if still open
    await page.keyboard.press('Escape').catch(() => { });
    await page.waitForTimeout(300);

  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling multiselect ${qid}: ${error.message}`);
    await page.keyboard.press('Escape').catch(() => { });
  }
}

async function fillYesNoField(page, field, question = null) {
  const qid = question?.qid || 'unknown';

  try {
    // Look for Yes/No buttons in the parent wrapper
    const wrapper = field.locator('..');
    const yesButton = wrapper.locator('button[data-test="YesBtn"]');
    const noButton = wrapper.locator('button[data-test="NoBtn"]');

    const yesCount = await yesButton.count();
    const noCount = await noButton.count();

    if (yesCount === 0 && noCount === 0) {
      // Try broader search
      const altYes = wrapper.locator('button:has-text("Yes")').first();
      const altNo = wrapper.locator('button:has-text("No")').first();

      if ((await altYes.count()) > 0) {
        await altYes.click();
        console.log(`   ┗ ✅ Clicked Yes button for ${qid}`);
        return;
      }

      console.log(`   ┗ ⚠️ No Yes/No buttons found for ${qid}`);
      return;
    }

    // Check which button is currently selected (has btn-raised class)
    const yesClass = await yesButton.first().getAttribute('class') || '';
    const noClass = await noButton.first().getAttribute('class') || '';

    const isYesSelected = yesClass.includes('btn-raised');
    const isNoSelected = noClass.includes('btn-raised');

    // Select opposite of current selection, or Yes if none selected
    let buttonToClick = null;
    let buttonName = '';

    if (isYesSelected && !isNoSelected) {
      buttonToClick = noButton.first();
      buttonName = 'No';
    } else if (isNoSelected && !isYesSelected) {
      buttonToClick = yesButton.first();
      buttonName = 'Yes';
    } else {
      // Neither selected or both selected - click Yes
      buttonToClick = yesButton.first();
      buttonName = 'Yes';
    }

    const isVisible = await buttonToClick.isVisible().catch(() => false);
    const isEnabled = await buttonToClick.isEnabled().catch(() => true);

    if (isVisible && isEnabled) {
      await buttonToClick.click();
      console.log(`   ┗ ✅ Clicked ${buttonName} button for ${qid}`);
    } else {
      console.log(`   ┗ ⚠️ ${buttonName} button not clickable for ${qid}`);
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling Yes/No field ${qid}: ${error.message}`);
  }
}

/**
 * Handle effectiveStartDate field specifically for programs (set to today's date)
 */
async function handleEffectiveStartDateForProgram(page, question) {
  try {
    console.log(`📅 Processing effectiveStartDate field for program...`);

    // Find the effective start date field
    const field = await findProgramField(page, 'effectiveStartDate');

    if (!field) {
      console.log(`   ┗ ⚠️ Could not find effectiveStartDate field`);
      return;
    }

    console.log(`   ┗ ✅ Found effectiveStartDate field`);

    const todayFormatted = formatFriendlyDate();

    console.log(`   ┣ Setting effectiveStartDate to today: ${todayFormatted}`);

    await fillDateField(page, field, todayFormatted);
  } catch (error) {
    console.log(`   ┗ ⚠️ Error in handleEffectiveStartDateForProgram: ${error.message}`);
  }
}

/**
 * Format a date into "Dec 18, 2025" style strings
 */
function formatFriendlyDate(date = new Date()) {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month} ${day}, ${year}`;
}

/**
 * Fill a date field with the specified value
 */
async function fillDateField(page, fieldElement, value) {
  try {
    console.log(`   ┣ 📅 Processing date field with value: ${value}`);

    // Try to find actual input element within the wrapper
    const inputSelectors = [
      'input[type="text"]',
      'input[type="date"]',
      'input',
      '.form-control'
    ];

    let actualInput = null;
    for (const selector of inputSelectors) {
      const input = fieldElement.locator(selector).first();
      if (await input.count() > 0) {
        const isVisible = await input.isVisible().catch(() => false);
        const isEnabled = await input.isEnabled().catch(() => true);
        if (isVisible && isEnabled) {
          actualInput = input;
          console.log(`   ┣ Found date input using selector: ${selector}`);
          break;
        }
      }
    }

    // If no input found, look in parent/sibling elements
    if (!actualInput) {
      const parentInput = fieldElement.locator('..').locator('input').first();
      if (await parentInput.count() > 0) {
        actualInput = parentInput;
        console.log(`   ┣ Found date input in parent element`);
      }
    }

    if (!actualInput) {
      // Maybe fieldElement itself is the input
      const tagName = await fieldElement.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      if (tagName === 'input') {
        actualInput = fieldElement;
        console.log(`   ┣ Field element itself is the input`);
      }
    }

    if (actualInput) {
      try {
        await actualInput.clear();
        await actualInput.fill(value);
        await page.waitForTimeout(500);
        await actualInput.press('Enter'); // Close any date picker
        console.log(`   ┗ ✅ Successfully set date to ${value}`);
      } catch (inputError) {
        console.log(`   ┣ Input field fill failed, trying direct typing...`);
        try {
          await actualInput.click();
          await actualInput.press('Control+a'); // Select all
          await page.keyboard.type(value);
          await actualInput.press('Enter');
          console.log(`   ┗ ✅ Successfully typed date: ${value}`);
        } catch (typeError) {
          console.log(`   ┗ ⚠️ Error typing date: ${typeError.message}`);
        }
      }
    } else {
      console.log(`   ┣ No input field found, trying to interact with wrapper element...`);
      try {
        await fieldElement.click();
        await page.waitForTimeout(500);
        await page.keyboard.type(value);
        await page.keyboard.press('Enter');
        console.log(`   ┗ ✅ Typed date into wrapper element`);
      } catch (wrapperError) {
        console.log(`   ┗ ⚠️ Error with wrapper element: ${wrapperError.message}`);
      }
    }
  } catch (error) {
    console.log(`   ┗ ⚠️ Error filling date field: ${error.message}`);
  }
}

/**
 * Get configured maxLength from question config (for text field validation)
 */
function getConfiguredMaxLength(question) {
  try {
    const v = question && question.config && question.config.validations && question.config.validations.maxLength;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : null;
  } catch (_) { return null; }
}

/**
 * Submit the program proposal and handle any errors
 */
async function submitProgram(page, subfolder, schoolId, browser = null) {
  try {
    console.log('📤 Attempting to submit program proposal...');

    // Look for the Submit Proposal button
    const submitSelectors = [
      '[data-test="submit-proposal-button"]',
      '[data-test="submitProposalBtn"]',
      'button:has-text("Submit Proposal")',
      'button:has-text("SUBMIT PROPOSAL")'
    ];

    let submitButton = null;
    for (const selector of submitSelectors) {
      const button = page.locator(selector).first();
      if (await button.count() > 0 && await button.isVisible()) {
        submitButton = button;
        console.log(`✅ Found submit button with selector: ${selector}`);
        break;
      }
    }

    if (!submitButton) {
      console.log('⚠️ No Submit Proposal button found - skipping submission');
      return false;
    }

    // Check if submit button is disabled
    const isDisabled = await submitButton.getAttribute('disabled') !== null;
    const buttonClass = await submitButton.getAttribute('class') || '';
    const isDisabledByClass = buttonClass.includes('disabled');

    if (isDisabled || isDisabledByClass) {
      console.log('❌ Submit Proposal button is disabled');

      // Check for form errors banner
      const formErrorsBanner = page.locator('#form-errors-summary');
      if ((await formErrorsBanner.count()) > 0 && await formErrorsBanner.first().isVisible()) {
        console.log('❌ Form errors banner detected - Submit Proposal button disabled due to validation errors');

        // Take error screenshot
        if (subfolder && schoolId) {
          const errorScreenshotPath = path.join(subfolder, `${schoolId}-program-submit-error.png`);
          await page.screenshot({
            path: errorScreenshotPath,
            fullPage: true
          });
          console.log(`📸 Error screenshot saved: ${errorScreenshotPath}`);
        }

        // Offer user takeover
        if (browser && schoolId) {
          console.log('🖐️ Manual intervention required - form has validation errors');
          const userResponse = await waitForUserResponseWithTimeout(5);
          if (userResponse === 'yes') {
            const takeoverResult = await offerUserTakeover(
              page,
              browser,
              subfolder,
              'program-submit',
              schoolId,
              'createProgram',
              'Form errors displayed - Submit Proposal button is disabled. Please fix errors and submit manually.',
              null,
              true
            );
            if (takeoverResult.success) {
              console.log('✅ User intervention successful - program submitted manually');
              return true;
            }
          }
        }

        return false;
      }

      // Disabled but no error banner - offer takeover anyway
      if (browser && schoolId) {
        console.log('🖐️ Manual intervention required - Submit button disabled');
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(
            page,
            browser,
            subfolder,
            'program-submit',
            schoolId,
            'createProgram',
            'Submit Proposal button is disabled. Please check and submit manually.',
            null,
            true
          );
          if (takeoverResult.success) {
            console.log('✅ User intervention successful - program submitted manually');
            return true;
          }
        }
      }

      return false;
    }

    // Click the submit button
    console.log('🖱️ Clicking Submit Proposal button...');
    await submitButton.click();
    await page.waitForTimeout(1500);

    // Check for form errors banner after clicking
    const formErrorsBanner = page.locator('#form-errors-summary');
    if ((await formErrorsBanner.count()) > 0 && await formErrorsBanner.first().isVisible()) {
      console.log('❌ Form errors banner appeared after clicking Submit Proposal');

      // Take error screenshot
      if (subfolder && schoolId) {
        const errorScreenshotPath = path.join(subfolder, `${schoolId}-program-submit-error.png`);
        await page.screenshot({
          path: errorScreenshotPath,
          fullPage: true
        });
        console.log(`📸 Error screenshot saved: ${errorScreenshotPath}`);
      }

      // Offer user takeover
      if (browser && schoolId) {
        console.log('🖐️ Manual intervention required - form has validation errors after submit attempt');
        const userResponse = await waitForUserResponseWithTimeout(5);
        if (userResponse === 'yes') {
          const takeoverResult = await offerUserTakeover(
            page,
            browser,
            subfolder,
            'program-submit',
            schoolId,
            'createProgram',
            'Form errors displayed after submit attempt. Please fix errors and submit manually.',
            null,
            true
          );
          if (takeoverResult.success) {
            console.log('✅ User intervention successful - program submitted manually');
            return true;
          }
        }
      }

      return false;
    }

    // Wait for submission to process
    await page.waitForTimeout(2000);

    // Check for success indicators
    const successBanner = page.locator('[data-test="integrationSyncStatus"].alert-success, .alert-success');
    if ((await successBanner.count()) > 0 && await successBanner.first().isVisible()) {
      console.log('✅ Success banner detected - program proposal submitted successfully');
      return true;
    }

    console.log('✅ Submit Proposal button clicked - assuming success');
    return true;

  } catch (error) {
    console.error(`❌ Error in submitProgram: ${error.message}`);
    return false;
  }
}

async function captureProgramScreenshot(page, message, outputPath) {
  if (!outputPath) return;
  try {
    console.log(`📸 ${message}`);
    await screenshotCourseForm(page, outputPath, 'form.auto-form');
    console.log(`✅ Screenshot saved: ${outputPath}`);
  } catch (error) {
    console.log(`⚠️ Screenshot failed: ${error.message}`);
  }
}

function generateProgramTestValue(questionType, qid) {
  const today = new Date();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[today.getMonth()];
  const day = today.getDate();
  const year = today.getFullYear();
  switch (questionType) {
    case 'wysiwyg':
      return `Program description -CDtest`;
    case 'text':
    case 'textarea':
      if (qid.toLowerCase().includes('code')) return 'PRG-CDTEST';
      if (qid.toLowerCase().includes('name')) return `Test Program -CDtest`;
      return `Test Value -CDtest`;
    case 'number':
      return '5';
    case 'date':
      return `${month} ${day}, ${year}`;
    default:
      return 'Test Value -CDtest';
  }
}

function getLatestProgramTemplateFile(schoolId) {
  try {
    const resourcesDir = path.join(__dirname, 'Resources');
    if (!fs.existsSync(resourcesDir)) return null;
    const files = fs.readdirSync(resourcesDir);
    const programFiles = files.filter(file => file.includes(schoolId) && file.includes('programTemplate') && file.endsWith('.json'));
    if (programFiles.length === 0) return null;
    programFiles.sort((a, b) => {
      const dateA = a.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      const dateB = b.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      if (dateA && dateB) {
        return dateB[1].localeCompare(dateA[1]);
      }
      return b.localeCompare(a);
    });
    return path.join(resourcesDir, programFiles[0]);
  } catch (error) {
    console.error('❌ Error finding program template file:', error.message);
    return null;
  }
}

module.exports = {
  createProgram,
  updateProgram,
  fillProgramTemplate,
  getLatestProgramTemplateFile,
  submitProgram
};

