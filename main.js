// Entry point at repo root that kicks off the app in src
require('./src/index.js');

function testExportedFunction() {
  return 'test-exported-function'
}

module.exports = {
  testExportedFunction
}
