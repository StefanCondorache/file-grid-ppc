const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI = /[‪-‮⁦-⁩‎‏]/g;
const ZERO_WIDTH = /[​-‍﻿]/g;
const MAX = 255;

/** Display-safe file name (threat-model §5): NFC, no control/bidi/zero-width characters, capped length. */
export function cleanName(raw: string): { text: string; mixedScripts: boolean } {
  const stripped = raw.normalize('NFC').replace(CONTROL, '').replace(BIDI, '').replace(ZERO_WIDTH, '');
  const text = Array.from(stripped).slice(0, MAX).join('');
  const mixedScripts = /\p{Script=Latin}/u.test(text) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(text);
  return { text, mixedScripts };
}
