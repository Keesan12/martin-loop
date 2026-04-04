import { describe, expect, it } from "vitest";

import {
  createTelemetryEnvelope,
  validateTelemetryEnvelope
} from "../src/index.js";

describe("createTelemetryEnvelope", () => {
  it("builds a versioned envelope with source metadata and ordered events", () => {
    const envelope = createTelemetryEnvelope(
      {
        workspaceId: "ws_alpha",
        projectId: "proj_control_plane",
        ingestKeyId: "ing_123",
        environment: "production",
        source: {
          runtimeVersion: "0.1.0",
          adapterId: "codex-cli",
          provider: "openai",
          model: "gpt-5.4"
        },
        events: [
          {
            loopId: "loop_001",
            type: "run.started",
            lifecycleState: "running",
            payload: {
              note: "Loop started."
            }
          },
          {
            loopId: "loop_001",
            attemptId: "attempt_001",
            type: "attempt.started",
            lifecycleState: "running",
            payload: {
              model: "gpt-5.4"
            }
          }
        ]
      },
      {
        now: "2026-03-27T16:00:00.000Z",
        idFactory: (prefix) => `${prefix}_seed`
      }
    );

    expect(envelope.schemaVersion).toBe("martin.telemetry.v1");
    expect(envelope.envelopeId).toBe("env_seed");
    expect(envelope.sequence).toBe(2);
    expect(envelope.events[0]?.eventId).toBe("evt_seed");
    expect(envelope.events[0]?.sequence).toBe(1);
    expect(envelope.events[1]?.sequence).toBe(2);
  });
});

describe("validateTelemetryEnvelope", () => {
  it("rejects missing ingestion fields and non-monotonic event sequences", () => {
    const result = validateTelemetryEnvelope({
      schemaVersion: "",
      envelopeId: "env_bad",
      workspaceId: "ws_alpha",
      projectId: "proj_control_plane",
      ingestKeyId: "",
      environment: "production",
      emittedAt: "2026-03-27T16:00:00.000Z",
      sequence: 2,
      source: {
        runtimeVersion: "0.1.0",
        adapterId: "codex-cli",
        provider: "openai",
        model: "gpt-5.4"
      },
      events: [
        {
          eventId: "evt_1",
          loopId: "loop_001",
          type: "run.started",
          lifecycleState: "running",
          timestamp: "2026-03-27T16:00:00.000Z",
          sequence: 2,
          payload: {}
        },
        {
          eventId: "evt_2",
          loopId: "loop_001",
          type: "attempt.started",
          lifecycleState: "running",
          timestamp: "2026-03-27T16:00:01.000Z",
          sequence: 1,
          payload: {}
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "schemaVersion is required",
        "ingestKeyId is required",
        "events must use a strictly increasing sequence starting at 1"
      ])
    );
  });
});
