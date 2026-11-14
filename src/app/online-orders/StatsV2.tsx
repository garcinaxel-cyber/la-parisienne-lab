'use client';
// Stats, UI v2 (Axel, 2026-11-14): one analysis period (from → to), three sub-tabs.
//  · Overview — revenue, orders, basket, chat → order, daily curve, channels / shops / categories
//    (with the product drill-downs kept from v1), customers new vs returning, weekdays, money to
//    collect, refunds, lab vs shop stock.
//  · Ads — Meta spend (ads_insights_daily, synced daily) vs revenue traced to each ad's chats.
//    Break-even = ×2 because shops buy at 50% of the selling price.
//  · Customer service — reply speed by hour / page / weekday, night messages, chats waiting.
// Read-only. Data: getOnlineAnalyticsAction + getOnlineStatsExtrasAction (SQL helpers lab_v155/156).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as actions from './actions';
import type { OnlineAnalytics, OnlineStatsExtras, ChannelProductDetail } from './actions';
import { useL } from './shared';
import { swr } from './client-cache';

// Neutrals from the staff-theme palette (re-tinted by the colour themes); status colours fixed.
const CARD = '#FFFFFF', LINE = '#E6DCCF', PANEL = '#F7F1E8', COL = '#EDE4D6';
const DARK = '#2A1810', DEEP = '#1F120C', INK = '#2E1B12', MUTED = '#6B5A4C', LIGHT = '#8A7A66', GOLD = '#C9A84C', GOLD2 = '#D9B36A', BAR = '#572C1A', SOFT = '#D9CBB8';
const RED = '#9A3324', GREEN = '#1F5235', CREAM_TXT = '#FBF7F0';
const PALETTE = ['#572C1A', '#C9A84C', '#8B5E34', '#D9CBB8', '#6B5A4C', '#A39484', '#2E1B12'];
const SERIF = "'Playfair Display', Georgia, serif";

type Sub = 'overview' | 'ads' | 'service';
type T = (vi: string, en: string) => string;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const M = (v: number) => `${(v / 1e6).toFixed(1)}M`;
const MK = (v: number) => v < 1e6 ? `${Math.round(v / 1000)}k` : M(v);
const K = (v: number) => (Math.abs(v) >= 1e6 ? M(v) : `${Math.round(v / 1000)}k`);
const N = (v: number) => Math.round(v).toLocaleString('vi-VN');

export default function StatsV2({ onOpenInbox }: { onOpenInbox?: () => void }) {
  const { lang } = useL();
  const t: T = (vi, en) => (lang === 'en' ? en : vi);
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
  const fmtD = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { day: 'numeric', month: 'short' });

  return (
    <div className="flex flex-col gap-5" style={{ color: INK, fontVariantNumeric: 'lining-nums tabular-nums', fontFeatureSettings: '"lnum" 1, "tnum" 1' }}>
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
        <div className="flex flex-col gap-3">
          <div className="hidden lg:flex items-baseline gap-3">
            <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: DARK }}>{t('Thống kê', 'Stats')}</h1>
            <span style={{ fontSize: 13, color: MUTED }}>{fmtD(from)} → {fmtD(to)} · {span} {t('ngày', 'days')}</span>
          </div>
          <nav className="flex gap-1 rounded-xl p-1 w-fit" style={{ backgroundColor: COL }}>
            {([['overview', t('Tổng quan', 'Overview')], ['ads', t('Quảng cáo', 'Ads')], ['service', t('Chăm sóc KH', 'Customer service')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setSub(k)} style={{
                minHeight: 38, padding: '0 16px', borderRadius: 9, fontSize: 13.5, fontWeight: sub === k ? 700 : 600,
                backgroundColor: sub === k ? CARD : 'transparent', color: sub === k ? DARK : MUTED, boxShadow: sub === k ? '0 1px 3px rgba(42,24,16,0.12)' : 'none',
              }}>{label}</button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {[7, 30, 90].map(n => (
            <button key={n} onClick={() => preset(n)} style={{ fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: '8px 13px', backgroundColor: isPreset(n) ? DARK : CARD, color: isPreset(n) ? CREAM_TXT : INK, border: `1px solid ${isPreset(n) ? DARK : LINE}` }}>{n} {t('ngày', 'days')}</button>
          ))}
          <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: '6px 9px' }}>
            {t('Từ', 'From')}<input type="date" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: INK, background: 'transparent' }} />
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: '6px 9px' }}>
            {t('Đến', 'To')}<input type="date" value={to} min={from} onChange={e => e.target.value && setTo(e.target.value)} style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: INK, background: 'transparent' }} />
          </label>
          {loading && <Loader2 size={15} className="animate-spin" color={LIGHT} />}
        </div>
      </div>

      {error && <div className="rounded-2xl p-5 text-center" style={{ backgroundColor: CARD, color: MUTED, fontSize: 13 }}>{t('Không tải được thống kê cho kỳ này.', 'Could not load stats for this period.')}</div>}
      {!data && !error && <div className="text-center py-16" style={{ color: LIGHT }}><Loader2 className="animate-spin inline" /></div>}
      {data && !error && (
        <div style={{ opacity: loading ? 0.65 : 1, transition: 'opacity .2s' }} className="flex flex-col gap-4">
          {sub === 'overview' && <Overview key={`${from}${to}`} data={data} extras={extras} span={span} t={t} goAds={() => setSub('ads')} goService={() => setSub('service')} />}
          {sub === 'ads' && <Ads key={`${from}${to}`} extras={extras} t={t} />}
          {sub === 'service' && <Service key={`${from}${to}`} extras={extras} t={t} onOpenInbox={onOpenInbox} />}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── building blocks ─────────────────────────

function Card({ title, sub, right, children, className = '', dark = false }: { title?: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; className?: string; dark?: boolean }) {
  return (
    <section className={`rounded-[20px] flex flex-col gap-4 min-w-0 ${className}`} style={{
      backgroundColor: dark ? DARK : CARD, color: dark ? CREAM_TXT : INK, padding: '18px 20px',
      boxShadow: dark ? '0 10px 30px rgba(42,24,16,0.25)' : '0 1px 2px rgba(42,24,16,0.04), 0 8px 24px rgba(42,24,16,0.05)',
    }}>
      {(title || right) && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            {title && <b style={{ fontSize: 15, color: dark ? CREAM_TXT : DARK }}>{title}</b>}
            {sub && <span style={{ fontSize: 12, color: dark ? '#D9C48A' : LIGHT }}>{sub}</span>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Kpi({ label, value, unit, sub, tone, icon }: { label: string; value: string; unit?: string; sub?: string; tone?: 'red' | 'green'; icon?: string }) {
  return (
    <div className="rounded-[20px] flex flex-col gap-1.5 min-w-0" style={{ backgroundColor: CARD, padding: '16px 18px', boxShadow: '0 1px 2px rgba(42,24,16,0.04), 0 8px 24px rgba(42,24,16,0.05)' }}>
      <span className="flex items-center gap-2" style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>
        {icon && <span className="flex items-center justify-center" style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: PANEL, fontSize: 13 }}>{icon}</span>}{label}
      </span>
      <span style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.1, color: tone === 'red' ? RED : tone === 'green' ? GREEN : DARK }}>
        {value}{unit && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, fontWeight: 600, color: LIGHT, marginLeft: 3 }}>{unit}</span>}
      </span>
      {sub && <span style={{ fontSize: 12, color: LIGHT }}>{sub}</span>}
    </div>
  );
}

