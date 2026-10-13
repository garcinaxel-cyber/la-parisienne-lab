-- 2026-10-13 (Axel): Tianhe 1 t order split into deliveries (Đ1 150 kg shipped S04122, Đ2 414 kg 26/10 S04271, rest TBC).
alter table lab_mm_delivery_plan add column if not exists order_no integer, add column if not exists shipped_on date;
alter table lab_mm_delivery_plan rename column shipped_on to shipped_date;
alter table lab_mm_delivery_plan add column if not exists shipped boolean not null default false;
