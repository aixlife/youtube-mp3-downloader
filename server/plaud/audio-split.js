// PLAUD 업로드 한계(길이 5시간 / 용량 500MB) 대응 모듈.
//
// 두 한계는 성격이 다르다:
//   - 길이 초과 → 압축으로 못 넘는다. 시간 축 분할만이 답. 자르기는 -c copy(스트림 복사)라 음질 손실 0.
//   - 용량 초과 → 모노 재인코딩으로 넘긴다. 재인코딩이므로 손실은 있으나 전사(STT) 품질에는 영향 없다
//     (STT 엔진은 어차피 모노로 다운믹스해서 처리한다).
//
// 분할 지점은 균등 분할 지점 ±window 안에서 가장 긴 무음을 찾아 그 중앙으로 잡는다.
// 말 중간에서 잘리면 그 문장이 양쪽 파트 모두에서 깨지기 때문이다.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SILENCE_NOISE_DB = process.env.PLAUD_SILENCE_NOISE_DB || '-30dB';
const SILENCE_MIN_DURATION = process.env.PLAUD_SILENCE_MIN_DURATION || '0.4';

function runFfmpeg(bin, args, { collectStderr = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    if (collectStderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`${bin} 실패 (code ${code}): ${stderr.slice(-400)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// 실제 파일 길이(초). yt-dlp가 보고하는 영상 길이와 다운로드된 오디오 길이는 어긋날 수 있으므로
// 분할 계획은 항상 실제 파일 기준으로 세운다.
async function probeDuration(filePath) {
  const { stdout } = await runFfmpeg('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`오디오 길이를 읽지 못했습니다: ${path.basename(filePath)}`);
  }
  return seconds;
}

function parseSilenceRanges(stderr) {
  // silencedetect 출력:
  //   [silencedetect @ ..] silence_start: 12.345
  //   [silencedetect @ ..] silence_end: 13.456 | silence_duration: 1.111
  const ranges = [];
  let pendingStart = null;

  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch && pendingStart !== null) {
      const end = parseFloat(endMatch[1]);
      const start = Math.max(0, pendingStart);
      if (end > start) ranges.push({ start, end, duration: end - start });
      pendingStart = null;
    }
  }
  return ranges;
}

// targetSec 근처(±windowSec)에서 가장 긴 무음의 중앙을 반환한다.
// 무음이 없으면 targetSec을 그대로 돌려준다 (균등 분할 폴백).
async function findSilenceCut(filePath, targetSec, windowSec, totalSeconds) {
  const winStart = Math.max(0, targetSec - windowSec);
  const winEnd = Math.min(totalSeconds, targetSec + windowSec);
  const winLen = winEnd - winStart;
  if (winLen <= 1) return { cutSec: targetSec, method: 'even' };

  let stderr;
  try {
    // -ss/-t 를 -i 앞에 둬서 입력 시킹(빠름). 이때 필터가 보는 타임스탬프는 창 시작을 0으로 하는 상대값이다.
    ({ stderr } = await runFfmpeg('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-ss', String(winStart),
      '-t', String(winLen),
      '-i', filePath,
      '-af', `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_DURATION}`,
      '-f', 'null',
      '-',
    ]));
  } catch (err) {
    console.warn(`[plaud-split] 무음 탐지 실패, 균등 분할로 진행: ${err.message}`);
    return { cutSec: targetSec, method: 'even' };
  }

  const ranges = parseSilenceRanges(stderr);
  if (!ranges.length) return { cutSec: targetSec, method: 'even' };

  const longest = ranges.reduce((a, b) => (b.duration > a.duration ? b : a));
  const relativeMid = longest.start + longest.duration / 2;
  const cutSec = winStart + relativeMid;

  // 창 밖으로 벗어나면 신뢰하지 않는다 (상대/절대 타임스탬프 해석이 어긋난 경우 방어)
  if (cutSec <= winStart || cutSec >= winEnd) {
    return { cutSec: targetSec, method: 'even' };
  }
  return { cutSec, method: 'silence', silenceDuration: longest.duration };
}

// 분할 계획: 파트당 maxPartSeconds 이하가 되도록 균등 분할한 뒤, 각 경계를 무음 지점으로 당긴다.
async function planSplitPoints(filePath, totalSeconds, maxPartSeconds, options = {}) {
  const windowSec = options.windowSec ?? 90;
  const partCount = Math.max(2, Math.ceil(totalSeconds / maxPartSeconds));
  const evenSpan = totalSeconds / partCount;

  const marks = [0];
  for (let i = 1; i < partCount; i++) {
    const target = evenSpan * i;
    const { cutSec, method, silenceDuration } = await findSilenceCut(filePath, target, windowSec, totalSeconds);
    // 경계는 반드시 증가해야 하고, 앞 경계보다 최소 1초는 뒤여야 한다
    const safeCut = Math.max(marks[marks.length - 1] + 1, Math.min(cutSec, totalSeconds - 1));
    marks.push(safeCut);
    const drift = Math.round(safeCut - target);
    console.log(
      `[plaud-split] 경계 ${i}/${partCount - 1}: ${Math.round(safeCut)}s ` +
      `(${method}${method === 'silence' ? ` ${silenceDuration.toFixed(1)}s 무음` : ''}, 균등지점 대비 ${drift >= 0 ? '+' : ''}${drift}s)`
    );
    if (options.onBoundary) options.onBoundary(i, partCount - 1);
  }
  marks.push(totalSeconds);
  return { partCount, marks };
}

// -c copy 로 자른다. 재인코딩이 없으므로 음질 손실 0이고 거의 즉시 끝난다.
async function cutSegment(filePath, startSec, endSec, outPath) {
  const duration = endSec - startSec;
  if (duration <= 0) throw new Error(`잘못된 분할 구간: ${startSec}s-${endSec}s`);

  await runFfmpeg('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-ss', String(startSec),
    '-i', filePath,
    '-t', String(duration),
    '-c', 'copy',
    '-y',
    outPath,
  ]);

  if (!fs.existsSync(outPath)) throw new Error(`분할 파일 생성 실패: ${path.basename(outPath)}`);
  return outPath;
}

// 용량 초과 시에만 쓴다. 모노 다운믹스 + 저비트레이트 AAC.
// 재인코딩이라 손실은 있으나 전사 품질에는 영향이 없다. 샘플레이트는 호환성을 위해 원본을 유지한다.
async function compressToMono(inPath, outPath, bitrateK) {
  await runFfmpeg('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i', inPath,
    '-vn',
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', `${bitrateK}k`,
    '-movflags', '+faststart',
    '-y',
    outPath,
  ]);

  if (!fs.existsSync(outPath)) throw new Error(`압축 파일 생성 실패: ${path.basename(outPath)}`);
  return outPath;
}

module.exports = {
  probeDuration,
  planSplitPoints,
  cutSegment,
  compressToMono,
  findSilenceCut,
  parseSilenceRanges,
};
