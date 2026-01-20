import fs from 'fs';
import path from 'path';
import { dismissReleaseNotesPopup, signIn } from './auth';
import { seedContext } from './context';
import { createCourse, updateCourse } from './courseTemplateFill';
import { getSchoolTemplate } from './getSchoolTemplate';
import { startMergeReportPolling } from './mergeReportPoller';
import { performPreflightChecks } from './preflightChecks';
import { createProgram, updateProgram } from './programTemplateFill';
import { appendRunSummary, generateRunId } from './runSummary';
import { captureModalAfter, captureModalBefore, createSection, openSection } from './section-screenshot';
import { bannerEthosScheduleType, ensureRunLogger, fillBaselineTemplate, meetAndProfDetails, relationshipsFill, saveSection, validateAndResetMeetingPatterns, validateAndResetProfessors } from './sectionTemplateFill';
import ConsoleLogger from './services/ConsoleLogger';
import type { ILogger } from './services/interfaces/ILogger';

const { launch } = require('./browser');
const { goToProduct } = require('./navigation');
//const { runComputerUseAgent } = require('./agent');

// Session-based course tracking system
global.sessionUsedCourses = new Set();

//const activeCode = 'A';
// Enrollment=0 filter query for sections dashboard
//const filterQuery = `?columns[0]=course.code&columns[1]=sectionNumber&columns[2]=callNumber&columns[3]=sectionName&columns[4]=course.departments&columns[5]=enrollment&columns[6]=statusCode&filter.condition=and&filter.filters[0].customField=false&filter.filters[0].group=section&filter.filters[0].id=enrollment-section&filter.filters[0].inputType=number&filter.filters[0].name=enrollment&filter.filters[0].type=is&filter.filters[0].value=0&filter.filters[1].customField=false&filter.filters[1].group=section&filter.filters[1].id=statusCode-section&filter.filters[1].inputType=select&filter.filters[1].name=statusCode&filter.filters[1].type=is&filter.filters[1].value=A`;

// Utility to ensure schoolId folder exists under src/schools and return its path
async function ensureSchoolFolder(schoolId) {
  const folderPath = path.join(__dirname, 'schools', schoolId);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  return folderPath;
}

// Utility to ensure debug-videos folder exists
function ensureDebugVideoFolder() {
  const folderPath = path.join(__dirname, 'debug-videos');
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  return folderPath;
}

// Helper function to determine product subfolder based on action
function getProductFolder(action) {
  const curriculumActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse', 'createProgram', 'updateProgram'];
  return curriculumActions.includes(action) ? 'Curriculum Management' : 'Academic Scheduling';
}

function getFormNameForAction(action, courseFormName, programFormName) {
  if (action === 'createProgram') return programFormName;
  if (action === 'createCourse') return courseFormName;
  return null;
}

