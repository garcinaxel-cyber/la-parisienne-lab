-- Purchasing role (Axel, 2026-10-08): the storage manager and the purchasing assistant get their
-- own space (/purchasing: purchase requests, today's storage withdrawals, history, raw material
-- catalogue). Kept alone in its migration: a new enum value can only be used in a later transaction.
alter type user_role add value if not exists 'purchasing';
