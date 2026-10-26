const crypto = require('crypto');

/**
 * Character set used for generating human-readable license keys.
 * Omits ambiguous characters (0, O, 1, I, L) to reduce transcription errors.
 */
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generates a random alphanumeric string segment of specified length.
 * Uses crypto.randomBytes for cryptographic security.
 *
 * @param {number} length - Number of characters to generate
 * @returns {string} Random string segment
 */
function generateSegment(length = 4) {
  const bytes = crypto.randomBytes(length * 2);
  let segment = '';
  let byteIndex = 0;

  while (segment.length < length && byteIndex < bytes.length) {
    const byte = bytes[byteIndex++];
    // Prevent modulo bias by discarding values above the largest multiple of CHARSET.length below 256
    const maxValid = 256 - (256 % CHARSET.length);
    if (byte < maxValid) {
      segment += CHARSET[byte % CHARSET.length];
    }
  }

  // Fallback if needed
  while (segment.length < length) {
    const extraByte = crypto.randomBytes(1)[0];
    segment += CHARSET[extraByte % CHARSET.length];
  }

  return segment;
}

/**
 * Generates a formatted license key in the format: PREFIX-XXXX-XXXX
 * Supports duration-specific prefixes like 'EQ-7D' or 'EQ-30D'.
 * Default prefix is 'EQ'.
 *
 * Examples:
 *   generateLicenseKey('EQ') -> 'EQ-8B2K-9X4F'
 *   generateLicenseKey('EQ-7D') -> 'EQ-7D-8B2K-9X4F'
 *   generateLicenseKey('EQ-30D') -> 'EQ-30D-M5P2-7R9K'
 *
 * @param {string} [prefix='EQ'] - Prefix for the license key
 * @param {'7d'|'30d'|null} [duration=null] - Optional duration to auto-format prefix if prefix is 'EQ'
 * @returns {string} Formatted license key
 */
function generateLicenseKey(prefix = 'EQ', duration = null) {
  let finalPrefix = prefix || 'EQ';
  if (prefix === 'EQ' && duration === '7d') finalPrefix = 'EQ-7D';
  if (prefix === 'EQ' && duration === '30d') finalPrefix = 'EQ-30D';

  const segment1 = generateSegment(4);
  const segment2 = generateSegment(4);
  return `${finalPrefix}-${segment1}-${segment2}`;
}

module.exports = {
  generateLicenseKey,
  generateSegment,
  CHARSET
};
