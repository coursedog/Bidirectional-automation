const fs = require('fs');
const path = require('path');
const prompt = require('prompt-sync')({ sigint: true });
const { chromium } = require('playwright');
const { appendRunSummary } = require('./runSummary');

/**
 * User takeover functionality for manual intervention when automation fails
 */

/**
 * Get current section/course ID from the header
 * @param {Object} page - Playwright page object
 * @returns {Promise<string|null>} - Section/course ID or null if not found
 */
async function getCurrentSectionId(page) {
  try {
    const headerElement = page.locator('[data-test="header"] span');
    if (await headerElement.count() > 0) {
      const headerText = await headerElement.first().textContent();
      console.log(`🔍 Current section/course ID from header: "${headerText}"`);
      return headerText?.trim() || null;
    }
    return null;
  } catch (error) {
    console.log('⚠️ Could not retrieve section/course ID from header:', error.message);
    return null;
  }
}

/**
 * Start manual intervention when an automated process fails
 * @param {Object} page - Playwright page object
 * @param {Object} browser - Playwright browser object
 * @param {string} subfolder - Output directory for screenshots
 * @param {string} errorType - Type of error (e.g., 'section-save', 'relationship-save')
 * @param {string} schoolId - School identifier
 * @param {string} action - Current action being performed
 * @param {string} errorMessage - Error message from the failure
 * @param {string} runFolder - Path to run folder for logging (optional)
 * @param {boolean} skipConfirmation - If true, skip the y/N prompt (default: false)
 * @returns {Object} - { success: boolean, sectionChanged: boolean, newSectionId?: string }
 */
