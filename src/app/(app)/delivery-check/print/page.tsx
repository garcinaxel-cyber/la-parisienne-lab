import { redirect } from 'next/navigation';

// Moved to /delivery-print (outside the (app) route group) on 2026-08-11: this route being
// nested under (app)/layout.tsx meant every print-out came wrapped in the full app chrome
// (Sidebar + top nav) — wrong for a page meant to be printed standalone. Kept as a redirect
// so any old bookmarked/cached link still lands somewhere useful instead of 404ing.
export default function DeliveryPrintLegacyRedirect({ searchParams }: { searchParams: { date?: string; orderRef?: string } }) {
  const params = new URLSearchParams();
  if (searchParams.date) params.set('date', searchParams.date);
  if (searchParams.orderRef) params.set('orderRef', searchParams.orderRef);
  redirect(`/delivery-print?${params.toString()}`);
}
