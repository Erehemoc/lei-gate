/**
 * Pure GLEIF parsing + verification decision (no CRE imports, so it can be reused by
 * the live sanity-check script and unit tests).
 *
 * API: GET https://api.gleif.org/api/v1/lei-records/{LEI}  (JSON:API, no auth, free)
 */

/** Fields every DON node extracts from the GLEIF response; consensus is "identical" per field. */
export type GleifObservation = {
  /** false when GLEIF answered 404 (no such LEI) */
  found: boolean;
  lei: string;
  legalName: string;
  entityStatus: string; // ACTIVE | INACTIVE | NULL | ...
  registrationStatus: string; // ISSUED | LAPSED | RETIRED | MERGED | ANNULLED | DUPLICATE | PENDING_* ...
  nextRenewalDate: string; // ISO-8601, "" if absent
  jurisdiction: string; // e.g. "US-DE", "" if absent
};

export const notFoundObservation = (lei: string): GleifObservation => ({
  found: false,
  lei,
  legalName: "",
  entityStatus: "NOT_FOUND",
  registrationStatus: "NOT_FOUND",
  nextRenewalDate: "",
  jurisdiction: "",
});

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Extracts the observation from a GLEIF `lei-records/{id}` JSON body. Throws on malformed bodies. */
export const parseGleifRecord = (body: unknown, requestedLei: string): GleifObservation => {
  const data = (body as { data?: unknown } | null)?.data as
    | { id?: unknown; attributes?: Record<string, unknown> }
    | undefined;
  const attrs = data?.attributes;
  if (!attrs || typeof attrs !== "object") {
    throw new Error("GLEIF response has no data.attributes");
  }
  const entity = (attrs.entity ?? {}) as Record<string, unknown>;
  const registration = (attrs.registration ?? {}) as Record<string, unknown>;
  const legalName = (entity.legalName ?? {}) as Record<string, unknown>;
  const lei = str(attrs.lei) || str(data?.id);
  if (lei !== requestedLei) {
    throw new Error(`GLEIF returned LEI ${lei}, expected ${requestedLei}`);
  }
  return {
    found: true,
    lei,
    legalName: str(legalName.name),
    entityStatus: str(entity.status),
    registrationStatus: str(registration.status),
    nextRenewalDate: str(registration.nextRenewalDate),
    jurisdiction: str(entity.jurisdiction),
  };
};

/** Parses an ISO-8601 timestamp to unix seconds; 0 when empty/invalid. */
export const isoToUnixSeconds = (iso: string): number => {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};

export type VerificationDecision = {
  verified: boolean;
  reasons: string[];
  nextRenewalDate: number; // unix seconds
};

/**
 * KYB rule: an entity is "verified" only if
 *   entity.status == ACTIVE  &&  registration.status == ISSUED  &&  nextRenewalDate > now
 */
export const decideVerification = (obs: GleifObservation, nowSeconds: number): VerificationDecision => {
  const reasons: string[] = [];
  const nextRenewalDate = isoToUnixSeconds(obs.nextRenewalDate);
  if (obs.entityStatus === "INVALID_LEI_FORMAT") {
    return { verified: false, reasons: [`invalid LEI format (${obs.registrationStatus || "?"}); GLEIF not queried`], nextRenewalDate };
  }
  if (!obs.found) reasons.push("LEI not found in GLEIF");
  if (obs.entityStatus !== "ACTIVE") reasons.push(`entity.status=${obs.entityStatus || "?"}`);
  if (obs.registrationStatus !== "ISSUED") reasons.push(`registration.status=${obs.registrationStatus || "?"}`);
  if (!(nextRenewalDate > nowSeconds)) reasons.push(`nextRenewalDate=${obs.nextRenewalDate || "?"} not in the future`);
  return { verified: reasons.length === 0, reasons, nextRenewalDate };
};
