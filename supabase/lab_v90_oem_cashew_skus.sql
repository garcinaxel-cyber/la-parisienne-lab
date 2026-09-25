-- Cashew SKUs renamed MM-… → OEM-… (client TIANHE FOOD, not Maison Mooncake). Axel, 2026-09-26.
-- Already applied on the database; kept here for traceability. Odoo default_code renamed the same way.
update lab_mm_order_items set sku = replace(sku,'MM-','OEM-') where sku like 'MM-HD%';
update lab_fiche_variants set sku = replace(sku,'MM-','OEM-') where sku like 'MM-HD%';
update lab_fiche_meta set b2c_sku_ref = replace(b2c_sku_ref,'MM-','OEM-'), updated_at = now() where b2c_sku_ref like 'MM-HD%';
