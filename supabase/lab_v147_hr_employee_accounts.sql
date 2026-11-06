-- v147 — HR pilot: link each Macaron employee to his station account (Axel, 2026-11-06).
-- The station shows a "Của tôi" tab (own schedule, requests, days off, overtime) to the signed-in
-- user whose hr_employees.profile_id matches. Hưng already linked in v146.
update public.hr_employees e set profile_id = v.pid::uuid
from (values
  ('Lê Công Trung',      'bcfb6453-361d-4594-a5e1-a05bf5d52c73'), -- trung (trung2404@icloud)
  ('Lê Thị Ngọc',        '06a0272e-d0ae-40ce-b003-80ce14dce7e5'), -- lengocsdx@
  ('Năng Thanh Huyền',   'e4e6d019-63c2-4c83-8383-7888d1136bbd'), -- Electric Girl (huyennt.0125@)
  ('Nguyễn Thảo Nguyên', '3115f94a-ca4a-4be3-a79b-b3c62b3855fa'), -- nthaonguyen301005@
  ('Chu Thanh Vũ Minh',  '16dd591a-0b5c-4eec-be25-21ad8f496f86'), -- mvu4388@
  ('Công Phương Thanh',  '4f10c194-1551-4e80-afb5-4ea90c3aafaf')  -- phuongthanhhcong@
) as v(name, pid)
where e.team = 'hung' and e.full_name = v.name and e.profile_id is null;
