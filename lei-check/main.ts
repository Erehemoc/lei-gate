/**
 * LEI Gate — CRE workflow
 *
 * Trigger 0: EVM log  `InvoiceCreated(id, payer, payee, lei, amount)` emitted by LeiEscrow (Sepolia)
 * Trigger 1: HTTP     `{"invoiceId": "1", "lei": "5493001KJTIIGC8Y1R12"}` (manual / simulation)
 *
 * For each trigger the workflow:
 *   1. validates the LEI locally (ISO 17442: 20 chars, MOD 97-10 checksum) — no API call if invalid
 *   2. fetches https://api.gleif.org/api/v1/lei-records/{LEI} on every node (HTTP capability) and
 *      reaches consensus with identical aggregation on the extracted fields
 *   3. decides verified = entity ACTIVE && registration ISSUED && nextRenewalDate > now (DON time)
 *   4. produces a DON-signed report and writes it to LeiEscrow.onReport via the EVM capability
 */
import {
  bytesToHex,
  ConsensusAggregationByFields,
  cre,
  decodeJson,
  type EVMLog,
  getNetwork,
  type HTTPPayload,
  type HTTPSendRequester,
  identical,
  logTriggerConfig,
  prepareReportRequest,
  Runner,
  type Runtime,
  text,
  TxStatus,
} from "@chainlink/cre-sdk";
import { decodeEventLog, type Hex, toEventSelector } from "viem";
import { z } from "zod";
import { LeiEscrowAbi } from "./src/abi";
import { decideVerification, type GleifObservation, notFoundObservation, parseGleifRecord } from "./src/gleif";
import { validateLei } from "./src/lei";
import { encodeVerificationReport } from "./src/report";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const configSchema = z.object({
  /** CRE chain selector name, e.g. "ethereum-testnet-sepolia" */
  chainSelectorName: z.string(),
  /** Deployed LeiEscrow address (receiver of reports and source of InvoiceCreated logs) */
  escrowAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Gas limit for the forwarder -> onReport transaction */
  gasLimit: z.string().regex(/^\d+$/),
  /** GLEIF base URL (record endpoint, LEI is appended) */
  gleifBaseUrl: z.string().regex(/^https:\/\/[^\s\/]+(\/[^\s]*)?$/, "must be an https URL"),
  /** Log trigger confidence */
  logConfidence: z.enum(["SAFE", "LATEST", "FINALIZED"]),
});
export type Config = z.infer<typeof configSchema>;

export const INVOICE_CREATED_SIG = "InvoiceCreated(uint256,address,address,string,uint256)";
export const INVOICE_CREATED_TOPIC: Hex = toEventSelector(INVOICE_CREATED_SIG);

/** What each handler returns (shown by `cre workflow simulate`). */
export type LeiCheckResult = {
  invoiceId: string;
  lei: string;
  verified: boolean;
  entityStatus: string;
  registrationStatus: string;
  legalName: string;
  jurisdiction: string;
  nextRenewalDate: string;
  reasons: string[];
  txStatus: string;
  receiverStatus: string;
  txHash: string;
};

/** evm v1alpha ReceiverContractExecutionStatus (0 = SUCCESS, 1 = REVERTED) */
const RECEIVER_STATUS = ["SUCCESS", "REVERTED"] as const;

// ---------------------------------------------------------------------------
// GLEIF fetch (runs on every node; result goes through consensus)
// ---------------------------------------------------------------------------
export const fetchGleif = (sendRequester: HTTPSendRequester, baseUrl: string, lei: string): GleifObservation => {
  const url = `${baseUrl.replace(/\/+$/, "")}/${lei}`;
  const response = sendRequester
    .sendRequest({ url, method: "GET", headers: { Accept: "application/vnd.api+json" } })
    .result();

  if (response.statusCode === 404) return notFoundObservation(lei);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    // Do not write a negative report because of an outage: fail the execution instead.
    throw new Error(`GLEIF request failed with status ${response.statusCode}`);
  }
  return parseGleifRecord(JSON.parse(text(response)), lei);
};

/** Identical aggregation on every extracted field: all honest nodes must see the same record. */
export const gleifConsensus = ConsensusAggregationByFields<GleifObservation>({
  found: identical,
  lei: identical,
  legalName: identical,
  entityStatus: identical,
  registrationStatus: identical,
  nextRenewalDate: identical,
  jurisdiction: identical,
});

// ---------------------------------------------------------------------------
// Core: verify an LEI for an invoice and write the report on-chain
// ---------------------------------------------------------------------------
const evmClientFor = (config: Config) => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Unknown chain selector name: ${config.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
};

