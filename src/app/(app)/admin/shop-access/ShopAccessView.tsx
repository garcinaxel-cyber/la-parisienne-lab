'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { Store, Copy, Check, Eye, KeyRound, AlertTriangle } from 'lucide-react';

type Shop = { name: string; hasAccount: boolean; email: string | null };

export default function ShopAccessView({ shops }: { shops: Shop[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [emailDraft, setEmailDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ shop: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rows, setRows] = useState(shops);
  // Bug found 2026-08-19 (Axel: "j'essaie de créer mais ça fonctionne pas") — a failed create
  // gave zero feedback, res.error was silently dropped. Also surfaced the real cause: an email
  // with Vietnamese diacritics in the local part (e.g. "Hoànkiếm@...") is rejected by Supabase
  // Auth as an invalid address — the server error now actually reaches the screen.
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function create(shopName: string) {
    const email = (emailDraft[shopName] ?? '').trim();
    if (!email) return;
    // ASCII-only check up front — Supabase Auth rejects accented characters (e.g. "Hoànkiếm@...")
    // as an invalid address, and that round trip is avoidable.
    if (!/^[\x00-\x7F]+$/.test(email)) {
      setErrors(p => ({ ...p, [shopName]: vi ? 'Email không được có dấu (chỉ chữ cái, số thường)' : 'Email sans accents (lettres/chiffres standards uniquement)' }));
      return;
    }
    setBusy(shopName);
    setErrors(p => ({ ...p, [shopName]: '' }));
    const { createShopAccountAction } = await import('./actions');
    const res = await createShopAccountAction(shopName, email);
    setBusy(null);
    if (res.link) {
      setLink({ shop: shopName, url: res.link });
      setRows(p => p.map(s => s.name === shopName ? { ...s, hasAccount: true, email } : s));
    } else {
      setErrors(p => ({ ...p, [shopName]: res.error ?? (vi ? 'Không tạo được tài khoản' : 'Échec de la création') }));
    }
  }

  async function resetLink(shopName: string) {
    setBusy(shopName);
    setErrors(p => ({ ...p, [shopName]: '' }));
    const { generateShopResetLinkAction } = await import('./actions');
    const res = await generateShopResetLinkAction(shopName);
    setBusy(null);
    if (res.link) setLink({ shop: shopName, url: res.link });
    else setErrors(p => ({ ...p, [shopName]: res.error ?? (vi ? 'Lỗi' : 'Erreur') }));
  }

  async function copyLink() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }

  return (
    <div className="space-y-4">
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1 flex items-center gap-2">
        <Store size={22} className="text-gold" /> {vi ? 'Truy cập cửa hàng' : 'Accès boutiques'}
      </h1>
      <p className="text-sm text-ink-light">
        {vi
          ? 'Mỗi cửa hàng có một tài khoản chung (email + mật khẩu) dùng chung cho nhân viên. Bấm "Xem" để mở giao diện giống cửa hàng thấy.'
          : "Chaque boutique a un compte partagé (email + mot de passe) commun à ses employés. Clique sur \"Voir\" pour ouvrir exactement l'interface que voit la boutique."}
      </p>

      {link && (
        <div className="card p-4 space-y-2" style={{ border: '1px solid #BBF7D0', backgroundColor: '#F0FDF4' }}>
          <p className="text-sm font-bold" style={{ color: '#166534' }}>
            {vi ? `Link đặt mật khẩu cho ${link.shop}` : `Lien de création de mot de passe pour ${link.shop}`}
          </p>
          <p className="text-xs" style={{ color: '#166534' }}>
            {vi ? 'Gửi link này qua Zalo — hết hạn sau khi dùng.' : "Envoie ce lien par Zalo — il expire après usage."}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs px-2.5 py-1.5 rounded-lg overflow-x-auto whitespace-nowrap" style={{ backgroundColor: 'white', border: '1px solid #D1D5DB' }}>{link.url}</code>
            <button onClick={copyLink} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 shrink-0" style={{ border: '1px solid #D1D5DB' }}>
              {copied ? <Check size={13} style={{ color: '#059669' }} /> : <Copy size={13} />} {copied ? (vi ? 'Đã sao chép' : 'Copié') : (vi ? 'Sao chép' : 'Copier')}
            </button>
          </div>
        </div>
      )}

      <div className="card divide-y divide-border-soft overflow-hidden">
        {rows.map(shop => (
          <div key={shop.name} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-sm font-bold text-navy">{shop.name}</div>
              {shop.email && <div className="text-xs text-ink-light truncate">{shop.email}</div>}
              {errors[shop.name] && (
                <div className="text-xs font-semibold flex items-center gap-1 mt-0.5" style={{ color: '#DC2626' }}>
                  <AlertTriangle size={11} className="shrink-0" /> {errors[shop.name]}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {shop.hasAccount ? (
                <>
                  <Link href={`/admin/shop-access/${encodeURIComponent(shop.name)}`}
                    className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white"
                    style={{ backgroundColor: '#1f2937' }}>
                    <Eye size={13} /> {vi ? 'Xem' : 'Voir'}
                  </Link>
                  <button onClick={() => resetLink(shop.name)} disabled={busy === shop.name}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-1.5 disabled:opacity-40"
                    style={{ border: '1px solid #D1D5DB' }}>
                    <KeyRound size={13} /> {busy === shop.name ? '…' : (vi ? 'Đặt lại mật khẩu' : 'Réinitialiser')}
                  </button>
                </>
              ) : (
                <>
                  <input type="email" value={emailDraft[shop.name] ?? ''} onChange={e => setEmailDraft(p => ({ ...p, [shop.name]: e.target.value }))}
                    placeholder="moonflower@laparisienne.lab" className="text-xs rounded-lg px-2.5 py-1.5 w-44" style={{ border: '1px solid #D1D5DB' }} />
                  <button onClick={() => create(shop.name)} disabled={busy === shop.name || !(emailDraft[shop.name] ?? '').trim()}
                    className="text-xs font-bold rounded-lg px-3.5 py-1.5 text-white disabled:opacity-50"
                    style={{ backgroundColor: '#16A34A' }}>
                    {busy === shop.name ? '…' : (vi ? 'Tạo tài khoản' : 'Créer le compte')}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
