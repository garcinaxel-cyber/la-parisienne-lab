// Hanoi district/quartier reference list for the optional "district" field on the two
// customer-facing order forms (online-orders + the shop order form) — Axel, 2026-09-15: wants
// to be able to filter the customer database by neighbourhood.
//
// Since 1 July 2025, Vietnam's nationwide 2-tier administrative reform formally abolished
// Hanoi's district level (quận/huyện) — the city is now divided directly into 126 phường/xã.
// These pre-reform district names are therefore no longer an official administrative unit, but
// they remain what people actually write on an address and think in day to day, and they're a
// far more useful grouping for a delivery-zone view than 126 fine-grained phường would be — so
// this list deliberately keeps the old names. Trimmed to the 12 urban quận plus the closest
// peri-urban huyện a bakery delivery might plausibly reach (Gia Lâm, Đông Anh, Thanh Trì, Sóc
// Sơn, Mê Linh) — the further rural huyện (Ba Vì, Chương Mỹ, Mỹ Đức...) were left out as
// unlikely to ever be picked; add them back here if that assumption is wrong.
//
// Pure data, zero imports: safe to import from a client component (same convention/reasoning
// as src/lib/shops.ts) and from server actions alike.
export const HANOI_DISTRICTS: string[] = [
  'Ba Đình', 'Hoàn Kiếm', 'Hai Bà Trưng', 'Đống Đa', 'Tây Hồ', 'Cầu Giấy',
  'Thanh Xuân', 'Hoàng Mai', 'Long Biên', 'Nam Từ Liêm', 'Bắc Từ Liêm', 'Hà Đông',
  'Gia Lâm', 'Đông Anh', 'Thanh Trì', 'Sóc Sơn', 'Mê Linh',
  'Khác',
];

export function isKnownHanoiDistrict(value: string | null | undefined): boolean {
  return !!value && HANOI_DISTRICTS.includes(value);
}