async function run({ email, password, env, productSlug, schoolId, action, courseFormName, programFormName, isApi, logger = new ConsoleLogger() }) {
  const programOnlyActions = ['createProgram', 'updateProgram'];
  const actionProductSlug = programOnlyActions.includes(action) ? 'cm/programs' : productSlug;

  // Ensure schoolId folder exists
  const outputDir = await ensureSchoolFolder(schoolId);
  // Ensure debug-videos folder exists
  const debugVideoDir = ensureDebugVideoFolder();

  // 1) Get API token
  logger.log('\n🔐 Getting API token...');
  const token = await getSchoolTemplate({ email, password }, env, schoolId, logger);
  logger.log('📋 Token:', token);

  // 2) Pre-flight checks
  try {
    await performPreflightChecks(env, schoolId, token, actionProductSlug, action, logger);
  } catch (error) {
    // Pre-flight check failed - error message already displayed, exit gracefully
    process.exit(1);
  }

  // Helper to run a single flow with a pre-created run folder (for 'all' action)
  async function runFlowInFolder(act, runFolder, logger: ILogger) {
    const videoName = `${schoolId}-${act}-debugging-run`;
    // 2) Browser & Context (with video recording)
    // Launch in headed mode for potential user takeover, but minimized initially
    const { browser, ctx, page, baseDomain } = await launch(env, debugVideoDir, videoName, isApi ? true : false);
    // 3) Seed cookies & localStorage
    await seedContext(ctx, baseDomain, email, schoolId, logger);

    // Determine the correct product slug based on the action
    const courseActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse', 'courseAll'];
    const programActions = ['updateProgram', 'createProgram'];
    let currentProductSlug = 'sm/section-dashboard';
    if (programActions.includes(act)) {
      currentProductSlug = 'cm/programs';
    } else if (courseActions.includes(act)) {
      currentProductSlug = 'cm/courses';
    }

    // For update and inactivateSection, navigate with enrollment=0 filter from the start
    if (act === 'update' || act === 'inactivateSection') {
      currentProductSlug = 'sm/section-dashboard';
    }

    // 4) Sign in
    try {
      await signIn(page, email, password, currentProductSlug, env, isApi, logger);
    } catch (error) {
      logger.error('\n❌', error.message);
      await browser.close();
      process.exit(1);
    }
    // 5) Navigate into product
    await goToProduct(page, currentProductSlug, env);
    await dismissReleaseNotesPopup(page, logger);

    // Optional: hand control to computer-use agent if AGENT_MODE is set
    // if (process.env.AGENT_MODE === '1') {
    //   await runComputerUseAgent(page, {
    //     allowedDomains: [baseDomain],
    //     userGoal: process.env.AGENT_GOAL || 'Inspect the page and do nothing destructive.',
    //     stepBudget: Number(process.env.AGENT_STEPS || 30),
    //     allowNavigation: true
    //   });
    // }

    // Check if a merge is in progress and exit if so
    await page.waitForTimeout(3000);

    const mergeAlert = page.locator('[data-cy="section-integration-status-alert"]');
    let alertVisible = false;
    try {
      // Wait up to 3 seconds for the alert to be visible
      await mergeAlert.waitFor({ state: 'visible', timeout: 3000 });
      alertVisible = true;
    } catch (error) {
      // Timeout means the alert is not visible, which is the desired state to proceed
      alertVisible = false;
    }

    if (alertVisible) {
      logger.log('\nA sections nightly merge for this school is currently in progress, please try again later.');
      await browser.close();
      process.exit(0); // Exit gracefully
    }

    // Use the pre-created run folder and create product and method-specific subfolder
    const productFolder = getProductFolder(act);
    const subfolder = path.join(runFolder, productFolder, act);
    fs.mkdirSync(subfolder, { recursive: true });

    // Generate dateStr for this action (needed for diff file names)
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    // Continue with the same logic as runFlow but using the shared run folder
    const actionFormName = getFormNameForAction(act, courseFormName, programFormName);
    await executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, actionFormName, logger);
  }

  // Helper to run a single flow, including browser setup/teardown
  async function runFlow(act, logger: ILogger) {
    // Reset session course tracking for new run
    global.sessionUsedCourses.clear();
    logger.log(`🔄 Reset session course tracking for new run`);

    const videoName = `${schoolId}-${act}-debugging-run`;
    // 2) Browser & Context (with video recording)
    // Launch in headed mode for potential user takeover, but minimized initially
    const { browser, ctx, page, baseDomain } = await launch(env, debugVideoDir, videoName, isApi ? true : false);
    // 3) Seed cookies & localStorage
    await seedContext(ctx, baseDomain, email, schoolId, logger);
    // 4) Sign in
    let desiredSlug = productSlug;
    const courseOnlyActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse', 'courseAll'];
    const programActions = ['updateProgram', 'createProgram'];
    if (programActions.includes(act)) {
      desiredSlug = 'cm/programs';
    } else if (courseOnlyActions.includes(act)) {
      desiredSlug = 'cm/courses';
    } else if (act === 'update' || act === 'inactivateSection') {
      desiredSlug = 'sm/section-dashboard';
    }
    try {
      await signIn(page, email, password, desiredSlug, env, isApi, logger);
    } catch (error) {
      logger.error('\n❌', error.message);
      await browser.close();
      process.exit(1);
    }
    // 5) Navigate into product
    await goToProduct(page, desiredSlug, env);
    await dismissReleaseNotesPopup(page, logger);

    // Optional: hand control to computer-use agent if AGENT_MODE is set
    //if (process.env.AGENT_MODE === '1') {
    //await runComputerUseAgent(page, {
    //allowedDomains: [baseDomain],
    //userGoal: process.env.AGENT_GOAL || 'Inspect the page and do nothing destructive.',
    //stepBudget: Number(process.env.AGENT_STEPS || 30),
    //allowNavigation: true
    //});
    //}

    // Check if a merge is in progress and exit if so
    await page.waitForTimeout(3000);

    const mergeAlert = page.locator('[data-cy="section-integration-status-alert"]');
    let alertVisible = false;
    try {
      // Wait up to 3 seconds for the alert to be visible
      await mergeAlert.waitFor({ state: 'visible', timeout: 3000 });
      alertVisible = true;
    } catch (error) {
      // Timeout means the alert is not visible, which is the desired state to proceed
      alertVisible = false;
    }

    if (alertVisible) {
      logger.log('\nA sections nightly merge for this school is currently in progress, please try again later.');
      await browser.close();
      process.exit(0); // Exit gracefully
    }

    // Create timestamped Run folder for this execution
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const runFolder = path.join(outputDir, `Run-${dateStr}`);
    fs.mkdirSync(runFolder, { recursive: true });

    logger.log(`\n🚀 Starting "${act}" run in folder: ${runFolder}`);

    // Create product and method-specific subfolder within the run folder
    const productFolder = getProductFolder(act);
    const subfolder = path.join(runFolder, productFolder, act);
    fs.mkdirSync(subfolder, { recursive: true });

    // Initialize run-scoped logger for this action subfolder before any further logs
    try { ensureRunLogger(subfolder, logger); } catch (_) { }

    // Execute the action
    const actionFormName = getFormNameForAction(act, courseFormName, programFormName);
    await executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, actionFormName, logger);
  }

  // Helper function to log failed runs to summary
  async function logFailedRun(runFolder, act, schoolId, reason, logger: ILogger) {
    try {
      const runId = generateRunId(act);
      const currentDate = new Date().toISOString();
      await appendRunSummary(
        runFolder,
        runId,
        'N/A',
        'failed',
        reason,
        currentDate,
        schoolId,
        act,
        'N/A', // errors parameter for failed runs
        logger,
      );
    } catch (error) {
      logger.error('❌ Failed to log failed run to summary:', error.message);
    }
  }

  // Shared function to execute actions
  async function executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, formName, logger: ILogger) {
    if (act === 'update') {
      // Begin update process (dashboard already filtered to enrollment=0)
      logger.log('\n📝 Initiating Section update process...');

      try {
        await openSection(page, logger);
      } catch (error) {
        logger.log(`❌ [Update] ${error.message}`);
        logger.log('❌ [Update] Ending update flow due to no available sections.');
        await browser.close();
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'No available sections to update', logger);
        return; // Exit the function early
      }
      await captureModalBefore(page, subfolder, 'update', logger);
      // Capture details "before" screenshots for Meeting Patterns & Instructor
      try { await meetAndProfDetails(page, subfolder, 'update', logger); } catch (_) { }
      logger.log('\n📝 Filling section template fields...');
      await fillBaselineTemplate(page, schoolId, 'update', undefined, undefined, logger);
      // Call bannerEthosScheduleType for banner_ethos schools
      if (schoolId.includes('banner_ethos')) {
        await bannerEthosScheduleType(page, logger);
      }
      await validateAndResetMeetingPatterns(page, subfolder, 'update', logger);
      let saveSuccess = await validateAndResetProfessors(page, subfolder, 'update', browser, schoolId, null, dateStr, logger);

      // Log the save result
      if (saveSuccess) {
        logger.log('\n📝 Section was saved successfully.');
      } else {
        logger.log('\n📝 Section was not saved.');
      }
      // saveSuccess is now set by validateAndResetProfessors which handles saving internally
      await browser.close();
      if (saveSuccess) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log("Couldn't save section, thus cannot pull merge report");
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Failed to save section', logger);
      }
    } else if (act === 'create') {
      await logger.log('\n Initiating create Section with Meeting and Professor process...');
      await createSection(page, undefined, logger);
      logger.log('\n📝 Filling section template fields...');
      await fillBaselineTemplate(page, schoolId, 'create', undefined, undefined, logger);
      // Call bannerEthosScheduleType for banner_ethos schools
      if (schoolId.includes('banner_ethos')) {
        await bannerEthosScheduleType(page, logger);
      }
      await validateAndResetMeetingPatterns(page, subfolder, 'create', logger);
      let saveSuccess = await validateAndResetProfessors(page, subfolder, 'create', browser, schoolId, null, dateStr, logger);
      await browser.close();
      if (saveSuccess) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log("Couldn't save section, thus cannot pull merge report");
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Failed to save section', logger);
      }
    } else if (act === 'createNoMeetNoProf') {
      await logger.log('\n Initiating create Section wit no Meeting or Professor process...');
      await createSection(page, undefined, logger);
      logger.log('\n📝 Filling section template fields (no meeting/prof)...');
      // First, fill baseline fields without saving to allow all sections to render
      await fillBaselineTemplate(page, schoolId, 'createNoMeetNoProf', undefined, undefined, logger);
      // Now adjust Banner Ethos Schedule Type after fields are rendered
      if (schoolId.includes('banner_ethos')) {
        await bannerEthosScheduleType(page, logger);
      }
      // Take the after screenshot and save explicitly
      await captureModalAfter(page, subfolder, 'createNoMeetNoProf', logger);
      let saveSuccess = await saveSection(page, subfolder, 'createNoMeetNoProf', browser, schoolId, logger);
      await browser.close();
      if (saveSuccess) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log("Couldn't save section, thus cannot pull merge report");
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Failed to save section', logger);
      }
    } else if (act === 'editRelationships') {
      await logger.log('\n🔗 Initiating Relationships edit process...');
      let result = await relationshipsFill(baseDomain, page, subfolder, 'editRelationships', schoolId, false, browser, logger);
      await browser.close();

      if (result === 'edit_completed' || result === true) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log('❌ Relationships edit process failed.');
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Relationships edit process failed', logger);
      }
    } else if (act === 'createRelationships') {
      await logger.log('\n🔗 Initiating Relationships creation process...');
      let result = await relationshipsFill(baseDomain, page, subfolder, 'createRelationships', schoolId, true, browser, logger);
      await browser.close();

      if (result === true) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log('❌ Relationships create process failed.');
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Relationships create process failed', logger);
      }
    } else if (act === 'inactivateSection') {
      await logger.log('\n Initiating Section inactivation process...');
      try {
        await openSection(page, logger);
      } catch (error) {
        logger.log(`❌ [InactivateSection] ${error.message}`);
        logger.log('❌ [InactivateSection] Ending inactivation flow due to no available sections.');
        await browser.close();
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'No available sections to inactivate', logger);
        return; // Exit the function early
      }
      await captureModalBefore(page, subfolder, 'inactivateSection', logger);

      logger.log('\n📝 Filling section template fields...');
      // fillBaselineTemplate will handle screenshot and save internally for this action
      let saveSuccess = await fillBaselineTemplate(page, schoolId, 'inactivateSection', subfolder, browser, logger);

      await browser.close();
      if (saveSuccess) {
        await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
      } else {
        logger.log("Couldn't save section, thus cannot pull merge report");
        // Log failed run to summary
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, 'Failed to save section', logger);
      }
    } else if (act === 'updateCourse') {
      await logger.log('\n📚 Initiating Course update process...');
      try {
        const success = await updateCourse(page, subfolder, schoolId, browser, 'updateCourse', logger);
        await browser.close();

        if (success) {
          logger.log('✅ Course update completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Course update process failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Course update process failed', logger);
        }
      } catch (error) {
        logger.log(`❌ [UpdateCourse] ${error.message}`);
        await browser.close();
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Course update error: ${error.message}`, logger);
      }
    } else if (act === 'updateProgram') {
      await logger.log('\n📚 Initiating Program update process...');
      try {
        const success = await updateProgram(page, subfolder, schoolId, browser, logger);
        await browser.close();

        if (success) {
          logger.log('✅ Program update completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Program update process failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Program update process failed', logger);
        }
      } catch (error) {
        logger.log(`❌ [UpdateProgram] ${error.message}`);
        await browser.close();
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Program update error: ${error.message}`, logger);
      }
    } else if (act === 'inactivateCourse') {
      await logger.log('\n📚 Initiating Course inactivation process...');
      try {
        const success = await updateCourse(page, subfolder, schoolId, browser, 'inactivateCourse', logger);
        await browser.close();

        if (success) {
          logger.log('✅ Course inactivation completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Course inactivation process failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Course inactivation process failed', logger);
        }
      } catch (error) {
        logger.log(`❌ [InactivateCourse] ${error.message}`);
        await browser.close();
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Course inactivation error: ${error.message}`, logger);
      }
    } else if (act === 'newCourseRevision') {
      await logger.log('\n📚 Initiating Course revision process...');
      try {
        const success = await updateCourse(page, subfolder, schoolId, browser, 'newCourseRevision', logger);
        await browser.close();

        if (success) {
          logger.log('✅ Course revision completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Course revision failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Course revision failed during execution', logger);
        }
      } catch (error) {
        logger.log(`❌ Course revision error: ${error.message}`);
        await browser.close();

        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Course revision error: ${error.message}`, logger);
      }
    } else if (act === 'createCourse') {
      await logger.log('\n📚 Initiating Course creation process...');
      try {
        const success = await createCourse(page, subfolder, schoolId, browser, formName, logger);
        await browser.close();

        if (success) {
          logger.log('✅ Course creation completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Course creation failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Course creation failed during execution', logger);
        }
      } catch (error) {
        logger.log(`❌ Course creation error: ${error.message}`);
        await browser.close();

        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Course creation error: ${error.message}`, logger);
      }
    } else if (act === 'createProgram') {
      await logger.log('\n📚 Initiating Program creation process...');
      try {
        const success = await createProgram(page, subfolder, schoolId, browser, formName, logger);
        await browser.close();

        if (success) {
          logger.log('✅ Program creation completed successfully');
          await startMergeReportPolling(env, schoolId, act, subfolder, undefined, logger);
        } else {
          logger.log('❌ Program creation failed');
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Program creation failed during execution', logger);
        }
      } catch (error) {
        logger.log(`❌ [CreateProgram] ${error.message}`);
        await browser.close();
        const runFolder = path.dirname(subfolder);
        await logFailedRun(runFolder, act, schoolId, `Program creation error: ${error.message}`, logger);
      }
    }
  }

  if (action === 'all') {
    // Create a single Run folder for all section actions when running 'all'
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const sharedRunFolder = path.join(outputDir, `Run-${dateStr}`);
    fs.mkdirSync(sharedRunFolder, { recursive: true });

    logger.log(`\n🚀 Starting "All Section Test Cases" run in folder: ${sharedRunFolder}`);

    await runFlowInFolder('update', sharedRunFolder, logger);
    await runFlowInFolder('create', sharedRunFolder, logger);
    await runFlowInFolder('createNoMeetNoProf', sharedRunFolder, logger);
    await runFlowInFolder('editRelationships', sharedRunFolder, logger);
    await runFlowInFolder('createRelationships', sharedRunFolder, logger);
    await runFlowInFolder('inactivateSection', sharedRunFolder, logger);
  } else if (action === 'courseAll') {
    // Create a single Run folder for all course actions when running 'courseAll'
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const sharedRunFolder = path.join(outputDir, `Run-${dateStr}`);
    fs.mkdirSync(sharedRunFolder, { recursive: true });

    // Reset session course tracking for new run
    global.sessionUsedCourses.clear();
    logger.log(`🔄 Reset session course tracking for new run`);

    logger.log(`\n🚀 Starting "All Course Test Cases" run in folder: ${sharedRunFolder}`);

    await runFlowInFolder('updateCourse', sharedRunFolder, logger);
    await runFlowInFolder('inactivateCourse', sharedRunFolder, logger);
    await runFlowInFolder('newCourseRevision', sharedRunFolder, logger);
    await runFlowInFolder('createCourse', sharedRunFolder, logger);
  } else if (action === 'both') {
    // Create a single Run folder for all actions from both products when running 'both'
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const sharedRunFolder = path.join(outputDir, `Run-${dateStr}`);
    fs.mkdirSync(sharedRunFolder, { recursive: true });

    // Reset session course tracking for new run
    global.sessionUsedCourses.clear();
    logger.log(`🔄 Reset session course tracking for new run`);

    logger.log(`\n🚀 Starting "Both Products - All Test Cases" run in folder: ${sharedRunFolder}`);

    // First run all Academic Scheduling actions
    logger.log('\n📚 Running Academic Scheduling Test Cases...');
    await runFlowInFolder('update', sharedRunFolder, logger);
    await runFlowInFolder('create', sharedRunFolder, logger);
    await runFlowInFolder('createNoMeetNoProf', sharedRunFolder, logger);
    await runFlowInFolder('editRelationships', sharedRunFolder, logger);
    await runFlowInFolder('createRelationships', sharedRunFolder, logger);
    await runFlowInFolder('inactivateSection', sharedRunFolder, logger);

    // Then run all Curriculum Management actions
    logger.log('\n📖 Running Curriculum Management Test Cases...');
    await runFlowInFolder('updateCourse', sharedRunFolder, logger);
    await runFlowInFolder('inactivateCourse', sharedRunFolder, logger);
    await runFlowInFolder('newCourseRevision', sharedRunFolder, logger);
    await runFlowInFolder('createCourse', sharedRunFolder, logger);
  } else {
    await runFlow(action, logger);
  }
}

export default run;
