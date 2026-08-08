-- 0416_document_vocabulary_debit.sql
-- The fourth kind, alone in its own migration (the 0411 lesson: a new enum value cannot
-- be USED in the transaction that added it, and 0418 uses this one in a check constraint).
--
-- A DEBIT NOTE is the under-charge case: the invoice went out for too little and the
-- customer owes more. AutoVault has both notes (`invoice_adjustments.note_type` is
-- 'credit' or 'debit'); we shipped only the credit half, which covers overcharging and
-- leaves the opposite mistake with no answer at all.

alter type partner_doc_kind add value if not exists 'debit_note';
