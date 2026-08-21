import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeIncident,
  classifyRuntimeFailure,
  isAutoRepairableFailure,
  safeFailureMessage,
} from "../lib/runtime-health.mjs";

test("Prisma initialization failure is the only auto-repairable class", () => {
  const prismaError = new Error('@prisma/client did not initialize yet. Please run "prisma generate"');
  assert.equal(classifyRuntimeFailure(prismaError), "prisma-client-uninitialized");
  assert.equal(isAutoRepairableFailure(prismaError), true);
  assert.equal(isAutoRepairableFailure(new Error("invalid_grant")), false);
});

test("database and YouTube failures remain explicit non-repairable classes", () => {
  assert.equal(classifyRuntimeFailure(new Error("P1001: Can't reach database server")), "database-unreachable");
  assert.equal(classifyRuntimeFailure(new Error("invalid_grant")), "youtube-auth");
  assert.equal(classifyRuntimeFailure(new Error("Authorized YouTube channel mismatch")), "youtube-auth");
  assert.equal(classifyRuntimeFailure(new Error("unexpected")), "runtime-unknown");
});

test("failure messages redact database URLs and OAuth tokens", () => {
  const message = safeFailureMessage(new Error(
    "DATABASE_URL=postgresql://person:secret@db.example/test refresh_token=abc123",
  ));
  assert.equal(message.includes("person:secret"), false);
  assert.equal(message.includes("abc123"), false);
  assert.match(message, /REDACTED/);
});

test("incident records stage, commit, and bounded repair metadata", () => {
  const incident = buildRuntimeIncident({
    sourceDate: "2026-08-20",
    kind: "business",
    slot: "final",
    stage: "discovering",
    error: new Error("@prisma/client did not initialize yet"),
    commit: "abc123",
    autoRepairAttempted: true,
    occurredAt: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(incident.classification, "prisma-client-uninitialized");
  assert.equal(incident.autoRepairable, true);
  assert.equal(incident.autoRepairAttempted, true);
  assert.equal(incident.commit, "abc123");
});
