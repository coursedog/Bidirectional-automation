const fs = require('fs');
const path = require('path');

/**
 * Appends a run summary entry to the markdown file in the Run root folder
 * @param {string} runFolder - Path to the current Run folder
 * @param {string} id - Unique identifier for this run
 * @param {string} mergeReportURL - URL to the merge report
 * @param {string} status - General status of the run
 * @param {string} mergeReportStatus - Status from merge report steps (e.g., "unable to sync some changes")
 * @param {string} date - Date of the run
 * @param {string} schoolId - School identifier
 * @param {string} action - Action type (update, create, etc.)
 * @param {string} errors - Errors from merge report (optional)
 */
async function appendRunSummary(runFolder, id, mergeReportURL, status, mergeReportStatus, date, schoolId, action, errors = 'N/A') {
  try {
    // Create filename with timestamp for uniqueness
    const summaryFileName = `RUN-SUMMARY-${schoolId}.md`;
    const summaryFilePath = path.join(runFolder, summaryFileName);
    
    // Determine product based on action
    const courseActions = ['updateCourse', 'inactivateCourse', 'newCourseRevision', 'createCourse', 'createProgram', 'updateProgram'];
    const product = courseActions.includes(action) ? 'Curriculum Management' : 'Academic Scheduling';
    
    // Check if file exists, if not create with headers
    let fileContent = '';
    if (!fs.existsSync(summaryFilePath)) {
      fileContent = `# Run Summary Report - ${schoolId}\n\n`;
      
      // Check if this is a "both products" run by looking at the folder structure
      const academicSchedulingPath = path.join(runFolder, 'Academic Scheduling');
      const curriculumManagementPath = path.join(runFolder, 'Curriculum Management');
      const isBothProducts = fs.existsSync(academicSchedulingPath) && fs.existsSync(curriculumManagementPath);
      
      if (isBothProducts) {
        // Create separate tables for both products
        fileContent += `## Academic Scheduling Test Cases\n\n`;
        fileContent += `| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |\n`;
        fileContent += `|----|------------------|---------|-------------------|------|--------|--------|\n`;
        fileContent += `\n## Curriculum Management Test Cases\n\n`;
        fileContent += `| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |\n`;
        fileContent += `|----|------------------|---------|-------------------|------|--------|--------|\n`;
      } else {
        // Single product run
        fileContent += `## ${product} Test Cases\n\n`;
        fileContent += `| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |\n`;
        fileContent += `|----|------------------|---------|-------------------|------|--------|--------|\n`;
      }
    } else {
      fileContent = fs.readFileSync(summaryFilePath, 'utf8');
    }
    
    // Format the date for display
    const formattedDate = new Date(date).toLocaleString();
    
    // Create new row
    const newRow = `| ${id} | [View Report](${mergeReportURL}) | ${status} | ${mergeReportStatus || 'N/A'} | ${formattedDate} | ${action} | ${errors} |\n`;
    
    // Insert the row in the appropriate section
    if (fileContent.includes('## Academic Scheduling Test Cases') && fileContent.includes('## Curriculum Management Test Cases')) {
      // Both products - insert in appropriate section
      if (product === 'Academic Scheduling') {
        // Insert before the Curriculum Management section
        const curriculumIndex = fileContent.indexOf('\n## Curriculum Management Test Cases');
        if (curriculumIndex !== -1) {
          fileContent = fileContent.slice(0, curriculumIndex) + newRow + fileContent.slice(curriculumIndex);
        } else {
          fileContent += newRow;
        }
      } else {
        // Curriculum Management - append at the end
        fileContent += newRow;
      }
    } else {
      // Single product - append at the end
      fileContent += newRow;
    }
    
    // Write the updated content
    fs.writeFileSync(summaryFilePath, fileContent, 'utf8');
    
    console.log(`✅ Run summary appended to: ${summaryFilePath}`);
    return summaryFilePath;
  } catch (error) {
    console.error('❌ Error creating run summary:', error.message);
    throw error;
  }
}

/**
 * Extracts status from merge report steps array
 * @param {Array} steps - Array of steps from merge report API response
 * @returns {string} - Prioritized status from steps, or 'No status available'
 */
function extractStepsStatus(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'No steps data';
  }
  
  // Look for specific priority statuses first
  const priorityStatuses = ['unable to sync some changes', 'failed', 'error'];
  
  for (const step of steps) {
    if (step && step.status) {
      // Check if this is a priority status
      if (priorityStatuses.includes(step.status.toLowerCase())) {
        return step.status;
      }
    }
  }
  
  // If no priority status found, return the first status found
  for (const step of steps) {
    if (step && step.status) {
      return step.status;
    }
  }
  
  return 'No status available';
}

/**
 * Extracts errors from merge report details
 * @param {Array} steps - Array of steps from merge report API response
 * @returns {string} - First error message found, or 'N/A'
 */
function extractErrors(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'N/A';
  }
  
  for (const step of steps) {
    if (step && step.errors && Array.isArray(step.errors) && step.errors.length > 0) {
      // Return the first error message
      return step.errors[0].error || 'Unknown error';
    }
  }
  
  return 'N/A';
}

/**
 * Extracts metadata differences from merge report steps
 * @param {Array} steps - Array of steps from merge report API response
 * @returns {Array} - Array of metadata objects with differences
 */
function extractMetadataDifferences(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [];
  }
  
  const metadataArray = [];
  
  for (const step of steps) {
    if (step && step.misc && step.misc.updates) {
      // Iterate through all entity updates
      for (const entityId in step.misc.updates) {
        const updates = step.misc.updates[entityId];
        if (Array.isArray(updates)) {
          for (const update of updates) {
            if (update.metadata && update.metadata.differences) {
              metadataArray.push({
                message: update.metadata.message || 'No message',
                differences: update.metadata.differences
              });
            }
          }
        }
      }
    }
  }
  
  return metadataArray;
}

/**
 * Generates a unique ID for the run based on timestamp and action
 * @param {string} action - The action type
 * @returns {string} - Unique ID
 */
function generateRunId(action) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Remove milliseconds and format
  return `${action}-${timestamp}`;
}

module.exports = {
  appendRunSummary,
  extractStepsStatus,
  extractErrors,
  extractMetadataDifferences,
  generateRunId
};
