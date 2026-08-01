// 자동 분할 업로드된 파트별 PLAUD transcript를 하나로 병합한다.
//
// 이 모듈이 없으면 6시간짜리 영상이 파트별 transcript 2개로 남고,
// 인사이트 후처리기가 앞뒤 반쪽씩만 읽어 반쪽짜리 노트를 만든다.
//
// PLAUD transcript 형식: `[MM:SS - MM:SS] Speaker N: 내용` (1시간 넘으면 H:MM:SS)
// 파트별 타임스탬프는 각자 0부터 시작하므로 원본 영상 기준으로 오프셋을 더해 보정한다.

const fs = require('fs');

// PLAUD는 1시간을 넘겨도 H:MM:SS로 바꾸지 않고 분을 계속 늘려 쓴다 (3시간짜리 파트 → `186:50`).
// 분 자리를 2자리로 제한하면 100분 이후 줄이 통째로 매칭에 실패해 보정 없이 지나간다.
// (2026-08-02 6시간 실사용에서 파트당 약 86분 분량이 미보정으로 남아 발견)
const LINE_RE = /^\[(\d+:\d{2}(?::\d{2})?)\s*-\s*(\d+:\d{2}(?::\d{2})?)\]\s*(.*)$/;

function parseTimestamp(str) {
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function formatTimestamp(totalSeconds, withHours) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return withHours ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// 한 파트의 본문을 오프셋만큼 밀어 반환. 타임스탬프가 없는 줄은 그대로 보존한다.
function shiftPart(text, offsetSec, withHours) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const m = line.match(LINE_RE);
    if (!m) {
      out.push(line);
      continue;
    }
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) {
      out.push(line);
      continue;
    }
    out.push(`[${formatTimestamp(start + offsetSec, withHours)} - ${formatTimestamp(end + offsetSec, withHours)}] ${m[3]}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param parts [{ path, offsetSec, endSec, partNum }]
 * @param outPath 병합 결과 경로
 * @param options { title, totalSeconds }
 */
function mergeTranscripts(parts, outPath, options = {}) {
  const usable = parts.filter((p) => p && p.path && fs.existsSync(p.path));
  if (!usable.length) throw new Error('병합할 transcript 파일이 없습니다.');

  const totalSeconds = options.totalSeconds
    || usable.reduce((max, p) => Math.max(max, p.endSec || 0), 0);
  const withHours = totalSeconds >= 3600;
  const totalParts = options.totalParts || usable.length;

  const header = [
    `# ${options.title || 'PLAUD transcript'}`,
    `# PLAUD 5시간 업로드 한계로 ${totalParts}개 파트로 나눠 올린 뒤 시간순으로 병합한 전사입니다.`,
    '# 타임스탬프는 원본 영상 기준으로 보정되어 있습니다.',
    '# 주의: 화자 분석은 파트별로 독립 수행되므로 같은 Speaker 번호라도 파트가 다르면 다른 사람일 수 있습니다.',
    '',
  ];

  const body = [];
  for (const part of usable) {
    const text = fs.readFileSync(part.path, 'utf8');
    const shifted = shiftPart(text, part.offsetSec || 0, withHours);
    const range = `${formatTimestamp(part.offsetSec || 0, withHours)} ~ ${formatTimestamp(part.endSec || 0, withHours)}`;
    body.push(`--- 파트 ${part.partNum}/${totalParts} (${range}) ---`);
    body.push(shifted);
    body.push('');
  }

  const merged = `${header.join('\n')}\n${body.join('\n').trim()}\n`;
  fs.writeFileSync(outPath, merged, 'utf8');
  return outPath;
}

module.exports = {
  mergeTranscripts,
  shiftPart,
  parseTimestamp,
  formatTimestamp,
};
