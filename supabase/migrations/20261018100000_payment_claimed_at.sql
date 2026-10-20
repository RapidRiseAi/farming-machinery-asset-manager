-- "I have paid" from the emailed invoice link tells the workshop once, not once per tap
-- (interaction safety, release 2). The link action stamps this and notifies only when the
-- last claim is more than ten minutes old; a customer who taps again, or reloads and taps,
-- is thanked again without a second notification.
alter table public.partner_documents
  add column if not exists payment_claimed_at timestamptz;
