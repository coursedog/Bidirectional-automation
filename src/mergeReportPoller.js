const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { appendRunSummary, extractStepsStatus, extractErrors, extractMetadataDifferences, generateRunId } = require('./runSummary');

let mergeStartTime = null; // Stopwatch start time

/**
 * Polls the mergeReports API until a new report is found
 * @param {string} env - Environment ('prd' or 'stg')
 * @param {string} schoolId - School ID
 * @param {string} act - Action type ('update', 'create', 'createNoMeetNoProf', 'relationships', 'editRelationships', 'createRelationships')
 * @returns {Promise<Object>} - Object containing mergeReportId, mergeReportStatus, totalCount, and mergeHistoryUrl
 */
async function pollMergeReport(env, schoolId, act) {
  const baseUrl = env === 'prd' 
    ? 'https://app.coursedog.com' 
    : 'https://staging.coursedog.com';

  // New endpoint for polling merge status
  let apiUrl;
  if (act === 'relationships' || act === 'editRelationships' || act === 'createRelationships') {
    apiUrl = `${baseUrl}/api/v1/int/${schoolId}/integrations-hub/merge-history?page=0&size=1&scheduleType=realtime&entityType=relationships`;
    console.log(`🔗 [Relationships] Using relationships entity type for ${act} action`);
  } else if (act === 'updateCourse' || act === 'createCourse' || act === 'inactivateCourse' || act === 'newCourseRevision') {
    apiUrl = `${baseUrl}/api/v1/int/${schoolId}/integrations-hub/merge-history?page=0&size=1&scheduleType=realtime&entityType=coursesCm`;
    console.log(`📚 [Curriculum Management] Using coursesCm entity type for ${act} action`);
  } else {
    apiUrl = `${baseUrl}/api/v1/int/${schoolId}/integrations-hub/merge-history?page=0&size=1&scheduleType=realtime&entityType=sections`;
    console.log(`📚 [Sections] Using sections entity type for ${act} action`);
  }

  // Wait 1 minute before first poll
  console.log('⏳ Waiting 1 minute before polling merge status...');
  console.log(`API URL: ${apiUrl}`);
  await new Promise(resolve => setTimeout(resolve, 60000));

  let lastStatus = null;
  let lastJobId = null;
  let started = false;

  while (true) {
    try {
      // Always get a fresh token before each API call
      const token = await getAuthToken(env, schoolId);
      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${token}`,
        'Host': env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Cookie': `isLoggedIn=true; token=${token}`
      };
      const response = await axios.get(apiUrl, { headers });
      const data = response.data;

      // Look for inProgressMerge and mergeReport inside items[0]
      const firstItem = Array.isArray(data.items) && data.items.length > 0 ? data.items[0] : null;

      if (firstItem && firstItem.inProgressMerge) {
        if (!started) {
          mergeStartTime = Date.now();
          started = true;
        }
        const status = firstItem.inProgressMerge.awsJobStatus;
        const jobId = firstItem.inProgressMerge.awsJobId;
        const jobName = firstItem.inProgressMerge.awsJobName;
        console.log(`🔄 Merge in progress. Status: ${status}, JobId: ${jobId}, JobName: ${jobName}`);
        lastStatus = status;
        lastJobId = jobId;
        // If still in progress, wait and poll again
        if (["SUBMITTED", "RUNNABLE", "STARTING", "RUNNING"].includes(status)) {
          await new Promise(resolve => setTimeout(resolve, 60000)); // poll every 1 minute
          continue;
        }
      }

      if (firstItem && firstItem.mergeReport) {
        const report = firstItem.mergeReport;
        const mergeReportId = report.id || report._id;
        const mergeReportStatus = report.status;
        const mergeHistoryUrl = `${baseUrl}/#/int/${schoolId}/merge-history/${mergeReportId}`;
        console.log('🎉 Merge report finished!');
        console.log('📋 mergeReportId:', mergeReportId);
        console.log('⏰ Merge Report Status:', mergeReportStatus);
        console.log('🔗 Merge Report URL:', mergeHistoryUrl);
        return {
          mergeReportId,
          mergeReportStatus,
          mergeHistoryUrl
        };
      }

      // If neither, wait and poll again
      console.log('⏳ No merge report yet, polling again in 1 minute...');
      await new Promise(resolve => setTimeout(resolve, 60000));
    } catch (error) {
      console.error('❌ Error polling merge status:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      // Wait and try again
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
}

/**
 * Main function to extract termCode and start polling
 * @param {string} env - Environment ('prd' or 'stg')
 * @param {string} schoolId - School ID
 * @param {string} token - Bearer token
 * @param {boolean} isSecondRun - Whether this is the second run (for relationships)
 * @returns {Promise<Object>} - Object containing mergeReportId, mergeReportStatus, totalCount, and mergeHistoryUrl
 */
async function startMergeReportPolling(env, schoolId, act, outputDir, isSecondRun = false) {
  
  const mergeReportData = await pollMergeReport(env, schoolId, act);
  await getMergeReportDetails(env, schoolId, mergeReportData.mergeReportId, act, outputDir, isSecondRun);
  return mergeReportData;
}

/**
 * Fetch and log merge report details from the API.
 * @param {string} env - Environment ('prd' or 'stg')
 * @param {string} schoolId - School ID
 * @param {string} mergeReportId - Merge Report ID
 * @param {string} token - Bearer token
 * @param {boolean} isSecondRun - Whether this is the second run (for relationships)
 * @returns {Promise<Object>} - The merge report details object
 */
async function getMergeReportDetails(env, schoolId, mergeReportId, act, outputDir, isSecondRun = false) {
  const baseUrl = env === 'prd'
    ? 'https://app.coursedog.com/api/v1'
    : 'https://staging.coursedog.com/api/v1';

  const url = `${baseUrl}/${schoolId}/mergeReports/${mergeReportId}`;

  // Always get a fresh token before each API call
  const token = await getAuthToken(env, schoolId);
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Cache-Control': 'no-cache'
  };

  try {
    const startTime = mergeStartTime || Date.now();
    const axios = require('axios');
    const response = await axios.get(url, { headers });
    const data = response.data;

    // Extract summary (ordered, exclude _id, mergeGroupId, timestampStart)
    const summary = {};
    const orderedKeys = ['id', 'schoolName', 'status', 'date', 'type', 'termCode', 'scheduleType'];
    for (const key of orderedKeys) {
      if (data[key] !== undefined) summary[key] = data[key];
    }
    // Only include steps with a postBody
    const steps = Array.isArray(data.steps)
      ? data.steps.filter(step => step.misc && step.misc.updates && Object.values(step.misc.updates).some(arr => Array.isArray(arr) && arr.some(obj => obj.postBody)))
      : [];

    const result = { summary, steps };

    // Save to file
    //const fileName = `${schoolId}-sections-${act}${isSecondRun ? '-create' : ''}-mergeReportDetails.json`;
    //const filePath = path.join(outputDir, fileName);
    //fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    //console.log(`✅ Saved merge report summary and steps to ${filePath}`);

    // --- Create Markdown summary file ---
    let markdown = '## Merge Report Summary\n\n';
    // Add summary as JSON code block with conflictHandlingMethod before mergeReportURL
    const conflictHandlingMethod = data?.configuration?.conflictHandlingMethod;
    const summaryWithUrl = { ...summary };
    if (conflictHandlingMethod !== undefined) {
      summaryWithUrl.conflictHandlingMethod = conflictHandlingMethod;
    }
    summaryWithUrl.mergeReportURL = `${baseUrl.replace('/api/v1','')}/#/int/${schoolId}/merge-history/${mergeReportId}`;
    markdown += '```json\n' + JSON.stringify(summaryWithUrl, null, 2) + '\n```\n\n';

    // Placeholders under Summary for specific actions
    const placeholderBlock = (label) => `=============\nPlaceholder for ${label} screenshot\n=============\n`;
    if (act === 'update') {
      markdown += placeholderBlock('fullModalBefore');
      markdown += placeholderBlock('MeetingPattern-Details-Before');
      markdown += placeholderBlock('section-Instructor-Details-Before');
      markdown += '\n';
    } else if (act === 'updateCourse') {
      markdown += placeholderBlock('updateCourse-fullModal-before');
      markdown += '\n';
    } else if (act === 'editRelationships') {
      markdown += placeholderBlock('update-modal-before');
      markdown += '\n';
    }

    // Always try to read differences file regardless of action type
    markdown += '## Differences\n\n';
    // Look for diff file with timestamp pattern
    const files = fs.readdirSync(outputDir);
    const diffFilePattern = new RegExp(`${schoolId}-.*-field-differences-.*\\.txt$`);
    const diffFile = files.find(file => diffFilePattern.test(file));
    
    if (diffFile) {
      const diffFilePath = path.join(outputDir, diffFile);
      const diffText = fs.readFileSync(diffFilePath, 'utf8');
      // The diff files are now markdown tables; embed directly
      markdown += diffText + '\n';
    } else {
      markdown += '_No differences file found._\n';
    }

    // Placeholders under Differences for specific actions
    if (act === 'update' || act === 'create') {
      markdown += placeholderBlock('fullModalAfter');
      markdown += placeholderBlock('MeetingPattern-Details-After');
      markdown += placeholderBlock('section-Instructor-Details-After');
      markdown += '\n';
    } else if (act === 'updateCourse') {
      markdown += placeholderBlock('updateCourse-fullModal-after');
      markdown += '\n';
    } else if (act === 'editRelationships') {
      markdown += placeholderBlock('update-modal-after');
      markdown += '\n';
    }

    // Add Posts section immediately after Differences
    markdown += '\n## Posts\n\n';
    const executedUpdates = [];
    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        const exec = step?.misc?.executedUpdates;
        if (exec && typeof exec === 'object') {
          for (const [, updates] of Object.entries(exec)) {
            if (Array.isArray(updates)) {
              for (const upd of updates) {
                if (upd && upd.postType) executedUpdates.push(upd);
              }
            }
          }
        }
      }
    }
    if (executedUpdates.length > 0) {
      for (const upd of executedUpdates) {
        markdown += `- postType: ${upd.postType}\n`;
        if (upd.postBody !== undefined) {
          markdown += '```json\n' + JSON.stringify(upd.postBody, null, 2) + '\n```\n';
        } else {
          markdown += '_No postBody available._\n';
        }
        markdown += '\n';
      }
    } else {
      markdown += '_No posts executed._\n\n';
    }

    // Add errors section below Posts
    markdown += '## Merge Report Errors\n\n';
    // failedSyncEntityIds header
    const failedIds = [];
    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        const ids = step?.misc?.failedSyncEntityIds;
        if (Array.isArray(ids)) {
          for (const id of ids) failedIds.push(id);
        }
      }
    }
    markdown += '### Failed Sync Entity Ids\n';
    markdown += '```json\n' + JSON.stringify(failedIds, null, 2) + '\n```\n\n';

    // error messages
    const errorMessages = [];
    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (Array.isArray(step.errors)) {
          for (const err of step.errors) {
            if (err && err.error) errorMessages.push(err.error);
          }
        }
      }
    }
    markdown += '### Error Messages\n';
    markdown += '```json\n' + JSON.stringify(errorMessages, null, 2) + '\n```\n\n';

    // errorDetails metadata.differences (with fallback to error and body.errors)
    const errorMetadataDifferences = [];
    if (Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (Array.isArray(step.errors)) {
          for (const err of step.errors) {
            const details = err?.errorDetails;
            if (details && typeof details === 'object') {
              for (const [, arr] of Object.entries(details)) {
                if (Array.isArray(arr)) {
                  for (const entry of arr) {
                    const diffs = entry?.metadata?.differences;
                    if (diffs !== undefined) errorMetadataDifferences.push(diffs);
                  }
                }
              }
            }
          }
        }
      }
    }
    markdown += '### Error Metadata Differences\n';
    if (errorMetadataDifferences.length > 0) {
      markdown += '```json\n' + JSON.stringify(errorMetadataDifferences, null, 2) + '\n```\n';
    } else {
      // Fallback: show errorDetails.error and errorDetails.body.errors
      const fallbackErrorDetails = [];
      if (Array.isArray(data.steps)) {
        for (const step of data.steps) {
          if (Array.isArray(step.errors)) {
            for (const err of step.errors) {
              const details = err?.errorDetails;
              if (details && typeof details === 'object') {
                for (const [, arr] of Object.entries(details)) {
                  if (Array.isArray(arr)) {
                    for (const entry of arr) {
                      const entryError = entry?.error;
                      const bodyErrors = entry?.body?.errors || [];
                      if (entryError !== undefined || (Array.isArray(bodyErrors) && bodyErrors.length > 0)) {
                        fallbackErrorDetails.push({
                          error: entryError,
                          bodyErrors
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      markdown += '```json\n' + JSON.stringify(fallbackErrorDetails, null, 2) + '\n```\n';
    }

    // GET resulting-sis-data and persist to file, then append to markdown
    try {
      const baseHost = baseUrl.replace('/api/v1','');
      const sisUrl = `${baseHost}/api/v1/${schoolId}/integration/getMergeReportBackup?backupType=resulting-sis-data&getHeadInfo=false&mergeReportId=${encodeURIComponent(mergeReportId)}`;
      const sisHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      };
      const sisResp = await axios.get(sisUrl, { headers: sisHeaders });
      const sisData = sisResp.data;
      const sisOutPath = path.join(outputDir, 'dataAfterSync.json');
      fs.writeFileSync(sisOutPath, JSON.stringify(sisData, null, 2), 'utf8');

      markdown += '\n## GET after POST\n\n';
      if (sisData && sisData.formattedData && typeof sisData.formattedData === 'object') {
        const formattedKeys = Object.keys(sisData.formattedData);
        if (formattedKeys.length === 0) {
          markdown += '_No formattedData found in response._\n';
        } else {
          for (const key of formattedKeys) {
            markdown += `formattedData.${key}\n`;
            markdown += '```json\n' + JSON.stringify(sisData.formattedData[key], null, 2) + '\n```\n\n';
          }
        }
      } else {
        markdown += '_No formattedData found in response._\n';
      }
    } catch (getAfterPostError) {
      console.error('❌ Failed GET after POST (resulting-sis-data):', getAfterPostError.message);
      markdown += '\n## GET after POST\n\n_Failed to fetch resulting-sis-data._\n';
    }

    const mdFileName = `${schoolId}-sections-${act}${isSecondRun ? '-create' : ''}-mergeReportSummary.md`;
    const mdFilePath = path.join(outputDir, mdFileName);
    fs.writeFileSync(mdFilePath, markdown, 'utf8');
    console.log(`✅ Saved merge report markdown summary to ${mdFilePath}`);
    //console.dir(result, { depth: null, colors: true });

    // --- Create Run Summary Entry ---
    try {
      // Extract merge report status from steps
      const mergeReportStatus = extractStepsStatus(data.steps);
      
      // Extract errors from steps
      const errors = extractErrors(data.steps);
      
      // Generate unique run ID
      const runId = generateRunId(act);
      
      // Get the Run root folder (parent of outputDir which is the action subfolder)
      const runRootFolder = path.dirname(outputDir);
      
      // Create merge report URL
      const mergeReportURL = `${baseUrl.replace('/api/v1','')}/#/int/${schoolId}/merge-history/${mergeReportId}`;
      
      // Determine overall run status based on merge report
      const runStatus = summary.status || 'completed';
      
      // Get current date
      const currentDate = new Date().toISOString();
      
      // Append to run summary
      await appendRunSummary(
        runRootFolder,
        runId,
        mergeReportURL,
        runStatus,
        mergeReportStatus,
        currentDate,
        schoolId,
        act,
        errors
      );
    } catch (summaryError) {
      console.error('❌ Failed to create run summary entry:', summaryError.message);
      // Don't throw - this shouldn't stop the main process
    }

    // Stopwatch: log elapsed time in seconds
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Merge process took ${elapsed} seconds.`);
    console.log('\n =================== END OF RUN =================== \n');
    mergeStartTime = null;

    return result;
  } catch (error) {
    console.error('❌ Failed to fetch merge report details:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

async function getAuthToken(env, schoolId) {
    const baseUrl = env === 'prd' 
      ? 'https://app.coursedog.com' 
      : 'https://staging.coursedog.com';
  
    const url = `${baseUrl}/api/v1/sessions`;
  
    const headers = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Cache-Control': 'no-cache',
      'Host': env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive'
    };
  
    // Load credentials from creds.json
    let creds = { email: '', password: '' };
    try {
      const credsPath = path.join(__dirname, 'creds.json');
      if (fs.existsSync(credsPath)) {
        creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      }
    } catch (_) {}

    const body = {
      email: creds.email,
      password: creds.password
    };
  
    try {
      console.log(`🔐 Re-authenticating...`);
      
      const response = await axios.post(url, body, { headers });
      
      if (response.data && response.data.token) {
        console.log('✅ Authentication successful');
        const token = response.data.token;
        
        // Fetch section template after successful authentication
        // await pollMergeReport(token, schoolId, env); // This line was removed as per the edit hint
        
        return token;
      } else {
        throw new Error('No token received in response');
      }
    } catch (error) {
      console.error('❌ Authentication failed:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      throw error;
    }
  }

module.exports = { 
  pollMergeReport, 
  startMergeReportPolling,
  getMergeReportDetails 
}; 