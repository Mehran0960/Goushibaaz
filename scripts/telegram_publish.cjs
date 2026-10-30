'use strict';
require('./platform_publish.cjs').publish('telegram').catch(error => {
  console.error('TELEGRAM_PUBLISH_FAILED', String(error && error.message || error).slice(0, 240));
  process.exitCode = 1;
});
