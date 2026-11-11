// Who counts what in the Lab inventory (Axel, 2026-11-11): the storage manager (purchasing) counts
// the raw materials, the assistants count the packaging and the finished goods; admins and lab
// managers see everything. Each role takes the missing photos of its own items.
export type StockKind = 'raw' | 'packaging';

export function stockKindsFor(role: string | null | undefined, canPurchase = false): StockKind[] {
  if (role === 'admin' || role === 'lab_manager') return ['raw', 'packaging'];
  if (role === 'purchasing') return ['raw'];
  if (role === 'assistant') return ['packaging'];
  return canPurchase ? ['raw'] : [];
}

export function canCountFinished(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'lab_manager' || role === 'assistant';
}
