import { redirect } from 'next/navigation';

// Tab removed (Axel, 2026-10-24): the birthday cake form now lives in Exceptional orders.
export default function BirthdayCakesPage() {
  redirect('/exceptional-orders?tab=cakes');
}
