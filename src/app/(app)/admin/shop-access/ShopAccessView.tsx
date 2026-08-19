'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Store, Copy, Check, ExternalLink, RefreshCw, Ban, PlayCircle } from 'lucide-react';

type Shop = {
  name: string;
  link: { id: string; token: string; active: boolean; created_at: string; regenerated_at: string | null } | null;
};

export default function ShopAccessView({ shops }: { shops: Shop[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [rows, setRows] = useState(shops);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function urlFor(token: string) {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/boutique/${token}`;
  }

  async function copy(token: string) {
    try { await navigator.clipboard.writeText(urlFor(token)); setCopied(token); setTimeout(() => setCopied(null), 2000); } catch {}
  }

  async function generate(shopName: string) {
    setBusy(shopName);
    const { generateShopLinkAction } = await import('./actions');
    const res = await generateShopLinkAction(shopName);
    setBusy(null);
    if (res.token) {
      setRows(p => p.map(s => s.name === shopName
        ? { ...s, link: { id: s.link?.id ?? '', token: res.token!, active: true, created_at: new Date().toISOString(), regenerated_at: null } }
        : s));
    }
  }

  async function regenerate(shop: Shop) {
    if (!shop.link) return;
    setBusy(shop.name);
    const { regenerateShopLinkAction } = await import('./actions');
    const res = await regenerateShopLinkAction(shop.link.id);
    setBusy(null);
    if (res.token) setRows(p => p.map(s => s.name === shop.name ? { ...s, link: { ...s.link!, token: res.token! } } : s));
  }

  async function toggleActive(shop: Shop) {
    if (!shop.link) return;
    setBusy(shop.name);
    const { setShopLinkActiveAction } = await import('./actions');
    const nextActive = !shop.link.active;
    const res = await setShopLinkActiveAction(shop.link.id, nextActive);
    setBusy(null);
    if (res.ok) setRows(p => p.map(s => s.name === shop.name ? { ...s, link: { ...s.link!, active: nextActive } } : s));
  }

  return (
    <div className="space-y-4">
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1 flex items-center gap-2">
        <Store size={22} className="text-gold" /> {vi ? 'Truy cập cửa hàng' : 'Accès boutiques'}
      </h1>
      <p className="text-sm text-ink-light">
        {vi
          ? 'Mỗi cửa hàng có một link riêng, không cần đăng nhập. Bấm "Xem" để mở giao diện giống cửa hàng thấy.'
          : "Chaque boutique a son propre lien, sans connexion. Clique sur \"Voir\" pour ouvrir exactement l'interface que voit la boutique."}
      </p>

      <div className="card divide-y divide-border-soft overflow-hidden">
        {rows.map(shop => (
          <div key={shop.name} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm font-bold text-navy">{shop.name}</div>
              {shop.link && !shop.link.active && (
                <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{vi ? 'Đã tắt' : 'Désactivé'}</div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {shop.link ? (
                <>
                  <a href={urlFor(shop.link.token)} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white"
                    style={{ backgroundColor: '#1f2937' }}>
                    <ExternalLink size={13} /> {vi ? 'Xem' : 'Voir'}
                  </a>
                  <button onClick={() => copy(shop.link!.token)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5"
                    style={{ border: '1px solid #D1D5DB' }}>
                    {copied === shop.link.token ? <Check size={13} style={{ color: '#059669' }} /> : <Copy size={13} />}
                    {copied === shop.link.token ? (vi ? 'Đã sao chép' : 'Copié') : (vi ? 'Sao chép' : 'Copier')}
                  </button>
                  <button onClick={() => regenerate(shop)} disabled={busy === shop.name}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 disabled:opacity-40"
                    style={{ border: '1px solid #D1D5DB' }} title={vi ? 'Tạo link mới (link cũ sẽ mất hiệu lực)' : "Régénérer (l'ancien lien devient invalide)"}>
                    <RefreshCw size={13} className={busy === shop.name ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => toggleActive(shop)} disabled={busy === shop.name}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 disabled:opacity-40"
                    style={{ border: '1px solid #D1D5DB', color: shop.link.active ? '#DC2626' : '#059669' }}>
                    {shop.link.active ? <Ban size={13} /> : <PlayCircle size={13} />}
                  </button>
                </>
              ) : (
                <button onClick={() => generate(shop.name)} disabled={busy === shop.name}
                  className="text-xs font-bold rounded-lg px-3.5 py-1.5 text-white disabled:opacity-50"
                  style={{ backgroundColor: '#16A34A' }}>
                  {busy === shop.name ? '…' : (vi ? 'Tạo link' : 'Générer un lien')}
                </button>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="p-8 text-center text-sm text-ink-light">{vi ? 'Chưa có cửa hàng nào' : 'Aucune boutique trouvée'}</div>
        )}
      </div>
    </div>
  );
}
