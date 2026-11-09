import PhotosView from './PhotosView';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // Odoo scope / send can take a while

export default function InventoryPhotosPage() {
  return <PhotosView />;
}