async function offerUserTakeover(page, browser, subfolder, errorType, schoolId, action, errorMessage, runFolder = null, skipConfirmation = false) {
  try {
    const headerMessage = skipConfirmation ? '🚨 STARTING MANUAL INTERVENTION 🚨' : '🚨 AUTOMATION FAILURE DETECTED 🚨';
    console.log(`\n${headerMessage}`);
    console.log('═══════════════════════════════════════');
    console.log(`Error Type: ${errorType}`);
    console.log(`Error Message: ${errorMessage}`);
    console.log('═══════════════════════════════════════');
    
    // Take screenshot of the error state
    const errorScreenshotPath = path.join(subfolder, `${schoolId}-${action}-${errorType}-error.png`);
    await page.screenshot({ 
      path: errorScreenshotPath,
      fullPage: true 
    });
    console.log(`📸 Error screenshot saved: ${errorScreenshotPath}`);
    
    // Handle confirmation if not skipped
    if (!skipConfirmation) {
      // Simple y/N prompt for user takeover
      console.log('\n🤝 MANUAL TAKEOVER OPTION');
      console.log('───────────────────────────────────────');
      console.log('The automation has encountered an issue that requires manual intervention.');
      console.log('');
      console.log('📋 CURRENT SITUATION:');
      console.log(`   • Browser URL: ${page.url()}`);
      console.log(`   • Error: ${errorMessage}`);
      console.log(`   • The browser is running in headed mode but minimized`);
      console.log('');
      console.log('⏰ Timeout: 5 minutes - will auto-skip if no response');
      
      // Wait for user response with timeout
      const userResponse = await waitForUserResponseWithTimeout(5); // 5 minutes timeout
      
      if (userResponse === 'timeout' || userResponse === 'no') {
        const skipReason = userResponse === 'timeout' 
          ? 'Manual takeover timed out after 5 minutes' 
          : 'User chose to skip manual intervention';
          
        console.log(`\n⏭️ SKIPPING MANUAL INTERVENTION: ${skipReason}`);
        console.log('───────────────────────────────────────');
        console.log(`❌ Error logged: ${errorMessage}`);
        
        // Log error to run summary if runFolder is provided
        if (runFolder) {
          await logErrorToRunSummary(runFolder, schoolId, action, errorType, errorMessage, skipReason);
        }
        
        return { success: false, sectionChanged: false };
      }
    } else {
      // Display current situation when skipping confirmation
      console.log('\n📋 CURRENT SITUATION:');
      console.log(`   • Browser URL: ${page.url()}`);
      console.log(`   • Error: ${errorMessage}`);
      console.log(`   • The browser is running in headed mode but minimized`);
      console.log('');
    }
    
    // User chose to take over (or confirmation was skipped)
    console.log('🎮 MAKING BROWSER VISIBLE FOR MANUAL INTERVENTION');
    console.log('═══════════════════════════════════════════════════');
    
    // Store current section/course ID before intervention
    const originalSectionId = await getCurrentSectionId(page);
    console.log(`📋 Original section/course before intervention: "${originalSectionId}"`);
    
    // Bring browser window to foreground and maximize
    try {
      await page.bringToFront();
      console.log('✅ Browser window brought to foreground');
      
      // Maximize the OS window via DevTools Protocol so the page becomes responsive
      try {
        const client = await page.context().newCDPSession(page);
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        console.log('✅ Browser window maximized for user interaction');
      } catch (cdpError) {
        console.log('⚠️ Could not maximize via DevTools Protocol:', cdpError.message);
      }
      
    } catch (error) {
      console.log('⚠️ Could not automatically bring browser to front:', error.message);
      console.log('📱 Please manually click on the browser window in your taskbar');
    }
    
    console.log('');
    console.log('📋 MANUAL INTERVENTION');
    console.log('───────────────────────────────────────');
    console.log('Work directly in the browser:');
    console.log(`- Fix the issue: ${errorMessage}`);
    console.log('- Click Save');
    console.log('Then return to this terminal and press Enter to resume automation.');
    console.log('(If you don\'t see the browser window, click it in your taskbar.)');
    console.log('⚠️ Do NOT close the browser window.');
    
    // User chose to take over - browser is now visible for manual intervention
    console.log('\n🎯 MANUAL INTERVENTION ACTIVE');
    console.log('───────────────────────────────────────');
    console.log('✅ Fix the issue in the browser and click Save');
    console.log('↩️ Return here and press Enter to resume automation\n');
    
    // Wait for user to confirm completion
    const interventionResponse = await waitForUserInputWithTimeout(5); // 5 minutes timeout
     
     if (interventionResponse === 'timeout') {
       console.log('\n⏰ TIMEOUT REACHED');
       console.log('───────────────────────────────────────');
       console.log('⚠️ No user input received within 5 minutes');
       console.log('🔄 Defaulting to skip step and continue automation...');
       
       // Log timeout to run summary if runFolder is provided
       if (runFolder) {
         await logErrorToRunSummary(runFolder, schoolId, action, errorType, errorMessage, 'Manual intervention timed out after 5 minutes');
       }
       
       return { success: false, sectionChanged: false };
     }
     
     if (interventionResponse === 'aborted') {
       console.log('\n🛑 MANUAL INTERVENTION ABORTED');
       console.log('───────────────────────────────────────');
       console.log('⚠️ User chose to abort manual intervention');
       console.log('🔄 Skipping this test and continuing automation...');
       
       // Log abort to run summary if runFolder is provided
       if (runFolder) {
         await logErrorToRunSummary(runFolder, schoolId, action, errorType, errorMessage, 'User aborted manual intervention - test could not be completed');
       }
       
       return { success: false, sectionChanged: false };
     }
     
     console.log('\n🔄 RESUMING AUTOMATION');
     console.log('───────────────────────────────────────');
     console.log('✅ User confirmed manual intervention completed');
    
    // Check if section/course has changed
    const currentSectionId = await getCurrentSectionId(page);
    
    // Special handling for when current is null - this typically means the section/course was saved and modal closed
    let sectionChanged = false;
    let sectionSaved = false;
    
    if (currentSectionId === null && originalSectionId !== null) {
      // Current is null but original had a value - likely means section/course was saved and modal closed
      sectionSaved = true;
      console.log('\n💾 SECTION/COURSE SAVED DETECTED');
      console.log('═══════════════════════════════════════');
      console.log(`📋 Original: "${originalSectionId}"`);
      console.log(`📋 Current:  "${currentSectionId}"`);
      console.log('✅ Section/course appears to have been saved - modal closed');
    } else if (originalSectionId !== currentSectionId && currentSectionId !== null) {
      // Both have values but they're different - genuine section change
      sectionChanged = true;
      console.log('\n🔄 SECTION/COURSE CHANGE DETECTED');
      console.log('═══════════════════════════════════════');
      console.log(`📋 Original: "${originalSectionId}"`);
      console.log(`📋 Current:  "${currentSectionId}"`);
      console.log('🔄 Different section/course detected - will restart template process');
    } else {
      // Same section/course (both null or both same value)
      console.log(`📋 Same section/course confirmed: "${currentSectionId}"`);
    }
    
    // Reset viewport to automation default and minimize window
    try {
      await page.setViewportSize({ width: 1280, height: 9000 });
      console.log('🔧 Browser viewport reset to automation mode');
    } catch (error) {
      console.log('⚠️ Could not reset viewport:', error.message);
    }
    
    // Brief pause to allow any pending UI updates
    console.log('⏳ Waiting 2 seconds for UI to settle...');
    await page.waitForTimeout(2000);
    
    // Take screenshot after user intervention
    const afterInterventionPath = path.join(subfolder, `${schoolId}-${action}-${errorType}-afterUserIntervention.png`);
    await page.screenshot({ 
      path: afterInterventionPath,
      fullPage: true 
    });
    console.log(`📸 Post-intervention screenshot saved: ${afterInterventionPath}`);
    
    if (sectionChanged) {
      console.log('🎉 Manual intervention completed with section change - will restart template process!');
      return { success: true, sectionChanged: true, newSectionId: currentSectionId };
    } else if (sectionSaved) {
      console.log('🎉 Manual intervention completed - section/course saved successfully!');
      return { success: true, sectionChanged: false, sectionSaved: true };
    } else {
      console.log('🎉 Manual intervention completed, automation resumed with same session!');
      return { success: true, sectionChanged: false };
    }
    
  } catch (error) {
    console.error('❌ Error during user takeover:', error.message);
    return { success: false, sectionChanged: false };
  }
}



