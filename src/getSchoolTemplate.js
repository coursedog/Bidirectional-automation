const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Fetches section template from API and saves to Resources folder
 * @param {string} token - Bearer token from authentication
 * @param {string} schoolId - School ID
 * @param {string} env - Environment ('prd' or 'stg')
 * @returns {Promise<void>}
 */
async function fetchSectionTemplate(token, schoolId, env) {
  const baseUrl = env === 'prd' 
    ? 'https://app.coursedog.com' 
    : 'https://staging.coursedog.com';

  const url = `${baseUrl}/api/v2/${schoolId}/general/sectionTemplate`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Host': env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cookie': `isLoggedIn=true; token=${token}`
  };

  try {
    console.log(`📡 Fetching section template for school: ${schoolId}...`);
    console.log(`🌐 API URL: ${url}`);
    
    const response = await axios.get(url, { headers });
    
    if (response.data) {
      console.log('✅ Section template received successfully');
      
      // Create Resources directory if it doesn't exist
      const resourcesDir = path.join(__dirname, 'Resources');
      if (!fs.existsSync(resourcesDir)) {
        console.log('📁 Creating Resources directory...');
        fs.mkdirSync(resourcesDir, { recursive: true });
      }
      
      // Save the JSON file
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const filename = `${schoolId}-sectionTemplate-${dateStr}.json`;
      const filepath = path.join(resourcesDir, filename);
      
      console.log(`💾 Saving template to: ${filepath}`);
      fs.writeFileSync(filepath, JSON.stringify(response.data, null, 2));
      
      console.log(`✅ Section template saved as: ${filename}`);
      return response.data;
    } else {
      throw new Error('No data received in response');
    }
  } catch (error) {
    console.error('❌ Failed to fetch section template:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Fetches course template from API and saves to Resources folder
 * @param {string} token - Bearer token from authentication
 * @param {string} schoolId - School ID
 * @param {string} env - Environment ('prd' or 'stg')
 * @returns {Promise<void>}
 */
async function fetchCourseTemplate(token, schoolId, env) {
  const baseUrl = env === 'prd' 
    ? 'https://app.coursedog.com' 
    : 'https://staging.coursedog.com';

  const url = `${baseUrl}/api/v1/${schoolId}/general/courseTemplate`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': '*/*',
    'Cache-Control': 'no-cache',
    'Host': env === 'prd' ? 'app.coursedog.com' : 'staging.coursedog.com',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cookie': `isLoggedIn=true; token=${token}`
  };

  try {
    console.log(`📡 Fetching course template for school: ${schoolId}...`);
    console.log(`🌐 API URL: ${url}`);
    
    const response = await axios.get(url, { headers });
    
    if (response.data) {
      console.log('✅ Course template received successfully');
      
      // Create Resources directory if it doesn't exist
      const resourcesDir = path.join(__dirname, 'Resources');
      if (!fs.existsSync(resourcesDir)) {
        console.log('📁 Creating Resources directory...');
        fs.mkdirSync(resourcesDir, { recursive: true });
      }
      
      // Save the JSON file
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const filename = `${schoolId}-courseTemplate-${dateStr}.json`;
      const filepath = path.join(resourcesDir, filename);
      
      console.log(`💾 Saving template to: ${filepath}`);
      fs.writeFileSync(filepath, JSON.stringify(response.data, null, 2));
      
      console.log(`✅ Course template saved as: ${filename}`);
      return response.data;
    } else {
      throw new Error('No data received in response');
    }
  } catch (error) {
    console.error('❌ Failed to fetch course template:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Authenticates with Coursedog API and returns a session token
 * @param {string} env - Environment ('prd' or 'stg')
 * @param {string} schoolId - School ID
 * @returns {Promise<string>} Session token
 */
async function getSchoolTemplate(env, schoolId) {
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

  const body = {
    email: "dataengineers@coursedog.com",
    password: "@&theNewD0g1nT0wn"
  };

  try {
    
    const response = await axios.post(url, body, { headers });
    
    if (response.data && response.data.token) {
      console.log('✅ Authentication successful');
      const token = response.data.token;
      
      // Fetch both section and course templates after successful authentication
      await fetchSectionTemplate(token, schoolId, env);
      await fetchCourseTemplate(token, schoolId, env);
      
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

module.exports = { getSchoolTemplate }; 