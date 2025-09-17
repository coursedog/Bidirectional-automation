const { chromium } = require('playwright');
const path = require('path');

async function launch(env, videoDir, videoName, headless = true) {
  const baseDomain = env === 'prd'
    ? 'app.coursedog.com'
    : 'staging.coursedog.com';

  // Set both viewport and video size to 1280x720 for correct aspect ratio
  const contextOptions = { viewport: { width: 1280, height: 6000 } };
  if (videoDir) {
    contextOptions.recordVideo = {
      dir: videoDir,
      size: { width: 1280, height: 6000 }
    };
  }

  const browser = await chromium.launch({ 
    headless: headless,
    // When headed, start minimized and set reasonable window size
    args: headless ? [] : [
      '--window-size=1400,900',
      '--start-minimized',
      '--disable-web-security', // Helps with some automation issues
      '--disable-blink-features=AutomationControlled' // Hide automation detection
    ]
  });
  const ctx     = await browser.newContext(contextOptions);
  const page    = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  // Return video path info if video recording is enabled
  let getVideoPath = null;
  if (videoDir && videoName) {
    getVideoPath = async () => {
      const video = page.video();
      if (!video) return { tempPath: null, targetPath: null, video };
      const tempPath = await video.path();
      const targetPath = path.join(videoDir, videoName + '.webm');
      return { tempPath, targetPath, video };
    };
  }

  return { browser, ctx, page, baseDomain, getVideoPath };
}

module.exports = { launch }; 