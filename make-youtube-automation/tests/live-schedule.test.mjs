import test from "node:test";
import assert from "node:assert/strict";
import {
  courseForKind,
  lessonMatchesTarget,
  manifestItemForLive,
  mergeResumableManifestItem,
  scheduledTarget,
  selectLiveForDate
} from "../lib/live-schedule.mjs";

test("Wednesday KST schedules the previous Tuesday AI live", () => {
  assert.deepEqual(scheduledTarget(new Date("2026-07-15T01:00:00Z")), {
    sourceDate: "2026-07-14",
    kind: "ai"
  });
});

test("Friday KST schedules the previous Thursday business live", () => {
  assert.deepEqual(scheduledTarget(new Date("2026-07-17T01:00:00Z")), {
    sourceDate: "2026-07-16",
    kind: "business"
  });
});

test("business course can be created but AI course must already exist", () => {
  assert.equal(courseForKind("ai").createCourseIfMissing, false);
  assert.equal(courseForKind("business").createCourseIfMissing, true);
  assert.equal(courseForKind("business").courseTitle, "라이브 다시보기 - 비즈니스");
});

test("selectLiveForDate uses KST and picks the latest matching start", () => {
  const early = { id: "early", liveStreamingDetails: { actualStartTime: "2026-07-14T10:00:00Z" } };
  const late = { id: "late", liveStreamingDetails: { actualStartTime: "2026-07-14T12:00:00Z" } };
  const other = { id: "other", liveStreamingDetails: { actualStartTime: "2026-07-13T12:00:00Z" } };
  const result = selectLiveForDate([early, other, late], "2026-07-14");
  assert.equal(result.selected.id, "late");
  assert.deepEqual(result.candidates.map((video) => video.id), ["late", "early"]);
});

test("manifest resume preserves upload recovery fields and safety settings", () => {
  const fresh = manifestItemForLive({
    id: "source123",
    snippet: { title: "수업 제목", description: "설명" }
  }, "2026-07-14", "ai");
  const merged = mergeResumableManifestItem({
    ...fresh,
    filePath: "downloads/source.mp4",
    uploadedUrl: "https://youtu.be/new123",
    videoId: "new123",
    privacyStatus: "public",
    notifySubscribers: true
  }, fresh);
  assert.equal(merged.filePath, "downloads/source.mp4");
  assert.equal(merged.uploadedUrl, "https://youtu.be/new123");
  assert.equal(merged.privacyStatus, "unlisted");
  assert.equal(merged.notifySubscribers, false);
});

test("date-prefixed registered lesson prevents duplicate upload", () => {
  assert.equal(lessonMatchesTarget({
    title: "2026-07-14 기존 제목",
    youtubeUrl: "https://youtu.be/existing"
  }, "2026-07-14", "2026-07-14 새 제목"), true);
  assert.equal(lessonMatchesTarget({
    title: "2026-07-14 기존 제목",
    youtubeUrl: null
  }, "2026-07-14", "2026-07-14 새 제목"), false);
});

