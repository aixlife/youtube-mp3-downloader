const COMPLETE_STATUS = "complete";

// cafe 인자를 안 주면 라이브 단계만 보던 기존 동작 그대로다.
function withCafe(base, cafe) {
  if (!cafe) return base;
  return { ...base, cafeStatus: cafe.status || "missing" };
}

export function monitorPlan(state, cafe = null) {
  const beforeStatus = state?.status || "missing";
  if (beforeStatus !== COMPLETE_STATUS) {
    return withCafe({
      action: "resume",
      beforeStatus,
      reason: beforeStatus === "missing" ? "state-missing" : `state-${beforeStatus}`,
    }, cafe);
  }
  // 라이브가 끝났어도 카페 단계가 남아 있으면 파이프라인을 이어서 돌린다.
  if (cafe && !cafe.terminal) {
    return withCafe({
      action: "resume",
      beforeStatus,
      reason: `cafe-${cafe.status || "missing"}`,
    }, cafe);
  }
  return withCafe({ action: "observe", beforeStatus, reason: "replay-complete" }, cafe);
}

export function monitorOutcome(state, attemptedResume = false, cafe = null) {
  const afterStatus = state?.status || "missing";
  if (afterStatus !== COMPLETE_STATUS) {
    return withCafe({
      ok: false,
      status: afterStatus.startsWith("waiting-") ? "waiting" : "error",
      afterStatus,
    }, cafe);
  }
  if (cafe && !cafe.terminal) {
    return withCafe({ ok: false, status: "cafe-pending", afterStatus }, cafe);
  }
  return withCafe({
    ok: true,
    status: attemptedResume ? "recovered" : "healthy",
    afterStatus,
  }, cafe);
}
