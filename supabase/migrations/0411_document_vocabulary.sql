-- 0411_document_vocabulary.sql
-- The two new values the correction path needs, alone in their own migration.
--
-- `alter type … add value` cannot have its new value USED in the same transaction that
-- added it, and 0412 uses both in check constraints. Splitting the file is the fix: each
-- migration is applied as its own transaction, so by the time 0412 runs these exist.

alter type partner_doc_kind   add value if not exists 'credit_note';
alter type partner_doc_status add value if not exists 'void';
