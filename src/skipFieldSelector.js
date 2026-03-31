const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');

const ENTRY_FILES_DIR = path.join(__dirname, 'Resources', 'entryFiles');
const RESOURCE_DIR = path.join(__dirname, 'Resources');
const ENTITY_KEYS = ['sections', 'coursesCm', 'programs'];

const HARDCODED_SKIP_FIELDS = {
  sections: [
    'ethosId', 'callNumber', 'secBillingPeriodType', 'durationUnits', 'sectionNumber',
    'meetingPattern', 'professors', 'preferredRoomCapacity', 'preferredBuilding', 'preferredRoomFeatures',
    'startDate', 'endDate', 'sectionNumberBanner', 'bannerSectionNumber',
    'times'
  ],
  coursesCm: [
    'effectiveStartDate', 'effectiveEndDate', 'crsApprovalDate', 'crsStatusDate',
    'subjectCode', 'courseNumber', 'crsApprovalAgencyIds', 'status', 'sisId',
    'allowIntegration', 'firstAvailable', 'studentEligibilityReference',
    'studentEligibilityRule', 'crossListedCourses'
  ],
  programs: [
    'degreeMaps', 'requisites', 'learningOutcomes', 'files', 'catalogImageUrl',
    'catalogFullDescription', 'catalogDisplayName', 'catalogDescription',
    'departmentOwnership', 'effectiveEndDate', 'sisId', 'allowIntegration',
    'status', 'programCode'
  ]
};

function ensureEntryFilesDir() {
  if (!fs.existsSync(ENTRY_FILES_DIR)) {
    fs.mkdirSync(ENTRY_FILES_DIR, { recursive: true });
  }
}


function getLatestTemplatePath(schoolId, templateType) {
  if (!fs.existsSync(RESOURCE_DIR)) return null;
  const files = fs.readdirSync(RESOURCE_DIR).filter(file => file.endsWith('.json'));
  const templateFiles = files.filter(file => file.includes(schoolId) && file.includes(templateType));
  if (templateFiles.length === 0) return null;

  templateFiles.sort((a, b) => {
    const dateA = a.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    const dateB = b.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    if (dateA && dateB) return dateB[1].localeCompare(dateA[1]);
    return b.localeCompare(a);
  });

  return path.join(RESOURCE_DIR, templateFiles[0]);
}

function getTemplatePayload(templateJson, entityType) {
  if (!templateJson || typeof templateJson !== 'object') return null;
  if (entityType === 'coursesCm') return templateJson.courseTemplate || null;
  if (entityType === 'programs') return templateJson.programTemplate || null;
  return templateJson.sectionTemplate || templateJson;
}

function collectQuestionIdsFromNode(node, setRef) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'question' && typeof node.id === 'string' && node.id.trim()) {
    setRef.add(node.id.trim());
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectQuestionIdsFromNode(child, setRef);
  }
}

function isQuestionEditableAndVisible(question) {
  if (!question || typeof question !== 'object') return false;
  if (question.hidden === true) return false;
  if (question.editable === false) return false;
  if (question.isVisibleInForm === false) return false;
  if (Array.isArray(question.rolesAllowedToEdit) && question.rolesAllowedToEdit.length === 0) return false;
  return true;
}

function parseTemplateFields(templateJson, entityType) {
  const payload = getTemplatePayload(templateJson, entityType);
  const questions = (payload && payload.questions) || {};
  const template = (payload && payload.template) || [];

  const rows = [];
  for (const node of template) {
    if (!node || node.type !== 'card') continue;
    const cardConfig = node.config || {};
    if (cardConfig.hiddenCard === true) continue;
    const cardTitle = (cardConfig.title || node.id || 'Untitled Card').toString().trim();
    const qids = new Set();
    collectQuestionIdsFromNode(node, qids);

    for (const qid of qids) {
      const question = questions[qid];
      if (!isQuestionEditableAndVisible(question)) continue;
      const label = (question.label || qid || '').toString().trim();
      const description = (question.description || question.descriptionLong || '').toString().replace(/\s+/g, ' ').trim();
      rows.push({
        card: cardTitle,
        questionId: qid,
        label,
        description
      });
    }
  }

  return rows;
}

function padRight(str, width) {
  const value = (str || '').toString();
  return value.length >= width ? value.slice(0, width - 1) + ' ' : value.padEnd(width, ' ');
}

const QID_WIDTH = 28;
const LABEL_WIDTH = 40;

function buildChoiceLabel(item) {
  return `${padRight(item.questionId, QID_WIDTH)} ${padRight(item.label, LABEL_WIDTH)}`;
}

