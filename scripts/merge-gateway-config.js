#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [targetPath, sourcePath = 'config/gateway.config.example.json'] = process.argv.slice(2);

if (!targetPath) {
  console.error('Usage: node scripts/merge-gateway-config.js <target-config> [source-config]');
  process.exit(2);
}

const target = readJson(targetPath);
const source = readJson(sourcePath);
const changes = [];
const merged = mergeDefaults(target, source, [], changes);

if (changes.length === 0) {
  console.log(`Config already contains all default schema entries: ${targetPath}`);
  process.exit(0);
}

const backupPath = `${targetPath}.${timestamp()}.bak`;
if (process.env.MERGE_CONFIG_BACKUP !== '0') fs.copyFileSync(targetPath, backupPath);
fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`);

console.log(`Merged ${changes.length} missing config entr${changes.length === 1 ? 'y' : 'ies'} into ${targetPath}`);
if (process.env.MERGE_CONFIG_BACKUP !== '0') console.log(`Backup written to ${backupPath}`);
for (const change of changes) console.log(`  + ${change}`);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read JSON config ${filePath}: ${error.message}`);
    process.exit(1);
  }
}

function mergeDefaults(targetValue, sourceValue, keyPath, changes) {
  if (targetValue === undefined) {
    changes.push(keyPath.join('.'));
    return clone(sourceValue);
  }

  if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
    return mergeArray(targetValue, sourceValue, keyPath, changes);
  }

  if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
    const result = { ...targetValue };
    for (const [key, sourceChild] of Object.entries(sourceValue)) {
      result[key] = mergeDefaults(targetValue[key], sourceChild, [...keyPath, key], changes);
    }
    return result;
  }

  return targetValue;
}

function mergeArray(targetArray, sourceArray, keyPath, changes) {
  const keyName = keyPath.at(-1);
  if (keyName !== 'keys' && keyName !== 'enum') return targetArray;

  const result = [...targetArray];
  const seen = new Set(result);
  for (const item of sourceArray) {
    if (seen.has(item)) continue;
    result.push(item);
    seen.add(item);
    changes.push(`${keyPath.join('.')}[]:${item}`);
  }
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}
