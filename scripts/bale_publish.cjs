'use strict';
require('./platform_publish.cjs').publish('bale').catch(error => {
  console.error('BALE_PUBLISH_FAILED', String(error && error.message || error).slice(0, 240));
  process.exitCode = 1;
});
