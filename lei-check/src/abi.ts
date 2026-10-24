import { parseAbi } from "viem";

/** Subset of the LeiEscrow ABI used by the workflow and tests. */
export const LeiEscrowAbi = parseAbi([
  "event InvoiceCreated(uint256 indexed id, address indexed payer, address indexed payee, string lei, uint256 amount)",
  "function getInvoice(uint256 id) view returns ((address payer, address payee, uint256 amount, uint64 createdAt, uint8 status, bytes32 leiHash, string lei))",
  "function onReport(bytes metadata, bytes report)",
]);

/** abi.encode layout of the report body decoded by LeiEscrow.onReport */
export const VERIFICATION_REPORT_PARAMS = [
  { name: "invoiceId", type: "uint256" },
  { name: "leiHash", type: "bytes32" },
  { name: "verified", type: "bool" },
  { name: "entityStatus", type: "string" },
  { name: "registrationStatus", type: "string" },
  { name: "nextRenewalDate", type: "uint64" },
  { name: "jurisdiction", type: "string" },
  { name: "legalNameHash", type: "bytes32" },
  { name: "checkedAt", type: "uint64" },
] as const;
