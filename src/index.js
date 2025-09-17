#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { gatherInputs } = require('./input');
const { launch } = require('./browser');
const { seedContext } = require('./context');
const { signIn } = require('./auth');
const { goToProduct } = require('./navigation');
const { openSection, createSection, captureModalBefore, captureModalAfter } = require('./section-screenshot');
const { getSchoolTemplate } = require('./getSchoolTemplate');
const { fillBaselineTemplate, saveSection, validateAndResetMeetingPatterns, validateAndResetProfessors, readSectionValues, relationshipsFill, bannerEthosScheduleType, meetAndProfDetails } = require('./sectionTemplateFill');
const { createCourse, updateCourse } = require('./courseTemplateFill');
const { startMergeReportPolling } = require('./mergeReportPoller');
const { appendRunSummary, generateRunId } = require('./runSummary');
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
  const courseActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse'];
  return courseActions.includes(action) ? 'Curriculum Management' : 'Academic Scheduling';
}


;(async () => {
  try {
    // 0) Inputs
    const { email, password, env, productSlug, schoolId, action, formName } = gatherInputs();

    // Ensure schoolId folder exists
    const outputDir = await ensureSchoolFolder(schoolId);
    // Ensure debug-videos folder exists
    const debugVideoDir = ensureDebugVideoFolder();

    // 1) Get API token
    console.log('\n🔐 Getting API token...');
    const token = await getSchoolTemplate(env, schoolId);
    console.log('📋 Token:', token);

    // Helper to run a single flow with a pre-created run folder (for 'all' action)
    async function runFlowInFolder(act, runFolder) {
      const videoName = `${schoolId}-${act}-debugging-run`;
      // 2) Browser & Context (with video recording)
      // Launch in headed mode for potential user takeover, but minimized initially
      const { browser, ctx, page, baseDomain } = await launch(env, debugVideoDir, videoName, false);
      // 3) Seed cookies & localStorage
      await seedContext(ctx, baseDomain, email, schoolId);
      
      // Determine the correct product slug based on the action
      const courseActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse'];
      let currentProductSlug = courseActions.includes(act) ? 'cm/courses' : 'sm/section-dashboard';

      // For update and inactivateSection, navigate with enrollment=0 filter from the start
      if (act === 'update' || act === 'inactivateSection') {
        currentProductSlug = 'sm/section-dashboard';
      }
      
      // 4) Sign in
      await signIn(page, email, password, currentProductSlug, env);
      // 5) Navigate into product
      await goToProduct(page, currentProductSlug, env);

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
        console.log('\nA sections nightly merge for this school is currently in progress, please try again later.');
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
      await executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, formName);
    }

    // Helper to run a single flow, including browser setup/teardown
    async function runFlow(act) {
      // Reset session course tracking for new run
      global.sessionUsedCourses.clear();
      console.log(`🔄 Reset session course tracking for new run`);
      
      const videoName = `${schoolId}-${act}-debugging-run`;
      // 2) Browser & Context (with video recording)
      // Launch in headed mode for potential user takeover, but minimized initially
      const { browser, ctx, page, baseDomain } = await launch(env, debugVideoDir, videoName, false);
      // 3) Seed cookies & localStorage
      await seedContext(ctx, baseDomain, email, schoolId);
      // 4) Sign in
      let desiredSlug = productSlug;
      if (act === 'update' || act === 'inactivateSection') {
        desiredSlug = 'sm/section-dashboard';
      }
      await signIn(page, email, password, desiredSlug, env);
      // 5) Navigate into product
      await goToProduct(page, desiredSlug, env);

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
        console.log('\nA sections nightly merge for this school is currently in progress, please try again later.');
        await browser.close();
        process.exit(0); // Exit gracefully
      }

      // Create timestamped Run folder for this execution
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const runFolder = path.join(outputDir, `Run-${dateStr}`);
      fs.mkdirSync(runFolder, { recursive: true });
      
      console.log(`\n🚀 Starting "${act}" run in folder: ${runFolder}`);
      
      // Create product and method-specific subfolder within the run folder
      const productFolder = getProductFolder(act);
      const subfolder = path.join(runFolder, productFolder, act);
      fs.mkdirSync(subfolder, { recursive: true });

      // Execute the action
      await executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, formName);
    }

    // Helper function to log failed runs to summary
    async function logFailedRun(runFolder, act, schoolId, reason) {
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
          'N/A' // errors parameter for failed runs
        );
      } catch (error) {
        console.error('❌ Failed to log failed run to summary:', error.message);
      }
    }

    // Shared function to execute actions
    async function executeAction(act, page, browser, subfolder, env, schoolId, baseDomain, dateStr, formName) {
      if (act === 'update') {
        // Begin update process (dashboard already filtered to enrollment=0)
        await console.log('\n📝 Initiating Section update process...');
        try {
          await openSection(page);
        } catch (error) {
          console.log(`❌ [Update] ${error.message}`);
          console.log('❌ [Update] Ending update flow due to no available sections.');
          await browser.close();
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'No available sections to update');
          return; // Exit the function early
        }
        await captureModalBefore(page, subfolder, 'update');
        // Capture details "before" screenshots for Meeting Patterns & Instructor
        try { await meetAndProfDetails(page, subfolder, 'update'); } catch (_) {}
        // Read all current values before filling
        const beforeValues = await readSectionValues(page, schoolId);
        console.log('\n📝 Saved original section values for comparing differences...');
        console.log('\n📝 Filling section template fields...');
        await fillBaselineTemplate(page, schoolId, 'update');
        // Call bannerEthosScheduleType for banner_ethos schools
        if (schoolId.includes('banner_ethos')) {
          await bannerEthosScheduleType(page);
        }
        await validateAndResetMeetingPatterns(page, subfolder, 'update');
        let saveSuccess = await validateAndResetProfessors(page, subfolder, 'update', browser, schoolId, beforeValues, dateStr);
        
        // Log the save result
        if (saveSuccess) {
          console.log('\n📝 Section was saved successfully.');
        } else {
          console.log('\n📝 Section was not saved.');
        }        
        // saveSuccess is now set by validateAndResetProfessors which handles saving internally
        await browser.close();
        if (saveSuccess) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log("Couldn't save section, thus cannot pull merge report");
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Failed to save section');
        }
      } else if (act === 'create') {
        await console.log('\n Initiating create Section with Meeting and Professor process...');
        await createSection(page);
        console.log('\n📝 Filling section template fields...');
        await fillBaselineTemplate(page, schoolId, 'create');
        // Call bannerEthosScheduleType for banner_ethos schools
        if (schoolId.includes('banner_ethos')) {
          await bannerEthosScheduleType(page);
        }
        await validateAndResetMeetingPatterns(page, subfolder, 'create');
        let saveSuccess = await validateAndResetProfessors(page, subfolder, 'create', browser, schoolId, null, dateStr);
        await browser.close();
        if (saveSuccess) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log("Couldn't save section, thus cannot pull merge report");
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Failed to save section');
        }
      } else if (act === 'createNoMeetNoProf') {
        await console.log('\n Initiating create Section wit no Meeting or Professor process...');
        await createSection(page);
        console.log('\n📝 Filling section template fields (no meeting/prof)...');
        // First, fill baseline fields without saving to allow all sections to render
        await fillBaselineTemplate(page, schoolId, 'createNoMeetNoProf');
        // Now adjust Banner Ethos Schedule Type after fields are rendered
        if (schoolId.includes('banner_ethos')) {
          await bannerEthosScheduleType(page);
        }
        // Take the after screenshot and save explicitly
        await captureModalAfter(page, subfolder, 'createNoMeetNoProf');
        let saveSuccess = await saveSection(page, subfolder, 'createNoMeetNoProf', browser, schoolId);
        await browser.close();
        if (saveSuccess) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log("Couldn't save section, thus cannot pull merge report");
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Failed to save section');
        }
      } else if (act === 'editRelationships') {
        await console.log('\n🔗 Initiating Relationships edit process...');
        let result = await relationshipsFill(baseDomain, page, subfolder, 'editRelationships', schoolId, false, browser);
        await browser.close();
        
        if (result === 'edit_completed' || result === true) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log('❌ Relationships edit process failed.');
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Relationships edit process failed');
        }
      } else if (act === 'createRelationships') {
        await console.log('\n🔗 Initiating Relationships creation process...');
        let result = await relationshipsFill(baseDomain, page, subfolder, 'createRelationships', schoolId, true, browser);
        await browser.close();
        
        if (result === true) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log('❌ Relationships create process failed.');
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Relationships create process failed');
        }
      } else if (act === 'inactivateSection') {
        await console.log('\n Initiating Section inactivation process...');
        try {
          await openSection(page);
        } catch (error) {
          console.log(`❌ [InactivateSection] ${error.message}`);
          console.log('❌ [InactivateSection] Ending inactivation flow due to no available sections.');
          await browser.close();
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'No available sections to inactivate');
          return; // Exit the function early
        }
        await captureModalBefore(page, subfolder, 'inactivateSection');

        console.log('\n📝 Filling section template fields...');
        // fillBaselineTemplate will handle screenshot and save internally for this action
        let saveSuccess = await fillBaselineTemplate(page, schoolId, 'inactivateSection', subfolder, browser);
      
        await browser.close();
        if (saveSuccess) {
          await startMergeReportPolling(env, schoolId, act, subfolder);
        } else {
          console.log("Couldn't save section, thus cannot pull merge report");
          // Log failed run to summary
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, 'Failed to save section');
        }
      } else if (act === 'updateCourse') {
        await console.log('\n📚 Initiating Course update process...');
        try {
          const success = await updateCourse(page, subfolder, schoolId, browser, 'updateCourse');
          await browser.close();
          
          if (success) {
            console.log('✅ Course update completed successfully');
            await startMergeReportPolling(env, schoolId, act, subfolder);
          } else {
            console.log('❌ Course update process failed');
            const runFolder = path.dirname(subfolder);
            await logFailedRun(runFolder, act, schoolId, 'Course update process failed');
          }
        } catch (error) {
          console.log(`❌ [UpdateCourse] ${error.message}`);
          await browser.close();
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, `Course update error: ${error.message}`);
        }
        
      } else if (act === 'inactivateCourse') {
        await console.log('\n📚 Initiating Course inactivation process...');
        try {
          const success = await updateCourse(page, subfolder, schoolId, browser, 'inactivateCourse');
          await browser.close();
          
          if (success) {
            console.log('✅ Course inactivation completed successfully');
            await startMergeReportPolling(env, schoolId, act, subfolder);
          } else {
            console.log('❌ Course inactivation process failed');
            const runFolder = path.dirname(subfolder);
            await logFailedRun(runFolder, act, schoolId, 'Course inactivation process failed');
          }
        } catch (error) {
          console.log(`❌ [InactivateCourse] ${error.message}`);
          await browser.close();
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, `Course inactivation error: ${error.message}`);
        }
        
      } else if (act === 'newCourseRevision') {
        await console.log('\n📚 Initiating Course revision process...');
        try {
          const success = await updateCourse(page, subfolder, schoolId, browser, 'newCourseRevision');
          await browser.close();
          
          if (success) {
            console.log('✅ Course revision completed successfully');
            await startMergeReportPolling(env, schoolId, act, subfolder);
          } else {
            console.log('❌ Course revision failed');
            const runFolder = path.dirname(subfolder);
            await logFailedRun(runFolder, act, schoolId, 'Course revision failed during execution');
          }
        } catch (error) {
          console.log(`❌ Course revision error: ${error.message}`);
          await browser.close();
          
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, `Course revision error: ${error.message}`);
        }
        
      } else if (act === 'createCourse') {
        await console.log('\n📚 Initiating Course creation process...');
        try {
          const success = await createCourse(page, subfolder, schoolId, browser, formName);
          await browser.close();
          
          if (success) {
            console.log('✅ Course creation completed successfully');
            await startMergeReportPolling(env, schoolId, act, subfolder);
          } else {
            console.log('❌ Course creation failed');
            const runFolder = path.dirname(subfolder);
            await logFailedRun(runFolder, act, schoolId, 'Course creation failed during execution');
          }
        } catch (error) {
          console.log(`❌ Course creation error: ${error.message}`);
          await browser.close();
          
          const runFolder = path.dirname(subfolder);
          await logFailedRun(runFolder, act, schoolId, `Course creation error: ${error.message}`);
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
      
      console.log(`\n🚀 Starting "All Section Test Cases" run in folder: ${sharedRunFolder}`);
      
      await runFlowInFolder('update', sharedRunFolder);
      await runFlowInFolder('create', sharedRunFolder);
      await runFlowInFolder('createNoMeetNoProf', sharedRunFolder);
      await runFlowInFolder('editRelationships', sharedRunFolder);
      await runFlowInFolder('createRelationships', sharedRunFolder);
      await runFlowInFolder('inactivateSection', sharedRunFolder);
    } else if (action === 'courseAll') {
      // Create a single Run folder for all course actions when running 'courseAll'
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const sharedRunFolder = path.join(outputDir, `Run-${dateStr}`);
      fs.mkdirSync(sharedRunFolder, { recursive: true });
      
      // Reset session course tracking for new run
      global.sessionUsedCourses.clear();
      console.log(`🔄 Reset session course tracking for new run`);
      
      console.log(`\n🚀 Starting "All Course Test Cases" run in folder: ${sharedRunFolder}`);
      
      await runFlowInFolder('updateCourse', sharedRunFolder);
      await runFlowInFolder('inactivateCourse', sharedRunFolder);
      await runFlowInFolder('newCourseRevision', sharedRunFolder);
      await runFlowInFolder('createCourse', sharedRunFolder);
    } else if (action === 'both') {
      // Create a single Run folder for all actions from both products when running 'both'
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const sharedRunFolder = path.join(outputDir, `Run-${dateStr}`);
      fs.mkdirSync(sharedRunFolder, { recursive: true });
      
      // Reset session course tracking for new run
      global.sessionUsedCourses.clear();
      console.log(`🔄 Reset session course tracking for new run`);
      
      console.log(`\n🚀 Starting "Both Products - All Test Cases" run in folder: ${sharedRunFolder}`);
      
      // First run all Academic Scheduling actions
      console.log('\n📚 Running Academic Scheduling Test Cases...');
      await runFlowInFolder('update', sharedRunFolder);
      await runFlowInFolder('create', sharedRunFolder);
      await runFlowInFolder('createNoMeetNoProf', sharedRunFolder);
      await runFlowInFolder('editRelationships', sharedRunFolder);
      await runFlowInFolder('createRelationships', sharedRunFolder);
      await runFlowInFolder('inactivateSection', sharedRunFolder);
      
      // Then run all Curriculum Management actions
      console.log('\n📖 Running Curriculum Management Test Cases...');
      await runFlowInFolder('updateCourse', sharedRunFolder);
      await runFlowInFolder('inactivateCourse', sharedRunFolder);
      await runFlowInFolder('newCourseRevision', sharedRunFolder);
      await runFlowInFolder('createCourse', sharedRunFolder);
    } else {
      await runFlow(action);
    }

  } catch (err) {
    console.error('❌ Unhandled error:', err);
  }
})();
