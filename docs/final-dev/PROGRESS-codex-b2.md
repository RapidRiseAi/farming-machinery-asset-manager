# Codex B2 progress

Task: B2, general staff chat. IN PROGRESS. Base be6fae7, branch codex/final-b2-chat-20261116.

Claude owns orchestration, integration and final review. Leave Claude's active A2 worker and lane worktrees untouched. No production credentials, migrations, push or deployment.

Requirements: R-048, R-087; BRIEF section 14, scenarios 19 and 34. Follow the original B2 task brief, with the founder's separate-worktree instruction overriding its lane path and Claude attribution.

Done: checked dependencies and reserved B2 in the manager's master log, queue and CODEX-B2-HANDOFF.md. A1/B1 are present. A2 changes account gate helpers; B2 will call, not replace them. A3 replaces the existing storage quota hook.

Done: new private chat schema and upload extension apply locally. Behavioural staff_chat.sql passes for readiness, membership, owner privacy, removed users, history after joining, idempotent send/finalise, attachments, edit/delete attribution and suspended writes. These are local checks, not real Supabase or Claude acceptance.

In progress: application API and bilingual UI. Existing job/partner discussions remain on work_request_events; staff chat is a new domain, not a replacement for them. Support reading requires an active recorded support visit. Postgres Changes sends only conversation updates through membership RLS; no message bodies are broadcast.

Next: database permissions and behavioural tests; application flows; attachment/realtime integration; full gates and self-review; final evidence and Claude integration instructions.

External verification: manager browser check and real Supabase Realtime/storage checks will be needed before enabling readiness. No claim of completion yet.
