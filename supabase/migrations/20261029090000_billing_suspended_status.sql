-- A subscription can be SUSPENDED for non-payment (decision of 26 October 2026: seven days'
-- grace after a missed payment, then access stops until the farm pays; nothing is deleted).
-- Its own file: an enum value has to be committed before anything can use it.
alter type billing_subscription_status add value if not exists 'suspended';
