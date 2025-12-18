/**
 * Shared screenshot helper for all products (Sections/Courses/Programs).
 *
 * Strategy:
 * - Disable clipping/scrolling on common containers so the root can expand
 * - Preload lazy-rendered content by scrolling through the root
 * - Use Playwright element screenshot (auto-stitches beyond viewport)
 */
async function screenshotFormRoot(page, outputPath, rootSelector = 'form[data-test="course-form-wrapper"].auto-form') {
  try {
    // Ensure containers are scrolled to the top for stable coordinates
    await page.evaluate(() => {
      try { window.scrollTo(0, 0); } catch (_) {}
      try { const main = document.querySelector('main#main.content'); if (main) main.scrollTo(0, 0); } catch (_) {}
      try { const content = document.querySelector('.content'); if (content) content.scrollTo(0, 0); } catch (_) {}
    });

    // Strong CSS to disable internal scrollbars and allow full height
    let styleHandle = null;
    try {
      styleHandle = await page.addStyleTag({ content: `
        /* Hide fixed chrome that can overlay */
        [data-test="app-navigation"], header, nav.app-navbar, .app-navbar { visibility: hidden !important; }
        /* Ensure main containers don't clip */
        html, body, .content, main#main, #app { overflow: visible !important; height: auto !important; }
        /* Ensure modal containers don't clip */
        .modal-dialog, .modal-content, .modal-body { max-height: none !important; height: auto !important; overflow: visible !important; }
        /* Make common form/editor roots expand fully */
        form.auto-form, form[data-test="course-form-wrapper"].auto-form, #section-modal-editor { max-height: none !important; height: auto !important; overflow: visible !important; }
        /* Nested auto-form wrappers inside cards should also expand */
        [data-test="course-form-wrapper"].auto-form, .auto-form, .auto-form-row { max-height: none !important; height: auto !important; overflow: visible !important; }
        .form-card, .card-body, .auto-form-row { max-height: none !important; height: auto !important; overflow: visible !important; }
      `});
      await page.waitForTimeout(100);
    } catch (_) {}

    const rootHandle = page.locator(rootSelector).first();
    await rootHandle.waitFor({ state: 'visible', timeout: 60000 });

    // Walk ancestor chain and disable overflow scroll to allow full layout expansion
    await page.evaluate((selector) => {
      const root = document.querySelector(selector);
      if (!root) return;
      let el = root;
      while (el && el !== document.documentElement) {
        try {
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/i.test(cs.overflowY || '')) {
            el.setAttribute('data-__orig-overflow-y', el.style.overflowY || '');
            el.setAttribute('data-__orig-height', el.style.height || '');
            el.setAttribute('data-__orig-max-height', el.style.maxHeight || '');
            el.style.overflowY = 'visible';
            el.style.height = 'auto';
            el.style.maxHeight = 'none';
          }
        } catch (_) {}
        el = el.parentElement;
      }
      // Ensure html/body expand
      document.documentElement.style.height = 'auto';
      document.body.style.height = 'auto';
      // Nudge layout and force reflow
      try { root.scrollTo(0, root.scrollHeight); } catch (_) {}
      try { root.scrollTo(0, 0); } catch (_) {}
    }, rootSelector);

    // Let layout settle after CSS adjustments
    await page.waitForTimeout(300);

    // Preload lazy content: gently scroll through the root to force render, then return to top
    try {
      const total = await rootHandle.evaluate(el => el.scrollHeight).catch(() => 0);
      const step = 600;
      if (total && total > step) {
        for (let y = 0; y <= total; y += step) {
          try { await rootHandle.evaluate((el, pos) => el.scrollTo(0, pos), y); } catch (_) {}
          await page.waitForTimeout(150);
        }
        // Wait longer after scrolling for lazy content to settle
        await page.waitForTimeout(500);
        try { await rootHandle.evaluate(el => el.scrollTo(0, 0)); } catch (_) {}
        // Wait for layout to stabilize after scrolling back to top
        await page.waitForTimeout(500);
      }
    } catch (_) {}

    // Briefly wait for any loading placeholders/spinners inside the root to disappear
    try {
      const loadingSel = '.spinner, [class*="skeleton"], [class*="loading"]';
      for (let i = 0; i < 6; i++) {
        const anyLoading = await rootHandle.locator(loadingSel).count().catch(() => 0);
        if (!anyLoading) break;
        await page.waitForTimeout(200);
      }
    } catch (_) {}

    // Prefer element screenshot so Playwright can stitch beyond viewport
    await rootHandle.screenshot({ path: outputPath });

    // Remove custom CSS
    try {
      await page.evaluate((styleEl) => { try { styleEl && styleEl.remove && styleEl.remove(); } catch (_) {} }, styleHandle);
    } catch (_) {}
  } catch (err) {
    // Fallback to full page if anything goes wrong
    try {
      await page.screenshot({ path: outputPath, fullPage: true });
    } catch (_) {}
  }
}

module.exports = { screenshotFormRoot };


