import { encodeAbiParameters, type Hex, keccak256, toBytes } from "viem";
import { VERIFICATION_REPORT_PARAMS } from "./abi";

export type VerificationReport = {
  invoiceId: bigint;
  lei: string;
  verified: boolean;
  entityStatus: string;
  registrationStatus: string;
  nextRenewalDate: number; // unix seconds
  jurisdiction: string;
  legalName: string;
  checkedAt: number; // unix seconds
};

/** keccak256(bytes(s)) — matches Solidity `keccak256(bytes(s))`. */
export const hashString = (s: string): Hex => keccak256(toBytes(s));

/** ABI-encodes the report body exactly as LeiEscrow.onReport decodes it. */
export const encodeVerificationReport = (r: VerificationReport): Hex =>
  encodeAbiParameters(VERIFICATION_REPORT_PARAMS, [
    r.invoiceId,
    hashString(r.lei),
    r.verified,
    r.entityStatus,
    r.registrationStatus,
    BigInt(r.nextRenewalDate),
    r.jurisdiction,
    hashString(r.legalName),
    BigInt(r.checkedAt),
  ]);
