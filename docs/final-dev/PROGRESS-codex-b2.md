# Codex B2 progress

Task: B2, general staff chat. IN PROGRESS. Base be6fae7, branch codex/final-b2-chat-20261116.

Claude owns orchestration, integration and final review. Leave Claude's active A2 worker and lane worktrees untouched. No production credentials, migrations, push or deployment.

Requirements: R-048, R-087; BRIEF section 14, scenarios 19 and 34. Follow the original B2 task brief, with the founder's separate-worktree instruction overriding its lane path and Claude attribution.

Done: checked dependencies and reserved B2 in the manager's master log, queue and CODEX-B2-HANDOFF.md. A1/B1 are present. A2 changes account gate helpers; B2 will call, not replace them. A3 replaces the existing storage quota hook.

In progress: inventory existing conversation, membership, upload, notification, audit and support-access code.

Next: database permissions and behavioural tests; application flows; attachment/realtime integration; full gates and self-review; final evidence and Claude integration instructions.

External verification: manager browser check and real Supabase Realtime/storage checks will be needed before enabling readiness. No claim of completion yet.
