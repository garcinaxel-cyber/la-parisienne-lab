import StockCountView from './StockCountView';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // Odoo scope / send can take a while

export default function StockCountPage({ params }: { params: { id: string } }) {
  return <StockCountView id={params.id} />;
}
