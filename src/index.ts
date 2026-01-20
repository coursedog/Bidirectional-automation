import run from './run';
import ConsoleLogger from './services/ConsoleLogger';
import type { ILogger } from './services/interfaces/ILogger';

const { gatherInputs } = require('./input');

async function runCli() {
  try {
    // 0) Inputs
    const { email, password, env, productSlug, schoolId, action, courseFormName, programFormName } = gatherInputs();

    await run({ email, password, env, productSlug, schoolId, action, courseFormName, programFormName, isApi: false });

  } catch (err) {
    console.error('❌ Unhandled error:', err);
  }
};

export type {
  ILogger
};

export {
  ConsoleLogger,
  run,
  runCli
};

