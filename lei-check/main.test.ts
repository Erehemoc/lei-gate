import { describe, expect } from "bun:test";
import type { EVMLog, HTTPPayload } from "@chainlink/cre-sdk";
import {
  addContractMock,
  EvmMock,
  HttpActionsMock,
  newTestRuntime,
  REPORT_METADATA_HEADER_LENGTH,
  test,
  type WriteReportMockInput,
} from "@chainlink/cre-sdk/test";
import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  hexToBytes,
  keccak256,
  toBytes,
} from "viem";
import { type Config, INVOICE_CREATED_TOPIC, initWorkflow, onHttpRequest, onInvoiceCreated } from "./main";
import { LeiEscrowAbi, VERIFICATION_REPORT_PARAMS } from "./src/abi";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const SEPOLIA = 16015286601757825753n; // ethereum-testnet-sepolia chain selector
const ESCROW = "0x1111111111111111111111111111111111111111" as const;
const NOW_MS = Date.UTC(2026, 9, 23, 12, 0, 0); // 2026-10-23T12:00:00Z

const config: Config = {
  chainSelectorName: "ethereum-testnet-sepolia",
  escrowAddress: ESCROW,
  gasLimit: "500000",
  gleifBaseUrl: "https://api.gleif.org/api/v1/lei-records",
  logConfidence: "LATEST",
};

const fixture = async (name: string) => Bun.file(`${import.meta.dir}/test/fixtures/${name}`).text();
const BLOOMBERG = "5493001KJTIIGC8Y1R12";
const ENSCO_LAPSED = "7N0UJMJLXD0MDT5D5086";
const BOFA_RETIRED = "EYKN6V0ZCB8VD9IULB80";
const UNREGISTERED = "LEIGATE0000000000073";

const GLEIF: Record<string, { status: number; body: string }> = {
  [BLOOMBERG]: { status: 200, body: await fixture(`gleif-${BLOOMBERG}-active.json`) },
  [ENSCO_LAPSED]: { status: 200, body: await fixture(`gleif-${ENSCO_LAPSED}-lapsed.json`) },
  [BOFA_RETIRED]: { status: 200, body: await fixture(`gleif-${BOFA_RETIRED}-retired.json`) },
  [UNREGISTERED]: {
    status: 404,
    body: JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }),
  },
};

type Harness = {
  runtime: ReturnType<typeof newTestRuntime<Config>>;
  httpCalls: string[];
  writes: WriteReportMockInput[];
};

/** Wires HTTP + EVM mocks. Must be called inside the CRE `test()` wrapper. */
const setup = (opts: { httpStatusOverride?: number } = {}): Harness => {
  const httpCalls: string[] = [];
  const writes: WriteReportMockInput[] = [];

  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    httpCalls.push(req.url);
    const lei = req.url.split("/").pop() ?? "";
    const entry = GLEIF[lei] ?? { status: 404, body: "{}" };
    const status = opts.httpStatusOverride ?? entry.status;
    return { statusCode: status, body: Buffer.from(entry.body).toString("base64") };
  };

  const evm = EvmMock.testInstance(SEPOLIA);
  const escrow = addContractMock(evm, { address: ESCROW, abi: LeiEscrowAbi });
  escrow.writeReport = (input) => {
    writes.push(input);
    return { txStatus: "TX_STATUS_SUCCESS", txHash: Buffer.from(new Uint8Array(32).fill(0xab)).toString("base64") };
  };

  const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW_MS }, config);
  return { runtime, httpCalls, writes };
};

/** Strips the 109-byte report metadata header and decodes the LeiEscrow.onReport body. */
const decodeWrittenReport = (w: WriteReportMockInput) => {
  const body = w.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH);
  const [invoiceId, leiHash, verified, entityStatus, registrationStatus, nextRenewalDate, jurisdiction, legalNameHash, checkedAt] =
    decodeAbiParameters(VERIFICATION_REPORT_PARAMS, bytesToHex(body));
  return {
    invoiceId,
    leiHash,
    verified,
    entityStatus,
    registrationStatus,
    nextRenewalDate,
    jurisdiction,
    legalNameHash,
    checkedAt,
  };
};

