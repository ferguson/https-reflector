#!/usr/bin/env node

process.on('uncaughtException', (err) => {
    console.error('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection', reason);
});

const main = require('./build/main.js');
main.default();