/**
 * Simple helper to check if user wants to retry after a failed save
 * @param {string} errorType - Type of error
 * @param {string} errorMessage - Error message
 * @returns {boolean} - True if user wants to retry
 */
function askUserToRetry(errorType, errorMessage) {
  console.log(`\n❌ ${errorType} failed: ${errorMessage}`);
  const retry = prompt('🤝 Do you want to take manual control to fix this issue? [y/N]: ').toLowerCase();
  return retry === 'y' || retry === 'yes';
}

/**
 * Wait for user response (y/N) with a timeout
 * @param {number} timeoutMinutes - Timeout in minutes
 * @returns {Promise<string>} - 'yes', 'no', or 'timeout'
 */
async function waitForUserResponseWithTimeout(timeoutMinutes) {
  return new Promise((resolve) => {
    const timeoutMs = timeoutMinutes * 60 * 1000; // Convert minutes to milliseconds

    console.log(`\n🤝 Do you want to take manual control to fix this issue? [y/N]: `);
    console.log(`⏰ (Timeout: ${timeoutMinutes} minutes - will auto-skip if no response)`);

    const stdin = process.stdin;
    // If stdin isn't interactive, we can't reliably wait for user input.
    if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      console.log(`⚠️  Manual control prompt skipped: stdin is not an interactive TTY for this run.`);
      resolve('no');
      return;
    }

    let timeoutId;
    let inputBuffer = '';
    const startedAt = Date.now();

    const cleanupAndResolve = (result) => {
      try { clearTimeout(timeoutId); } catch (_) {}
      try { stdin.setRawMode(false); } catch (_) {}
      try { stdin.pause(); } catch (_) {}
      try { stdin.removeListener('data', onInput); } catch (_) {}
      resolve(result);
    };

    // Set up timeout (with cleanup)
    timeoutId = setTimeout(() => {
      console.log(`\n⏰ ${timeoutMinutes} minute timeout reached!`);
      cleanupAndResolve('timeout');
    }, timeoutMs);

    // Set up input listener
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onInput = (key) => {
      // Check for Ctrl+C to gracefully exit
      if (key === '\u0003') {
        console.log('\n🛑 User interrupted with Ctrl+C');
        cleanupAndResolve('timeout');
        return;
      }

      // Check for Enter key (ASCII 13 or \r)
      if (key === '\r' || key === '\n' || (key && key.charCodeAt && key.charCodeAt(0) === 13)) {
        // Guard against buffered/newline artifacts that can arrive immediately on listener attach
        if (inputBuffer.trim() === '' && Date.now() - startedAt < 500) {
          return;
        }

        const response = inputBuffer.toLowerCase().trim();
        if (response === 'y' || response === 'yes') {
          cleanupAndResolve('yes');
        } else {
          // Default to 'no' for any other input including empty
          cleanupAndResolve('no');
        }
        return;
      }

      // Handle backspace
      if (key === '\u007f' || key === '\u0008') {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          process.stdout.write('\b \b'); // Erase character visually
        }
        return;
      }

      // Add printable characters to buffer and echo them
      if (key >= ' ' && key <= '~') {
        inputBuffer += key;
        process.stdout.write(key);
      }
    };

    stdin.on('data', onInput);
  });
}

