-- lab_v102 (applied 2026-10-07): who rang up an event sale. The event till runs on a shared
-- login, so the only way to know who sold is the name staff already pick on that phone for
-- deliveries and losses. The till reuses that name without asking again at each sale; it is an
-- indication (a phone handed over without switching the name keeps the previous one), not a
-- proof. Nullable: a sale without a name is recorded exactly as before.
alter table public.lab_online_orders add column if not exists seller_name text;
comment on column public.lab_online_orders.seller_name is 'Event till only: staff name remembered on the phone when the sale was recorded. Indicative, may be null.';
