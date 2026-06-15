import fs from 'node:fs';
import path from 'node:path';

export function gatewayVersion() {
  const packageJson = readPackageJson();
  const versionInfo = readVersionInfo();
  const gitHash = process.env.JON_GATEWAY_GIT_HASH || versionInfo.gitHash || '';
  const releaseTag = process.env.JON_GATEWAY_RELEASE_TAG || versionInfo.releaseTag || '';
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

function readVersionInfo() {
  const versionInfoPath = path.resolve(process.cwd(), 'src/version-info.json');
  try {
    return JSON.parse(fs.readFileSync(versionInfoPath, 'utf8'));
  } catch {
    return {};
  }
}
