# meeting-end

Run the MakeFamily meeting-end workflow.

1. Execute `./회의끝` from the repository root. It should attempt existing PLAUD transcript/note export automatically.
2. If PLAUD profile/list status fails, run `./회의끝 --open-plaud-login`, let the user confirm login/workspace, then rerun `./회의끝`.
3. Read the generated `meeting-runs/YYYY-MM-DD/agent-brief.md` and `run-report.json`.
4. Continue the workflow from that brief, including Notion weekly toggle/subpage review.
5. Preserve team-written notes as source material; only draft the `회의끝 정리본` summary layer.
6. Do not write to Notion until the user approves the draft.
7. If headless PLAUD cannot see the meeting, use the visible fallback for existing exports. Do not trigger paid or credit-consuming PLAUD generation without explicit user approval.
