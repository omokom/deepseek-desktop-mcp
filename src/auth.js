import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare a presented bearer token with the expected token without leaking
 * length or content through early exits. Both values are digested first so
 * timingSafeEqual always receives fixed-size buffers.
 *
 * @param {string} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Read a Bearer credential from an Authorization header. Returns undefined for
 * a missing or malformed header; never throws and never logs the value.
 *
 * @param {string | string[] | undefined} header
 * @returns {string | undefined}
 */
export function bearerFromHeader(header) {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(header);
  return match?.[1];
}
