const axios = require('axios');

/**
 * Performs Merge settings checks for integration settings
 * @param {string} env - Environment ('prd' or 'stg')
 * @param {string} schoolId - School ID
 * @param {string} token - Bearer token from authentication
 * @param {string} productSlug - Product slug (e.g., 'sm/section-dashboard' or 'cm/courses')
 * @param {string} action - Action to perform
 * @returns {Promise<void>}
 * @throws {Error} If any validation fails
 */
async function performPreflightChecks(env, schoolId, token, productSlug, action) {
  const baseUrl = env === 'prd' 
    ? 'https://app.coursedog.com' 
    : 'https://staging.coursedog.com';

  console.log('\n🔍 Running Merge settings checks...');
  
  try {
    // Step 1: Get Integration Save State ID
    const saveStateId = await getIntegrationSaveStateId(baseUrl, schoolId, token);
    
    // Step 2: Validate Integration Schedule (realtime check)
    await validateIntegrationSchedule(baseUrl, schoolId, token);
    
    // Step 3: Validate Merge Settings based on product and action
    await validateMergeSettings(baseUrl, schoolId, token, saveStateId, productSlug, action);
    
    console.log('✅ All Merge settings checks passed!\n');
  } catch (error) {
    // Display user-friendly error message
    console.error('\n❌ Merge settings check failed:', error.message);
    console.error('\n📋 Please fix the issue and try again.');
    throw error; // Re-throw to trigger exit
  }
}

/**
 * Step 1: Get the Integration Save State ID
 */
async function getIntegrationSaveStateId(baseUrl, schoolId, token) {
  const url = `${baseUrl}/api/v1/${schoolId}/general/enabledIntegrationSaveState`;
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Cookie': `isLoggedIn=true; token=${token}`
  };

  try {
    console.log('  → Fetching integration save state...');
    const response = await axios.get(url, { headers });
    
    if (!response.data?.enabledIntegrationSaveState?.integrationSaveStateId) {
      throw new Error('Integration Save State ID not found. Please ensure integration is configured for this school.');
    }
    
    const saveStateId = response.data.enabledIntegrationSaveState.integrationSaveStateId;
    console.log(`  ✓ Integration Save State ID: ${saveStateId}`);
    return saveStateId;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error('Integration Save State not found. This school may not have integration enabled.');
    }
    if (error.message.includes('Integration Save State ID not found')) {
      throw error;
    }
    throw new Error(`Failed to fetch Integration Save State: ${error.message}`);
  }
}

/**
 * Step 2: Validate that real-time merges are enabled
 */
async function validateIntegrationSchedule(baseUrl, schoolId, token) {
  const url = `${baseUrl}/api/v1/${schoolId}/general/integrationSchedule`;
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Cookie': `isLoggedIn=true; token=${token}`
  };

  try {
    console.log('  → Checking integration schedule...');
    const response = await axios.get(url, { headers });
    
    const syncType = response.data?.integrationSchedule?.syncType;
    
    if (!syncType) {
      throw new Error('Integration schedule not configured for this school.');
    }
    
    if (syncType !== 'realtime') {
      throw new Error(
        `Real-time merges are not currently enabled for ${schoolId}, only ${syncType} merges are enabled.\n` +
        `    Action required: Enable real-time merges in the school settings.`
      );
    }
    
    console.log('  ✓ Real-time merges are enabled');
  } catch (error) {
    if (error.message.includes('must be "realtime"') || error.message.includes('not configured')) {
      throw error; // Re-throw our custom errors
    }
    throw new Error(`Failed to validate integration schedule: ${error.message}`);
  }
}

/**
 * Step 3: Validate merge settings based on product and action
 */
async function validateMergeSettings(baseUrl, schoolId, token, saveStateId, productSlug, action) {
  console.log('  → Validating merge settings...');
  
  // Determine which entity types to validate based on product and action
  if (action === 'both') {
    // Both products - validate all three entity types
    await validateCourseMergeSettings(baseUrl, schoolId, token, saveStateId);
    await validateSectionMergeSettings(baseUrl, schoolId, token, saveStateId);
    await validateRelationshipMergeSettings(baseUrl, schoolId, token, saveStateId);
  } else if (productSlug === 'cm/courses') {
    // Curriculum Management
    await validateCourseMergeSettings(baseUrl, schoolId, token, saveStateId);
  } else if (productSlug === 'sm/section-dashboard') {
    // Academic Scheduling - always check sections
    await validateSectionMergeSettings(baseUrl, schoolId, token, saveStateId);
    
    // Check relationships for specific actions
    const relationshipActions = ['editRelationships', 'createRelationships', 'all'];
    if (relationshipActions.includes(action)) {
      await validateRelationshipMergeSettings(baseUrl, schoolId, token, saveStateId);
    }
  }
}

/**
 * Validate Course (Curriculum Management) merge settings
 */
async function validateCourseMergeSettings(baseUrl, schoolId, token, saveStateId) {
  await checkEntityMergeSettings(
    baseUrl, 
    schoolId, 
    token, 
    saveStateId, 
    'coursesCm', 
    'Courses'
  );
}

/**
 * Validate Section (Academic Scheduling) merge settings
 */
async function validateSectionMergeSettings(baseUrl, schoolId, token, saveStateId) {
  await checkEntityMergeSettings(
    baseUrl, 
    schoolId, 
    token, 
    saveStateId, 
    'sections', 
    'Sections'
  );
}

/**
 * Validate Relationship merge settings
 */
async function validateRelationshipMergeSettings(baseUrl, schoolId, token, saveStateId) {
  await checkEntityMergeSettings(
    baseUrl, 
    schoolId, 
    token, 
    saveStateId, 
    'relationships', 
    'Relationships'
  );
}

/**
 * Helper to check merge settings for a specific entity type
 */
async function checkEntityMergeSettings(baseUrl, schoolId, token, saveStateId, entityType, displayName) {
  const url = `${baseUrl}/api/v1/int/${schoolId}/merge-settings?entityType=${entityType}&integrationSaveStateId=${saveStateId}`;
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Cookie': `isLoggedIn=true; token=${token}`
  };

  try {
    const response = await axios.get(url, { headers });
    const syncSisData = response.data?.stepsToExecute?.syncSisData;
    
    if (syncSisData !== true) {
      throw new Error(
        `Merge setting "Should Coursedog send updates to the SIS?" is disabled for ${displayName}.\n` +
        `    Action required: Enable this setting in merge settings for ${displayName}.`
      );
    }
    
    console.log(`  ✓ ${displayName} merge settings validated ("Should Coursedog send updates to the SIS?": true)`);
  } catch (error) {
    if (error.message.includes('Should Coursedog send updates')) {
      throw error;
    }
    if (error.response?.status === 404) {
      throw new Error(
        `Merge settings not found for ${displayName}.\n` +
        `    Action required: Ensure merge settings are configured for this entity type.`
      );
    }
    throw new Error(`Failed to validate ${displayName} merge settings: ${error.message}`);
  }
}

module.exports = { performPreflightChecks };

