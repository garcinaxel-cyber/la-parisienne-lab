-- lab_v131: link the Lab loss of a 'made without order → lost' answer (retry of its Odoo scrap)
alter table lab_made_without_order add column if not exists loss_id uuid;
