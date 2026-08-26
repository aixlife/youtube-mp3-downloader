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

test("completed replay with an unfinished Cafe stage is resumed, not observed", () => {
  const cafe = { status: "missing", terminal: false };
  assert.deepEqual(monitorPlan({ status: "complete" }, cafe), {
    action: "resume",
    beforeStatus: "complete",
    reason: "cafe-missing",
    cafeStatus: "missing",
  });
  assert.equal(monitorPlan({ status: "complete" }, { status: "error", terminal: false }).reason,
    "cafe-error");
});

test("completed replay with a terminal Cafe stage stays observed", () => {
  assert.deepEqual(monitorPlan({ status: "complete" }, { status: "published", terminal: true }), {
    action: "observe",
    beforeStatus: "complete",
    reason: "replay-complete",
    cafeStatus: "published",
  });
});

test("Cafe that never reached terminal is not reported as a healthy run", () => {
  const pending = monitorOutcome({ status: "complete" }, true, { status: "running", terminal: false });
  assert.equal(pending.ok, false);
  assert.equal(pending.status, "cafe-pending");
  assert.equal(pending.cafeStatus, "running");
  assert.equal(monitorOutcome({ status: "complete" }, true, { status: "published", terminal: true }).ok,
    true);
});

test("Cafe state never masks an incomplete replay", () => {
  const stuck = monitorOutcome({ status: "waiting-processing" }, true, { status: "published", terminal: true });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.status, "waiting");
});
