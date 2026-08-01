#!/bin/zsh
# 영상 인사이트 주간 회수 — 쌓인 노트를 "다시 꺼내 쓰는" 유일한 경로.
#
# 문제: 노트는 자동으로 쌓이는데(2026-08-02 기준 67개) 그날 데일리에서 한 번 보고 지나가면
#       다시 만날 길이 없다. 검색은 "찾을 게 있다는 걸 이미 알 때"만 작동한다.
# 해결: 매주 지난 노트의 '지금 제안'만 모아 3개로 추려 데일리에 밀어 넣는다.
#       민수는 67개를 다시 읽지 않고 3개만 본다.
#
# 부채 자동 정리: 14일 넘게 active인데 실행 로그가 비어 있는 노트는 status를 stale로 강등한다.
#       (삭제가 아니라 회수 대상에서 빼는 것 — 미해결 더미가 계속 쌓이면 회수 자체가 무의미해진다)
#
# 사용법: insight-weekly-review.sh [--days N] [--dry-run]
# 구조는 insight-processor.sh와 같다: headless claude는 읽기 전용, 파일 쓰기는 이 스크립트가 한다.

set -u
export LC_ALL=en_US.UTF-8

SELF_DIR="${0:a:h}"
VAULT="/Users/aixlife/Documents/creator-os-vault"
VIDEOS="$VAULT/insights/videos"
PACK="$VAULT/situation-pack.md"
REVIEW_DIR="$VIDEOS/_weekly"
LOG="$HOME/.plaud-insight/weekly-review.log"

DAYS=7
STALE_DAYS=14
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --stale-days) STALE_DAYS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$HOME/.plaud-insight" "$REVIEW_DIR"
TODAY=$(date +%F)

[ -d "$VIDEOS" ] || { echo "$(date +%F\ %T) SKIP no-videos-dir" >> "$LOG"; exit 1; }

# ---------- 1. 오래 방치된 active 노트를 stale로 강등 ----------
STALE_CUTOFF=$(date -v-${STALE_DAYS}d +%F 2>/dev/null || date -d "-${STALE_DAYS} days" +%F)
staled=0
for f in "$VIDEOS"/*.md(N); do
  base="${f:t}"
  notedate="${base[1,10]}"
  [[ "$notedate" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  [[ "$notedate" < "$STALE_CUTOFF" ]] || continue
  grep -q '^status: *active' "$f" || continue
  # 실행 로그에 실제 기록이 있으면 방치가 아니다 (플레이스홀더 줄은 기록으로 치지 않는다)
  if awk '/^## 실행 로그/{f=1;next} f && NF && !/아직 없음/ {found=1} END{exit !found}' "$f"; then
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] stale 강등: $base"
  else
    /usr/bin/sed -i '' 's/^status: *active.*$/status: stale   # 주간 회수에서 자동 강등 (미실행 방치)/' "$f"
  fi
  staled=$((staled + 1))
done

# ---------- 2. 회수 대상 수집 ----------
CUTOFF=$(date -v-${DAYS}d +%F 2>/dev/null || date -d "-${DAYS} days" +%F)
CANDIDATES=$(mktemp)
count=0
for f in "$VIDEOS"/*.md(N); do
  base="${f:t}"
  notedate="${base[1,10]}"
  [[ "$notedate" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  [[ "$notedate" > "$CUTOFF" || "$notedate" == "$CUTOFF" ]] || continue
  grep -q '^status: *active' "$f" || continue
  printf '%s\n' "$f" >> "$CANDIDATES"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "$(date +%F\ %T) SKIP no-candidates (stale=$staled, days=$DAYS)" >> "$LOG"
  echo "회수 대상 없음 (최근 ${DAYS}일 active 노트 0건, stale 강등 ${staled}건)"
  exit 0
fi

FILE_LIST=$(cat "$CANDIDATES")
rm -f "$CANDIDATES"

if [ "$DRY_RUN" = "1" ]; then
  echo "회수 대상 ${count}건 (stale 강등 예정 ${staled}건):"
  printf '%s\n' "$FILE_LIST" | sed 's|.*/||'
  exit 0
fi

