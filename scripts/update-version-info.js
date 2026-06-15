import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const versionInfo = {
  gitHash: gitOutput(['rev-parse', '--short=7', 'HEAD']) || 'unknown',
  releaseTag: gitOutput(['describe', '--exact-match', '--tags', 'HEAD'])
};

fs.writeFileSync('src/version-info.json', `${JSON.stringify(versionInfo, null, 2)}\n`);

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim();
  } catch {
    return '';
  }
}
