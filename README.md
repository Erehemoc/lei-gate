# LEI Gate — payments released only to verified legal entities

**LEI Gate** is a Chainlink CRE (Chainlink Runtime Environment) project for the *"Best workflow with CRE"* bounty.
A payer puts an invoice payment into an on-chain escrow on **Ethereum Sepolia**. The money can only go to the payee
once a **CRE workflow** has checked the payee's **Legal Entity Identifier (LEI, ISO 17442)** against the official
**GLEIF** registry (`api.gleif.org`, free, no API key) and written a **DON-signed report** to the contract.

* Blockchain: Ethereum Sepolia (EVM log trigger + EVM `writeReport`)
* External API: GLEIF LEI records API, called with the CRE HTTP capability and node consensus
* Demo: `cre workflow simulate lei-check --target staging-settings` (HTTP trigger works with no deployment)

## Why this is legal tech

Before a company pays a counterparty it has to know *who* it is paying: **KYB (Know Your Business)** and
counterparty due diligence. The LEI is the global, regulator-backed identifier for legal entities
(used under MiFID II/MiFIR, EMIR, Dodd-Frank, and the FSB/G20 framework). Each LEI record states whether the
entity still exists (`entity.status`) and whether its reference data is kept current (`registration.status`, `nextRenewalDate`).

LEI Gate writes that compliance rule into the payment contract itself:

> Release funds only if the payee's LEI is **ACTIVE** (the entity exists), **ISSUED** (the record is maintained),
> and **not past its renewal date**. Otherwise the payer can take the money back.

So a payment can't go to a dissolved company (`INACTIVE`/`RETIRED`), to an entity whose reference data has
lapsed (`LAPSED`), or to an identifier that doesn't exist or is mistyped. The check comes from a
decentralized oracle network rather than one trusted server, and the evidence (statuses, jurisdiction, hash of the
legal name, time of the check) is kept on-chain for audit.

## Architecture

```
  Payer                                      Ethereum Sepolia
  ─────                                      ────────────────────────────────────────────
  create(payee, lei, amount) ───────────────▶ LeiEscrow (holds ETH or ERC-20)
                                              │  emit InvoiceCreated(id, payer, payee, lei, amount)
                                              │
              ┌───────────────────────────────┘  (EVM log trigger)
              ▼
  ┌──────────────────────── CRE workflow "lei-check" (TypeScript → WASM) ────────────────────┐
  │  trigger 0: EVM log InvoiceCreated      trigger 1: HTTP {"invoiceId","lei"} (manual/demo)  │
  │       │                                        │                                         │
  │       └──────────────┬─────────────────────────┘                                         │
  │                      ▼                                                                   │
  │  1. ISO 17442 check: 20 chars [0-9A-Z]{18}[0-9]{2}, MOD 97-10 == 1 ── invalid ─┐          │
  │                      ▼ valid                                                 │          │
  │  2. HTTP capability (every node): GET api.gleif.org/api/v1/lei-records/{LEI}  │          │
  │     extract {found, lei, legalName, entityStatus, registrationStatus,         │          │
  │              nextRenewalDate, jurisdiction}                                   │          │
  │     consensus: ConsensusAggregationByFields(identical per field)              │          │
  │     404 → NOT_FOUND (negative)   5xx → execution fails, nothing written      │          │
  │                      ▼                                                       ▼          │
  │  3. verified = ACTIVE && ISSUED && nextRenewalDate > runtime.now()                       │
  │  4. report = abi.encode(invoiceId, keccak(lei), verified, entityStatus,                  │
  │              registrationStatus, nextRenewalDate, jurisdiction, keccak(legalName),        │
  │              checkedAt)  → runtime.report() (DON-signed) → EVMClient.writeReport()        │
  └──────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                 ▼
                                Keystone forwarder ──▶ LeiEscrow.onReport(metadata, report)
                                                         • msg.sender must be the forwarder
                                                         • optional: workflowOwner in metadata must match
                                                         • invoice must be Pending
                                                         • keccak(lei) must match the invoice's LEI
                                                         • checkedAt must not be older than the stored check
                                                         ▼
   release(id)  (anyone; pays the payee)  ← only if verified && now < nextRenewalDate
   refund(id)   (payer only)              ← only if NOT verified && now ≥ createdAt + refundTimeout
```

