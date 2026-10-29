-- 2026-10-29 (Axel): "wrong shop" — one shop's REP units put on another shop's van.
alter table lab_offslip_items drop constraint lab_offslip_items_lab_cause_check;
alter table lab_offslip_items add constraint lab_offslip_items_lab_cause_check check (lab_cause is null or lab_cause = any (array['customer_order','wrong_shop','lab_extra','shop_error']));
alter table lab_delivery_gaps drop constraint lab_delivery_gaps_lab_cause_check;
alter table lab_delivery_gaps add constraint lab_delivery_gaps_lab_cause_check check (lab_cause is null or lab_cause = any (array['found_at_lab','damaged_returned','lost_transport','shop_miscount','lab_sent_extra','wrong_shop']));
