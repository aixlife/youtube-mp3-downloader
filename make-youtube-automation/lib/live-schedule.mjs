const KST_TIME_ZONE = "Asia/Seoul";

function kstDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function previousDate(dateString, days = 1) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function scheduledTarget(now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: KST_TIME_ZONE,
    weekday: "short"
  }).format(now);
  const today = kstDateString(now);

  if (weekday === "Wed") return { sourceDate: previousDate(today), kind: "ai" };
  if (weekday === "Fri") return { sourceDate: previousDate(today), kind: "business" };
  throw new Error(`No live replay schedule for KST ${weekday}. Expected Wednesday or Friday.`);
}

export function courseForKind(kind) {
  if (kind === "ai") {
    return {
      courseTitle: "라이브 다시보기 - AI",
      courseCategory: "라이브 다시보기",
      courseIsFree: false,
      createCourseIfMissing: false
    };
  }
  if (kind === "business") {
    return {
      courseTitle: "라이브 다시보기 - 비즈니스",
      courseCategory: "라이브 다시보기",
      courseIsFree: false,
      courseSortOrder: 25,
      createCourseIfMissing: true
    };
  }
  throw new Error(`Unknown live kind: ${kind}`);
}

export function selectLiveForDate(videos, sourceDate) {
  const candidates = videos
    .filter((video) => {
      const startedAt = video.liveStreamingDetails?.actualStartTime;
      return startedAt && kstDateString(new Date(startedAt)) === sourceDate;
    })
    .sort((a, b) => String(b.liveStreamingDetails.actualStartTime).localeCompare(String(a.liveStreamingDetails.actualStartTime)));

  return {
    selected: candidates[0] || null,
    candidates
  };
}

export function manifestItemForLive(video, sourceDate, kind) {
  if (!video?.id) throw new Error("Cannot create a manifest item without a YouTube video id.");
  const originalTitle = video.snippet?.title || `Live ${sourceDate}`;
  const title = originalTitle.startsWith(`${sourceDate} `) ? originalTitle : `${sourceDate} ${originalTitle}`;
  return {
    sourceDate,
    sourceVideoId: video.id,
    sourceUrl: `https://youtu.be/${video.id}`,
    ...courseForKind(kind),
    title,
    description: video.snippet?.description || "",
    privacyStatus: "unlisted",
    copyThumbnail: true,
    notifySubscribers: false
  };
}

export function mergeResumableManifestItem(existing, fresh) {
  if (!existing) return fresh;
  if (existing.sourceVideoId && existing.sourceVideoId !== fresh.sourceVideoId) {
    throw new Error(`Existing manifest source ${existing.sourceVideoId} does not match ${fresh.sourceVideoId}.`);
  }
  return {
    ...fresh,
    ...existing,
    sourceDate: fresh.sourceDate,
    sourceVideoId: fresh.sourceVideoId,
    sourceUrl: fresh.sourceUrl,
    courseTitle: fresh.courseTitle,
    courseCategory: fresh.courseCategory,
    courseIsFree: fresh.courseIsFree,
    createCourseIfMissing: fresh.createCourseIfMissing,
    ...(fresh.courseSortOrder == null ? {} : { courseSortOrder: fresh.courseSortOrder }),
    privacyStatus: "unlisted",
    notifySubscribers: false
  };
}

export function lessonMatchesTarget(lesson, sourceDate, expectedTitle = null) {
  if (!lesson?.youtubeUrl) return false;
  return lesson.title === expectedTitle || lesson.title?.startsWith(`${sourceDate} `) === true;
}

