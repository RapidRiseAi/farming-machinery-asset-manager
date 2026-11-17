# Codex B3 manual driving progress

IMPLEMENTED LOCALLY, final checks and handoff in progress. Only R-044, not full B3.
Branch codex/b3-driving-20261117, base be6fae7, C:/projects/.fw-codex-b3-driving.
Manual kilometre readings, destination, ordered stops, atomic retries and tab-draft
recovery are implemented. Stale itinerary updates are refused and recoverable.
SQL, browser, mutation and unit checks pass; build/static checks pass. Full SQL has the
known billing_review_5.sql money-10 trial-anchor failure, owned by Claude/A2.
Next: final report/evidence, commit and external review queue. Claude remains orchestrator.
A2 and B2 trees are untouched. No production credentials, merge, push or deployment.
Other B3 scopes (trips/maps audit, imports, broader offline/retries, exports and native
Android) remain open. See REPORT-B3-DRIVING.md for the exact candidate scope.
