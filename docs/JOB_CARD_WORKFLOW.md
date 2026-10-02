# Job cards: work, review and supplier billing

Implementation review: 1 October 2026, including a final pass against the original farmer/fleet-owner request. These changes are local; the three new migrations and application changes have not been deployed.

**Released 2 October 2026.** The three migrations below were applied to the live database and the application deployed (`5d307ed`); the job-card and work-request screens were then simplified without changing this workflow (`38ea421`). Notes below that say these changes are local or undeployed are historical.

## Choose who does the work first

The job-card list, asset page and fault page use the same creation form. Ask for the asset, who will do the work, the work type and the problem. Collect diagnosis, parts, labour and handover information later, when those details are known.

| Situation | Who starts it? | Who maintains the job card? | Who supplies the invoice? |
| --- | --- | --- | --- |
| Farm or fleet staff do the work internally | Owner, manager or mechanic | Farm staff with work permission | No invoice. Parts, labour and other lines record internal costs. |
| A connected contractor does the work | Owner or manager sends a work request | Assigned contractor; either party can create the linked card after authorization | Contractor issues its invoice. Farm staff may file an invoice already supplied by that contractor. |
| An outside company does not use FleetWise | Owner or manager names the company and creates an external card | Owner or manager records the supplied work details | Outside company issues its own invoice; farm records the received document and amount. |
| A contractor starts a direct job for a connected customer | Contractor creates a card for its own workshop | That contractor | Contractor records its invoice after completing the work. |

Creating the record does not determine who owns the work or who bills for it. Permissions follow the farm, selected provider and stage. A user who owns one farm but is an operator on another does not inherit owner powers on the second farm.

## Job stages and the options shown

| Stage | Available work | Next action |
| --- | --- | --- |
| Open or reported | Review and correct intake; add supporting photos | Start work |
| In progress | Save work performed, costs and service tasks covered; enter handover information | Wait for parts or submit completed work |
| Waiting for parts | Maintain the work record | Resume work before completion |
| Completed | Read the submitted record; external supplier billing becomes available | Owner/manager approves, or returns the work with a reason |
| Approved | Read the locked work record; retain supplier documents | No further work edits |

The page shows a summary and next action first. Intake, work notes, handover, line entry, service kits and document uploads open in smaller forms. Users do not have to fill every field to open a job. Clicking a table row opens the job card; an explicit **Open job card** link remains available for keyboard navigation and opening another tab.

Completion requires saved work performed and a valid completion date. Scheduled services require a meter reading only when the asset uses a meter. A meterless implement must not need a fabricated reading. Repairs can finish without a reading. Starting a connected scheduled service preserves its service type when the request becomes a card.

Select the service tasks actually covered. A general service without selected tasks records history and its meter reading but leaves individual task due dates unchanged; this also preserves the assistant's completed-service command. Current or newer readings cannot decrease the asset's recorded meter. Historical completion dates remain supported, and meter replacements use the separate meter-replacement process.

Owners and managers can assign internal work to an active owner, manager or mechanic on that farm. The job list follows the selected farm, and parts and kits are scoped to the job's farm. Both asset-specific kits and matching asset-type templates are offered.

Completion records operational history. Approval accepts and locks that history. An unfinished job cannot be approved or created already approved through an authenticated write. These rules apply at the database boundary as well as in the interface.

## Connected contractor process

1. Owner/manager selects the contractor and sends the request. Existing unassigned requests must receive a contractor before progressing.
2. Contractor supplies a quote, if needed. The owner/manager accepts the quote or authorizes work without a quote. A supplied structured quote must be accepted through its document.
3. Either party creates the linked job card after authorization. Repeating conversion returns the existing card. A source fault and requested work type carry through to the job.
4. Contractor starts work, adds the actual work and submits completion. The request follows the linked job's progress.
5. Owner/manager reviews the work. The supplier records or issues the final invoice after completion. Receiving an invoice does not make the farm its issuer.
6. Owner/manager closes the invoiced request. If its linked card is completed, closing also approves that card in the same transaction. An unfinished linked card prevents closure.

Farm staff cannot enter the contractor's quote or final price through the provider controls. They can file an already supplied document from the work request, entering the supplier's printed document number and total. This records the supplier as issuer and updates the request's quoted/invoiced stage and amount. The upload does not allocate a new supplier invoice number; duplicate supplier numbers are rejected. Direct external cards use supplier-document upload; the structured invoice builder is reached through the work request.

## Costs and corrections

- Internal work never offers a job-card invoice action. Its lines form the cost record.
- External lines are estimates until a supplier bill is recorded. The bill replaces those estimated costs in the asset ledger, preventing the parts and invoice from being counted twice. A zero-value final bill is supported.
- A completed job can be returned to the assigned team with a correction reason before a supplier invoice is filed or the linked request is billed or closed. Returning it withdraws its service-task, meter, usage and recommendation effects, restores prior service baselines and reopens its source fault. Later valid work remains intact. Completing the correction reapplies the corrected history without duplicate effects.
- Supplier totals sum active issued invoices. Voiding one invoice reduces the total; voiding all invoices returns an unclosed request to completed and clears the invoice amount. An old manually recorded amount is not resurrected as another cost.
- Approved work remains locked. Further work belongs on a new card. This change does not add an approval reversal or financial credit-note process for an already billed correction.
- Cards completed before these migrations do not have reliably traceable completion effects. They remain available for approval and supplier billing, but cannot be returned automatically: the screen explains that corrective work requires a new card. No uncertain historical meter/service backfill is performed. Existing unfinished cards acquire traceable effects when they complete after migration.
- Corrections preserve service baselines changed by a meter replacement or manual adjustment, including corrections and resubmissions on the same date. Changing selected service tasks updates the job's version, so an older completion screen cannot submit unseen task changes.
- Disconnecting a contractor removes its working access; the receiving farm retains its ability to review completed work.
- Separate internal work and work by different suppliers into separate cards, each with its own costs and responsibility.

