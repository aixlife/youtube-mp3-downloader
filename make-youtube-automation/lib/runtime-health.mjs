const PRISMA_UNINITIALIZED = /@prisma\/client did not initialize yet|generated Prisma Client was not found|Cannot find module ['"].*\.prisma[\\/]client/i;
const DATABASE_URL_MISSING = /Database URL is missing|DATABASE_URL.*(?:missing|not found)|Environment variable not found:\s*DATABASE_URL/i;
const DATABASE_UNREACHABLE = /P1001|Can't reach database server|ECONNREFUSED|ETIMEDOUT/i;
const YOUTUBE_AUTH = /invalid_grant|YouTube OAuth secrets are missing|Stored YouTube OAuth client is invalid|Authorized YouTube channel (?:was not found|mismatch)/i;

export function classifyRuntimeFailure(error) {
  const message = String(error?.message || error || "");
  if (PRISMA_UNINITIALIZED.test(message)) return "prisma-client-uninitialized";
  if (DATABASE_URL_MISSING.test(message)) return "database-credential-missing";
  if (DATABASE_UNREACHABLE.test(message)) return "database-unreachable";
  if (YOUTUBE_AUTH.test(message)) return "youtube-auth";
  return "runtime-unknown";
}

export function isAutoRepairableFailure(errorOrClassification) {
  const classification = typeof errorOrClassification === "string"
    ? errorOrClassification
    : classifyRuntimeFailure(errorOrClassification);
  return classification === "prisma-client-uninitialized";
}

export function safeFailureMessage(error, maxLength = 600) {
  return String(error?.message || error || "Unknown runtime failure")
    .replace(/(?:postgres|postgresql):\/\/[^\s'"<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(DATABASE_URL\s*[=:]\s*)[^\s'"<>]+/gi, "$1[REDACTED]")
    .replace(/(client_secret|refresh_token|access_token)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1$2[REDACTED]")
    .slice(0, maxLength);
}

export function buildRuntimeIncident({
  sourceDate = null,
  kind = null,
  slot = "manual",
  stage = "runtime-preflight",
  error,
  classification = classifyRuntimeFailure(error),
  commit = null,
  autoRepairAttempted = false,
  occurredAt = new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    status: "error",
    occurredAt,
    sourceDate,
    kind,
    slot,
    stage,
    classification,
    autoRepairable: isAutoRepairableFailure(classification),
    autoRepairAttempted: Boolean(autoRepairAttempted),
    commit,
    error: safeFailureMessage(error),
  };
}