## Repository layout

```
lei-gate/
├── project.yaml              # CRE project settings (staging/production → Sepolia RPC), in `cre init` format
├── secrets.yaml              # no secrets are needed (GLEIF is public)
├── .env.example              # copy to .env (CRE_ETH_PRIVATE_KEY; the placeholder works for dry-run simulation)
├── payloads/                 # ready-made HTTP trigger payloads (--http-payload ./payloads/…)
├── scripts/gleif-live-check.ts   # runs the workflow's parsing/decision code against the live GLEIF API
├── lei-check/                # the CRE workflow
│   ├── workflow.yaml         # CRE workflow settings (`cre init` format)
│   ├── main.ts               # triggers, GLEIF fetch + consensus, report + writeReport
│   ├── src/lei.ts            # ISO 17442 / ISO 7064 MOD 97-10 validation
│   ├── src/gleif.ts          # GLEIF JSON parsing + verification rule (pure, reusable)
│   ├── src/report.ts, abi.ts # ABI encoding of the report and the LeiEscrow ABI
│   ├── config.staging.json / config.production.json
│   ├── *.test.ts             # bun tests (CRE SDK test runtime + HTTP/EVM capability mocks)
│   └── test/fixtures/        # real GLEIF responses (captured 2026-10-23)
└── contracts/                # Foundry project (no external libs needed)
    ├── src/LeiEscrow.sol     # escrow + IReceiver (CRE consumer)
    ├── src/interfaces/       # IReceiver, IERC165, IERC20
    ├── test/LeiEscrow.t.sol  # 20 forge tests
    └── script/DeployLeiEscrow.s.sol
```

## Contract: `LeiEscrow`

| Function | Who | What |
|---|---|---|
| `constructor(forwarder, token, refundTimeout)` | deployer | `token = 0x0` → native ETH escrow, otherwise that ERC-20 |
| `create(payee, lei, amount)` | payer | locks funds (send `msg.value == amount` for ETH, or `approve` first for ERC-20), emits `InvoiceCreated` |
| `onReport(metadata, report)` | Keystone forwarder only | stores `verified`, `entityStatus`, `registrationStatus`, `nextRenewalDate`, `jurisdiction`, `legalNameHash`, `checkedAt` |
| `release(id)` | anyone | pays the **payee**; only if verified and `now < nextRenewalDate` |
| `refund(id)` | payer | after `refundTimeout`, only if not verified |
| `getInvoice`, `getVerification`, `isReleasable` | view | |
| `setForwarder`, `setExpectedWorkflowOwner`, `transferOwnership` | owner | admin |

It uses the standard CRE consumer interface `IReceiver.onReport(bytes metadata, bytes report)` with ERC-165
`supportsInterface`, which the Keystone forwarder checks before delivering a report. The metadata is
`workflowId (32) | workflowName (10) | workflowOwner (20) | reportId (2)`.

## Test results (run locally, no login needed)