function buildHeaderBlock(entityLabel, schoolId) {
  const title = `Select fields to SKIP for ${entityLabel} (${schoolId})`;
  const hint = 'Use arrow keys to navigate, space to toggle, enter to confirm.';
  const headerLine = `  ${padRight('Question ID', QID_WIDTH)} ${padRight('Label', LABEL_WIDTH)}`;
  const divider = '  ' + '─'.repeat(QID_WIDTH + 1 + LABEL_WIDTH);
  return `${title}\n${hint}\n\n${headerLine}\n${divider}`;
}

async function selectFieldsToSkip(fields, entityLabel, schoolId, preSelected, lockedFields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    console.log(`\nNo editable visible fields found for ${entityLabel} (${schoolId}).`);
    return [];
  }

  const preSelectedSet = new Set(Array.isArray(preSelected) ? preSelected : []);
  const lockedSet = new Set(Array.isArray(lockedFields) ? lockedFields : []);

  const grouped = new Map();
  for (const field of fields) {
    if (!grouped.has(field.card)) grouped.set(field.card, []);
    grouped.get(field.card).push(field);
  }

  const choices = [];
  for (const [card, cardFields] of grouped.entries()) {
    choices.push(new inquirer.Separator(`── ${card} ${'─'.repeat(Math.max(0, QID_WIDTH + LABEL_WIDTH - card.length - 3))}`));
    for (const item of cardFields) {
      if (lockedSet.has(item.questionId)) {
        choices.push({
          name: buildChoiceLabel(item),
          disabled: 'Managed by the tool or test flow (not configurable here)'
        });
      } else {
        choices.push({
          name: buildChoiceLabel(item),
          value: item.questionId,
          checked: preSelectedSet.has(item.questionId)
        });
      }
    }
  }

  const answer = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: buildHeaderBlock(entityLabel, schoolId),
      pageSize: 25,
      loop: false,
      choices
    }
  ]);

  return Array.isArray(answer.selected) ? answer.selected : [];
}

function parseCsvLine(line) {
  const parts = line.split(',');
  if (parts.length < 3) return null;
  const schoolId = (parts[0] || '').trim();
  const entity = (parts[1] || '').trim();
  const questionId = parts.slice(2).join(',').trim();
  if (!schoolId || !entity || !questionId) return null;
  return { schoolId, entity, questionId };
}

function normalizeSelections() {
  return { sections: [], coursesCm: [], programs: [] };
}

function readSkipFieldsFromCsv(filePath, expectedSchoolId) {
  const selections = normalizeSelections();
  if (!fs.existsSync(filePath)) return selections;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return selections;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0 && /^schoolId\s*,\s*entity\s*,\s*questionId$/i.test(line)) {
      continue;
    }
    const parsed = parseCsvLine(line);
    if (!parsed) continue;
    if (expectedSchoolId && parsed.schoolId !== expectedSchoolId) continue;
    if (!ENTITY_KEYS.includes(parsed.entity)) continue;
    if (!selections[parsed.entity].includes(parsed.questionId)) {
      selections[parsed.entity].push(parsed.questionId);
    }
  }

  return selections;
}

function scanEntryFiles(schoolId) {
  ensureEntryFilesDir();
  const files = fs.readdirSync(ENTRY_FILES_DIR).filter(file => file.toLowerCase().endsWith('.csv'));
  const matching = [];

  for (const file of files) {
    const fullPath = path.join(ENTRY_FILES_DIR, file);
    const parsed = readSkipFieldsFromCsv(fullPath, schoolId);
    const hasRows = ENTITY_KEYS.some(key => parsed[key].length > 0);
    if (hasRows) {
      matching.push({ fileName: file, filePath: fullPath });
    }
  }

  return matching.sort((a, b) => b.fileName.localeCompare(a.fileName));
}

/**
 * Writes CSV. If `updatedEntities` is provided (non-empty Set or array), merges with existing file:
 * only rows for those entity keys are replaced; other entities keep their existing rows.
 * If `updatedEntities` is omitted or empty, replaces the whole file from `selections` (full replace).
 * @returns {Object} merged selections `{ sections, coursesCm, programs }` that were written
 */