# ---------- 3. 3개 추리기 (headless claude, 읽기 전용) ----------
PROMPT="너는 영상 인사이트 주간 회수 담당이다. 파일을 쓰지 마라 — 읽고 생성해서 출력만 하라.

민수는 매주 67개가 넘는 인사이트 노트를 다시 읽을 수 없다. 네 일은 지난 ${DAYS}일 노트에서
'이번 주에 실제로 손댈 만한 것' 딱 3개를 골라 주는 것이다.

1. 상황 팩을 읽어라: $PACK (이번 주 우선순위가 여기 있다)
2. 아래 노트들을 전부 읽고 각자의 '지금 제안' 섹션을 파악하라:
$FILE_LIST

3. 선정 기준 (순서대로 적용):
   - 상황 팩의 이번 주 우선순위와 직접 맞물리는 것이 최우선
   - 첫 단계를 오늘 10분 안에 시작할 수 있는 것
   - 서로 다른 자산(강의/회사/채널/제품/컨설팅)에 걸치도록 3개를 분산 — 같은 프로젝트로 3개 몰지 마라
   - 일반론이거나 지금 상황과 안 맞으면 과감히 버려라. 3개를 억지로 채우지 말고 2개여도 된다.

4. 출력 형식 (이 구조 외 다른 텍스트 금지):
INBOX: <데일리 노트 한 줄 요약 — 이번 주 회수 3건의 공통 방향>
---REVIEW---
<아래 형식의 노트 전문>

형식:
---
type: weekly-review
period: ${CUTOFF} ~ ${TODAY}
reviewed: ${count}
---

## 이번 주 집을 것 (최대 3)

### 1. <한 줄 제목>
- 출처: [[insights/videos/<파일명(확장자 제외)>]]
- 오늘 10분: <첫 단계 한 문장>
- 왜 지금: <상황 팩과 연결되는 이유 한 문장>

(2, 3도 같은 형식)

## 이번 주 넘긴 것
- <제목> — <넘긴 이유 한 줄> ([[링크]])
(간단히, 넘긴 노트 전부 한 줄씩)"

OUT=$(env -u ANTHROPIC_API_KEY claude -p "$PROMPT" \
  --model sonnet --add-dir "$VAULT" \
  --allowedTools "Read" --max-turns 15 2>>"$LOG")
RC=$?

INBOX=$(printf '%s\n' "$OUT" | grep -m1 '^INBOX:' | sed 's/^INBOX:[[:space:]]*//')
BODY=$(printf '%s\n' "$OUT" | sed -n '/^---REVIEW---$/,$p' | tail -n +2 | sed '/^```[a-z]*$/d')

if [ $RC -ne 0 ] || [ -z "$BODY" ]; then
  echo "$(date +%F\ %T) FAIL rc=$RC :: $(printf '%s' "$OUT" | tail -c 200)" >> "$LOG"
  exit 1
fi

DST="$REVIEW_DIR/${TODAY}-주간회수.md"
n=2; while [ -e "$DST" ]; do DST="$REVIEW_DIR/${TODAY}-주간회수-${n}.md"; n=$((n + 1)); done
if ! printf '%s\n' "$BODY" > "$DST" || [ ! -s "$DST" ]; then
  echo "$(date +%F\ %T) FAIL write $DST" >> "$LOG"
  exit 1
fi

# ---------- 4. 데일리 노트에 밀어 넣기 ----------
DAILY="$VAULT/daily/$TODAY.md"
[ -f "$DAILY" ] || printf '# %s\n\n' "$TODAY" > "$DAILY"
NOTE_REL="insights/videos/_weekly/$(basename "$DST" .md)"
{
  printf -- '- 영상 인사이트 주간 회수 (%d건 검토): %s → [[%s]]\n' "$count" "${INBOX:-이번 주 집을 것 정리}" "$NOTE_REL"
  # 데일리에서 바로 보이도록 선정 3건 제목만 들여쓴다 (파일을 열지 않아도 읽히게)
  printf '%s\n' "$BODY" | grep -E '^### [0-9]+\.' | sed 's/^### /    - /'
} >> "$DAILY"

echo "$(date +%F\ %T) OK $DST (검토 $count, stale $staled)" >> "$LOG"
echo "$DST"
