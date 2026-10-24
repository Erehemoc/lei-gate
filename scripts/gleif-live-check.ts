#!/usr/bin/env bun
/**
 * Live sanity check (outside CRE): runs the exact parsing + decision code used by the
 * workflow (lei-check/src/{lei,gleif}.ts) against the real GLEIF API.
 *
 *   bun scripts/gleif-live-check.ts [LEI ...]
 */
import { decideVerification, notFoundObservation, parseGleifRecord } from "../lei-check/src/gleif";
import { validateLei } from "../lei-check/src/lei";

const BASE = "https://api.gleif.org/api/v1/lei-records";
const cases: { lei: string; expectVerified: boolean | null }[] =
  process.argv.length > 2
    ? process.argv.slice(2).map((lei) => ({ lei, expectVerified: null }))
    : [
        { lei: "5493001KJTIIGC8Y1R12", expectVerified: true }, // Bloomberg Finance L.P. ACTIVE/ISSUED
        { lei: "7N0UJMJLXD0MDT5D5086", expectVerified: false }, // ENSCO PLC ACTIVE/LAPSED
        { lei: "EYKN6V0ZCB8VD9IULB80", expectVerified: false }, // BofA Merrill Lynch Intl INACTIVE/RETIRED
        { lei: "LEIGATE0000000000073", expectVerified: false }, // checksum-valid, unregistered -> 404
        { lei: "5493001KJTIIGC8Y1R13", expectVerified: false }, // bad checksum -> no API call
      ];

const now = Math.floor(Date.now() / 1000);
let failures = 0;
for (const { lei, expectVerified } of cases) {
  const format = validateLei(lei);
  let obs = notFoundObservation(lei);
  let http = "-";
  if (!format.valid) {
    obs = { ...obs, entityStatus: "INVALID_LEI_FORMAT", registrationStatus: format.reason };
  } else {
    const res = await fetch(`${BASE}/${lei}`, { headers: { Accept: "application/vnd.api+json" } });
    http = String(res.status);
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`GLEIF ${res.status} for ${lei}`);
      obs = parseGleifRecord(await res.json(), lei);
    }
  }
  const d = decideVerification(obs, now);
  const ok = expectVerified === null || d.verified === expectVerified;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${lei} http=${http} verified=${d.verified} entity=${obs.entityStatus} ` +
      `registration=${obs.registrationStatus} renewal=${obs.nextRenewalDate || "-"} ` +
      `jurisdiction=${obs.jurisdiction || "-"} name="${obs.legalName}"` +
      (d.reasons.length ? ` reasons=[${d.reasons.join("; ")}]` : ""),
  );
}
if (failures) {
  console.error(`${failures} live check(s) failed`);
  process.exit(1);
}