/**
 * Wait for user input with a timeout (for manual intervention completion)
 * @param {number} timeoutMinutes - Timeout in minutes
 * @returns {Promise<string>} - 'completed' if user responds, 'timeout' if timeout reached, 'aborted' if user aborts
 */
async function waitForUserInputWithTimeout(timeoutMinutes) {
  return new Promise((resolve) => {
    const timeoutMs = timeoutMinutes * 60 * 1000; // Convert minutes to milliseconds
    
    console.log(`\n🤝 After you fix the issue and click Save, press Enter to resume automation...`);
    console.log(`🛑 Press ESC or C to abort and skip this test`);
    console.log(`⏰ (Timeout: ${timeoutMinutes} minutes - will auto-skip if no response)`);
    
    const stdin = process.stdin;
    // If stdin isn't interactive, we can't reliably wait for user input.
    if (!stdin || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      console.log(`⚠️  Manual intervention wait skipped: stdin is not an interactive TTY for this run.`);
      resolve('timeout');
      return;
    }

    const startedAt = Date.now();
    // Set up input listener
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const cleanupAndResolve = (result) => {
      clearTimeout(timeoutId);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onInput);
      resolve(result);
    };

    // Set up timeout (with cleanup)
    const timeoutId = setTimeout(() => {
      console.log(`\n⏰ ${timeoutMinutes} minute timeout reached!`);
      cleanupAndResolve('timeout');
    }, timeoutMs);
    
    const onInput = (key) => {
      // Check for Enter key (ASCII 13 or \r)
      if (key === '\r' || key === '\n' || key.charCodeAt(0) === 13) {
        // Guard against buffered/newline artifacts that can arrive immediately on listener attach
        if (Date.now() - startedAt < 500) return;
        cleanupAndResolve('completed');
      }
      // Check for ESC key (ASCII 27)
      else if (key === '\u001b') {
        console.log('\n🛑 User pressed ESC - aborting manual intervention');
        cleanupAndResolve('aborted');
      }
      // Check for C key (case insensitive)
      else if (key.toLowerCase() === 'c') {
        console.log('\n🛑 User pressed C - aborting manual intervention');
        cleanupAndResolve('aborted');
      }
      // Check for Ctrl+C to gracefully exit
      else if (key === '\u0003') {
        console.log('\n🛑 User interrupted with Ctrl+C');
        cleanupAndResolve('timeout');
      }
    };
    
    stdin.on('data', onInput);
  });
}

/**
 * Log error to run summary when manual takeover is skipped
 * @param {string} runFolder - Path to run folder
 * @param {string} schoolId - School identifier
 * @param {string} action - Current action being performed
 * @param {string} errorType - Type of error
 * @param {string} errorMessage - Error message
 * @param {string} skipReason - Reason for skipping
 */
async function logErrorToRunSummary(runFolder, schoolId, action, errorType, errorMessage, skipReason) {
  try {
    const runId = `${schoolId}-${action}-${errorType}-${Date.now()}`;
    const currentDate = new Date().toISOString();
    const errorDetails = `${skipReason}: ${errorMessage}`;
    
    await appendRunSummary(
      runFolder,
      runId,
      'N/A', // No merge report URL for failed runs
      'failed',
      skipReason,
      currentDate,
      schoolId,
      action,
      errorDetails
    );
    
    console.log(`✅ Error logged to run summary: ${runId}`);
  } catch (error) {
    console.error('❌ Failed to log error to run summary:', error.message);
  }
}

module.exports = {
  offerUserTakeover,
  askUserToRetry,
  waitForUserResponseWithTimeout
};
