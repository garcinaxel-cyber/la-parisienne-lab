import EmployeeHrView from './EmployeeHrView';

export const revalidate = 0;
export const metadata = { title: 'La Paris — Nhân viên', robots: { index: false, follow: false } };
export const viewport = { width: 'device-width', initialScale: 1 };

// HR pilot (Axel, 2026-11-06) — employee personal space, no login: the token in the URL is the key
// (validated server-side on every action, see ./actions.ts).
export default function EmployeeHrPage({ params }: { params: { token: string } }) {
  return <EmployeeHrView token={params.token} />;
}
