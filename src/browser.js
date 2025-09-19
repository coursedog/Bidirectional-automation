const { chromium } = require('playwright');
const path = require('path');

async function launch(env, videoDir, videoName, headless = true) {
  const baseDomain = env === 'prd'
    ? 'app.coursedog.com'
    : 'staging.coursedog.com';

  // During automation, use a tall viewport to capture content.
  // During manual takeover, disable viewport emulation so the
  // page follows the OS window size (fully responsive/resizable).
  const contextOptions = headless
    ? { viewport: { width: 1280, height: 9000 } }
    : { viewport: null };

  if (videoDir) {
    // In headless mode we pin the video size to match the fixed viewport.
    // In headed mode we omit size so Playwright derives it from the window.
    contextOptions.recordVideo = headless
      ? {
          dir: videoDir,
          size: { width: 1280, height: 9000 }
        }
      : {
          dir: videoDir
        };
  }

  const browser = await chromium.launch({ 
    headless: headless,
    // When headed, start minimized; window/viewport becomes responsive via viewport: null
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