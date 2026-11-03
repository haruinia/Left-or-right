'use strict';

const { execFileSync } = require('node:child_process');

module.exports = async function signMac(options) {
  if (options.identity) {
    const { signAsync } = require('@electron/osx-sign');
    await signAsync(options);
  } else {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', options.app], { stdio: 'inherit' });
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app], { stdio: 'inherit' });
};
