// Best-effort Vietnamese phone canonicalization for customer_phone fields (Axel, 2026-09-15:
// "je voudrais [...] avoir des numero de telephone standard qui se match bien avec la base de
// donnee client"). Deliberately NEVER rejects or blocks: if the input doesn't reduce to a
// confident, plausible VN number, the original (already trimmed/length-capped) value is
// returned untouched rather than erroring — a foreign number, a landline written differently, a
// typo, or free text like "khách gửi sau" must never stop an order from being saved.
//
// Canonical form when confident: local 0-prefixed 10-digit, no spaces/dashes ("0976797971") —
// easiest to sort/search/export, and matches how staff actually dial/text. This mirrors the
// same 9-significant-digit logic normalizePhoneKey already uses for fuzzy matching in
// online-orders/actions.ts (0xxxxxxxxx / +84xxxxxxxxx / 84xxxxxxxxx all collapse to the same
// number) — canonicalizing the STORED value on top of that existing matching key just cleans up
// display/export and catches obviously-VN numbers into one consistent shape.
export function canonicalizePhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed; // no digits at all (e.g. free text) — leave exactly as typed

  let local = digits;
  if (local.startsWith('84') && local.length === 11) local = '0' + local.slice(2);
  else if (!local.startsWith('0') && local.length === 9) local = '0' + local;

  if (/^0\d{9}$/.test(local)) return local; // confident VN mobile/landline shape
  return trimmed; // anything else (wrong length, foreign number, garbage) — never mangled
}
