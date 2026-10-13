-- Products kept off an event's till even though the event has them in stock (Axel, 2026-10-09:
-- truffle macaron BMCNT at HỘI CHỢ AEON HẢI PHÒNG, too expensive for that crowd, they don't sell it).
alter table lab_event_shops add column if not exists hidden_skus text[] not null default '{}';
update lab_event_shops set hidden_skus = array['BMCNT'] where id = 'f04eee1c-68d9-4c44-a726-a4aec6a99ba8';