// Smooth area chart with grid, average line and hover read-out.
function AreaChart({ points, height = 220, color = BAR, fill = GOLD, avg, fmt, secondary, secondaryColor = GOLD }: {
  points: { label: string; value: number }[]; height?: number; color?: string; fill?: string; avg?: number; fmt: (v: number) => string;
  secondary?: number[]; secondaryColor?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the real pixel width (no SVG scaling) so labels keep their size on any screen.
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useLayoutEffect(() => {
    const el = boxRef.current; if (!el) return;
    const set = () => setW(Math.max(260, Math.round(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, P = { l: 44, r: 10, t: 14, b: 26 };
  const n = Math.max(1, points.length);
  const max = Math.max(1, ...points.map(p => p.value), ...(secondary ?? [0])) * 1.08;
  const x = (i: number) => P.l + (n === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (n - 1));
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / max);
  const path = (vals: number[]) => vals.map((v, i) => {
    if (i === 0) return `M${x(0)},${y(v)}`;
    const cx = (x(i - 1) + x(i)) / 2;
    return `C${cx},${y(vals[i - 1])} ${cx},${y(v)} ${x(i)},${y(v)}`;
  }).join(' ');
  const vals = points.map(p => p.value);
  const line = path(vals);
  const area = `${line} L${x(n - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f / 1.08);
  const peak = vals.indexOf(Math.max(...vals));
  const sh = hover ?? peak;
  const gid = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 110))));
  return (
    <div ref={boxRef} className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ overflow: 'visible', display: 'block' }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * W; setHover(Math.max(0, Math.min(n - 1, Math.round((px - P.l) / ((W - P.l - P.r) / Math.max(1, n - 1)))))); }}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={fill} stopOpacity="0.45" /><stop offset="100%" stopColor={fill} stopOpacity="0.02" /></linearGradient>
        </defs>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke={LINE} strokeDasharray={i ? '3 4' : undefined} />
            <text x={P.l - 8} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill={LIGHT}>{fmt(v)}</text>
          </g>
        ))}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {secondary && <path d={path(secondary)} fill="none" stroke={secondaryColor} strokeWidth="2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
        {avg != null && avg > 0 && <g><line x1={P.l} x2={W - P.r} y1={y(avg)} y2={y(avg)} stroke={GOLD} strokeWidth="1.2" strokeDasharray="6 5" /></g>}
        {points.map((p, i) => i % labelEvery === 0 || i === n - 1 ? <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize="10.5" fill={LIGHT}>{p.label}</text> : null)}
        {points[sh] && (
          <g>
            <line x1={x(sh)} x2={x(sh)} y1={P.t} y2={H - P.b} stroke={SOFT} />
            <circle cx={x(sh)} cy={y(vals[sh])} r="5" fill={CARD} stroke={color} strokeWidth="2.5" />
          </g>
        )}
      </svg>
      {points[sh] && (
        <div className="absolute pointer-events-none rounded-lg" style={{
          left: `${Math.min(82, Math.max(2, x(sh) / W * 100 - 6))}%`, top: 0, backgroundColor: DARK, color: CREAM_TXT, fontSize: 12, padding: '5px 9px', whiteSpace: 'nowrap',
        }}><b>{fmt(vals[sh])}</b> · {points[sh].label}{secondary ? ` · ${fmt(secondary[sh] ?? 0)}` : ''}</div>
      )}
    </div>
  );
}

function Donut({ items, size = 150, center, centerSub }: { items: { label: string; value: number; color: string }[]; size?: number; center: string; centerSub?: string }) {
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0) || 1;
  const r = 52, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg viewBox="0 0 140 140" width={size} height={size} className="flex-none">
      <circle cx="70" cy="70" r={r} fill="none" stroke={PANEL} strokeWidth="18" />
      {items.map((it, i) => {
        const len = Math.max(0, it.value) / total * c;
        const el = <circle key={i} cx="70" cy="70" r={r} fill="none" stroke={it.color} strokeWidth="18" strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
        off += len;
        return el;
      })}
      <text x="70" y="68" textAnchor="middle" fontSize="19" fontWeight="700" fill={DARK} style={{ fontFamily: SERIF }}>{center}</text>
      {centerSub && <text x="70" y="86" textAnchor="middle" fontSize="10" fill={LIGHT}>{centerSub}</text>}
    </svg>
  );
}

function Ring({ pct, color = GOLD, track = 'rgba(255,255,255,0.12)', size = 84, label, labelColor = CREAM_TXT }: { pct: number; color?: string; track?: string; size?: number; label: string; labelColor?: string }) {
  const r = 34, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 84 84" width={size} height={size} className="flex-none">
      <circle cx="42" cy="42" r={r} fill="none" stroke={track} strokeWidth="9" />
      <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${Math.min(1, Math.max(0, pct)) * c} ${c}`} transform="rotate(-90 42 42)" />
      <text x="42" y="47" textAnchor="middle" fontSize="16" fontWeight="700" fill={labelColor}>{label}</text>
    </svg>
  );
}

function Sparkline({ values, color = GOLD, height = 54 }: { values: number[]; color?: string; height?: number }) {
  const W = 300, H = height, n = Math.max(2, values.length), max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (n - 1)) * W},${H - 4 - (v / max) * (H - 8)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={color} opacity="0.18" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function HBar({ label, value, max, right, color = BAR, rank }: { label: React.ReactNode; value: number; max: number; right: React.ReactNode; color?: string; rank?: number }) {
  return (
    <div className="flex items-center gap-3" style={{ fontSize: 12.5 }}>
      {rank != null && <span className="flex-none flex items-center justify-center" style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: rank === 1 ? GOLD : PANEL, color: rank === 1 ? DARK : MUTED, fontSize: 11, fontWeight: 700 }}>{rank}</span>}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex justify-between gap-2"><span className="truncate">{label}</span><span className="flex-none">{right}</span></div>
        <span style={{ height: 8, borderRadius: 4, backgroundColor: PANEL, display: 'block', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', borderRadius: 4, width: `${Math.max(2, value / Math.max(1, max) * 100)}%`, backgroundColor: color }} /></span>
      </div>
    </div>
  );
}

function ProductList({ items }: { items: { name: string; sku: string | null; qty: number; total: number }[] | undefined }) {
  if (!items) return <div className="px-2 py-1.5" style={{ fontSize: 12, color: LIGHT }}><Loader2 size={12} className="animate-spin inline" /></div>;
  return (
    <div className="rounded-xl" style={{ backgroundColor: PANEL }}>
      {items.slice(0, 15).map((p, j) => (
        <div key={`${p.sku ?? p.name}-${j}`} className="flex justify-between gap-2 px-3 py-1.5" style={{ fontSize: 12, borderTop: j ? `1px solid ${LINE}` : 'none' }}>
          <span className="truncate">{p.name}</span><span className="flex-none">×{p.qty} · <b>{K(p.total)}</b></span>
        </div>
      ))}
    </div>
  );
}

const DOW = (t: T) => [t('T2', 'Mon'), t('T3', 'Tue'), t('T4', 'Wed'), t('T5', 'Thu'), t('T6', 'Fri'), t('T7', 'Sat'), t('CN', 'Sun')];

// ───────────────────────── Overview ─────────────────────────

function Overview({ data, extras, span, t, goAds, goService }: { data: OnlineAnalytics; extras: OnlineStatsExtras | null; span: number; t: T; goAds: () => void; goService: () => void }) {
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [openCh, setOpenCh] = useState<string | null>(null);
  const [chProducts, setChProducts] = useState<Record<string, ChannelProductDetail[]>>({});
  async function toggleCh(ch: string) {
    if (openCh === ch) { setOpenCh(null); return; }
    setOpenCh(ch);
    if (!chProducts[ch]) {
      const res = await actions.getChannelProductDetailsAction(ch, data.rangeStart, data.rangeEnd).catch(() => ({ data: [] as ChannelProductDetail[] }));
      setChProducts(p => ({ ...p, [ch]: res.data ?? [] }));
    }
  }
  const ads = extras?.ads, svc = extras?.service, ov = extras?.overview;
  const avg = data.rangeCount ? data.rangeTotal / data.rangeCount : 0;
  const chatPct = ads && ads.conversations ? ads.chatConversationsWithOrder / ads.conversations : null;
  const points = data.series.map(s => ({ label: s.label, value: s.total }));
  const avgPerBucket = points.length ? points.reduce((a, p) => a + p.value, 0) / points.length : 0;
  const sumCh = data.byChannel.reduce((a, c) => a + c.total, 0) || 1;
  const sumCat = data.byCategory.reduce((a, c) => a + c.total, 0) || 1;
  const maxShop = Math.max(1, ...data.byShop.map(s => s.total));
  const peakIdx = points.findIndex(p => p.value === Math.max(...points.map(q => q.value)));

  const takeaways: { title: string; body: string; go?: () => void }[] = [];
  if (data.byChannel[0]) takeaways.push({ title: `${Math.round(data.byChannel[0].total / sumCh * 100)}% ${t('doanh thu đến từ', 'of revenue comes from')} ${data.byChannel[0].channel}`, body: `${M(data.byChannel[0].total)} ₫ ${t('trên', 'of')} ${M(sumCh)} ₫` });
  if (ov && ov.returningCustomers + ov.newCustomers > 0) takeaways.push({ title: `${Math.round(ov.returningCustomers / (ov.returningCustomers + ov.newCustomers) * 100)}% ${t('khách quay lại', 'of customers came back')}`, body: `${ov.returningCustomers} ${t('khách cũ', 'returning')} · ${ov.newCustomers} ${t('khách mới', 'new')}` });
  if (ads && ads.campaigns.length) {
    const live = ads.campaigns.filter(c => c.spend > 0);
    const best = [...live].sort((a, b) => b.revenue / b.spend - a.revenue / a.spend)[0];
    takeaways.push({ title: `${live.filter(c => c.revenue / c.spend >= 2).length} / ${live.length} ${t('chiến dịch vượt hoà vốn ×2', 'campaigns clear the ×2 break-even')}`, body: best ? `${t('Tốt nhất', 'Best')}: ${best.name} · ×${(best.revenue / best.spend).toFixed(2)}` : '', go: goAds });
  }
  if (svc && svc.night) takeaways.push({ title: `${svc.night} ${t('tin nhắn ban đêm chờ đến sáng', 'night messages wait until morning')}`, body: `${t('Ban ngày trả lời trong', 'Daytime reply in')} ${svc.daytimeMedian ?? '—'} min`, go: goService });
  if (ov && ov.unpaidOrders) takeaways.push({ title: `${M(ov.unpaidAmount)} ₫ ${t('chưa thu', 'still to collect')}`, body: `${ov.unpaidOrders} ${t('đơn chưa thanh toán đủ', 'orders not fully paid')}` });

  const weekdays = ov?.weekdays ?? [];
  const wMax = Math.max(1, ...weekdays.map(w => w.revenue));
  const srcLabel = (s: string) => s === 'lab' ? t('Lab sản xuất', 'Made by the lab') : s === 'shop_stock' ? t('Kho shop', 'Shop stock') : s === 'excel_import' ? t('Bán kho (nhập Excel)', 'Shop stock (imported)') : s;

  return (
    <>
      {/* Hero row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card dark className="col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#D9C48A', fontWeight: 700 }}>{t('Doanh thu (hàng)', 'Revenue (goods)')}</span>
              <span style={{ fontFamily: SERIF, fontSize: 46, fontWeight: 700, lineHeight: 1.05, color: CREAM_TXT }}>{M(data.rangeTotal)}<span style={{ fontSize: 20, color: GOLD2, marginLeft: 6 }}>₫</span></span>
              <span style={{ fontSize: 12.5, color: '#E8DCCB' }}>{t('Gồm phí', 'With fees')} {M(data.rangeGrandTotal)} ₫ · {M(data.rangeTotal / span)} ₫ / {t('ngày', 'day')}</span>
            </div>
            {chatPct != null && (
              <div className="flex flex-col items-center gap-1">
                <Ring pct={chatPct} label={`${Math.round(chatPct * 100)}%`} />
                <span style={{ fontSize: 11, color: '#D9C48A', textAlign: 'center' }}>{t('chat → đơn', 'chat → order')}</span>
              </div>
            )}
          </div>
          <Sparkline values={points.map(p => p.value)} color={GOLD2} height={56} />
        </Card>
        <div className="col-span-2 grid grid-cols-2 gap-4">
          <Kpi icon="🧾" label={t('Đơn hàng', 'Orders')} value={N(data.rangeCount)} sub={`≈ ${Math.round(data.rangeCount / span)} ${t('đơn/ngày', 'a day')}`} />
          <Kpi icon="🛍" label={t('Giá trị TB/đơn', 'Average order')} value={K(avg)} unit="₫" sub={t('chỉ tính hàng', 'goods only')} />
          <Kpi icon="🔁" label={t('Khách quay lại', 'Returning customers')} value={ov && ov.newCustomers + ov.returningCustomers ? `${Math.round(ov.returningCustomers / (ov.newCustomers + ov.returningCustomers) * 100)}%` : '—'} sub={ov ? `${ov.returningCustomers} / ${ov.newCustomers + ov.returningCustomers} ${t('khách', 'customers')}` : ''} />
          <Kpi icon="⏳" label={t('Chưa thu', 'To collect')} value={ov ? M(ov.unpaidAmount) : '—'} unit="₫" tone={ov && ov.unpaidAmount > 0 ? 'red' : undefined} sub={ov ? `${ov.unpaidOrders} ${t('đơn chưa thanh toán đủ', 'orders not fully paid')}` : ''} />
        </div>
      </div>

      {/* Curve + takeaways */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2" title={t('Doanh thu theo ngày giao', 'Revenue per delivery day')}
          sub={peakIdx >= 0 && points[peakIdx] ? `${t('Cao nhất', 'Peak')} ${points[peakIdx].label} · ${M(points[peakIdx].value)} ₫ · ${t('đường vàng = trung bình', 'gold line = average')}` : ''}>
          <AreaChart points={points} avg={avgPerBucket} fmt={v => K(v)} />
        </Card>
        <Card title={t('Điểm đáng chú ý', 'What stands out')}>
          <div className="flex flex-col gap-2.5">
            {takeaways.slice(0, 4).map((k, i) => (
              <button key={i} onClick={k.go} disabled={!k.go} className="text-left flex gap-3 rounded-2xl" style={{ backgroundColor: PANEL, padding: '11px 13px', cursor: k.go ? 'pointer' : 'default' }}>
                <span className="flex-none flex items-center justify-center" style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: i === 0 ? GOLD : DARK, color: i === 0 ? DARK : CREAM_TXT, fontSize: 12, fontWeight: 700 }}>{i + 1}</span>
                <span className="flex flex-col gap-0.5 min-w-0"><b style={{ fontSize: 13, color: DARK, lineHeight: 1.35 }}>{k.title}</b><span style={{ fontSize: 12, color: MUTED }}>{k.body}{k.go ? ' ›' : ''}</span></span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Funnel + customers + money */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {ads && (
          <Card title={t('Từ chat đến đơn hàng', 'From chat to order')} sub={t('Hội thoại mới trong kỳ, ghép với đơn qua SĐT', 'New conversations, matched to orders by phone')}>
            {[
              [t('Hội thoại mới', 'New conversations'), ads.conversations],
              [t('Để lại SĐT', 'Gave a phone number'), ads.conversationsWithPhone],
              [t('Đã đặt hàng', 'Ordered'), ads.chatConversationsWithOrder],
            ].map(([l, v], i) => {
              const w = ads.conversations ? (v as number) / ads.conversations : 0;
              return (
                <div key={l as string} className="flex flex-col gap-1">
                  <div className="flex justify-between" style={{ fontSize: 12.5 }}><span>{l}</span><b>{N(v as number)}{i ? <span style={{ color: LIGHT, fontWeight: 500 }}> · {Math.round(w * 100)}%</span> : null}</b></div>
                  <div style={{ height: 26, borderRadius: 8, backgroundColor: PANEL, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(3, w * 100)}%`, borderRadius: 8, backgroundColor: [BAR, '#8B5E34', GOLD][i] }} />
                  </div>
                </div>
              );
            })}
            <div className="rounded-xl flex justify-between items-center" style={{ backgroundColor: '#FBF3DF', padding: '10px 12px', fontSize: 12.5, color: '#5F4A10' }}>
              <span>{t('Doanh thu từ chat', 'Revenue from chats')}</span><b style={{ fontSize: 15 }}>{M(ads.chatRevenue)} ₫</b>
            </div>
          </Card>
        )}
        {ov && (
          <Card title={t('Khách hàng', 'Customers')} sub={`${ov.newCustomers + ov.returningCustomers} ${t('khách có SĐT trong kỳ', 'customers with a phone in the period')}`}>
            <div className="flex items-center gap-4">
              <Donut size={132} center={`${Math.round(ov.returningCustomers / Math.max(1, ov.newCustomers + ov.returningCustomers) * 100)}%`} centerSub={t('quay lại', 'returning')}
                items={[{ label: 'new', value: ov.newCustomers, color: SOFT }, { label: 'ret', value: ov.returningCustomers, color: GOLD }]} />
              <div className="flex-1 flex flex-col gap-2.5" style={{ fontSize: 12.5 }}>
                <div className="flex flex-col"><span className="flex items-center gap-2"><span style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: SOFT }} />{t('Khách mới', 'New')}</span><b style={{ fontSize: 16 }}>{ov.newCustomers} · {M(ov.newRevenue)} ₫</b></div>
                <div className="flex flex-col"><span className="flex items-center gap-2"><span style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: GOLD }} />{t('Khách quay lại', 'Returning')}</span><b style={{ fontSize: 16 }}>{ov.returningCustomers} · {M(ov.returningRevenue)} ₫</b></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                [t('Chi tiêu / khách mới', 'Spend per new customer'), ov.newCustomers ? `${MK(ov.newRevenue / ov.newCustomers)} ₫` : '—'],
                [t('Chi tiêu / khách quay lại', 'Spend per returning one'), ov.returningCustomers ? `${MK(ov.returningRevenue / ov.returningCustomers)} ₫` : '—'],
              ].map(([l, v]) => (
                <div key={l} className="rounded-xl flex flex-col" style={{ backgroundColor: PANEL, padding: '10px 12px' }}>
                  <span style={{ fontSize: 11.5, color: MUTED }}>{l}</span><b style={{ fontSize: 17, color: DARK }}>{v}</b>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 12, color: MUTED }}>
              {t('Khách quay lại mang', 'Returning customers bring')} <b style={{ color: DARK }}>{Math.round(ov.returningRevenue / Math.max(1, ov.newRevenue + ov.returningRevenue) * 100)}%</b> {t('doanh thu', 'of revenue')}
            </span>
          </Card>
        )}
        {ov && (
          <Card title={t('Tiền & nguồn hàng', 'Money & supply')}>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                [t('Chưa thu', 'To collect'), `${M(ov.unpaidAmount)} ₫`, `${ov.unpaidOrders} ${t('đơn', 'orders')}`, ov.unpaidAmount > 0 ? RED : DARK],
                [t('Hoàn tiền', 'Refunds'), `${M(ov.refunds)} ₫`, `${ov.refundOrders} ${t('đơn', 'orders')}`, DARK],
                [t('Phí giao hàng', 'Delivery fees'), `${M(ov.deliveryFees)} ₫`, t('thu thêm', 'charged on top'), DARK],
                [t('Có SĐT', 'With phone'), `${data.rangeCount ? Math.round(ov.withPhone / data.rangeCount * 100) : 0}%`, `${ov.withPhone} ${t('đơn', 'orders')}`, DARK],
              ].map(([l, v, s, c]) => (
                <div key={l} className="rounded-xl flex flex-col" style={{ backgroundColor: PANEL, padding: '10px 12px' }}>
                  <span style={{ fontSize: 11.5, color: MUTED }}>{l}</span><b style={{ fontSize: 17, color: c }}>{v}</b><span style={{ fontSize: 11, color: LIGHT }}>{s}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {[...ov.bySource].sort((a, b) => b.revenue - a.revenue).map(s => (
                <HBar key={s.source} label={srcLabel(s.source)} value={s.revenue} max={Math.max(1, ...ov.bySource.map(x => x.revenue))} right={<b>{M(s.revenue)} <span style={{ color: LIGHT, fontWeight: 500 }}>· {s.orders}</span></b>} color={s.source === 'lab' ? BAR : s.source === 'shop_stock' ? GOLD : SOFT} />
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Channels / shops / categories */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title={t('Theo kênh', 'By channel')} sub={t('Bấm để xem sản phẩm', 'Tap to see products')}>
          <div className="flex items-center gap-4">
            <Donut size={140} center={`${data.byChannel.length}`} centerSub={t('kênh', 'channels')} items={data.byChannel.map((c, i) => ({ label: c.channel, value: c.total, color: PALETTE[i % PALETTE.length] }))} />
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              {data.byChannel.filter(c => c.total / sumCh >= 0.01).slice(0, 6).map((c, i) => (
                <div key={c.channel} className="flex flex-col gap-1">
                  <button onClick={() => toggleCh(c.channel)} className="flex items-center gap-2 text-left" style={{ fontSize: 12.5 }}>
                    <span className="flex-none" style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: PALETTE[i % PALETTE.length] }} />
                    <span className="flex-1 truncate">{c.channel}</span>
                    <span className="flex-none" style={{ color: LIGHT }}>{M(c.total)}</span>
                    <b className="flex-none text-right" style={{ width: 40 }}>{Math.round(c.total / sumCh * 100)}%</b>
                  </button>
                </div>
              ))}
              {data.byChannel.some(c => c.total / sumCh < 0.01) && (
                <span style={{ fontSize: 11.5, color: LIGHT }}>
                  + {data.byChannel.filter(c => c.total / sumCh < 0.01).map(c => c.channel).join(', ')} · {'<'} 1%
                </span>
              )}
            </div>
          </div>
          {openCh && <div className="flex flex-col gap-1"><span style={{ fontSize: 12, fontWeight: 700 }}>{openCh}</span><ProductList items={chProducts[openCh]} /></div>}
        </Card>
        <Card title={t('Theo shop', 'By shop')}>
          <div className="flex flex-col gap-3">
            {data.byShop.map((s, i) => <HBar key={s.shop} rank={i + 1} label={s.shop} value={s.total} max={maxShop} right={<b>{M(s.total)}</b>} color={i === 0 ? GOLD : BAR} />)}
          </div>
        </Card>
        <Card title={t('Theo danh mục', 'By category')} sub={t('Bấm để xem sản phẩm', 'Tap to see products')}>
          <div className="flex rounded-lg overflow-hidden" style={{ height: 14 }}>
            {data.byCategory.map((c, i) => <span key={c.category} title={c.category} style={{ width: `${c.total / sumCat * 100}%`, backgroundColor: PALETTE[i % PALETTE.length] }} />)}
          </div>
          <div className="flex flex-col gap-1.5">
            {data.byCategory.map((c, i) => (
              <div key={c.category} className="flex flex-col gap-1">
                <button onClick={() => setOpenCat(openCat === c.category ? null : c.category)} className="flex items-center gap-2 text-left" style={{ fontSize: 12.5 }}>
                  <span className="flex-none" style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: PALETTE[i % PALETTE.length] }} />
                  <span className="flex-1 truncate">{c.category} <span style={{ color: LIGHT }}>({c.products.length})</span></span>
                  <b className="flex-none">{M(c.total)} <span style={{ color: LIGHT, fontWeight: 500 }}>· {Math.round(c.total / sumCat * 100)}%</span></b>
                </button>
                {openCat === c.category && <ProductList items={c.products} />}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {weekdays.length > 0 && (
        <Card title={t('Doanh thu theo thứ', 'Revenue by weekday')} sub={t('theo ngày giao', 'by delivery day')}>
          <div className="grid grid-cols-7 gap-2 items-end" style={{ height: 150 }}>
            {[1, 2, 3, 4, 5, 6, 7].map(d => {
              const w = weekdays.find(x => x.dow === d);
              const v = w?.revenue ?? 0;
              const top = v === wMax;
              return (
                <div key={d} className="flex flex-col items-center justify-end gap-1.5 h-full">
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: top ? '#7A5A12' : MUTED }}>{K(v)}</span>
                  <span style={{ width: '100%', maxWidth: 64, height: `${Math.max(4, v / wMax * 100)}%`, borderRadius: '10px 10px 4px 4px', backgroundColor: top ? GOLD : BAR }} />
                  <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{DOW(t)[d - 1]}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

// ───────────────────────── Ads ─────────────────────────

function Ads({ extras, t }: { extras: OnlineStatsExtras | null; t: T }) {
  const ads = extras?.ads;
  const rows = useMemo(() => (ads?.campaigns ?? []).filter(c => c.spend > 0).map(c => ({
    ...c, roas: c.revenue / c.spend, result: c.revenue * 0.5 - c.spend,
    cpChat: c.chats ? c.spend / c.chats : null, cpOrder: c.orders ? c.spend / c.orders : null,
    ctr: c.impressions ? (c.linkClicks ?? c.clicks ?? 0) / c.impressions : null, cpm: c.impressions ? c.spend / c.impressions * 1000 : null,
  })).sort((a, b) => b.spend - a.spend), [ads]);
  if (!ads) return <Card><span style={{ fontSize: 13, color: MUTED }}>{t('Chưa có dữ liệu quảng cáo.', 'No ads data yet.')}</span></Card>;
  const spend = rows.reduce((a, c) => a + c.spend, 0);
  const rev = rows.reduce((a, c) => a + c.revenue, 0);
  const orders = rows.reduce((a, c) => a + c.orders, 0);
  const chats = rows.reduce((a, c) => a + c.chats, 0);
  const imp = rows.reduce((a, c) => a + (c.impressions ?? 0), 0);
  const reach = rows.reduce((a, c) => a + (c.reach ?? 0), 0);
  const roas = spend ? rev / spend : 0;
  const result = rev * 0.5 - spend;
  const daily = ads.daily ?? [];
  const pos = (r: number) => `${Math.min(100, r / 3 * 100)}%`;
  // Gauge geometry: half circle from ×0 to ×3.
  const gA = (r: number) => Math.PI * (1 - Math.min(3, r) / 3);
  const gx = (a: number, rad: number) => 100 + rad * Math.cos(a), gy = (a: number, rad: number) => 100 - rad * Math.sin(a);
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card dark>
          <span style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#D9C48A', fontWeight: 700 }}>{t('Mỗi 1₫ quảng cáo mang về', 'Each ₫1 of ads brings back')}</span>
          <svg viewBox="0 0 200 118" width="100%" height={150}>
            <path d={`M20,100 A80,80 0 0 1 180,100`} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="16" strokeLinecap="round" />
            <path d={`M20,100 A80,80 0 0 1 ${gx(gA(roas), 80)},${gy(gA(roas), 80)}`} fill="none" stroke={roas >= 2 ? '#7FB08E' : GOLD} strokeWidth="16" strokeLinecap="round" />
            <line x1={gx(gA(2), 66)} y1={gy(gA(2), 66)} x2={gx(gA(2), 96)} y2={gy(gA(2), 96)} stroke={CREAM_TXT} strokeWidth="2.5" />
            <text x={gx(gA(2), 108)} y={gy(gA(2), 108)} textAnchor="middle" fontSize="10" fill="#D9C48A">×2</text>
            <text x="100" y="92" textAnchor="middle" fontSize="34" fontWeight="700" fill={CREAM_TXT} style={{ fontFamily: SERIF }}>×{roas.toFixed(2)}</text>
            <text x="100" y="112" textAnchor="middle" fontSize="10.5" fill="#E8DCCB">{t('hoà vốn là ×2', 'break-even is ×2')}</text>
          </svg>
          <span style={{ fontSize: 12.5, color: '#E8DCCB', lineHeight: 1.45 }}>{t('Shop mua bánh bằng 50% giá bán, nên quảng cáo phải mang về ít nhất gấp đôi chi phí.', 'Shops buy at 50% of the selling price, so an ad must bring back at least twice its cost.')}</span>
        </Card>
        <div className="lg:col-span-2 grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Kpi icon="💸" label={t('Chi phí', 'Spend')} value={M(spend)} unit="₫" sub={`${rows.length} ${t('chiến dịch', 'campaigns')}`} />
          <Kpi icon="💰" label={t('Doanh thu từ QC', 'Revenue from ads')} value={M(rev)} unit="₫" sub={`${orders} ${t('đơn', 'orders')}`} />
          <Kpi icon="⚖️" label={t('Sau hàng & QC', 'After goods & ads')} value={`${result >= 0 ? '+' : '−'}${M(Math.abs(result))}`} unit="₫" tone={result >= 0 ? 'green' : 'red'} sub={t('trên đơn truy được', 'on traced orders')} />
          <Kpi icon="💬" label={t('Chi phí / chat', 'Cost per chat')} value={chats ? K(spend / chats) : '—'} unit="₫" sub={`${N(chats)} chat`} />
          <Kpi icon="🧾" label={t('Chi phí / đơn', 'Cost per order')} value={orders ? K(spend / orders) : '—'} unit="₫" sub={orders && rev ? `${t('đơn TB', 'avg order')} ${K(rev / orders)} ₫` : ''} />
          <Kpi icon="👁" label={t('Tiếp cận', 'Reach')} value={reach >= 1e6 ? M(reach) : `${Math.round(reach / 1000)}k`} sub={imp ? `${Math.round(imp / 1000)}k ${t('lượt hiển thị', 'impressions')} · CPM ${K(spend / imp * 1000)}` : ''} />
        </div>
      </div>

      {daily.length > 1 && (
        <Card title={t('Chi phí và doanh thu theo ngày', 'Spend and revenue per day')}
          right={<span className="flex gap-3" style={{ fontSize: 11.5, color: MUTED }}><span className="flex items-center gap-1.5"><span style={{ width: 14, height: 3, backgroundColor: BAR, borderRadius: 2 }} />{t('Chi phí', 'Spend')}</span><span className="flex items-center gap-1.5"><span style={{ width: 14, height: 3, backgroundColor: GOLD, borderRadius: 2 }} />{t('Doanh thu từ QC', 'Revenue from ads')}</span></span>}>
          <AreaChart points={daily.map(d => ({ label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, value: d.spend }))} secondary={daily.map(d => d.revenue)} fmt={v => K(v)} height={200} />
        </Card>
      )}

      <Card title={t('Chiến dịch', 'Campaigns')} sub={t('Hiệu quả mỗi chiến dịch · vạch đen là điểm hoà vốn ×2', 'Return per campaign · the dark mark is the ×2 break-even')}>
        <div className="hidden lg:grid gap-3 pb-1" style={{ gridTemplateColumns: 'minmax(0,2.2fr) 90px 80px 80px 90px minmax(0,1.6fr) 90px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: LIGHT, fontWeight: 700 }}>
          <span>{t('Chiến dịch', 'Campaign')}</span><span style={{ textAlign: 'right' }}>{t('Chi', 'Spend')}</span><span style={{ textAlign: 'right' }}>Chat</span><span style={{ textAlign: 'right' }}>{t('Đơn', 'Orders')}</span><span style={{ textAlign: 'right' }}>{t('Doanh thu', 'Revenue')}</span><span>{t('Hiệu quả', 'Return')}</span><span style={{ textAlign: 'right' }}>{t('Kết quả', 'Result')}</span>
        </div>
        {rows.map(c => (
          <div key={c.name} className="flex flex-col lg:grid gap-2 lg:gap-3 lg:items-center py-2.5" style={{ gridTemplateColumns: 'minmax(0,2.2fr) 90px 80px 80px 90px minmax(0,1.6fr) 90px', borderTop: `1px solid ${PANEL}`, fontSize: 12.5 }}>
            <span className="flex flex-col min-w-0"><b className="truncate" style={{ fontSize: 13, color: DARK }}>{c.name}</b>
              <span style={{ fontSize: 11.5, color: LIGHT }}>{c.cpChat ? `${K(c.cpChat)}/chat` : ''}{c.cpOrder ? ` · ${K(c.cpOrder)}/${t('đơn', 'order')}` : ''}{c.ctr != null ? ` · CTR ${(c.ctr * 100).toFixed(1)}%` : ''}</span></span>
            <span className="hidden lg:block" style={{ textAlign: 'right' }}>{M(c.spend)}</span>
            <span className="hidden lg:block" style={{ textAlign: 'right' }}>{N(c.chats)}</span>
            <span className="hidden lg:block" style={{ textAlign: 'right' }}>{c.orders}</span>
            <span className="hidden lg:block" style={{ textAlign: 'right' }}>{M(c.revenue)}</span>
            <span className="flex items-center gap-2">
              <span className="relative flex-1" style={{ height: 10, borderRadius: 5, backgroundColor: PANEL, display: 'block' }}>
                <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pos(c.roas), borderRadius: 5, backgroundColor: c.roas >= 2 ? GREEN : c.roas >= 1 ? GOLD : '#B9876B' }} />
                <span style={{ position: 'absolute', left: pos(2), top: -3, bottom: -3, width: 2, backgroundColor: DARK }} />
              </span>
              <b style={{ width: 46, textAlign: 'right', color: c.roas >= 2 ? GREEN : RED }}>×{c.roas.toFixed(2)}</b>
            </span>
            <b className="lg:text-right" style={{ color: c.result >= 0 ? GREEN : RED }}>{c.result >= 0 ? '+' : '−'}{M(Math.abs(c.result))}<span className="lg:hidden" style={{ color: LIGHT, fontWeight: 500 }}> · {M(c.spend)} {t('chi', 'spent')} · {c.orders} {t('đơn', 'orders')}</span></b>
          </div>
        ))}
      </Card>
      <div className="rounded-2xl" style={{ backgroundColor: PANEL, padding: '12px 16px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        <b style={{ color: DARK }}>{t('Đây là con số tối thiểu.', 'Read these as minimums.')}</b> {t('Chỉ tính các đơn ghép được với chat của quảng cáo (qua SĐT hoặc nút "Tạo đơn"). Khách gọi điện hoặc mua tại shop không được tính. Chi phí lấy từ Meta, cập nhật mỗi ngày.', 'Only orders linked to the ad’s chat are counted (phone number or the “Create order” button). Customers who call or buy in a shop are not counted. Spend comes from Meta, synced daily.')}
      </div>
    </>
  );
}

// ───────────────────────── Customer service ─────────────────────────

function Service({ extras, t, onOpenInbox }: { extras: OnlineStatsExtras | null; t: T; onOpenInbox?: () => void }) {
  const svc = extras?.service;
  const [active, setActive] = useState<number | null>(null);
  if (!svc) return <Card><span style={{ fontSize: 13, color: MUTED }}>{t('Chưa có dữ liệu tin nhắn.', 'No message data yet.')}</span></Card>;
  const hours = Array.from({ length: 24 }, (_, h) => svc.hours.find(x => x.h === h) ?? { h, n: 0, median: null, never: 0 });
  const max = Math.max(1, ...hours.map(h => h.n));
  const busiest = hours.reduce((b, h) => (h.n > b.n ? h : b), hours[0]);
  const shown = active != null && hours[active] ? hours[active] : busiest;
  const ago = (iso: string) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} ${t('ngày', 'days')}`; };
  const pages = svc.pages ?? [];
  const wk = svc.weekdays ?? [];
  const wkMax = Math.max(1, ...wk.map(w => w.n));
  const daily = svc.daily ?? [];
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card dark className="col-span-2">
          <div className="flex items-center gap-5">
            <Ring pct={(svc.within5Pct ?? 0) / 100} size={96} label={`${svc.within5Pct ?? 0}%`} />
            <div className="flex flex-col gap-1">
              <span style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#D9C48A', fontWeight: 700 }}>{t('Trả lời trong 5 phút', 'Answered within 5 min')}</span>
              <span style={{ fontFamily: SERIF, fontSize: 38, fontWeight: 700, lineHeight: 1.05 }}>{svc.daytimeMedian ?? '—'}<span style={{ fontSize: 16, color: GOLD2, marginLeft: 6 }}>min</span></span>
              <span style={{ fontSize: 12.5, color: '#E8DCCB' }}>{t('trả lời đầu tiên ban ngày (trung vị, 8:00–22:00)', 'first reply in daytime (median, 8:00–22:00)')}</span>
            </div>
          </div>
        </Card>
        <Kpi icon="🌙" label={t('Chờ ban đêm', 'Night wait')} value={svc.nightMaxHours != null ? `${svc.nightMaxHours}` : '—'} unit="h max" sub={`${N(svc.night)} ${t('tin 22:00–8:00', 'messages 22:00–8:00')}`} tone="red" />
        <Kpi icon="🔕" label={t('Không được trả lời', 'Never answered')} value={N(svc.never)} sub={`${N(svc.lateOrNever)} ${t('chờ > 1h hoặc không trả lời', 'waited > 1 h or no reply')}`} tone="red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2" title={t('Khách nhắn lúc nào', 'When customers write')}
          sub={`${shown.h}:00 · ${N(shown.n)} ${t('tin', 'messages')} · ${t('trả lời sau', 'median reply')} ${shown.median ?? '—'} min`}
          right={<span className="flex gap-3" style={{ fontSize: 11.5, color: MUTED }}><span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: BAR }} />{t('Có người trực', 'Staff on shift')}</span><span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: GOLD2 }} />22:00–8:00</span></span>}>
          <div className="flex items-end gap-1" style={{ height: 190 }} onMouseLeave={() => setActive(null)}>
            {hours.map((h, i) => (
              <button key={h.h} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} className="flex-1 h-full flex flex-col justify-end items-center gap-1" aria-label={`${h.h}h`}>
                <span style={{ width: '100%', height: `${Math.max(h.n ? 2 : 0, h.n / max * 100)}%`, borderRadius: '6px 6px 2px 2px', backgroundColor: i === active ? GOLD : (h.h >= 22 || h.h < 8) ? GOLD2 : BAR, opacity: i === active || active == null ? 1 : 0.55, transition: 'opacity .15s' }} />
              </button>
            ))}
          </div>
          <div className="flex justify-between" style={{ fontSize: 11, color: LIGHT }}><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
        </Card>
        <Card title={`${t('Đang chờ trả lời', 'Waiting for a reply')}`} right={<span style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 700, color: (extras?.waitingCount ?? 0) > 0 ? RED : GREEN }}>{extras?.waitingCount ?? 0}</span>}
          sub={t('Khách nhắn hơn 1 giờ, chưa ai trả lời (7 ngày)', 'Wrote over 1 h ago, no reply yet (7 days)')}>
          {(extras?.waiting ?? []).length === 0 && <span style={{ fontSize: 13, color: GREEN, fontWeight: 600 }}>✓ {t('Không có', 'None')}</span>}
          <div className="flex flex-col">
            {(extras?.waiting ?? []).map(w => (
              <div key={w.id} className="flex items-center gap-3 py-2" style={{ borderTop: `1px solid ${PANEL}` }}>
                <span className="flex-none flex items-center justify-center" style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: PANEL, color: DARK, fontSize: 12, fontWeight: 700 }}>{(w.name || '?').trim().split(/\s+/).map(s => s[0]).slice(-2).join('').toUpperCase()}</span>
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="flex gap-2 items-baseline"><b className="truncate" style={{ fontSize: 13, color: DARK }}>{w.name || '—'}</b><span style={{ fontSize: 11.5, color: RED, fontWeight: 600, flex: 'none' }}>{ago(w.since)}</span></span>
                  <span className="truncate" style={{ fontSize: 12, color: MUTED }}>{w.preview}</span>
                </span>
              </div>
            ))}
          </div>
          {onOpenInbox && <button onClick={onOpenInbox} style={{ minHeight: 42, borderRadius: 12, backgroundColor: DARK, color: CREAM_TXT, fontSize: 13, fontWeight: 700 }}>{t('Mở tin nhắn', 'Open messages')}</button>}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(pages.length > 0 || daily.length > 1) && (
          <Card title={t('Theo trang Facebook', 'By Facebook page')} className="lg:col-span-2">
            <div className={`grid gap-3 ${pages.length > 1 ? 'sm:grid-cols-2' : ''}`}>
              {pages.map(p => (
                <div key={p.page} className="rounded-2xl flex flex-col gap-3" style={{ backgroundColor: PANEL, padding: '14px 16px' }}>
                  <b style={{ fontSize: 14, color: DARK }}>{p.page}</b>
                  <div className="grid grid-cols-3 gap-2">
                    {[[N(p.conversations), t('hội thoại', 'chats')], [`${p.median ?? '—'} min`, t('trả lời', 'reply')], [`${p.within5Pct ?? 0}%`, '< 5 min']].map(([v, l]) => (
                      <div key={l} className="flex flex-col"><b style={{ fontSize: 17, color: DARK }}>{v}</b><span style={{ fontSize: 11, color: MUTED }}>{l}</span></div>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: p.never ? RED : GREEN, fontWeight: 600 }}>{p.never ? `${p.never} ${t('không được trả lời', 'never answered')}` : `✓ ${t('Không bỏ sót', 'Nothing missed')}`}</span>
                </div>
              ))}
            </div>
            {daily.length > 1 && (
              <div className="flex flex-col gap-2">
                <b style={{ fontSize: 13.5, color: DARK }}>{t('Hội thoại mỗi ngày', 'Conversations per day')}</b>
                <AreaChart points={daily.map(d => ({ label: `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, value: d.conversations }))} fmt={v => String(Math.round(v))} height={170} />
              </div>
            )}
          </Card>
        )}
        {wk.length > 0 && (
          <Card title={t('Theo thứ', 'By weekday')} sub={t('lượt khách nhắn', 'customer messages')}>
            <div className="flex flex-col gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map(d => {
                const n = wk.find(w => w.dow === d)?.n ?? 0;
                return <HBar key={d} label={DOW(t)[d - 1]} value={n} max={wkMax} right={<b>{N(n)}</b>} color={n === wkMax ? GOLD : BAR} />;
              })}
            </div>
          </Card>
        )}
      </div>

    </>
  );
}

// Exposed for the local visual check harness only.
export { Overview as StatsOverview, Ads as StatsAds, Service as StatsService };
