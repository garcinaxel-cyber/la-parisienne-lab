-- Purchasing access on top of another role (Axel, 2026-10-09: Hien went back to 'assistant' to keep his
-- OEM rights, but still handles purchasing and confirms the chefs' withdrawal slips).
alter table profiles add column if not exists can_purchase boolean not null default false;
update profiles set can_purchase = true where id = '35d6fd56-d6cd-4224-a0fc-1f587485f9ba';
