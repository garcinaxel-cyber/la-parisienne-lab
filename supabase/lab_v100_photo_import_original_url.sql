-- lab_v100 (applied 2026-10-07): keep the recipe card's photo from before the website photo
-- switch in its own column, so old_url can follow the card's current photo while the rollback
-- record stays. Same day, 286 recipe cards were pointed at the website's current photo file
-- (fixed address in bucket product-images) by a one-off statement; variant photos untouched.
alter table public.lab_photo_import add column if not exists original_url text;
comment on column public.lab_photo_import.original_url is 'Recipe card photo before the 2026-10-07 switch to the website photos (rollback record).';
update public.lab_photo_import set original_url = old_url where original_url is null and old_url is not null;