const httpPayload = (obj: unknown): HTTPPayload =>
  ({ input: new TextEncoder().encode(JSON.stringify(obj)) }) as unknown as HTTPPayload;

const invoiceCreatedLog = (id: bigint, lei: string, amount: bigint): EVMLog => {
  const topics = encodeEventTopics({
    abi: LeiEscrowAbi,
    eventName: "InvoiceCreated",
    args: {
      id,
      payer: "0x000000000000000000000000000000000000a11c",
      payee: "0x0000000000000000000000000000000000000b0b",
    },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [lei, amount]);
  return {
    address: hexToBytes(ESCROW),
    topics: topics.map((t) => hexToBytes(t)),
    data: hexToBytes(data),
    txHash: new Uint8Array(32),
    blockHash: new Uint8Array(32),
    eventSig: hexToBytes(topics[0] as Hex),
    txIndex: 0,
    index: 0,
    removed: false,
  } as unknown as EVMLog;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("initWorkflow", () => {
  test("registers an EVM log trigger on InvoiceCreated and an HTTP trigger", () => {
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(2);

    const logTrigger = handlers[0].trigger as unknown as {
      capabilityId(): string;
      config: { addresses: Uint8Array[]; topics: { values: Uint8Array[] }[] };
    };
    expect(logTrigger.capabilityId()).toBe(`evm:ChainSelector:${SEPOLIA}@1.0.0`);
    expect(bytesToHex(logTrigger.config.addresses[0])).toBe(ESCROW);
    expect(bytesToHex(logTrigger.config.topics[0].values[0])).toBe(INVOICE_CREATED_TOPIC);
    expect(INVOICE_CREATED_TOPIC).toBe(
      keccak256(toBytes("InvoiceCreated(uint256,address,address,string,uint256)")),
    );

    const httpTrigger = handlers[1].trigger as unknown as { capabilityId(): string };
    expect(httpTrigger.capabilityId()).toBe("http-trigger@1.0.0-alpha");
  });
});

describe("HTTP trigger", () => {
  test("ACTIVE/ISSUED LEI => verified report written to LeiEscrow", () => {
    const { runtime, httpCalls, writes } = setup();
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "7", lei: BLOOMBERG }));

    expect(httpCalls).toEqual([`https://api.gleif.org/api/v1/lei-records/${BLOOMBERG}`]);
    expect(result).toMatchObject({
      invoiceId: "7",
      lei: BLOOMBERG,
      verified: true,
      entityStatus: "ACTIVE",
      registrationStatus: "ISSUED",
      legalName: "Bloomberg Finance L.P.",
      jurisdiction: "US-DE",
      nextRenewalDate: "2027-01-25T16:50:02Z",
      reasons: [],
      txStatus: "SUCCESS",
    });
    expect(result.txHash).toBe(`0x${"ab".repeat(32)}`);

    expect(writes).toHaveLength(1);
    expect(bytesToHex(writes[0].receiver)).toBe(ESCROW);
    expect(writes[0].gasConfig.gasLimit).toBe(500000n);
    const r = decodeWrittenReport(writes[0]);
    expect(r).toEqual({
      invoiceId: 7n,
      leiHash: keccak256(toBytes(BLOOMBERG)),
      verified: true,
      entityStatus: "ACTIVE",
      registrationStatus: "ISSUED",
      nextRenewalDate: BigInt(Date.parse("2027-01-25T16:50:02Z") / 1000),
      jurisdiction: "US-DE",
      legalNameHash: keccak256(toBytes("Bloomberg Finance L.P.")),
      checkedAt: BigInt(NOW_MS / 1000),
    });
    expect(runtime.getLogs().some((l) => l.includes("verified=true"))).toBe(true);
  });

  test("numeric invoiceId is accepted", () => {
    const { runtime, writes } = setup();
    onHttpRequest(runtime, httpPayload({ invoiceId: 3, lei: BLOOMBERG }));
    expect(decodeWrittenReport(writes[0]).invoiceId).toBe(3n);
  });

  test("LAPSED LEI => negative report", () => {
    const { runtime, writes } = setup();
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "2", lei: ENSCO_LAPSED }));
    expect(result.verified).toBe(false);
    expect(result.legalName).toBe("ENSCO PLC");
    expect(result.reasons).toContain("registration.status=LAPSED");
    const r = decodeWrittenReport(writes[0]);
    expect(r.verified).toBe(false);
    expect(r.registrationStatus).toBe("LAPSED");
    expect(r.jurisdiction).toBe("GB");
  });

  test("RETIRED / INACTIVE LEI => negative report", () => {
    const { runtime, writes } = setup();
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "4", lei: BOFA_RETIRED }));
    expect(result.verified).toBe(false);
    expect(decodeWrittenReport(writes[0])).toMatchObject({
      verified: false,
      entityStatus: "INACTIVE",
      registrationStatus: "RETIRED",
    });
  });

  test("unregistered LEI (GLEIF 404) => NOT_FOUND negative report", () => {
    const { runtime, writes } = setup();
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "5", lei: UNREGISTERED }));
    expect(result.verified).toBe(false);
    expect(result.entityStatus).toBe("NOT_FOUND");
    expect(decodeWrittenReport(writes[0])).toMatchObject({ verified: false, entityStatus: "NOT_FOUND", nextRenewalDate: 0n });
  });

  test("bad checksum => rejected locally, GLEIF is never called", () => {
    const { runtime, httpCalls, writes } = setup();
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "6", lei: "5493001KJTIIGC8Y1R13" }));
    expect(httpCalls).toHaveLength(0);
    expect(result.verified).toBe(false);
    expect(result.entityStatus).toBe("INVALID_LEI_FORMAT");
    expect(result.registrationStatus).toBe("CHECKSUM");
    const r = decodeWrittenReport(writes[0]);
    expect(r.verified).toBe(false);
    expect(r.leiHash).toBe(keccak256(toBytes("5493001KJTIIGC8Y1R13")));
  });

  test("GLEIF outage (HTTP 503) => execution fails and nothing is written", () => {
    const { runtime, writes } = setup({ httpStatusOverride: 503 });
    expect(() => onHttpRequest(runtime, httpPayload({ invoiceId: "8", lei: BLOOMBERG }))).toThrow(/503/);
    expect(writes).toHaveLength(0);
  });

  test("renewal date in the past (DON time) => not verified", () => {
    const { runtime, writes } = setup();
    runtime.setTimeProvider(() => Date.parse("2027-02-01T00:00:00Z"));
    const result = onHttpRequest(runtime, httpPayload({ invoiceId: "9", lei: BLOOMBERG }));
    expect(result.verified).toBe(false);
    expect(result.reasons[0]).toMatch(/nextRenewalDate=2027-01-25T16:50:02Z not in the future/);
    expect(decodeWrittenReport(writes[0]).verified).toBe(false);
  });

  test("malformed HTTP payload is rejected", () => {
    const { runtime, writes } = setup();
    expect(() => onHttpRequest(runtime, httpPayload({ lei: BLOOMBERG }))).toThrow();
    expect(() => onHttpRequest(runtime, httpPayload({ invoiceId: "-1", lei: BLOOMBERG }))).toThrow();
    expect(writes).toHaveLength(0);
  });
});

describe("EVM log trigger (InvoiceCreated)", () => {
  test("decodes id + LEI from the log and writes the report for that invoice", () => {
    const { runtime, httpCalls, writes } = setup();
    const result = onInvoiceCreated(runtime, invoiceCreatedLog(42n, BLOOMBERG, 1_000_000n));

    expect(httpCalls).toEqual([`https://api.gleif.org/api/v1/lei-records/${BLOOMBERG}`]);
    expect(result.invoiceId).toBe("42");
    expect(result.verified).toBe(true);
    const r = decodeWrittenReport(writes[0]);
    expect(r.invoiceId).toBe(42n);
    expect(r.leiHash).toBe(keccak256(toBytes(BLOOMBERG)));
    expect(runtime.getLogs().some((l) => l.includes("InvoiceCreated id=42"))).toBe(true);
  });

  test("lapsed LEI from the log => negative report", () => {
    const { runtime, writes } = setup();
    const result = onInvoiceCreated(runtime, invoiceCreatedLog(43n, ENSCO_LAPSED, 5n));
    expect(result.verified).toBe(false);
    expect(decodeWrittenReport(writes[0])).toMatchObject({ invoiceId: 43n, verified: false });
  });
});
