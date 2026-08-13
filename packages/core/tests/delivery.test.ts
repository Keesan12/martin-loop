import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import {
  isCooldownExpired,
  isDismissed,
  isNewerVersion,
  loadDeliveryRecord,
  parseMessageSelectionResponse,
  recordDismissed,
  recordShown,
  saveDeliveryRecord,
} from "../src/delivery/index.js";
import type { DeliveryMessage } from "@martin/contracts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_MESSAGE: DeliveryMessage = {
  schemaVersion: "delivery-message/1",
  id: "msg-001",
  revision: 1,
  kind: "update",
  title: "New version available",
  body: "martin-loop 0.5.0 is out.",
  action: { type: "upgrade_cli", targetVersion: "0.5.0" },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  cooldownHours: 24,
};

const VALID_RESPONSE = JSON.stringify({
  schemaVersion: "martin-message-selection/1",
  message: VALID_MESSAGE,
});

const EMPTY_RESPONSE = JSON.stringify({
  schemaVersion: "martin-message-selection/1",
});

// ─── Schema validation ────────────────────────────────────────────────────────

describe("parseMessageSelectionResponse", () => {
  it("accepts a valid message", () => {
    const r = parseMessageSelectionResponse(VALID_RESPONSE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.message?.id, "msg-001");
  });

  it("accepts an empty (no-message) response", () => {
    const r = parseMessageSelectionResponse(EMPTY_RESPONSE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.message, undefined);
  });

  it("rejects unknown action type — must not render or execute", () => {
    const bad = JSON.stringify({
      schemaVersion: "martin-message-selection/1",
      message: { ...VALID_MESSAGE, action: { type: "run_arbitrary_command" } },
    });
    const r = parseMessageSelectionResponse(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "schema_unknown_action_type");
  });

  it("rejects unknown message kind", () => {
    const bad = JSON.stringify({
      schemaVersion: "martin-message-selection/1",
      message: { ...VALID_MESSAGE, kind: "upsell" },
    });
    const r = parseMessageSelectionResponse(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "schema_unknown_kind");
  });

  it("rejects malformed JSON", () => {
    const r = parseMessageSelectionResponse("{bad");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "schema_malformed");
  });

  it("rejects response exceeding size ceiling", () => {
    const big = JSON.stringify({
      schemaVersion: "martin-message-selection/1",
      message: { ...VALID_MESSAGE, body: "x".repeat(9_000) },
    });
    const r = parseMessageSelectionResponse(big);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "schema_response_too_large");
  });

  it("rejects non-HTTPS URL", () => {
    const bad = JSON.stringify({
      schemaVersion: "martin-message-selection/1",
      message: { ...VALID_MESSAGE, action: { type: "open_release_notes", url: "http://example.com" } },
    });
    const r = parseMessageSelectionResponse(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "schema_url_not_https");
  });

  it("accepts valid HTTPS URL", () => {
    const good = JSON.stringify({
      schemaVersion: "martin-message-selection/1",
      message: { ...VALID_MESSAGE, action: { type: "open_release_notes", url: "https://martinloop.com/changelog" } },
    });
    const r = parseMessageSelectionResponse(good);
    assert.equal(r.ok, true);
  });
});

// ─── Cooldown and dismissal ───────────────────────────────────────────────────

describe("cooldown", () => {
  it("no cooldown set → expired", () => {
    const rec = loadDeliveryRecord("/nonexistent/path.json");
    assert.equal(isCooldownExpired(rec, Date.now()), true);
  });

  it("cooldown in future → not expired", () => {
    const nowMs = Date.now();
    let rec = loadDeliveryRecord("/nonexistent/path.json");
    rec = recordShown(rec, VALID_MESSAGE, nowMs);
    assert.equal(isCooldownExpired(rec, nowMs + 1_000), false);
  });

  it("cooldown elapsed → expired", () => {
    const nowMs = Date.now();
    let rec = loadDeliveryRecord("/nonexistent/path.json");
    rec = recordShown(rec, VALID_MESSAGE, nowMs - 25 * 3600 * 1000); // shown 25h ago
    assert.equal(isCooldownExpired(rec, nowMs), true);
  });

  it("clock skew: now < lastShown → treats cooldown as expired", () => {
    const nowMs = Date.now();
    let rec = loadDeliveryRecord("/nonexistent/path.json");
    rec = recordShown(rec, VALID_MESSAGE, nowMs + 60_000); // future lastShown
    // now is in the past relative to lastShown → expired
    assert.equal(isCooldownExpired(rec, nowMs), true);
  });
});