function writeSkipFieldsCsv(schoolId, selections, updatedEntities) {
  ensureEntryFilesDir();
  const fileName = `${schoolId}-skipFields.csv`;
  const filePath = path.join(ENTRY_FILES_DIR, fileName);

  const hasPartialUpdate = updatedEntities && (
    (updatedEntities instanceof Set && updatedEntities.size > 0) ||
    (Array.isArray(updatedEntities) && updatedEntities.length > 0)
  );

  let merged = normalizeSelections();
  if (hasPartialUpdate) {
    if (fs.existsSync(filePath)) {
      merged = readSkipFieldsFromCsv(filePath, schoolId);
    }
    const set = updatedEntities instanceof Set ? updatedEntities : new Set(updatedEntities);
    for (const key of ENTITY_KEYS) {
      if (set.has(key)) {
        merged[key] = Array.isArray(selections[key]) ? [...selections[key]] : [];
      }
    }
  } else {
    for (const key of ENTITY_KEYS) {
      merged[key] = Array.isArray(selections[key]) ? [...selections[key]] : [];
    }
  }

  const lines = ['schoolId,entity,questionId'];
  for (const entity of ENTITY_KEYS) {
    const list = merged[entity] || [];
    for (const questionId of list) {
      lines.push(`${schoolId},${entity},${questionId}`);
    }
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return merged;
}

function getEntitiesForProduct(prodChoice) {
  if (prodChoice === '1') return ['sections'];
  if (prodChoice === '2') return ['coursesCm', 'programs'];
  return ['sections', 'coursesCm', 'programs'];
}

function getTemplateTypeByEntity(entity) {
  if (entity === 'sections') return 'sectionTemplate';
  if (entity === 'coursesCm') return 'courseTemplate';
  return 'programTemplate';
}

function getEntityLabel(entity) {
  if (entity === 'sections') return 'Sections';
  if (entity === 'coursesCm') return 'Courses';
  return 'Programs';
}

async function runSkipFieldWorkflow(schoolId, prodChoice) {
  ensureEntryFilesDir();
  const existingFiles = scanEntryFiles(schoolId);
  const modeChoices = [
    { name: 'Use default definitions (hardcoded only)', value: 'default' },
    { name: 'Generate a new entry file', value: 'generate' }
  ];
  if (existingFiles.length > 0) {
    modeChoices.unshift({ name: 'Use an existing entry file', value: 'existing' });
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Skip field source:',
      choices: modeChoices
    }
  ]);

  if (mode === 'default') return null;

  if (mode === 'existing') {
    const { selectedFilePath } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedFilePath',
        message: `Select entry file for ${schoolId}:`,
        choices: existingFiles.map(file => ({ name: file.fileName, value: file.filePath }))
      }
    ]);
    const selections = readSkipFieldsFromCsv(selectedFilePath, schoolId);
    console.log(`\n✅ Loaded entry file: ${selectedFilePath}`);
    return selections;
  }

  const entities = getEntitiesForProduct(prodChoice);
  const selections = normalizeSelections();
  const updatedEntities = new Set();

  // Load previously saved selections so they appear pre-checked in the table
  let previousSelections = normalizeSelections();
  const existingCsvPath = path.join(ENTRY_FILES_DIR, `${schoolId}-skipFields.csv`);
  if (fs.existsSync(existingCsvPath)) {
    previousSelections = readSkipFieldsFromCsv(existingCsvPath, schoolId);
  }

  for (const entity of entities) {
    const templateType = getTemplateTypeByEntity(entity);
    const templatePath = getLatestTemplatePath(schoolId, templateType);
    if (!templatePath) {
      console.log(`\nNo ${templateType} file found for ${schoolId}. Skipping ${entity}.`);
      continue;
    }

    let templateJson = null;
    try {
      templateJson = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (error) {
      console.log(`\nCould not read template file: ${templatePath} (${error.message})`);
      continue;
    }

    const fields = parseTemplateFields(templateJson, entity);
    const locked = HARDCODED_SKIP_FIELDS[entity] || [];
    const picked = await selectFieldsToSkip(fields, getEntityLabel(entity), schoolId, previousSelections[entity], locked);
    selections[entity] = picked;
    updatedEntities.add(entity);
  }

  if (updatedEntities.size === 0) {
    if (fs.existsSync(existingCsvPath)) {
      console.log('\nNo templates available to configure; CSV unchanged. Using existing entry file if present.');
      return readSkipFieldsFromCsv(existingCsvPath, schoolId);
    }
    console.log('\nNo templates available to configure; no entry file written.');
    return null;
  }

  const merged = writeSkipFieldsCsv(schoolId, selections, updatedEntities);
  const outPath = path.join(ENTRY_FILES_DIR, `${schoolId}-skipFields.csv`);
  console.log(`\nEntry file updated: ${outPath}`);
  return merged;
}

module.exports = {
  runSkipFieldWorkflow,
  parseTemplateFields,
  readSkipFieldsFromCsv,
  writeSkipFieldsCsv,
  scanEntryFiles
};
