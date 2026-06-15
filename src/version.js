import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function gatewayVersion() {
  const packageJson = readPackageJson();
  const gitHash = process.env.JON_GATEWAY_GIT_HASH || gitOutput(['rev-parse', '--short=7', 'HEAD']);
  const releaseTag = process.env.JON_GATEWAY_RELEASE_TAG || gitOutput(['describe', '--exact-match', '--tags', 'HEAD']);
  return {
    packageVersion: packageJson.version || '0.0.0',
    gitHash: gitHash || 'unknown',
    releaseTag: releaseTag || '',
    display: releaseTag ? `${releaseTag} (${gitHash || 'unknown'})` : gitHash || 'unknown'
  };
}

function readPackageJson() {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return {};
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim();
  } catch {
    return '';
  }
}
