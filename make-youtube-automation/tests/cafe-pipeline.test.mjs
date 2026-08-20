import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildPublisherArgs,
  isCafeTerminal,
  normalizeCafePublisherConfig,
  shouldCleanupReplay,
  stateFromPublisherResult,
} from "../lib/cafe-pipeline.mjs";

const rootDir = "/tmp/live-replay";
const target = { sourceDate: "2026-08-18", kind: "ai" };
const item = {
  sourceVideoId: "original123",
  sourceUrl: "https://youtu.be/original123",
  uploadedUrl: "https://youtu.be/replay123",
  title: "2026-08-18 새 강의",
};

test("publisher config is disabled and dry by default", () => {
  const config = normalizeCafePublisherConfig({}, rootDir);
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "dry");
  assert.equal(config.imageCount, 5);
});

test("enabled publisher fails closed without the approved board ids", () => {
  assert.throws(() => normalizeCafePublisherConfig({
    cafePublisher: { enabled: true, script: "publisher.py", mode: "dry" },
  }, rootDir), /expectedClubId and expectedMenuId/);
});

test("enabled publisher rejects a self-consistent but unapproved board", () => {
  assert.throws(() => normalizeCafePublisherConfig({
    cafePublisher: {
      enabled: true,
      expectedClubId: "111",
      expectedMenuId: "222",
    },
  }, rootDir), /pinned to club 26321967, menu 315/);
});

test("publisher uses the members-only live for the article link and replay for NotebookLM", () => {
  const cafe = normalizeCafePublisherConfig({
    cafePublisher: {
      enabled: true,
      script: "publisher/notebook_cafe_auto.py",
      mode: "dry",
      expectedClubId: "26321967",
      expectedMenuId: "315",
    },
  }, rootDir);
  const args = buildPublisherArgs({
    cafe, item, target, resultPath: "/tmp/result.json", videoFile: "/tmp/live.mp4",
  });
  assert.equal(args[0], path.resolve(rootDir, "publisher/notebook_cafe_auto.py"));
  assert.equal(args[1], item.sourceUrl);
  assert.equal(args[args.indexOf("--notebook-url") + 1], item.uploadedUrl);
  assert.ok(args.includes("--video-file"));
  assert.deepEqual(args.slice(args.indexOf("--expected-menu-id"), args.indexOf("--expected-menu-id") + 2), [
    "--expected-menu-id", "315",
  ]);
  assert.ok(args.includes("--dry"));
  assert.ok(!args.includes("--notify"));
});

test("publisher fails closed without the original members-only live URL", () => {
  const cafe = normalizeCafePublisherConfig({
    cafePublisher: {
      enabled: true,
      script: "publisher.py",
      mode: "dry",
      expectedClubId: "26321967",
      expectedMenuId: "315",
    },
  }, rootDir);
  assert.throws(() => buildPublisherArgs({
    cafe,
    item: { ...item, sourceUrl: "" },
    target,
    resultPath: "/tmp/result.json",
  }), /original members-only live URL/);
});

test("publish mode requests notification only when enabled", () => {
  const cafe = normalizeCafePublisherConfig({
    cafePublisher: {
      enabled: true,
      script: "publisher.py",
      mode: "publish",
      notify: true,
      expectedClubId: "26321967",
      expectedMenuId: "315",
    },
  }, rootDir);
  const args = buildPublisherArgs({ cafe, item, target, resultPath: "/tmp/result.json" });
  assert.ok(args.includes("--publish"));
  assert.ok(args.includes("--notify"));
  assert.ok(args.includes("--unattended"));
  assert.ok(args.includes("--no-keywords"));
});

test("dry result is terminal only for the same mode", () => {
  const dryState = { mode: "dry", ok: true, status: "dry-run-complete" };
  assert.equal(isCafeTerminal(dryState, { mode: "dry" }), true);
  assert.equal(isCafeTerminal({ mode: "dry", ok: true, status: "dry-run-complete" }, { mode: "publish" }), false);
  assert.equal(shouldCleanupReplay(dryState, { mode: "dry" }), false);
});

test("verified publish waits for Telegram before cleanup", () => {
  const cafe = { mode: "publish", notify: true };
  const pending = {
    mode: "publish", ok: true, status: "published-verified", verification: { ok: true },
  };
  assert.equal(isCafeTerminal(pending, cafe), false);
  assert.equal(shouldCleanupReplay(pending, cafe), false);
  const sent = { ...pending, notification: { ok: true, status: "sent" } };
  assert.equal(isCafeTerminal(sent, cafe), true);
  assert.equal(shouldCleanupReplay(sent, cafe), true);
  const unknown = { ...pending, ok: false, status: "published-verified-notification-unknown",
    notification: { ok: false, status: "unknown" } };
  assert.equal(isCafeTerminal(unknown, cafe), false);
});

test("state keeps known article URL when a notification retry fails", () => {
  const state = stateFromPublisherResult({
    target,
    cafe: { mode: "publish" },
    item,
    resultPath: "/tmp/result.json",
    previous: { articleUrl: "https://cafe.naver.com/old/1", verification: { ok: true } },
    result: { ok: false, status: "published-verified-notification-error", error: "network" },
  });
  assert.equal(state.articleUrl, "https://cafe.naver.com/old/1");
  assert.equal(state.sourceUrl, item.sourceUrl);
  assert.equal(state.verification.ok, true);
  assert.equal(state.error, "network");
});
