# REPORT B5: custom asset fields, import review, document reading and manual questions

Lane B, branch `final/lane-b`, 19 November 2026, from `3b552e8`. Built by the main Claude session (the founder ended subagents on 19 Nov). BRIEF section 17 ("Custom fields", "Document extraction and structured import", "Manuals/document questions", "Other old roadmap entries"); scenario 44. Nothing was pushed, merged, applied to a live database or released by this work.

Gates at the final code commit: see section 8.

## 1. Done

Three migrations, all additive, each with a probe in `scripts/apply_pending.mjs`, a suite in `supabase/tests/run.sh` and a `docs/DATABASE.md` line.

| Part | What was built | Migration and suite |
|---|---|---|
| Custom asset fields (Professional and Complete) | A business defines typed fields: text, number with a unit, date, yes/no, choice. Each field has a visibility (everyone or managers), a group, an order and a required setting. Renaming or retiring a field keeps every value; a retired field takes no new values and can come back. `/settings/fields`; a card and dialog on the asset page; columns headed `field:<key>` in the machine CSV import, with skipped values reported; both tables in the business export. The fields carry no billing or engine effect, and equipment may use them. Labels refuse markup; values are data in typed columns. | `20261121100000`, `custom_asset_fields.sql` |
| Import review (every plan) | A readings sheet (CSV) is staged, not written. Every problem is named on its row: unknown or ambiguous asset; invalid, future or conflicting date; not a reading; unit not this meter's; lower than the meter; already recorded; twice in the file; any value the reader was below 0.8 sure of. Nothing is guessed: dates are day-first or ISO, never month-first. A row with a problem is accepted only with the person's own value for the doubtful field. In the review dialog that field starts empty, and the database refuses an accept that leaves it out. Bulk accept takes only rows with no problem. Writing re-checks each row and writes it once; a reading recorded since staging is skipped, never doubled. The same file reopens its own review. `/imports` and `/imports/<id>`, a template, and an entry in the Machines menu. | `20261121110000`, `import_staging.sql` |
| Reading photos and PDFs into the review | `src/lib/extraction`: a provider interface and the mapping of its output into staged rows. A value with no stated confidence, or a malformed one, counts as 0 (uncertain). Pages outside the document are dropped. Text is cleaned of control characters and bounded, and stays data. The file's own bytes decide its type. A document batch records which reader read it. The provider runs only inside a hold on the owner's one assistance limit (`runHeld`, the A3 ledger), and with no hold there is no call. Off: provider `none`, flag `document_extraction` off, and Professional refused until its price is decided. | same migration; `extraction.test.ts` |
| Questions over manuals (Complete) | An asset gets a Manuals card for uploading a PDF, making it searchable with a title, reading it again, or removing it from search. Pages are read inside a hold, and only their text is stored: there is no second copy of the file and no second storage charge, and the text size is shown on the asset. Search runs as the person (security invoker), so a page is found only when that person may see its document; the finance rule and business isolation hold. The assistant's read-only `search_manuals` returns excerpts with a cite (document, page). When nothing matches, the assistant is told to say the manuals do not cover it. The prompt keeps live records (readings, services, fuel, faults) with the deterministic tools, and manual text is quoted data. Deleting or soft-deleting a document deletes its text. Off: reader `none`, flag `manual_questions` off. | `20261121120000`, `manual_questions.sql`; `manuals.test.ts` |
| Old roadmap entries | Already classified with evidence by A1 (register I-050 to I-061); re-checked: nothing B5 built changes them, and no new price or tier was introduced. | register section 3 |

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| Scenario 44: OCR review prevents silent writes | `import_staging.sql` [1] to [6] (poor photo, multipage, contradictory dates, duplicates in the file and already recorded, injected text, per-field confirmation, bulk, confirm once, isolation, plan and flag); `extraction.test.ts`; `import-staging.test.ts` |
| Scenario 44: custom field isolation and validation | `custom_asset_fields.sql`; `custom-fields.test.ts` |
| Scenario 44: document Q&A citations, deletion and retrieval isolation | `manual_questions.sql` [1] to [5]; `manuals.test.ts` |

Register: R-111 E (B5). R-110 E (B5) for staging, X for the adapter (provider and price). R-112 X (built behind the flag; reader and price). R-113 re-checked.

## 3. Not done, and why

- **No provider for documents or manuals.** Which OCR or vision provider, and what a page costs on Professional, is the founder's decision (FOUNDER-DECISIONS-PENDING 12). Only `pdf-lib` is installed, and it cannot read text. Both paths are complete up to the provider call and tested with a stand-in.
- **Readings only.** The staging tables carry `purpose = 'readings'`; service events from documents would be a second purpose on the same flow.
- **No browser pass.** `ui:check` was not run on `/imports`, `/imports/<id>`, `/settings/fields` or the asset page's new cards; they follow the existing dialog and card patterns.

## 4. Assumptions (flag any that are wrong)

1. A blank or unreadable page is not billed to the customer; its cost is recorded as ours.
2. Manual questions belong to Complete's paid assistance (the `voice_ai` rank). Reading documents into the review has the feature on Professional (the `tco` rank) but runs only where the paid-assistance path exists.
3. A manual's text is not counted against the storage pool. It is at most 20,000 characters a page and 300 pages, and its size is shown.
4. The review's row numbers are the spreadsheet's own (the header is row 1); blank lines keep their number.
5. A sheet up to 2 MiB and 2,000 rows (the fuel-card cap) is enough for readings.

## 5. Risks, most important first

1. **Deploy order.** Apply the three migrations before the new build serves `/imports`, the asset page's cards and the assistant. The assistant asks `manual_questions_available` softly, so a missing function means "off", not an error. The asset page and `/imports` read the new tables.
2. **The `simple` text search** matches words as written, with no stemming, so "filters" does not find "filter". English and Afrikaans filler words are dropped from questions. This is good enough for capacities, part numbers and intervals; a better ranker can come with the reader decision.
3. **Search permission depends on the attachments policies.** If those policies ever loosen, manual pages loosen with them. That is the intent, and `manual_questions.sql` [4] pins the finance case.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| Provider and price | Founder decision 12: choose a provider; set the Professional price or keep it off; add the model's price row so the ledger can hold it; then set `DOCUMENT_EXTRACTION_PROVIDER` / `MANUAL_READER_PROVIDER` and switch the flags per business on `/admin/features`. |
| Release | Apply `20261121100000`, `20261121110000` and `20261121120000` with the deploy (probes in `scripts/apply_pending.mjs`). |

## 7. For the next tasks

- **B6 (Android):** nothing here needs the app; `/imports` and the asset cards are ordinary pages.
- **A6 (release):** add the three migrations to the release sequence; the flags `document_extraction` and `manual_questions` appear on `/admin/features` and stay off; `ui:check` the new screens at 360 and 1024 px in both languages.
