'use client';
// Stats, UI v2 (Axel, 2026-11-14): one analysis period (from → to), three sub-tabs.
//  · Overview — same figures as before (getOnlineAnalyticsAction: revenue, orders, shops,
//    categories and channels with their product drill-down) plus the chat → order funnel.
//  · Ads — Meta spend per campaign vs revenue traced to its chats. Break-even = ×2 because shops
//    buy at 50% of the selling price.
//  · Customer service — reply speed by hour, night messages, chats still waiting.
// Read-only: nothing on this screen writes data.
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as actions from './actions';
import type { OnlineAnalytics, OnlineStatsExtras, ChannelProductDetail } from './actions';
import { useL } from './shared';
import { swr } from './client-cache';

const BG = '#F6F1EA', CARD = '#FFFFFF', LINE = '#E6DCCF', PANEL = '#F7F1E8', COL = '#EDE4D6';
const DARK = '#2A1810', INK = '#2E1B12', MUTED = '#6B5A4C', LIGHT = '#8A7A66', GOLD = '#C9A84C', BAR = '#572C1A', SOFT = '#D9CBB8';
const RED = '#9A3324', GREEN = '#1F5235', NIGHT = '#D9B36A';

type Sub = 'overview' | 'ads' | 'service';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const M = (v: number) => `${(v / 1e6).toFixed(1)}M`;
const K = (v: number) => v >= 1e6 ? M(v) : `${Math.round(v / 1000)}k`;

export default function StatsV2({ onOpenInbox }: { onOpenInbox?: () => void }) {
  const { lang } = useL();
  const t = (vi: string, en: string) => (lang === 'en' ? en : vi);
  const [sub, setSub] = useState<Sub>('overview');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(daysAgo(0));
  const [data, setData] = useState<OnlineAnalytics | null>(null);
  const [extras, setExtras] = useState<OnlineStatsExtras | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!from || !to || to < from) return;
    let alive = true;
    setLoading(true); setError(false);
    // Overview figures and the Ads/Service figures load independently and are cached per period
    // (5 min): coming back to Stats or to a period already seen is instant.
    const a = swr(`stats:a:${from}:${to}`, () => actions.getOnlineAnalyticsAction({ from, to }), r => {
      if (!alive) return;
      if (r.error) setError(true); else setData(r.data ?? null);
    }, 300_000);
    const x = swr(`stats:x:${from}:${to}`, () => actions.getOnlineStatsExtrasAction(from, to), r => { if (alive) setExtras(r.data ?? null); }, 300_000);
    Promise.all([a, x]).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to]);

  const span = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
  const preset = (n: number) => { setFrom(daysAgo(n - 1)); setTo(daysAgo(0)); };
  const isPreset = (n: number) => to === daysAgo(0) && from === daysAgo(n - 1);

  return (
    <div className="flex flex-col gap-4" style={{ color: INK }}>
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
        <div className="flex flex-col gap-2.5">
          <h1 className="hidden lg:block" style={{ margin: 0, fontFamily: "'Playfair Display', Georgia, serif", fontSize: 28, fontWeight: 700, color: DARK }}>{t('Thống kê', 'Stats')}</h1>
          <nav className="flex gap-1 rounded-xl p-1 w-fit" style={{ backgroundColor: COL }}>
            {([['overview', t('Tổng quan', 'Overview')], ['ads', t('Quảng cáo', 'Ads')], ['service', t('Chăm sóc KH', 'Customer service')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setSub(k)} style={{
                minHeight: 36, padding: '0 14px', borderRadius: 9, fontSize: 13.5, fontWeight: sub === k ? 700 : 600,
                backgroundColor: sub === k ? CARD : 'transparent', color: sub === k ? DARK : MUTED, boxShadow: sub === k ? '0 1px 2px rgba(42,24,16,0.08)' : 'none',
              }}>{label}</button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {[7, 30, 90].map(n => (
            <button key={n} onClick={() => preset(n)} style={{ fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: '7px 12px', backgroundColor: isPreset(n) ? DARK : CARD, color: isPreset(n) ? '#FBF7F0' : INK, border: `1px solid ${isPreset(n) ? DARK : LINE}` }}>{n} {t('ngày', 'days')}</button>
          ))}
          <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: '5px 8px' }}>
            {t('Từ', 'From')}<input type="date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: INK, background: 'transparent' }} />
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: '5px 8px' }}>
            {t('Đến', 'To')}<input type="date" value={to} min={from} onChange={e => e.target.value && setTo(e.target.value)} style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: INK, background: 'transparent' }} />
          </label>
          {loading && <Loader2 size={15} className="animate-spin" color={LIGHT} />}
        </div>
      </div>

      {error && <div className="rounded-xl p-4 text-center" style={{ backgroundColor: CARD, color: MUTED, fontSize: 13 }}>{t('Không tải được thống kê cho kỳ này.', 'Could not load stats for this period.')}</div>}
      {!data && !error && <div className="text-center py-12" style={{ color: LIGHT }}><Loader2 className="animate-spin inline" /></div>}
      {data && !error && (
        <div style={{ opacity: loading ? 0.6 : 1 }} className="flex flex-col gap-4">
          {sub === 'overview' && <Overview data={data} extras={extras} span={span} from={from} to={to} t={t} goAds={() => setSub('ads')} goService={() => setSub('service')} />}
          {sub === 'ads' && <Ads extras={extras} t={t} />}
          {sub === 'service' && <Service extras={extras} t={t} onOpenInbox={onOpenInbox} />}
        </div>
      )}
    </div>
  );
}

