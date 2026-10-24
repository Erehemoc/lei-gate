import { describe, expect, test } from "bun:test";
import { computeLeiCheckDigits, isValidLei, validateLei } from "./src/lei";

describe("validateLei (ISO 17442, MOD 97-10)", () => {
  test.each([
    "5493001KJTIIGC8Y1R12", // Bloomberg Finance L.P.
    "7N0UJMJLXD0MDT5D5086", // ENSCO PLC
    "EYKN6V0ZCB8VD9IULB80", // Bank of America Merrill Lynch International Ltd
    "529900T8BM49AURSDO55", // Ubisecure Oy
    "LEIGATE0000000000073", // synthetic, checksum-valid, not registered
  ])("accepts real/valid LEI %s", (lei) => {
    expect(validateLei(lei)).toEqual({ valid: true });
  });

  test("rejects wrong check digits", () => {
    expect(validateLei("5493001KJTIIGC8Y1R13")).toEqual({ valid: false, reason: "CHECKSUM" });
    expect(validateLei("5493001KJTIIGC8Y1R21")).toEqual({ valid: false, reason: "CHECKSUM" });
  });

  test("rejects single-character substitutions in the body", () => {
    expect(isValidLei("5493001KJTIIGC8Y1S12")).toBe(false);
    expect(isValidLei("6493001KJTIIGC8Y1R12")).toBe(false);
  });

  test("rejects wrong length", () => {
    expect(validateLei("")).toEqual({ valid: false, reason: "LENGTH" });
    expect(validateLei("5493001KJTIIGC8Y1R1")).toEqual({ valid: false, reason: "LENGTH" });
    expect(validateLei("5493001KJTIIGC8Y1R123")).toEqual({ valid: false, reason: "LENGTH" });
  });

  test("rejects lowercase, symbols and letters in the check digits", () => {
    expect(validateLei("5493001kjtiigc8y1r12")).toEqual({ valid: false, reason: "CHARSET" });
    expect(validateLei("5493001KJTIIGC8Y1R-2")).toEqual({ valid: false, reason: "CHARSET" });
    expect(validateLei("5493001KJTIIGC8Y1RAB")).toEqual({ valid: false, reason: "CHARSET" });
  });

  test("computeLeiCheckDigits reproduces the published check digits", () => {
    expect(computeLeiCheckDigits("5493001KJTIIGC8Y1R")).toBe("12");
    expect(computeLeiCheckDigits("7N0UJMJLXD0MDT5D50")).toBe("86");
    expect(computeLeiCheckDigits("EYKN6V0ZCB8VD9IULB")).toBe("80");
  });
});
