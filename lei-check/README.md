# lei-check (CRE workflow)

Verifies a payee's LEI against the GLEIF API and writes a signed verification report to `LeiEscrow`.
See the project [README](../README.md) for the full picture.

```bash
bun install
bun test                  # 32 unit tests (CRE SDK test runtime + HTTP/EVM mocks)
bun run typecheck         # workflow sources
bun run typecheck:tests   # incl. tests
bun run compile           # -> dist/lei-check.wasm

# from the project root, after `cre login`:
cre workflow simulate lei-check --target staging-settings --non-interactive --trigger-index 1 \
  --http-payload '{"invoiceId":"1","lei":"5493001KJTIIGC8Y1R12"}'
```

Triggers: `0` = EVM log `InvoiceCreated` on `escrowAddress`, `1` = HTTP `{"invoiceId","lei"}`.