export const verifyAndReport = (runtime: Runtime<Config>, invoiceId: bigint, lei: string): LeiCheckResult => {
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000);

  // 1. local ISO 17442 validation
  const format = validateLei(lei);
  let obs: GleifObservation;
  if (!format.valid) {
    runtime.log(`Invoice ${invoiceId}: LEI "${lei}" rejected locally (${format.reason}); skipping GLEIF call`);
    obs = { ...notFoundObservation(lei), entityStatus: "INVALID_LEI_FORMAT", registrationStatus: format.reason };
  } else {
    // 2. GLEIF lookup with node consensus
    const http = new cre.capabilities.HTTPClient();
    obs = http.sendRequest(runtime, fetchGleif, gleifConsensus)(runtime.config.gleifBaseUrl, lei).result();
    runtime.log(
      `GLEIF ${lei}: found=${obs.found} name="${obs.legalName}" entity=${obs.entityStatus} ` +
        `registration=${obs.registrationStatus} nextRenewal=${obs.nextRenewalDate} jurisdiction=${obs.jurisdiction}`,
    );
  }

  // 3. decision
  const decision = decideVerification(obs, nowSeconds);
  runtime.log(
    `Invoice ${invoiceId}: verified=${decision.verified}${decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""}`,
  );

  // 4. signed report -> LeiEscrow.onReport
  const payload = encodeVerificationReport({
    invoiceId,
    lei,
    verified: decision.verified,
    entityStatus: obs.entityStatus,
    registrationStatus: obs.registrationStatus,
    nextRenewalDate: decision.nextRenewalDate,
    jurisdiction: obs.jurisdiction,
    legalName: obs.legalName,
    checkedAt: nowSeconds,
  });
  const report = runtime.report(prepareReportRequest(payload)).result();
  const reply = evmClientFor(runtime.config)
    .writeReport(runtime, {
      receiver: runtime.config.escrowAddress,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result();

  const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : "";
  const txStatus = TxStatus[reply.txStatus] ?? String(reply.txStatus);
  const receiverStatus =
    reply.receiverContractExecutionStatus === undefined
      ? "UNKNOWN"
      : (RECEIVER_STATUS[reply.receiverContractExecutionStatus] ?? String(reply.receiverContractExecutionStatus));
  runtime.log(
    `writeReport txStatus=${txStatus} receiver=${receiverStatus} tx=${txHash || "-"}${reply.errorMessage ? ` error=${reply.errorMessage}` : ""}`,
  );

  return {
    invoiceId: invoiceId.toString(),
    lei,
    verified: decision.verified,
    entityStatus: obs.entityStatus,
    registrationStatus: obs.registrationStatus,
    legalName: obs.legalName,
    jurisdiction: obs.jurisdiction,
    nextRenewalDate: obs.nextRenewalDate,
    reasons: decision.reasons,
    txStatus,
    receiverStatus,
    txHash,
  };
};

// ---------------------------------------------------------------------------
// Trigger handlers
// ---------------------------------------------------------------------------
export const onInvoiceCreated = (runtime: Runtime<Config>, log: EVMLog): LeiCheckResult => {
  const decoded = decodeEventLog({
    abi: LeiEscrowAbi,
    eventName: "InvoiceCreated",
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    data: bytesToHex(log.data),
  });
  const { id, payer, payee, lei, amount } = decoded.args;
  runtime.log(`InvoiceCreated id=${id} payer=${payer} payee=${payee} lei=${lei} amount=${amount}`);
  return verifyAndReport(runtime, id, lei);
};

const httpInputSchema = z.object({
  invoiceId: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
  lei: z.string(),
});

export const onHttpRequest = (runtime: Runtime<Config>, payload: HTTPPayload): LeiCheckResult => {
  const input = httpInputSchema.parse(decodeJson(payload.input));
  const invoiceId = BigInt(input.invoiceId);
  runtime.log(`HTTP trigger invoiceId=${invoiceId} lei=${input.lei}`);
  return verifyAndReport(runtime, invoiceId, input.lei);
};

// ---------------------------------------------------------------------------
// Workflow wiring
// ---------------------------------------------------------------------------
export const initWorkflow = (config: Config) => {
  const evm = evmClientFor(config);
  const http = new cre.capabilities.HTTPCapability();

  return [
    cre.handler(
      evm.logTrigger(
        logTriggerConfig({
          addresses: [config.escrowAddress as Hex],
          topics: [[INVOICE_CREATED_TOPIC]],
          confidence: config.logConfidence,
        }),
      ),
      onInvoiceCreated,
    ),
    cre.handler(http.trigger({}), onHttpRequest),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
