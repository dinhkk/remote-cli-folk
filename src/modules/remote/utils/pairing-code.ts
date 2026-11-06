// Pairing codes are 8 Crockford base32 characters shown as XXXX-XXXX (phase 05).
const CODE_LENGTH = 8;
const CODE_GROUP = 4;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Normalises what a person typed into the display form `XXXX-XXXX`: upper-case,
 * separators dropped, Crockford look-alikes folded (O to 0, I and L to 1) and cut
 * to 8 characters. Used live while typing so both machines show the same string.
 */
export const formatPairingCode = (input: string): string => {
  const folded = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, CODE_LENGTH);
  return folded.length > CODE_GROUP ? `${folded.slice(0, CODE_GROUP)}-${folded.slice(CODE_GROUP)}` : folded;
};

/** Whether a formatted code has all 8 characters and every one is in the alphabet (U is not). */
export const isPairingCodeComplete = (formatted: string): boolean => CODE_PATTERN.test(formatted.replace('-', ''));
