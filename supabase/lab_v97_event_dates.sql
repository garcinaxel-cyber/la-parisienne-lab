-- lab_v97 — event days (Axel, 2026-10-07: "pour les rapports ça peut être que du 8 au 11 pour
-- cet event"). An event shop's Báo cáo tab lists the event's own days instead of the shops'
-- "current month + previous month" window. Both nullable: an event without dates keeps the
-- usual window. VN calendar dates, both inclusive. Applied in production on 2026-10-07.
alter table public.lab_event_shops add column if not exists start_date date;
alter table public.lab_event_shops add column if not exists end_date date;
comment on column public.lab_event_shops.start_date is 'First day of the event (VN calendar date, inclusive). Null = no restriction.';
comment on column public.lab_event_shops.end_date is 'Last day of the event (VN calendar date, inclusive). Null = no restriction.';
