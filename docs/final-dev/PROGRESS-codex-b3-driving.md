# Codex B3 manual driving progress

IN PROGRESS: independent R-044 portion of B3, manual driving logs with kilometre readings,
destination and an ordered written stop list. Base be6fae7, branch codex/b3-driving-20261117.
Worktree C:/projects/.fw-codex-b3-driving. Founder authorised choosing safe unstarted work
on 17 November after the A3/A2 dependency assessment.

Claude remains orchestrator and reviewer. A2 and B2 worktrees are unchanged. No production,
credentials, merge, push or deployment. Do not claim full B3 complete: trip refinements,
imports, broader offline/retry work, assistant/payment/export work and native Android remain
outside this contribution. A3 waits for A2; later tasks were checked and have more dependencies.

Done: confirmed active A2 paths do not include driver/activity, driving helpers or driving
schema. Existing driving_sessions/events support start/arrive/depart/end and are retained.
Next: add manual itinerary and kilometre capture through checked atomic RPCs, preserving
existing APIs; bilingual UI and failure recovery; behavioural, mutation and browser checks;
report and precise Claude handoff. Existing baseline billing SQL failure stays with A2.
