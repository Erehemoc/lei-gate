import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, keccak256, toBytes } from "viem";
import { VERIFICATION_REPORT_PARAMS } from "./src/abi";
import { encodeVerificationReport } from "./src/report";

/** Fixed input shared with contracts/test/LeiEscrow.t.sol::test_DecodesReportProducedByWorkflowEncoder */
export const FIXTURE_INPUT = {
  invoiceId: 1n,
  lei: "5493001KJTIIGC8Y1R12",
  verified: true,
  entityStatus: "ACTIVE",
  registrationStatus: "ISSUED",
  nextRenewalDate: Date.parse("2027-01-25T16:50:02Z") / 1000,
  jurisdiction: "US-DE",
  legalName: "Bloomberg Finance L.P.",
  checkedAt: Date.UTC(2025, 9, 23) / 1000,
};

describe("encodeVerificationReport", () => {
  test("round-trips through the onReport ABI layout", () => {
    const hex = encodeVerificationReport(FIXTURE_INPUT);
    const d = decodeAbiParameters(VERIFICATION_REPORT_PARAMS, hex);
    expect(d[0]).toBe(1n);
    expect(d[1]).toBe(keccak256(toBytes("5493001KJTIIGC8Y1R12")));
    expect(d[2]).toBe(true);
    expect(d[3]).toBe("ACTIVE");
    expect(d[4]).toBe("ISSUED");
    expect(d[5]).toBe(1800895802n);
    expect(d[6]).toBe("US-DE");
    expect(d[7]).toBe(keccak256(toBytes("Bloomberg Finance L.P.")));
    expect(d[8]).toBe(1761177600n);
  });

  test("matches the fixture embedded in the Solidity test", async () => {
    const sol = await Bun.file(`${import.meta.dir}/../contracts/test/LeiEscrow.t.sol`).text();
    const m = sol.match(/TS_FIXTURE = hex"([0-9a-f]+)"/);
    expect(m).not.toBeNull();
    expect(`0x${m?.[1]}`).toBe(encodeVerificationReport(FIXTURE_INPUT));
  });
});
