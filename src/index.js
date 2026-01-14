#!/usr/bin/env node
import run from './run';

const { gatherInputs } = require('./input');

; (async () => {
  try {
    // 0) Inputs
    const { email, password, env, productSlug, schoolId, action, courseFormName, programFormName } = gatherInputs();

    await run({ email, password, env, productSlug, schoolId, action, courseFormName, programFormName });

  } catch (err) {
    console.error('❌ Unhandled error:', err);
  }
})();
