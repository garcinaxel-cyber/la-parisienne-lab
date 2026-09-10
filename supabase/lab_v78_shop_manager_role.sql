-- Shop Manager role (Axel, 2026-09-10): individual manager logins instead of sharing the
-- shop's own PIN-only identity. A shop_manager account logs in on its own (no shared shop
-- password), picks which of its authorized shops to act on (lab_shop_managers.shops), and from
-- there gets the exact same read/write access a shop's own login already has (via
-- requireShopOrStaffSession in src/app/shop/actions.ts) plus read-only Analytic/Suivi access to
-- the online-sales app (src/app/online-orders/actions.ts). Kept as its own migration (not
-- combined with lab_v79's lab_shop_managers.user_id column) because a new enum value can only
-- be USED in a later transaction, never the one that adds it — same two-step precedent as the
-- 'shop' (lab_v45) and 'online_sales' (lab_v69) roles before it.
alter type user_role add value if not exists 'shop_manager';
