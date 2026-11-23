// Starts the adapter in a temporary js-controller installation (standard test of @iobroker/testing)
const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'));