type T = (vi: string, en: string) => string;

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' }) {
  return (
    <div className="rounded-2xl flex flex-col gap-1" style={{ backgroundColor: CARD, padding: '14px 16px', boxShadow: '0 1px 2px rgba(42,24,16,0.05)' }}>
      <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', color: tone === 'red' ? RED : tone === 'green' ? GREEN : DARK }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: LIGHT }}>{sub}</span>}
    </div>
  );
}
function Card({ title, sub, children, className = '' }: { title?: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl flex flex-col gap-3 ${className}`} style={{ backgroundColor: CARD, padding: '16px 18px', boxShadow: '0 1px 2px rgba(42,24,16,0.05)' }}>
      {title && <div className="flex flex-col gap-0.5"><b style={{ fontSize: 15, color: DARK }}>{title}</b>{sub && <span style={{ fontSize: 12, color: LIGHT }}>{sub}</span>}</div>}
      {children}
    </section>
  );
}

function Overview({ data, extras, span, from, to, t, goAds, goService }: { data: OnlineAnalytics; extras: OnlineStatsExtras | null; span: number; from: string; to: string; t: T; goAds: () => void; goService: () => void }) {
  const [active, setActive] = useState<number | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [openCh, setOpenCh] = useState<string | null>(null);
  const [chProducts, setChProducts] = useState<Record<string, ChannelProductDetail[]>>({});
  useEffect(() => { setOpenCh(null); setChProducts({}); }, [from, to]);
  async function toggleCh(ch: string) {
    if (openCh === ch) { setOpenCh(null); return; }
    setOpenCh(ch);
    if (!chProducts[ch]) {
      const res = await actions.getChannelProductDetailsAction(ch, data.rangeStart, data.rangeEnd).catch(() => ({ data: [] as ChannelProductDetail[] }));
      setChProducts(p => ({ ...p, [ch]: res.data ?? [] }));
    }
  }
  const ads = extras?.ads, svc = extras?.service;
  const avg = data.rangeCount ? data.rangeTotal / data.rangeCount : 0;
  const chatPct = ads && ads.conversations ? Math.round(ads.chatConversationsWithOrder / ads.conversations * 100) : null;
  const series = data.series;
  const max = Math.max(1, ...series.map(s => s.total));
  const peak = series.reduce((b, s, i) => (s.total > (series[b]?.total ?? -1) ? i : b), 0);
  const shown = active ?? (series[peak]?.total ? peak : null);
  const sumCh = data.byChannel.reduce((a, c) => a + c.total, 0) || 1;
  const sumCat = data.byCategory.reduce((a, c) => a + c.total, 0) || 1;
  const maxShop = Math.max(1, ...data.byShop.map(s => s.total));

  const takeaways: { title: string; body: string; go?: () => void }[] = [];
  if (data.byChannel[0]) takeaways.push({ title: `${Math.round(data.byChannel[0].total / sumCh * 100)}% ${t('doanh thu đến từ', 'of revenue comes from')} ${data.byChannel[0].channel}`, body: `${M(data.byChannel[0].total)} ₫ / ${M(sumCh)} ₫` });
  if (ads && ads.campaigns.length) {
    const spend = ads.campaigns.reduce((a, c) => a + c.spend, 0);
    const winners = ads.campaigns.filter(c => c.spend > 0 && c.revenue / c.spend >= 2);
    const best = [...ads.campaigns].filter(c => c.spend > 0).sort((a, b) => b.revenue / b.spend - a.revenue / a.spend)[0];
    takeaways.push({ title: `${winners.length} / ${ads.campaigns.filter(c => c.spend > 0).length} ${t('chiến dịch vượt điểm hoà vốn ×2', 'campaigns clear the ×2 break-even')}`, body: best ? `${t('Tốt nhất', 'Best')}: ${best.name} · ×${(best.revenue / best.spend).toFixed(2)} · ${t('chi', 'spend')} ${M(spend)} ₫` : '', go: goAds });
  }
  if (svc && svc.night) takeaways.push({ title: `${svc.night} ${t('tin nhắn ban đêm (22h–8h) chờ đến sáng', 'night messages (22:00–8:00) wait until morning')}`, body: `${t('Ban ngày trả lời trong', 'Daytime reply in')} ${svc.daytimeMedian ?? '—'} ${t('phút', 'min')} · ${svc.never} ${t('không được trả lời', 'never answered')}`, go: goService });

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label={t('Doanh thu (hàng)', 'Revenue (goods)')} value={`${M(data.rangeTotal)} ₫`} sub={`${t('Tổng gồm phí', 'With fees')} ${M(data.rangeGrandTotal)} ₫`} />
        <Kpi label={t('Đơn hàng', 'Orders')} value={String(data.rangeCount)} sub={`≈ ${Math.round(data.rangeCount / span)} ${t('đơn/ngày', 'a day')}`} />
        <Kpi label={t('Giá trị TB/đơn', 'Average order')} value={`${K(avg)} ₫`} sub={t('chỉ tính hàng', 'goods only')} />
        <Kpi label={t('Chat → đơn', 'Chat → order')} value={chatPct != null ? `${chatPct}%` : '—'} sub={ads ? `${ads.chatConversationsWithOrder} / ${ads.conversations} ${t('hội thoại', 'conversations')}` : ''} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title={t('Doanh thu theo ngày giao', 'Revenue per delivery day')} sub={shown != null ? `${series[shown].label} · ${M(series[shown].total)} ₫` : ''} className="lg:col-span-2">
          <div className="flex items-end gap-[3px]" style={{ height: 180, borderBottom: `1px solid ${LINE}` }} onMouseLeave={() => setActive(null)}>
            {series.map((s, i) => (
              <button key={s.key} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} className="flex-1 h-full flex items-end" aria-label={`${s.label} ${M(s.total)}`}>
                <span style={{ width: '100%', height: `${Math.max(s.total > 0 ? 2 : 0, s.total / max * 100)}%`, borderRadius: '3px 3px 0 0', backgroundColor: i === shown ? GOLD : BAR }} />
              </button>
            ))}
          </div>
          <div className="flex justify-between" style={{ fontSize: 11, color: LIGHT }}>
            <span>{series[0]?.label}</span><span>{series[Math.floor(series.length / 2)]?.label}</span><span>{series[series.length - 1]?.label}</span>
          </div>
        </Card>
        <Card title={t('Điểm đáng chú ý', 'What stands out')}>
          {takeaways.map((k, i) => (
            <button key={i} onClick={k.go} disabled={!k.go} className="text-left flex gap-3 rounded-xl" style={{ backgroundColor: PANEL, padding: '10px 12px' }}>
              <span className="flex-none flex items-center justify-center" style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: DARK, color: '#FBF7F0', fontSize: 12, fontWeight: 700 }}>{i + 1}</span>
              <span className="flex flex-col gap-0.5"><b style={{ fontSize: 13, color: DARK, lineHeight: 1.35 }}>{k.title}</b><span style={{ fontSize: 12, color: MUTED }}>{k.body}</span></span>
            </button>
          ))}
        </Card>
      </div>

      {ads && (
        <Card title={t('Từ chat đến đơn hàng', 'From chat to order')} sub={t('Hội thoại Messenger, ghép với đơn qua số điện thoại', 'Messenger conversations, matched to orders by phone number')}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {[
              [t('Hội thoại mới', 'New conversations'), String(ads.conversations)],
              [t('Có để lại SĐT', 'Gave a phone number'), String(ads.conversationsWithPhone)],
              [t('Đã đặt hàng', 'Ordered'), String(ads.chatConversationsWithOrder)],
              [t('Doanh thu từ chat', 'Revenue from chats'), `${M(ads.chatRevenue)} ₫`],
            ].map(([l, v], i) => (
              <div key={l} className="rounded-xl flex flex-col gap-0.5" style={{ backgroundColor: i === 3 ? '#FBF3DF' : PANEL, padding: '10px 12px' }}>
                <span style={{ fontSize: 11.5, color: MUTED }}>{l}</span><b style={{ fontSize: 18, color: DARK }}>{v}</b>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title={t('Theo kênh', 'By channel')} sub={t('Bấm để xem sản phẩm', 'Tap to see products')}>
          {data.byChannel.map(c => (
            <div key={c.channel} className="flex flex-col gap-1">
              <button onClick={() => toggleCh(c.channel)} className="text-left flex flex-col gap-1">
                <span className="flex justify-between" style={{ fontSize: 12.5 }}><span>{openCh === c.channel ? '▾' : '▸'} {c.channel}</span><b>{M(c.total)} <span style={{ color: LIGHT, fontWeight: 500 }}>· {Math.round(c.total / sumCh * 100)}%</span></b></span>
                <span style={{ height: 7, borderRadius: 4, backgroundColor: PANEL, display: 'block' }}><span style={{ display: 'block', height: '100%', borderRadius: 4, width: `${c.total / sumCh * 100}%`, backgroundColor: '#B08A3E' }} /></span>
              </button>
              {openCh === c.channel && <ProductList items={chProducts[c.channel]} />}
            </div>
          ))}
        </Card>
        <Card title={t('Theo shop', 'By shop')}>
          {data.byShop.map(s => (
            <div key={s.shop} className="grid items-center gap-2" style={{ gridTemplateColumns: '110px minmax(0,1fr) 56px', fontSize: 12.5 }}>
              <span className="truncate">{s.shop}</span>
              <span style={{ height: 7, borderRadius: 4, backgroundColor: PANEL, display: 'block' }}><span style={{ display: 'block', height: '100%', borderRadius: 4, width: `${s.total / maxShop * 100}%`, backgroundColor: BAR }} /></span>
              <b style={{ textAlign: 'right' }}>{M(s.total)}</b>
            </div>
          ))}
        </Card>
        <Card title={t('Theo danh mục', 'By category')} sub={t('Bấm để xem sản phẩm', 'Tap to see products')}>
          {data.byCategory.map(c => (
            <div key={c.category} className="flex flex-col gap-1">
              <button onClick={() => setOpenCat(openCat === c.category ? null : c.category)} className="flex justify-between text-left" style={{ fontSize: 12.5 }}>
                <span>{openCat === c.category ? '▾' : '▸'} {c.category} <span style={{ color: LIGHT }}>({c.products.length})</span></span>
                <b>{M(c.total)} <span style={{ color: LIGHT, fontWeight: 500 }}>· {Math.round(c.total / sumCat * 100)}%</span></b>
              </button>
              {openCat === c.category && <ProductList items={c.products} />}
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function ProductList({ items }: { items: { name: string; sku: string | null; qty: number; total: number }[] | undefined }) {
  if (!items) return <div className="px-2 py-1.5" style={{ fontSize: 12, color: LIGHT }}><Loader2 size={12} className="animate-spin inline" /></div>;
  return (
    <div className="rounded-lg" style={{ backgroundColor: PANEL }}>
      {items.slice(0, 15).map((p, j) => (
        <div key={`${p.sku ?? p.name}-${j}`} className="flex justify-between gap-2 px-2.5 py-1.5" style={{ fontSize: 12, borderTop: j ? `1px solid ${LINE}` : 'none' }}>
          <span className="truncate">{p.name}</span><span className="flex-none">×{p.qty} · <b>{K(p.total)}</b></span>
        </div>
      ))}
    </div>
  );
}

function Ads({ extras, t }: { extras: OnlineStatsExtras | null; t: T }) {
  const ads = extras?.ads;
  const rows = useMemo(() => (ads?.campaigns ?? []).filter(c => c.spend > 0).map(c => ({ ...c, roas: c.revenue / c.spend, result: c.revenue * 0.5 - c.spend })).sort((a, b) => b.roas - a.roas), [ads]);
  if (!ads) return <Card><span style={{ fontSize: 13, color: MUTED }}>{t('Chưa có dữ liệu quảng cáo.', 'No ads data.')}</span></Card>;
  const spend = rows.reduce((a, c) => a + c.spend, 0);
  const rev = rows.reduce((a, c) => a + c.revenue, 0);
  const orders = rows.reduce((a, c) => a + c.orders, 0);
  const roas = spend ? rev / spend : 0;
  const result = rev * 0.5 - spend;
  const pos = (r: number) => `${Math.min(100, r / 3 * 100)}%`;
  return (
    <>
      <div className="flex gap-3 items-center rounded-2xl" style={{ backgroundColor: '#FBF3DF', border: '1px solid #EAD7A4', padding: '12px 16px' }}>
        <span className="flex-none flex items-center justify-center" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: DARK, color: '#FBF7F0', fontWeight: 700 }}>×2</span>
        <span style={{ fontSize: 13, color: '#5F4A10', lineHeight: 1.45 }}><b>{t('Điểm hoà vốn = ×2.', 'Break-even = ×2.')}</b> {t('Shop mua bánh với giá bằng 50% giá bán, nên một nửa mỗi đơn là tiền hàng. Quảng cáo phải mang về ít nhất gấp đôi chi phí.', 'Shops buy cakes at 50% of the selling price, so half of every order pays for the goods. An ad must bring back at least twice what it costs.')}</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label={t('Chi phí', 'Spend')} value={`${M(spend)} ₫`} sub={`${rows.length} ${t('chiến dịch', 'campaigns')}`} />
        <Kpi label={t('Doanh thu từ quảng cáo', 'Revenue traced to ads')} value={`${M(rev)} ₫`} sub={`${orders} ${t('đơn', 'orders')}${orders ? ` · ${K(spend / orders)} ${t('chi phí/đơn', 'ad cost each')}` : ''}`} />
        <Kpi label={t('Hiệu quả chung', 'Overall return')} value={`×${roas.toFixed(2)}`} sub={t('hoà vốn là ×2', 'break-even is ×2')} tone={roas >= 2 ? 'green' : 'red'} />
        <Kpi label={t('Kết quả sau hàng & QC', 'Result after goods & ads')} value={`${result >= 0 ? '+' : '−'}${M(Math.abs(result))} ₫`} sub={t('chỉ trên đơn truy được', 'on traced orders only')} tone={result >= 0 ? 'green' : 'red'} />
      </div>
      <Card title={t('Chiến dịch', 'Campaigns')} sub={t('Mỗi đồng chi mang về bao nhiêu · vạch là điểm hoà vốn', 'Return on each đồng spent · the line marks break-even')}>
        {rows.map(c => (
          <div key={c.name} className="grid gap-x-4 gap-y-1.5 items-center py-2" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', borderTop: `1px solid ${PANEL}` }}>
            <span className="flex flex-col min-w-0"><b className="truncate" style={{ fontSize: 13.5, color: DARK }}>{c.name}</b>
              <span style={{ fontSize: 12, color: MUTED }}>{M(c.spend)} {t('chi', 'spent')} · {c.chats} chat · {c.orders} {t('đơn', 'orders')} · {M(c.revenue)} {t('doanh thu', 'revenue')}</span></span>
            <span className="flex flex-col items-end"><b style={{ fontSize: 16, color: c.roas >= 2 ? GREEN : RED }}>×{c.roas.toFixed(2)}</b><span style={{ fontSize: 11.5, color: c.result >= 0 ? GREEN : RED }}>{c.result >= 0 ? '+' : '−'}{M(Math.abs(c.result))}</span></span>
            <span className="relative col-span-2" style={{ height: 8, borderRadius: 4, backgroundColor: PANEL, display: 'block' }}>
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pos(c.roas), borderRadius: 4, backgroundColor: c.roas >= 2 ? GREEN : '#B08A3E' }} />
              <span style={{ position: 'absolute', left: pos(2), top: -3, bottom: -3, width: 2, backgroundColor: DARK }} />
            </span>
          </div>
        ))}
        <div className="flex justify-between" style={{ fontSize: 11, color: LIGHT }}><span>×0</span><span>×1</span><span style={{ fontWeight: 700, color: DARK }}>×2</span><span>×3</span></div>
      </Card>
      <div className="rounded-xl" style={{ backgroundColor: PANEL, padding: '12px 14px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        <b style={{ color: DARK }}>{t('Đây là con số tối thiểu.', 'Read these as minimums.')}</b> {t('Chỉ tính các đơn ghép được với chat của quảng cáo (qua SĐT hoặc nút "Tạo đơn"). Khách gọi điện hoặc mua tại shop không được tính.', 'Only orders linked to the ad’s chat are counted (by phone number or the “Create order” button). Customers who call or buy in a shop are not counted.')}
      </div>
    </>
  );
}

function Service({ extras, t, onOpenInbox }: { extras: OnlineStatsExtras | null; t: T; onOpenInbox?: () => void }) {
  const svc = extras?.service;
  const [active, setActive] = useState<number | null>(null);
  if (!svc) return <Card><span style={{ fontSize: 13, color: MUTED }}>{t('Chưa có dữ liệu tin nhắn.', 'No message data.')}</span></Card>;
  const hours = Array.from({ length: 24 }, (_, h) => svc.hours.find(x => x.h === h) ?? { h, n: 0, median: null, never: 0 });
  const max = Math.max(1, ...hours.map(h => h.n));
  const busiest = hours.reduce((b, h) => (h.n > b.n ? h : b), hours[0]);
  const shown = active != null ? hours[active] : busiest;
  const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} ${t('ngày', 'days')}`; };
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label={t('Trả lời đầu tiên · ban ngày', 'First reply · daytime')} value={svc.daytimeMedian != null ? `${svc.daytimeMedian} min` : '—'} sub={t('trung vị, 8:00–22:00', 'median, 8:00–22:00')} />
        <Kpi label={t('Trả lời trong 5 phút', 'Answered within 5 min')} value={svc.within5Pct != null ? `${svc.within5Pct}%` : '—'} sub={`${svc.total} ${t('lượt khách nhắn', 'customer messages')}`} />
        <Kpi label={t('Chờ ban đêm', 'Night wait')} value={svc.nightMaxHours != null ? `${t('tới', 'up to')} ${svc.nightMaxHours} h` : '—'} sub={`${svc.night} ${t('tin nhắn 22:00–8:00', 'messages 22:00–8:00')}`} tone="red" />
        <Kpi label={t('Không được trả lời', 'Never answered')} value={String(svc.never)} sub={`${svc.lateOrNever} ${t('chờ hơn 1h hoặc không trả lời', 'waited over 1 h or got no reply')}`} tone="red" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title={t('Khách nhắn lúc nào', 'When customers write')} sub={`${shown.h}h · ${shown.n} ${t('tin', 'messages')} · ${t('trả lời sau', 'median reply')} ${shown.median ?? '—'} min`} className="lg:col-span-2">
          <div className="flex items-end gap-1" style={{ height: 170, borderBottom: `1px solid ${LINE}` }} onMouseLeave={() => setActive(null)}>
            {hours.map((h, i) => (
              <button key={h.h} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} className="flex-1 h-full flex items-end" aria-label={`${h.h}h`}>
                <span style={{ width: '100%', height: `${Math.max(h.n ? 2 : 0, h.n / max * 100)}%`, borderRadius: '3px 3px 0 0', backgroundColor: i === active ? GOLD : (h.h >= 22 || h.h < 8) ? NIGHT : BAR }} />
              </button>
            ))}
          </div>
          <div className="flex justify-between" style={{ fontSize: 11, color: LIGHT }}><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
          <div className="flex gap-4 flex-wrap" style={{ fontSize: 12, color: MUTED }}>
            <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: BAR }} />{t('Có người trực', 'Staff on shift')}</span>
            <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: NIGHT }} />22:00–8:00</span>
          </div>
        </Card>
        <Card title={`${t('Đang chờ trả lời', 'Waiting for a reply')} · ${extras?.waitingCount ?? 0}`} sub={t('Khách nhắn hơn 1 giờ, chưa ai trả lời (7 ngày)', 'Customer wrote over 1 h ago, no reply yet (7 days)')}>
          {(extras?.waiting ?? []).length === 0 && <span style={{ fontSize: 13, color: LIGHT }}>✓ {t('Không có', 'None')}</span>}
          {(extras?.waiting ?? []).map(w => (
            <div key={w.id} className="flex items-center gap-3" style={{ borderTop: `1px solid ${PANEL}`, paddingTop: 8 }}>
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="flex gap-2 items-baseline"><b className="truncate" style={{ fontSize: 13.5, color: DARK }}>{w.name || '—'}</b><span style={{ fontSize: 11.5, color: RED, fontWeight: 600, flex: 'none' }}>{ago(w.since)}</span></span>
                <span className="truncate" style={{ fontSize: 12, color: MUTED }}>{w.page ? `${w.page} · ` : ''}{w.preview}</span>
              </span>
            </div>
          ))}
          {onOpenInbox && <button onClick={onOpenInbox} style={{ minHeight: 40, borderRadius: 11, backgroundColor: DARK, color: '#FBF7F0', fontSize: 13, fontWeight: 700 }}>{t('Mở tin nhắn', 'Open messages')}</button>}
        </Card>
      </div>
    </>
  );
}