## Saving and recovery

Section saves update only fields present in that section. They check the stored version so an older open page cannot silently overwrite newer work. Section and line drafts remain until saved values are confirmed; conflicting drafts require an explicit choice. Successful line saves acknowledge the matching draft before clearing it. Existing lines can be edited with the same version protection. Removing a line uses a permission-checked database operation, preserves the audit record and removes its cost; stale removal requests fail instead of deleting newly edited work.

Creation forms on the job list, asset and fault pages retain actor-scoped intake drafts. A stable creation receipt returns the original card/request after an uncertain response, even after later edits or request conversion. The request and opening event save atomically. Changing an already-saved capture's details or switching it between a request and a card reports a conflict. Only an acknowledged capture clears its draft. Source faults now link directly to their job card, including after resolution.

Line additions validate descriptions, quantities and amounts. Failed or zero-row writes are reported. Stable receipts prevent repeated line and kit submissions from adding duplicates, including an offline retry of a draft already saved online. Retrying a removed line reports a conflict rather than claiming it is still present. Job media uses a stable capture identifier and an atomic attachment/cost operation so retrying an uncertain upload does not duplicate the invoice cost. Offline completion checks the saved version and preserves the saved handover date and meter. Late lines for completed jobs become conflicts. Editing an existing line requires an online connection; additions can be queued offline.

Pending job-media receipts survive dialog closure and reload. Reselecting the same file reuses a receipt only when its hash, metadata and invoice details match. Standalone supplier invoice recording requires an explicit amount, including zero; an invoice cannot silently leave estimated costs in place because its amount was omitted. Supplied documents on work requests similarly retain an upload receipt and validate file contents, context, actor, supplier number and amounts on retry.

Creation from a fault links the card atomically. Acknowledged and in-progress faults can become jobs; resolved or already linked faults cannot be silently reassigned. A pending contractor request appears on the fault so staff can open it instead of creating another request.

## Verification and rollout

Regression coverage includes role ownership, selected-farm permissions, invalid transitions, internal invoice rejection, quote acceptance, contractor conversion, source-fault linking, meterless services, corrections, supplier cost reconciliation, media retry handling and offline capture. The second audit adds line/kit retry receipts, online-to-offline retries, line removal, invalid assignments, decreasing current readings, stale offline completion, saved historical handovers, and corrections of multiple services out of order. See `supabase/tests/jobcard_revision.sql`, `jobcard_workflow.sql`, `jobcard_media_receipts.sql`, `atomic_offline_capture.sql`, and the workflow TypeScript tests.

Final review coverage adds `jobcard_intake.sql` and `jobcard_received_invoice.sql`, including fault-linked creation retries, request/event atomicity, changed-capture rejection, cross-kind capture reuse, role denials and zero-charge supplied invoices. Application tests also cover supplied-document receipt ownership, numbers, payload and file-hash matching.

Local results after integrating the second UI pass: all 467 application tests passed. All 29 SQL suites passed; all 187 migrations applied. The production build, TypeScript/lint checks, translation parity/key coverage (5,391 keys per language), error coverage, design and punctuation checks passed. The SQL runner uses disposable PGlite databases with Supabase auth stubs, the real bundled trigram extension and a digest substitute; it does not validate hosted Auth or Storage behavior.

Apply the pending migrations in order before releasing the application that uses their fields and RPCs:

1. `20260927160340_jobcard_workflow_ownership.sql`
2. `20260928061830_jobcard_media_receipts.sql`
3. `20261001062931_jobcard_intake_receipts.sql`

No live database changes were performed during this review. An interactive browser was unavailable, so browser acceptance remains outstanding. Use the [documented test accounts](FLEETWISE_MANUAL_SETUP_GUIDE.md#4-demo-login-credentials) to verify these paths on the target environment:

- Internal repair and a scheduled service, including a meterless asset.
- Connected contractor job initiated by the farmer, and one converted by the contractor.
- Outside-company work with a received invoice and a no-charge invoice.
- Acknowledged fault to internal card and fault to contractor request to card.
- Return completed work for correction, complete again, then approve.
- Add a part, labour line, kit and photo; refresh and confirm each persisted.
- Simulate a failed save, restore a draft, and retry an interrupted upload.
- Two sessions editing the same card; confirm the older save reports a conflict.
- Operator, unrelated contractor and selected-farm permission denials.
- Row clicks, keyboard links and dialogs on desktop and mobile.

Cancellation and reassignment of an existing job are not introduced by this change. Those require explicit rules for outstanding quotes, stock, work already performed and supplier charges; changing the supplier on an existing card is blocked.
