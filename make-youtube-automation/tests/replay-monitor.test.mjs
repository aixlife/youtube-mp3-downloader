import test from "node:test";
import assert from "node:assert/strict";
import { monitorOutcome, monitorPlan } from "../lib/replay-monitor.mjs";

test("completed replay is observed without another runner pass", () => {
  assert.deepEqual(monitorPlan({ status: "complete" }), {
    action: "observe",
    beforeStatus: "complete",
    reason: "replay-complete",
  });
  assert.deepEqual(monitorOutcome({ status: "complete" }, false), {
    ok: true,
    status: "healthy",
    afterStatus: "complete",
  });
});

test("missing, waiting, and error states receive one bounded resume pass", () => {
  assert.equal(monitorPlan(null).action, "resume");
  assert.equal(monitorPlan({ status: "waiting-processing" }).action, "resume");
  assert.equal(monitorPlan({ status: "error" }).action, "resume");
});

test("monitor distinguishes recovery from remaining incomplete state", () => {
  assert.equal(monitorOutcome({ status: "complete" }, true).status, "recovered");
  assert.deepEqual(monitorOutcome({ status: "waiting-processing" }, true), {
    ok: false,
    status: "waiting",
    afterStatus: "waiting-processing",
  });
  assert.equal(monitorOutcome({ status: "error" }, true).ok, false);
});