describe("dismissal", () => {
  it("not dismissed by default", () => {
    const rec = loadDeliveryRecord("/nonexistent/path.json");
    assert.equal(isDismissed(rec, "msg-001"), false);
  });

  it("dismissed after recordDismissed", () => {
    let rec = loadDeliveryRecord("/nonexistent/path.json");
    rec = recordDismissed(rec, "msg-001");
    assert.equal(isDismissed(rec, "msg-001"), true);
  });

  it("double dismiss is idempotent", () => {
    let rec = loadDeliveryRecord("/nonexistent/path.json");
    rec = recordDismissed(rec, "msg-001");
    rec = recordDismissed(rec, "msg-001");
    assert.equal(rec.dismissedIds.filter((id) => id === "msg-001").length, 1);
  });
});

// ─── Ledger atomic write ──────────────────────────────────────────────────────

describe("saveDeliveryRecord / loadDeliveryRecord", () => {
  it("round-trips through disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "martin-dlv-test-"));
    const ledgerPath = path.join(dir, "delivery-record.json");
    let rec = loadDeliveryRecord(ledgerPath);
    rec = recordDismissed(rec, "msg-xyz");
    saveDeliveryRecord(ledgerPath, rec);
    const loaded = loadDeliveryRecord(ledgerPath);
    assert.deepEqual(loaded.dismissedIds, ["msg-xyz"]);
    fs.rmSync(dir, { recursive: true });
  });

  it("two-process ledger write leaves no corruption (sequential)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "martin-dlv-concurrent-"));
    const ledgerPath = path.join(dir, "delivery-record.json");
    let rec = loadDeliveryRecord(ledgerPath);
    rec = recordDismissed(rec, "a");
    saveDeliveryRecord(ledgerPath, rec);

    let rec2 = loadDeliveryRecord(ledgerPath);
    rec2 = recordDismissed(rec2, "b");
    saveDeliveryRecord(ledgerPath, rec2);

    const final = loadDeliveryRecord(ledgerPath);
    assert.equal(final.dismissedIds.includes("a"), true);
    assert.equal(final.dismissedIds.includes("b"), true);
    fs.rmSync(dir, { recursive: true });
  });

  it("corrupted ledger file returns empty record without throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "martin-dlv-corrupt-"));
    const ledgerPath = path.join(dir, "delivery-record.json");
    fs.writeFileSync(ledgerPath, "NOT JSON", "utf8");
    const rec = loadDeliveryRecord(ledgerPath);
    assert.deepEqual(rec.dismissedIds, []);
    fs.rmSync(dir, { recursive: true });
  });
});

// ─── Version check ────────────────────────────────────────────────────────────

describe("isNewerVersion", () => {
  it("detects newer patch", () => assert.equal(isNewerVersion("0.4.5", "0.4.6"), true));
  it("detects newer minor", () => assert.equal(isNewerVersion("0.4.5", "0.5.0"), true));
  it("detects newer major", () => assert.equal(isNewerVersion("0.4.5", "1.0.0"), true));
  it("same version is not newer", () => assert.equal(isNewerVersion("0.4.5", "0.4.5"), false));
  it("older is not newer", () => assert.equal(isNewerVersion("0.5.0", "0.4.9"), false));
  it("prerelease not shown to stable user", () => assert.equal(isNewerVersion("0.4.5", "0.5.0-beta.1"), false));
  it("prerelease shown to prerelease user", () => assert.equal(isNewerVersion("0.5.0-alpha.1", "0.5.0-beta.1"), true));
  // SemVer-correct numeric prerelease ordering
  it("beta.2 → beta.10 is an update", () => assert.equal(isNewerVersion("0.5.0-beta.2", "0.5.0-beta.10"), true));
  it("beta.10 → beta.2 is not an update", () => assert.equal(isNewerVersion("0.5.0-beta.10", "0.5.0-beta.2"), false));
  it("beta → beta.1 is an update (more identifiers = higher precedence)", () => assert.equal(isNewerVersion("0.5.0-beta", "0.5.0-beta.1"), true));
  it("prerelease → stable is an update", () => assert.equal(isNewerVersion("0.5.0-beta.1", "0.5.0"), true));
  it("stable → prerelease is blocked", () => assert.equal(isNewerVersion("0.5.0", "0.6.0-beta.1"), false));
  it("build metadata does not affect precedence", () => assert.equal(isNewerVersion("0.5.0-beta.1+build.1", "0.5.0-beta.1+build.2"), false));
  it("invalid numeric prerelease with leading zero is rejected", () => assert.equal(isNewerVersion("0.5.0-beta.01", "0.5.0-beta.2"), false));
});
