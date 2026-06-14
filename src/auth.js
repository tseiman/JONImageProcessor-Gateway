import { timingSafeEqual } from 'node:crypto';
import { sha256 } from './config.js';

export function extractToken(req, config, url) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  if (req.headers['x-api-token']) return String(req.headers['x-api-token']);
  if (config.auth.allowQueryToken && url.searchParams.has('token')) return url.searchParams.get('token');
  return '';
}

export function isAuthorized(token, config) {
  if (!token) return false;
  const tokenHash = Buffer.from(sha256(token), 'hex');
  return config.auth.acceptedTokenHashes.some((hash) => {
    const expected = Buffer.from(hash, 'hex');
    return expected.length === tokenHash.length && timingSafeEqual(expected, tokenHash);
  });
}
