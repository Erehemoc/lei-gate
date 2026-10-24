import { describe, expect, test } from "bun:test";
import { decideVerification, isoToUnixSeconds, notFoundObservation, parseGleifRecord } from "./src/gleif";

const FIXTURES = [
  "gleif-5493001KJTIIGC8Y1R12-active.json",
  "gleif-7N0UJMJLXD0MDT5D5086-lapsed.json",
  "gleif-EYKN6V0ZCB8VD9IULB80-retired.json",
];
const loaded: Record<string, unknown> = {};
for (const f of FIXTURES) loaded[f] = await Bun.file(`${import.meta.dir}/test/fixtures/${f}`).json();
const fixture = (name: string) => loaded[name];
// 2026-10-23T00:00:00Z
const NOW = Date.UTC(2026, 9, 23) / 1000;

describe("parseGleifRecord (real GLEIF responses captured 2026-10-23)", () => {
  test("ACTIVE / ISSUED: Bloomberg Finance L.P.", () => {
    const obs = parseGleifRecord(fixture("gleif-5493001KJTIIGC8Y1R12-active.json"), "5493001KJTIIGC8Y1R12");
    expect(obs).toEqual({
      found: true,
      lei: "5493001KJTIIGC8Y1R12",
      legalName: "Bloomberg Finance L.P.",
      entityStatus: "ACTIVE",
      registrationStatus: "ISSUED",
      nextRenewalDate: "2027-01-25T16:50:02Z",
      jurisdiction: "US-DE",
    });
    expect(decideVerification(obs, NOW)).toEqual({
      verified: true,
      reasons: [],
      nextRenewalDate: isoToUnixSeconds("2027-01-25T16:50:02Z"),
    });
  });

  test("ACTIVE / LAPSED: ENSCO PLC is not verified", () => {
    const obs = parseGleifRecord(fixture("gleif-7N0UJMJLXD0MDT5D5086-lapsed.json"), "7N0UJMJLXD0MDT5D5086");
    expect(obs.entityStatus).toBe("ACTIVE");
    expect(obs.registrationStatus).toBe("LAPSED");
    const d = decideVerification(obs, NOW);
    expect(d.verified).toBe(false);
    expect(d.reasons).toContain("registration.status=LAPSED");
    expect(d.reasons.some((r) => r.startsWith("nextRenewalDate=2015-10-14"))).toBe(true);
  });

  test("INACTIVE / RETIRED: BofA Merrill Lynch International is not verified", () => {
    const obs = parseGleifRecord(fixture("gleif-EYKN6V0ZCB8VD9IULB80-retired.json"), "EYKN6V0ZCB8VD9IULB80");
    expect(obs.legalName).toBe("BANK OF AMERICA MERRILL LYNCH INTERNATIONAL LIMITED");
    const d = decideVerification(obs, NOW);
    expect(d.verified).toBe(false);
    expect(d.reasons).toEqual(expect.arrayContaining(["entity.status=INACTIVE", "registration.status=RETIRED"]));
  });

  test("rejects a record for a different LEI and malformed bodies", () => {
    expect(() =>
      parseGleifRecord(fixture("gleif-5493001KJTIIGC8Y1R12-active.json"), "7N0UJMJLXD0MDT5D5086"),
    ).toThrow(/expected 7N0UJMJLXD0MDT5D5086/);
    expect(() => parseGleifRecord({ errors: [{ status: "404" }] }, "X")).toThrow(/no data.attributes/);
    expect(() => parseGleifRecord(null, "X")).toThrow();
  });
});

describe("decideVerification", () => {
  const base = parseGleifRecord(fixture("gleif-5493001KJTIIGC8Y1R12-active.json"), "5493001KJTIIGC8Y1R12");

  test("ACTIVE/ISSUED but renewal date already passed => not verified", () => {
    const after = isoToUnixSeconds("2027-01-25T16:50:02Z");
    expect(decideVerification(base, after).verified).toBe(false);
    expect(decideVerification(base, after - 1).verified).toBe(true);
  });

  test("missing renewal date => not verified", () => {
    expect(decideVerification({ ...base, nextRenewalDate: "" }, NOW).verified).toBe(false);
  });

  test("not found => not verified", () => {
    const d = decideVerification(notFoundObservation("LEIGATE0000000000073"), NOW);
    expect(d.verified).toBe(false);
    expect(d.reasons[0]).toBe("LEI not found in GLEIF");
  });

  test("PENDING_TRANSFER etc. are not ISSUED", () => {
    expect(decideVerification({ ...base, registrationStatus: "PENDING_TRANSFER" }, NOW).verified).toBe(false);
  });
});
