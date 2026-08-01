#!/bin/zsh
# 인사이트 제안을 닫는다 — 실행했든 기각했든 "결론이 났다"고 기록하는 유일한 경로.
#
# 왜 필요한가: 2026-08-02 점검에서 노트 67개의 실행 로그가 전부 플레이스홀더였다.
# 실행도 기각도 기록되지 않으면 (1) 판례가 안 쌓이고 (2) 전부 미해결로 남아 회수가 무의미해진다.
# 기각은 실패가 아니다. 닫히지 않은 채 쌓이는 것이 문제다.
#
# 사용법:
#   insight-close.sh <노트 검색어> 실행함 [메모]
#   insight-close.sh <노트 검색어> 기각   [메모]
#   insight-close.sh <노트 검색어> 보류   [메모]
#
# 검색어는 파일명 일부면 된다 (예: "쇼핑쇼츠"). 여러 개 걸리면 목록만 보여주고 멈춘다.

set -u
export LC_ALL=en_US.UTF-8

VAULT="/Users/aixlife/Documents/creator-os-vault"
VIDEOS="$VAULT/insights/videos"

if [ $# -lt 2 ]; then
  echo "사용법: $0 <노트 검색어> <실행함|기각|보류> [메모]" >&2
  exit 2
fi

QUERY="$1"
RESULT="$2"
MEMO="${3:-}"
TODAY=$(date +%F)

case "$RESULT" in
  실행함|기각|보류) ;;
  *) echo "결과는 실행함 / 기각 / 보류 중 하나여야 합니다: $RESULT" >&2; exit 2 ;;
esac

matches=()
for f in "$VIDEOS"/**/*.md(N); do
  [[ "${f:t}" == *"$QUERY"* ]] && matches+=("$f")
done

if [ ${#matches[@]} -eq 0 ]; then
  echo "'$QUERY'와 맞는 노트를 찾지 못했습니다." >&2
  exit 1
fi

if [ ${#matches[@]} -gt 1 ]; then
  echo "여러 노트가 걸렸습니다. 검색어를 좁혀주세요:" >&2
  printf '  %s\n' "${matches[@]:t}" >&2
  exit 1
fi

NOTE="${matches[1]}"

# 실행 로그에 한 줄 추가 — 플레이스홀더 줄은 첫 기록이 들어올 때 치운다
python3 - "$NOTE" "$TODAY" "$RESULT" "$MEMO" <<'PY'
import io, re, sys

note, today, result, memo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = io.open(note, encoding='utf-8').read()

entry = f"- {today} · {result}" + (f" · {memo}" if memo else "")

if '## 실행 로그' in text:
    head, _, tail = text.partition('## 실행 로그')
    lines = tail.split('\n')
    kept = [l for l in lines if '아직 없음' not in l]
    body = '\n'.join(kept).rstrip()
    text = f"{head}## 실행 로그{body}\n{entry}\n"
else:
    text = text.rstrip() + f"\n\n## 실행 로그\n{entry}\n"

# 실행함/기각은 닫고, 보류는 열어둔다
new_status = 'active' if result == '보류' else 'done'
if re.search(r'^status: *\S+', text, flags=re.M):
    text = re.sub(r'^status: *\S+.*$', f'status: {new_status}', text, count=1, flags=re.M)

io.open(note, 'w', encoding='utf-8').write(text)
print(f"{note}\n  → {entry}\n  → status: {new_status}")
PY
