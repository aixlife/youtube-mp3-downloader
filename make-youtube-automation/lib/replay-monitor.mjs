const COMPLETE_STATUS = "complete";

export function monitorPlan(state) {
  const beforeStatus = state?.status || "missing";
  if (beforeStatus === COMPLETE_STATUS) {
    return {
      action: "observe",
      beforeStatus,
      reason: "replay-complete",
    };
  }
  return {
    action: "resume",
    beforeStatus,
    reason: beforeStatus === "missing" ? "state-missing" : `state-${beforeStatus}`,
  };
}

export function monitorOutcome(state, attemptedResume = false) {
  const afterStatus = state?.status || "missing";
  if (afterStatus === COMPLETE_STATUS) {
    return {
      ok: true,
      status: attemptedResume ? "recovered" : "healthy",
      afterStatus,
    };
  }
  return {
    ok: false,
    status: afterStatus.startsWith("waiting-") ? "waiting" : "error",
    afterStatus,
  };
}