| Check | Command | Result |
|---|---|---|
| Workflow unit tests (CRE SDK `@chainlink/cre-sdk/test`: `newTestRuntime`, `HttpActionsMock`, `EvmMock` + `addContractMock`) | `cd lei-check && bun test` | **32 pass, 0 fail** (96 `expect()` calls, 4 files) |
| Workflow typecheck | `bun run typecheck` | OK |
| Typecheck incl. tests | `bun run typecheck:tests` | OK |
| Compile to WASM (`cre-compile`, also runs the SDK's runtime-compat check) | `bun run compile` | OK, `dist/lei-check.wasm` ≈ 2.7 MB |
| Contract tests (Foundry 1.7.1, solc 0.8.26) | `cd contracts && forge test` | **20 passed, 0 failed** |
| Deploy script dry run (in-memory, nothing sent) | `forge script script/DeployLeiEscrow.s.sol` | OK |
| Live GLEIF sanity check (same parser + rule, real API) | `bun scripts/gleif-live-check.ts` | 5/5 as expected (see below) |
| `project.yaml` + `workflow.yaml` parsed by the CRE CLI's own settings loader (`internal/settings.New`, Go test run in a scratch copy of the CLI source) | — | both targets load: `lei-check-staging`, `./main.ts`, Sepolia RPC |

What the tests cover:

* **Workflow (bun):** LEI checksum (valid, wrong check digits, single-character substitutions, length, charset);
  GLEIF parsing of real ACTIVE/ISSUED, ACTIVE/LAPSED and INACTIVE/RETIRED records; the decision rule
  (renewal date passed, missing, pending statuses); HTTP trigger end-to-end (positive, lapsed, retired, 404,
  bad checksum never calls GLEIF, 503 writes nothing, renewal date passed in DON time, malformed payload);
  EVM log trigger decoding `InvoiceCreated`; the trigger set-up (log filter address/topic, HTTP trigger);
  checking the ABI of the written report, receiver and gas limit; a fixture shared with the Solidity test.
* **Contract (forge):** ERC-165; `create` and its input checks; **only the forwarder can call onReport**;
  workflow-owner check; LEI-hash mismatch, unknown invoice and stale reports are rejected; **release only if
  verified**, release blocked when lapsed or after the renewal date, a newer negative report takes back a
  verification; **refund path** (too early, not payer, success, double refund, no report at all, blocked once
  verified); ERC-20 create/release/refund; and decoding the exact bytes produced by the TypeScript encoder.

### Live GLEIF check (2026-10-23)

```
OK   5493001KJTIIGC8Y1R12 http=200 verified=true  entity=ACTIVE   registration=ISSUED  renewal=2027-01-25T16:50:02Z jurisdiction=US-DE name="Bloomberg Finance L.P."
OK   7N0UJMJLXD0MDT5D5086 http=200 verified=false entity=ACTIVE   registration=LAPSED  renewal=2015-10-14T18:11:00Z jurisdiction=GB    name="ENSCO PLC"
OK   EYKN6V0ZCB8VD9IULB80 http=200 verified=false entity=INACTIVE registration=RETIRED renewal=2020-09-12T14:33:00Z jurisdiction=GB    name="BANK OF AMERICA MERRILL LYNCH INTERNATIONAL LIMITED"
OK   LEIGATE0000000000073 http=404 verified=false entity=NOT_FOUND (checksum-valid but unregistered)
OK   5493001KJTIIGC8Y1R13 http=-   verified=false entity=INVALID_LEI_FORMAT registration=CHECKSUM (no API call)
```

The negative LEIs were found with GLEIF filters, e.g.
`/api/v1/lei-records?filter[registration.status]=LAPSED&filter[entity.legalAddress.country]=GB&sort=registration.initialRegistrationDate`
and `filter[registration.status]=RETIRED`.

## Simulation results (`cre workflow simulate`, CRE CLI v1.39.0, 2026-10-24)

Real runs in the CRE simulator: live HTTP call to GLEIF, node consensus, signed report, dry-run write
through the Sepolia forwarder. Full logs are in [`simulation-logs/`](simulation-logs/).

| Payload | LEI | GLEIF result | Decision | Report write |
|---|---|---|---|---|
| `http-active.json` | 5493001KJTIIGC8Y1R12 | Bloomberg Finance L.P., ACTIVE / ISSUED, renews 2027-01-25 | **verified** | SUCCESS (dry run) |
| `http-lapsed.json` | 7N0UJMJLXD0MDT5D5086 | LAPSED, renewal date 2015-10-14 | not verified | SUCCESS (dry run) |
| `http-retired.json` | EYKN6V0ZCB8VD9IULB80 | INACTIVE / RETIRED | not verified | SUCCESS (dry run) |
| `http-bad-checksum.json` | 5493001KJTIIGC8Y1R13 | not queried (checksum fails locally) | not verified | SUCCESS (dry run) |

## How to simulate

Requirements: [bun](https://bun.sh) ≥ 1.2.21, CRE CLI ≥ 1.39, a CRE account (`cre login`).

```bash
cd lei-gate
cp .env.example .env                 # the placeholder key is fine for a dry run (no --broadcast)
(cd lei-check && bun install)
cre login

# 1) HTTP trigger (index 1) — works right away, no contract needed. The write is a dry run.
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 1 \
  --http-payload '{"invoiceId":"1","lei":"5493001KJTIIGC8Y1R12"}'

# negative cases
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 1 --http-payload ./payloads/http-lapsed.json
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 1 --http-payload ./payloads/http-retired.json
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 1 --http-payload ./payloads/http-bad-checksum.json

# interactive (pick the trigger from a menu)
cre workflow simulate lei-check --target staging-settings
```

Expected log for the positive case: `GLEIF 5493001KJTIIGC8Y1R12: found=true name="Bloomberg Finance L.P." entity=ACTIVE registration=ISSUED …`,
then `Invoice 1: verified=true`, then a `writeReport …` line. The handler returns a JSON summary.

### Full on-chain flow (optional, needs Sepolia test ETH; not done in this repo)

```bash
cd contracts
# FORWARDER defaults to 0x15fC6ae953E024d975e77382eEeC56A9101f9F88, the Sepolia forwarder used by `cre workflow simulate --broadcast`
forge script script/DeployLeiEscrow.s.sol --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key $PK --broadcast
# put the deployed address into lei-check/config.staging.json → "escrowAddress"
cast send <ESCROW> "create(address,string,uint256)" <PAYEE> 5493001KJTIIGC8Y1R12 1000000000000000 --value 1000000000000000 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key $PK
# EVM log trigger (index 0): replay the create() tx. For an ETH escrow InvoiceCreated is log 0
# (for an ERC-20 escrow the Transfer log comes first → use --evm-event-index 1)
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 0 \
  --evm-tx-hash <CREATE_TX_HASH> --evm-event-index 0 --broadcast
cast send <ESCROW> "release(uint256)" 1 --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key $PK
```

The HTTP trigger with `--broadcast` also works against a deployed escrow: the `invoiceId` must exist and the
`lei` must be the one the invoice was created with, or `onReport` reverts with `LeiMismatch`.

## Limits / what isn't verified here

* No contract was deployed, so the EVM log-trigger path was only tested with mocks. `escrowAddress` in the config is
  `0x000…000` until you deploy. With that placeholder the HTTP-trigger simulation does a dry-run write.
* The HTTP trigger has an empty config (`authorizedKeys: []`). That's fine for simulation, but a deployed workflow
  should add authorized signer keys.
* The Keystone forwarder checks the DON signatures. The contract trusts the forwarder and can also pin the workflow
  owner (`setExpectedWorkflowOwner`). Pinning the workflow ID/name is not implemented.
* GLEIF data is a snapshot. `release()` re-checks `nextRenewalDate` on-chain, but a status change *after* the check
  only takes effect when a new report arrives (re-trigger the HTTP trigger, or add a cron trigger).
* The LEI proves the payee **entity exists in good standing**. It doesn't prove that the payee **address** belongs to
  that entity. That binding (e.g. vLEI / ISO 17442-3 credentials, or a signed attestation) is the natural next step.
* GLEIF outages: a non-2xx response other than 404 fails the run without writing a false negative.
* Foundry lint shows warnings about `block.timestamp` comparisons and `uint64` casts. Both are intentional, because the timescales here are days.

## Credits

Built with an AI coding agent (Claude Code) for a legal-tech hackathon. Uses `@chainlink/cre-sdk` 1.23.0,
viem, zod and Foundry. GLEIF data © GLEIF, available under CC0.

License: MIT (see `LICENSE`).
