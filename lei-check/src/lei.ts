/**
 * ISO 17442 Legal Entity Identifier validation.
 *
 * Structure: 18 alphanumeric characters (4-char LOU prefix + 14-char entity part)
 * followed by 2 check digits computed with ISO/IEC 7064 MOD 97-10 — the same
 * scheme as IBAN: replace each letter by its value (A=10 … Z=35); the resulting
 * integer mod 97 must equal 1.
 */

const LEI_REGEX = /^[0-9A-Z]{18}[0-9]{2}$/;

export type LeiValidation =
  | { valid: true }
  | { valid: false; reason: "LENGTH" | "CHARSET" | "CHECKSUM" };

/** Computes `value mod 97` for an alphanumeric string, digit by digit (no bigint needed). */
const mod97 = (alnum: string): number => {
  let rem = 0;
  for (const ch of alnum) {
    const code = ch.charCodeAt(0);
    // '0'..'9' => 0..9, 'A'..'Z' => 10..35
    const v = code <= 57 ? code - 48 : code - 55;
    rem = v >= 10 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem;
};

export const validateLei = (lei: string): LeiValidation => {
  if (lei.length !== 20) return { valid: false, reason: "LENGTH" };
  if (!LEI_REGEX.test(lei)) return { valid: false, reason: "CHARSET" };
  if (mod97(lei) !== 1) return { valid: false, reason: "CHECKSUM" };
  return { valid: true };
};

export const isValidLei = (lei: string): boolean => validateLei(lei).valid;

/** Computes the two ISO 7064 check digits for an 18-character LEI prefix. */
export const computeLeiCheckDigits = (prefix18: string): string => {
  if (!/^[0-9A-Z]{18}$/.test(prefix18)) throw new Error("prefix must be 18 chars [0-9A-Z]");
  const check = 98 - mod97(`${prefix18}00`);
  return check.toString().padStart(2, "0");
};
