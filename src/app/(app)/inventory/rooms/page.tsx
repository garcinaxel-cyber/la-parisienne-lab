import RoomCountsAdminView from './RoomCountsAdminView';

export const dynamic = 'force-dynamic';

// Admin check list of the chefs' room counts (Axel, 2026-10-20). Data loaded by the client view
// through an admin-only server action.
export default function RoomCountsPage() {
  return <RoomCountsAdminView />;
}
