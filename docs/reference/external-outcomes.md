# External outcome verification

MartinLoop can verify that an agent-reported external action actually changed the independently observable state.

The v1 surface is deliberately narrow:

- JSON-over-HTTP read-back only.
- GET only. MartinLoop never submits, retries, cancels, rolls back, or mutates the external system.
- Operator-owned, versioned expectations.
- Exact identity, count, value, and optional freshness checks.
- One global deadline with at most four concurrent observations.
- `passed`, `failed`, and `unknown` remain distinct.
- Full redacted action evidence is written to the trusted run store; the signed verifier step retains its SHA-256 reference.
- Browser-only systems without an independent read-back source remain unverified.

## Standalone

```sh
martin outcomes verify --contract outcome-contract.json --json
```

A standalone pass prints `outcome checks passed`. It never emits a governed `VERIFIED` claim.

For local/private staging endpoints, add `--allow-local`. Remote endpoints require HTTPS by default.

## Governed external-side-effect run

External writes are high-risk because retrying a failed observation can duplicate the real-world action. MartinLoop therefore requires one worker attempt:

```sh
martin run "Submit the staging change" \
  --execution-profile staging_controlled \
  --allow-network-domain staging.example.com \
  --approve-external-writes \
  --max-iterations 1 \
  --verify "martin outcomes verify --contract outcome-contract.json --json"
```

Before worker execution MartinLoop:

1. validates the contract and network authority,
2. hashes the canonical operator contract,
3. copies an immutable snapshot into the trusted run store,
4. rewrites the verifier to use that snapshot and expected hash, and
5. denies the original repo contract path when it is inside the worker workspace.

The verifier reads only external state. A failed or unknown outcome cannot cause MartinLoop to submit the external action again.

## Contract v1

```json
{
  "schemaVersion": "external-outcome/1",
  "contractId": "booking-save",
  "allowedOrigins": ["https://staging.example.com"],
  "deadlineMs": 5000,
  "pollIntervalMs": 500,
  "requestTimeoutMs": 1500,
  "actions": [{
    "actionId": "booking-001",
    "claimedDone": true,
    "source": {
      "url": "https://staging.example.com/api/bookings/by-request/known-request-nonce",
      "authEnv": "BOOKING_READ_TOKEN"
    },
    "recordPointer": "/records",
    "identity": {
      "pointer": "/requestNonce",
      "equals": "known-request-nonce"
    },
    "expectedCount": 1,
    "assertions": [
      { "pointer": "/tenantId", "equals": "tenant-test" },
      { "pointer": "/status", "equals": "confirmed" },
      { "pointer": "/guests", "equals": 2 }
    ]
  }]
}
```

`recordPointer` may select an array of records or, when `expectedCount` is exactly one, a single object.

JSON Pointer follows RFC 6901. Equality is type-sensitive. There is no JSONPath, regex, JavaScript, or shell expression evaluation.

## Result semantics

- `passed`: every required observation and assertion passed.
- `failed`: external state was successfully observed and contradicted the claim, or the required state never appeared by the deadline.
- `unknown`: MartinLoop could not reliably determine the business outcome because of auth, transport, malformed/schema-invalid response, timeout, redirect, or cancellation.

Aggregate JSON includes:

- `claimedDone`
- `checked`
- `passed`
- `failed`
- `unknown`
- `rejectedClaimRate = failed / claimedDone`
- `unknownClaimRate = unknown / claimedDone`
- `coverage = checked / claimedDone`

Do not interpret a fixture's injected miss ratio as a customer or production failure rate.

## CiteOps design-partner acceptance

The private CiteOps app already exposes a reversible staging workflow with an independently readable persisted record:

- writer: `PATCH /api/brands/[id]`
- reader: `GET /api/brands/[id]`

The resource ID is known before execution, so it can be frozen into the operator contract.

Use a dedicated staging brand and first record its baseline `description` and `category`. Choose a unique marker such as `martinloop-outcome-<nonce>`. The worker changes only staging fields through the existing PATCH route.

The read-back contract should use the existing GET route:

```json
{
  "schemaVersion": "external-outcome/1",
  "contractId": "citeops-brand-update",
  "allowedOrigins": ["http://127.0.0.1:3200"],
  "deadlineMs": 5000,
  "pollIntervalMs": 250,
  "requestTimeoutMs": 1000,
  "actions": [{
    "actionId": "citeops-brand-marker",
    "claimedDone": true,
    "source": {
      "url": "http://127.0.0.1:3200/api/brands/REPLACE_WITH_STAGING_BRAND_UUID"
    },
    "recordPointer": "",
    "identity": {
      "pointer": "/id",
      "equals": "REPLACE_WITH_STAGING_BRAND_UUID"
    },
    "expectedCount": 1,
    "assertions": [
      {
        "pointer": "/description",
        "equals": "REPLACE_WITH_UNIQUE_POST_UPDATE_MARKER"
      },
      {
        "pointer": "/category",
        "equals": "REPLACE_WITH_EXPECTED_STAGING_CATEGORY"
      }
    ],
    "freshness": {
      "pointer": "/description",
      "notEquals": "REPLACE_WITH_CAPTURED_BASELINE_DESCRIPTION"
    }
  }]
}
```

This JSON is an example, not an executable template. Replace every placeholder before the run and let MartinLoop freeze the resulting contract.

For a local CiteOps staging app, use `--allow-local` on the nested outcome command and `--allow-network-domain 127.0.0.1` on the governed run. Do not run this against production.

After acceptance, manually restore the staging brand's original values. MartinLoop does not perform external rollback in v1.

Retain:

- CiteOps commit SHA,
- staging brand ID,
- baseline values,
- expected marker,
- MartinLoop run ID,
- outcome evidence SHA,
- redacted receipt,
- confirmation that no second PATCH occurred.

Do not call CiteOps staging verified until that actual integration has run.

## Security boundary

The checker rejects arbitrary external writes, redirects, URL credentials, and non-allowlisted origins. Remote DNS is resolved once and the HTTP connection is pinned to the vetted address; private/link-local/metadata/reserved targets are blocked unless local/staging access is explicitly enabled.

Bearer tokens are loaded only from a named environment variable. Token values, authorization headers, response payloads, full source paths, and assertion values are not copied into the outcome evidence artifact.

The operator owns expectations. A malicious worker that shares unrestricted host filesystem/process authority outside MartinLoop's isolation boundary is not made safe by this feature.
