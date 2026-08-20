import path from "node:path";

export const CAFE_MODES = new Set(["dry", "draft", "publish"]);
export const APPROVED_CAFE_TARGET = Object.freeze({
  clubId: "26321967",
  menuId: "315",
});

export function normalizeCafePublisherConfig(config, rootDir) {
  const raw = config?.cafePublisher || {};
  const mode = raw.mode || "dry";
  if (!CAFE_MODES.has(mode)) throw new Error(`cafePublisher.mode must be dry, draft, or publish; got ${mode}.`);
  const imageCount = Number(raw.imageCount ?? 5);
  if (!Number.isInteger(imageCount) || imageCount <= 0) {
    throw new Error("cafePublisher.imageCount must be a positive integer.");
  }

  const resolveFromRoot = (value) => {
    if (!value) return null;
    return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
  };
  const expectedClubId = String(raw.expectedClubId || "");
  const expectedMenuId = String(raw.expectedMenuId || "");
  if (raw.enabled === true && (!expectedClubId || !expectedMenuId)) {
    throw new Error("Enabled Cafe publishing requires expectedClubId and expectedMenuId.");
  }
  if (raw.enabled === true && (
    expectedClubId !== APPROVED_CAFE_TARGET.clubId
    || expectedMenuId !== APPROVED_CAFE_TARGET.menuId
  )) {
    throw new Error(
      `Enabled Cafe publishing is pinned to club ${APPROVED_CAFE_TARGET.clubId}, menu ${APPROVED_CAFE_TARGET.menuId}.`,
    );
  }
  return {
    enabled: raw.enabled === true,
    mode,
    python: raw.python || "python",
    script: resolveFromRoot(raw.script),
    template: raw.template || "reference-5854",
    imageCount,
    notify: raw.notify === true,
    expectedClubId,
    expectedMenuId,
  };
}

export function buildPublisherArgs({ cafe, item, target, resultPath, videoFile = null }) {
  if (!cafe?.script) throw new Error("cafePublisher.script is required when the publisher is enabled.");
  if (!item?.uploadedUrl) throw new Error("Cafe publishing requires the verified unlisted replay URL.");
  if (!item?.title) throw new Error("Cafe publishing requires an explicit title.");
  if (!resultPath) throw new Error("Cafe publishing requires a machine-readable result path.");

  const args = [
    cafe.script,
    item.uploadedUrl,
    "--title", item.title,
    "--images", String(cafe.imageCount),
    "--template", cafe.template,
    "--result", resultPath,
    "--source-date", target.sourceDate,
    "--kind", target.kind,
    "--no-keywords",
    "--unattended",
  ];
  if (item.sourceUrl) args.push("--notebook-url", item.sourceUrl);
  if (videoFile) args.push("--video-file", videoFile);
  if (cafe.expectedClubId) args.push("--expected-club-id", cafe.expectedClubId);
  if (cafe.expectedMenuId) args.push("--expected-menu-id", cafe.expectedMenuId);
  if (cafe.mode === "dry") args.push("--dry");
  else if (cafe.mode === "draft") args.push("--draft");
  else {
    args.push("--publish");
    if (cafe.notify) args.push("--notify");
  }
  return args;
}

export function notificationComplete(notification) {
  return ["sent", "already-sent"].includes(notification?.status) && notification?.ok === true;
}

export function isCafeTerminal(state, cafe) {
  if (!state || state.mode !== cafe.mode) return false;
  if (cafe.mode === "dry") return state.status === "dry-run-complete" && state.ok === true;
  if (cafe.mode === "draft") return state.status === "draft-saved" && state.ok === true;
  if (state.status !== "published-verified" || state.ok !== true || state.verification?.ok !== true) return false;
  return !cafe.notify || notificationComplete(state.notification);
}

export function shouldCleanupReplay(state, cafe) {
  return cafe.mode === "publish" && isCafeTerminal(state, cafe);
}

export function stateFromPublisherResult({ target, cafe, item, result, resultPath, previous = null }) {
  return {
    sourceDate: target.sourceDate,
    kind: target.kind,
    mode: cafe.mode,
    ok: result?.ok === true,
    status: result?.status || "error",
    stage: result?.stage || "publisher",
    sourceVideoId: item?.sourceVideoId || null,
    uploadedUrl: item?.uploadedUrl || null,
    articleUrl: result?.articleUrl || previous?.articleUrl || null,
    verification: result?.verification || previous?.verification || null,
    notification: result?.notification || previous?.notification || null,
    previewPath: result?.previewPath || previous?.previewPath || null,
    framePaths: result?.framePaths || previous?.framePaths || [],
    publisherResultPath: resultPath,
    error: result?.error || null,
    updatedAt: new Date().toISOString(),
  };
}
