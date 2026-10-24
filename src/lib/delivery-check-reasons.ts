// Delivery check reasons (Axel, 2026-10-24): closed list, simple words, no free "Khác".
// "other" survives only as "Lý do khác — ghi rõ" with a mandatory comment.
// Which reasons are offered depends on the direction (fewer / more than ordered) and on the
// family (stock products: macaron, biscuit voyage, tiramisu vs made-to-order) — see GapResolver.
export type ReasonCode =
  | 'out_of_stock' | 'not_made' | 'casse' | 'order_changed' | 'packing' | 'other'
  | 'extra_stock' | 'extra_made' | 'undeclared' | 'from_lab_stock'
  | 'shortage' | 'miscount'; // legacy (before 2026-10-24), display only

export const REASON_LABELS: Record<string, { vi: string; en: string }> = {
  out_of_stock: { vi: 'Hết hàng trong kho', en: 'Out of stock' },
  not_made: { vi: 'Bếp chưa làm', en: 'Not made' },
  casse: { vi: 'Bị hỏng / vỡ', en: 'Broken / damaged' },
  order_changed: { vi: 'Cửa hàng / khách đổi đơn', en: 'Order changed' },
  packing: { vi: 'Soạn hàng thiếu', en: 'Packing mistake' },
  other: { vi: 'Lý do khác (ghi rõ)', en: 'Other (explain)' },
  extra_stock: { vi: 'Gửi thêm từ kho', en: 'Extra from stock' },
  extra_made: { vi: 'Bếp đã làm dư', en: 'Kitchen made extra' },
  undeclared: { vi: 'Bếp làm nhưng chưa báo', en: 'Made but not declared' },
  from_lab_stock: { vi: 'Lấy từ kho Lab', en: 'Taken from Lab stock' },
  shortage: { vi: 'Không sản xuất đủ / hết hàng', en: 'Not enough produced / out of stock' },
  miscount: { vi: 'Đếm sai', en: 'Miscount' },
};

export const reasonLabel = (code: string | null | undefined, vi: boolean) =>
  code ? (REASON_LABELS[code] ? (vi ? REASON_LABELS[code].vi : REASON_LABELS[code].en) : code) : '';

// Short lines: stock products vs made-to-order. Over lines are handled by GapResolver directly.
export const SHORT_REASONS_STOCK: ReasonCode[] = ['out_of_stock', 'casse', 'order_changed', 'packing', 'other'];
export const SHORT_REASONS_MTO: ReasonCode[] = ['not_made', 'casse', 'order_changed', 'packing', 'other'];
export const SHORT_REASONS_PACKAGING: ReasonCode[] = ['out_of_stock', 'casse', 'order_changed', 'packing', 'other'];

export const OTHER_NOTE_MIN = 5;

// Kept for older imports — the select lists are now built by GapResolver.
export const DELIVERY_CHECK_REASONS = (['out_of_stock', 'not_made', 'casse', 'order_changed', 'packing', 'other'] as const)
  .map(v => ({ v, vi: REASON_LABELS[v].vi, en: REASON_LABELS[v].en }));
