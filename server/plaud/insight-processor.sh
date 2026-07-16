#!/bin/zsh
# PLAUD 전사 → Obsidian 인사이트 노트 후처리기
# 사용법: insight-processor.sh <transcript-path> <title> [plaud-id]
# 구조: headless claude는 읽기 전용(Read)으로 노트 본문만 생성 → 파일 쓰기는 이 스크립트가
#       고정 경로에 직접 수행 (무인 Write 에이전트 금지 — 2026-07-16 권한 분류기 지적 반영)
# ANTHROPIC_API_KEY 종량 과금 방지 위해 env -u 필수 (구독 인증 사용).
set -u
SELF_DIR="${0:a:h}"
VAULT="/Users/aixlife/Documents/creator-os-vault"
RULES="$SELF_DIR/insight-rules.md"
PACK="$VAULT/situation-pack.md"
LOG="$HOME/.plaud-insight/processor.log"
mkdir -p "$HOME/.plaud-insight" "$VAULT/insights/videos/unsorted"

SRC="${1:?transcript path}"
TITLE="${2:?title}"
PLAUD_ID="${3:-unknown}"
TODAY=$(date +%F)

[ -s "$SRC" ] || { echo "$(date +%F\ %T) SKIP no-transcript $TITLE" >> "$LOG"; exit 1; }
[ -s "$RULES" ] || { echo "$(date +%F\ %T) SKIP no-rules" >> "$LOG"; exit 1; }

PROMPT="너는 PLAUD 영상 인사이트 후처리기다. 파일을 쓰지 마라 — 읽고 생성해서 출력만 하라.
1. 규칙 파일 전체를 읽어라: $RULES
2. 상황 팩을 읽어라: $PACK (없으면 규칙 파일 1절의 대체 경로)
3. 전사를 읽어라: $SRC (제목: \"$TITLE\", PLAUD id: $PLAUD_ID)
4. 규칙의 노트 포맷·적용 제안 생성 규칙(1액션+1질문, 대기 제안 2-3, 일반론 금지, 확신도 게이트)을 정확히 따라 노트 전문을 생성하라.
5. 출력 형식 (이 구조 외 다른 텍스트 금지):
SLUG: <파일명용 한글-하이픈 슬러그 40자 이내>
INBOX: <데일리 노트용 제안 요약 한 줄>
---NOTE---
<frontmatter 포함 노트 전문>"

OUT=$(env -u ANTHROPIC_API_KEY claude -p "$PROMPT" \
  --model sonnet --add-dir "$SELF_DIR" --add-dir "$VAULT" --add-dir "$(dirname "$SRC")" \
  --allowedTools "Read" --max-turns 12 2>>"$LOG")
RC=$?

SLUG=$(printf '%s\n' "$OUT" | grep -m1 '^SLUG:' | sed 's/^SLUG:[[:space:]]*//' | tr -cd 'a-zA-Z0-9가-힣-' | cut -c1-40)
INBOX=$(printf '%s\n' "$OUT" | grep -m1 '^INBOX:' | sed 's/^INBOX:[[:space:]]*//')
NOTE_BODY=$(printf '%s\n' "$OUT" | sed -n '/^---NOTE---$/,$p' | tail -n +2 | sed '/^```[a-z]*$/d')

if [ $RC -ne 0 ] || [ -z "$SLUG" ] || [ -z "$NOTE_BODY" ]; then
  echo "$(date +%F\ %T) FAIL rc=$RC $TITLE :: $(printf '%s' "$OUT" | tail -c 200)" >> "$LOG"
  exit 1
fi

# 확신도 '하'면 unsorted/로 (frontmatter confidence 필드 기준)
SUBDIR=""
printf '%s' "$NOTE_BODY" | grep -q '^confidence: *하' && SUBDIR="unsorted/"
DST="$VAULT/insights/videos/${SUBDIR}${TODAY}-${SLUG}.md"
n=2; while [ -e "$DST" ]; do DST="$VAULT/insights/videos/${SUBDIR}${TODAY}-${SLUG}-${n}.md"; n=$((n+1)); done
printf '%s\n' "$NOTE_BODY" > "$DST"

# 데일리 노트 인박스 한 줄 (없으면 생성). 소급 배치는 PLAUD_INSIGHT_NO_DAILY=1로 스킵 (도배 방지)
if [ "${PLAUD_INSIGHT_NO_DAILY:-0}" != "1" ]; then
  DAILY="$VAULT/daily/$TODAY.md"
  [ -f "$DAILY" ] || printf '# %s\n\n' "$TODAY" > "$DAILY"
  NOTE_REL="insights/videos/${SUBDIR}$(basename "$DST" .md)"
  printf -- '- 영상 인사이트: %s → [[%s]]\n' "${INBOX:-$TITLE}" "$NOTE_REL" >> "$DAILY"
fi

echo "$(date +%F\ %T) OK $DST" >> "$LOG"
echo "$DST"
