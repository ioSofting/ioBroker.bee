// Checks package.json and io-package.json (standard test of @iobroker/testing)
const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.packageFiles(path.join(__dirname, '..'));
