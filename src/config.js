import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gatewayVersion } from './version.js';

const DEFAULT_CONFIG_PATHS = [
  '/opt/JONImageProcessor-Gateway/etc/gateway.config.json',
  path.resolve(process.cwd(), 'config/gateway.config.json'),
  path.resolve(process.cwd(), 'config/gateway.config.example.json')
];

export function loadConfig() {
  const configPath = process.env.JON_GATEWAY_CONFIG || DEFAULT_CONFIG_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error('No gateway config found. Set JON_GATEWAY_CONFIG or create /opt/JONImageProcessor-Gateway/etc/gateway.config.json.');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.__path = configPath;
  normalizeConfig(config);
  return config;
}

function normalizeConfig(config) {
  config.server ??= {};
  config.server.host ??= '127.0.0.1';
  config.server.port ??= 8080;
  config.server.corsAllowedOrigins ??= [];

  config.auth ??= {};
  config.auth.tokenEnv ??= 'JON_GATEWAY_TOKEN';
  config.auth.tokenSha256 ??= [];
  config.auth.allowQueryToken ??= true;

  const envToken = process.env[config.auth.tokenEnv];
  config.auth.acceptedTokenHashes = [...config.auth.tokenSha256];
  if (envToken) {
    config.auth.acceptedTokenHashes.push(sha256(envToken));
  }
  if (config.auth.acceptedTokenHashes.length === 0) {
    throw new Error(`No API token configured. Set ${config.auth.tokenEnv} or auth.tokenSha256 in the gateway config.`);
  }

  config.jonImageProcessor ??= {};
  config.jonImageProcessor.ipcSocket ??= '/tmp/jonimageprocessor.sock';
  config.jonImageProcessor.requestTimeoutMs ??= 2000;
  config.jonImageProcessor.pollIntervalMs ??= 1000;

  config.files ??= {};
  config.files.maxUploadBytes ??= 50 * 1024 * 1024;
  config.files.roots ??= {};
}

export function publicConfig(config) {
  return {
    gateway: gatewayVersion(),
    server: {
      host: config.server.host,
      port: config.server.port,
      corsAllowedOrigins: config.server.corsAllowedOrigins
    },
    jonImageProcessor: {
      ipcSocket: config.jonImageProcessor.ipcSocket,
      requestTimeoutMs: config.jonImageProcessor.requestTimeoutMs,
      pollIntervalMs: config.jonImageProcessor.pollIntervalMs
    },
    files: {
      maxUploadBytes: config.files.maxUploadBytes,
      roots: Object.fromEntries(Object.entries(config.files.roots).map(([name, root]) => [
        name,
        {
          allowUpload: Boolean(root.allowUpload),
          allowDelete: Boolean(root.allowDelete),
          allowedExtensions: root.allowedExtensions ?? [],
          ipcKey: root.ipcKey
        }
      ]))
    },
    api: config.api
  };
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
