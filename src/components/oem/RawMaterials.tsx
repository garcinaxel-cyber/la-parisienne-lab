'use client';
import { useMemo, useState } from 'react';
import { Loader2, Check, Copy, Calculator } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { Card, Title, Banner, Chip, Btn, ExprInput, inputCls, inputStyle } from './ui';
import { fmt, dmy, mondayOf, localToday, MUTED, FAINT, GREEN, type Derived, type Ingredient, type Item, type LFn, type ProdLog, type RmCount, type Usage , evalQty } from './model';

// Inventory → Raw materials. Weekly count of the 29 ingredients; the app estimates today's stock
// (count − what Hung baked since, per the recipes) and tells how much can still be made:
// per product (first blocking ingredient) and for one or several TARGETED products together
// (Axel, 2026-09-25: "savoir combien je peux produire d'un ou plusieurs produits ciblés").
export default function RawMaterials({ items, d, ingredients, usage, counts, prod, canCount, userId, userName, reload, L }: {
  items: Item[]; d: Derived; ingredients: Ingredient[]; usage: Usage[]; counts: RmCount[]; prod: ProdLog[];
  canCount: boolean; userId: string | null; userName: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const supabase = useMemo(() => createClient(), []);
  const groups = useMemo(() => Array.from(new Map(items.map(i => [i.group_key, { key: i.group_key, name: i.group_name, items: items.filter(x => x.group_key === i.group_key) }])).values()), [items]);
  const q = useMemo(() => { const m: Record<string, Record<string, number>> = {}; for (const u of usage) (m[u.group_key] ??= {})[u.ingredient_code] = Number(u.qty_per_kg); return m; }, [usage]);
  const remaining = useMemo(() => Object.fromEntries(groups.map(g => [g.key, Math.max(0, (d.targetKg[g.key] ?? 0) - (d.producedKg[g.key] ?? 0))])) as Record<string, number>, [groups, d]);

  // latest count per ingredient + estimated stock now
  const latest = useMemo(() => {
    const m: Record<string, RmCount> = {};
    for (const c of counts) { const p = m[c.ingredient_code]; if (!p || c.week_start > p.week_start || (c.week_start === p.week_start && c.created_at > p.created_at)) m[c.ingredient_code] = c; }
    return m;
  }, [counts]);
  const est = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const ing of ingredients) {
      const c = latest[ing.code];
      if (!c) { m[ing.code] = null; continue; }
      let used = 0;
      for (const l of prod) if (l.created_at > c.created_at) used += Number(l.weight_kg) * (q[l.group_key]?.[ing.code] ?? 0);
      m[ing.code] = Number(c.qty) - used;
    }
    return m;
  }, [ingredients, latest, prod, q]);
  const need = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of groups) for (const [code, per] of Object.entries(q[g.key] ?? {})) m[code] = (m[code] ?? 0) + remaining[g.key] * per;
    return m;
  }, [groups, q, remaining]);
  const ingName = (code: string) => ingredients.find(i => i.code === code)?.name ?? code;
  const ingUnit = (code: string) => ingredients.find(i => i.code === code)?.unit ?? '';

  // max kg of a MIX (shares sum to 1) that the estimated stock allows
  function maxMix(shares: Record<string, number>) {
    let best = Infinity; let block: string | null = null; const uncounted: string[] = [];
    const per: Record<string, number> = {};
    for (const [g, s] of Object.entries(shares)) for (const [code, v] of Object.entries(q[g] ?? {})) per[code] = (per[code] ?? 0) + s * v;
    for (const [code, v] of Object.entries(per)) {
      if (v <= 0) continue;
      const e = est[code];
      if (e == null) { uncounted.push(code); continue; }
      const t = Math.max(0, e) / v;
      if (t < best) { best = t; block = code; }
    }
    return { kg: best === Infinity ? null : best, block, uncounted };
  }

  // ── weekly count form ──
  const [week, setWeek] = useState(mondayOf(localToday()));
  const [val, setVal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  // counts accept "12+3+50" / "12×24+7" (evalQty); an invalid field blocks the save
  const filled = Object.entries(val).filter(([, v]) => { const x = evalQty(v); return x !== null && !Number.isNaN(x); });
  const anyBad = Object.values(val).some(v => Number.isNaN(evalQty(v) as number));
  const lastWeek = Object.values(latest).reduce<string | null>((a, c) => (!a || c.week_start > a ? c.week_start : a), null);
  const lastBy = lastWeek ? Array.from(new Set(counts.filter(c => c.week_start === lastWeek).map(c => c.created_by_name).filter(Boolean))).join(', ') : '';

  async function save() {
    setBusy(true); setMsg(null);
    await supabase.from('lab_mm_rm_inventory').delete().eq('week_start', week).in('ingredient_code', filled.map(([c]) => c));
    const { error } = await supabase.from('lab_mm_rm_inventory').insert(filled.map(([code, v]) => ({
      week_start: week, ingredient_code: code, qty: evalQty(v) as number, created_by: userId, created_by_name: userName,
    })));
    setBusy(false);
    if (error) { setMsg({ ok: false, t: error.message }); return; }
    setVal({}); setMsg({ ok: true, t: L('Đã lưu kiểm kê.', 'Count saved.') }); await reload();
  }
  function copyLast() {
    const v: Record<string, string> = {};
    for (const ing of ingredients) { const c = latest[ing.code]; if (c) v[ing.code] = String(Number(c.qty)); }
    setVal(v);
  }

  // ── targeted calculator ──
  const [sel, setSel] = useState<string[]>([]);
  const [pct, setPct] = useState<Record<string, string>>({});
  const defaultShares = (keys: string[]) => {
    const tot = keys.reduce((s, k) => s + remaining[k], 0);
    return Object.fromEntries(keys.map(k => [k, tot > 0 ? remaining[k] / tot : 1 / keys.length]));
  };
  function toggle(k: string) {
    const next = sel.includes(k) ? sel.filter(x => x !== k) : [...sel, k];
    setSel(next);
    const s = defaultShares(next);
    setPct(Object.fromEntries(next.map(x => [x, String(Math.round(s[x] * 100))])));
  }
  const shares = useMemo(() => {
    const raw = Object.fromEntries(sel.map(k => [k, Math.max(0, Number(pct[k]) || 0)]));
    const tot = Object.values(raw).reduce((a, b) => a + b, 0);
    return tot > 0 ? Object.fromEntries(sel.map(k => [k, raw[k] / tot])) : {};
  }, [sel, pct]);
  const target = sel.length ? maxMix(shares) : null;
  const shortForRemaining = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of sel) for (const [code, per] of Object.entries(q[k] ?? {})) m[code] = (m[code] ?? 0) + remaining[k] * per;
    return Object.entries(m).map(([code, n]) => ({ code, short: n - Math.max(0, est[code] ?? 0), uncounted: est[code] == null })).filter(x => x.short > 0.0005 || x.uncounted);
  }, [sel, q, remaining, est]);

  const bagsText = (gk: string, kg: number) => {
    const g = groups.find(x => x.key === gk); if (!g) return '';
    return g.items.map(i => i.unit === 'kg' ? `${fmt(kg)} kg` : `${fmt(Math.floor((kg * 1000) / i.unit_weight_g), 0)} × ${fmt(i.unit_weight_g, 0)} g`).join(L(' hoặc ', ' or '));
  };

  return (
    <div className="space-y-4">
      <Banner>{L('Kiểm kê hằng tuần 29 nguyên liệu. App ước tính tồn hiện tại (số đếm − lượng Hưng đã dùng từ lúc đếm) và cho biết còn làm được bao nhiêu.',
        'Weekly count of the 29 raw materials. The app estimates today\'s stock (count − what Hưng used since, per the recipes) and tells how much can still be made.')}</Banner>

      {/* stock table + count form */}
      <Card className="overflow-hidden">
        <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-2" style={{ backgroundColor: '#FCFBF8' }}>
          <div>
            <Title>{L('Kiểm kê tuần · 29 nguyên liệu', 'Weekly count · 29 raw materials')}</Title>
            <div className="text-[11px]" style={{ color: FAINT }}>{lastWeek ? `${L('Lần gần nhất: tuần', 'Last: week of')} ${dmy(lastWeek)}${lastBy ? ` · ${lastBy}` : ''}` : L('Chưa kiểm lần nào.', 'Never counted yet.')}</div>
          </div>
          {canCount && (
            <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
              {L('Tuần', 'Week of')} <input type="date" value={week} onChange={e => setWeek(mondayOf(e.target.value || localToday()))} className={inputCls} style={inputStyle} />
            </div>
          )}
        </div>
        <div className="hidden sm:grid grid-cols-12 text-[10px] font-bold uppercase px-3 py-1.5" style={{ color: FAINT, borderTop: '1px solid #F3F4F6' }}>
          <span className="col-span-4">{L('Nguyên liệu', 'Ingredient')}</span>
          <span className="col-span-2 text-right">{L('Đếm', 'Counted')}</span>
          <span className="col-span-2 text-right">{L('Ước tính nay', 'Est. now')}</span>
          <span className="col-span-2 text-right">{L('Còn cần', 'Still needed')}</span>
          <span className="col-span-2 text-right">{canCount ? L('Số đếm mới', 'New count') : L('Đủ cho', 'Coverage')}</span>
        </div>
        {ingredients.map(ing => {
          const c = latest[ing.code]; const e = est[ing.code]; const n = need[ing.code] ?? 0;
          const cov = e != null && n > 0 ? (Math.max(0, e) / n) * 100 : null;
          return (
            <div key={ing.code} className="grid grid-cols-12 items-center gap-y-1 px-3 py-1.5 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
              <span className="col-span-12 sm:col-span-4 truncate font-semibold">{ing.name} <span className="font-normal" style={{ color: FAINT }}>· {ing.unit}</span></span>
              <span className="col-span-3 sm:col-span-2 sm:text-right" style={{ color: MUTED }}>{c ? fmt(Number(c.qty), 2) : '—'}</span>
              <span className="col-span-3 sm:col-span-2 sm:text-right font-bold">{e != null ? fmt(e, 2) : '—'}</span>
              <span className="col-span-3 sm:col-span-2 sm:text-right" style={{ color: MUTED }}>{fmt(n, 2)}</span>
              <span className="col-span-3 sm:col-span-2 flex justify-end items-center gap-1.5">
                {cov != null && <Chip tone={cov >= 100 ? 'green' : cov >= 50 ? 'amber' : 'red'}>{fmt(Math.min(cov, 999), 0)}%</Chip>}
                {canCount && (
                  <ExprInput className="w-40" placeholder="—" value={val[ing.code] ?? ''} unit={ing.unit} onChange={x => setVal(v => ({ ...v, [ing.code]: x }))} />
                )}
              </span>
            </div>
          );
        })}
        {canCount && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
            <Btn primary onClick={save} disabled={busy || !filled.length || anyBad}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')} {filled.length ? `(${filled.length})` : ''}</Btn>
            <Btn onClick={copyLast} disabled={!lastWeek}><Copy size={13} />{L('Chép tuần trước', 'Copy last week')}</Btn>
            {msg && <span className="text-xs font-semibold" style={{ color: msg.ok ? '#059669' : '#DC2626' }}>{msg.t}</span>}
          </div>
        )}
      </Card>

      {/* per product */}
      <div className="space-y-1.5">
        <Title>{L('Với tồn này còn làm được…', 'With this stock we can still make…')}</Title>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-12 text-[10px] font-bold uppercase px-3 py-1.5" style={{ color: FAINT }}>
            <span className="col-span-4">{L('Sản phẩm', 'Product')}</span><span className="col-span-2 text-right">{L('Làm được', 'Possible')}</span>
            <span className="col-span-2 text-right">{L('Còn phải làm', 'Left to make')}</span><span className="col-span-4 text-right">{L('Nguyên liệu chặn', 'Blocking')}</span>
          </div>
          {groups.map(g => {
            const r = maxMix({ [g.key]: 1 });
            const ok = r.kg != null && r.kg >= remaining[g.key] - 0.0005;
            return (
              <div key={g.key} className="grid grid-cols-12 items-center px-3 py-1.5 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
                <span className="col-span-4 font-semibold truncate">{g.name}</span>
                <span className="col-span-2 text-right font-bold" style={{ color: r.kg == null ? FAINT : ok ? '#059669' : '#B45309' }}>{r.kg == null ? '—' : `${fmt(r.kg)} kg`}</span>
                <span className="col-span-2 text-right" style={{ color: MUTED }}>{fmt(remaining[g.key])} kg</span>
                <span className="col-span-4 text-right truncate" style={{ color: MUTED }}>
                  {r.uncounted.length ? <Chip tone="grey">{r.uncounted.length} {L('chưa đếm', 'not counted')}</Chip> : r.block ? ingName(r.block) : '—'}
                </span>
              </div>
            );
          })}
        </Card>
        <div className="text-[11px]" style={{ color: FAINT }}>{L('Mỗi dòng tính riêng (nguyên liệu dùng chung không bị trừ giữa các sản phẩm) — dùng công cụ bên dưới để tính nhiều sản phẩm cùng lúc.',
          'Each line is computed on its own (shared ingredients are not split between products) — use the tool below for several products together.')}</div>
      </div>

      {/* targeted calculator */}
      <Card className="p-3 sm:p-4 space-y-3">
        <Title><span className="inline-flex items-center gap-1.5"><Calculator size={13} />{L('Tính cho sản phẩm mục tiêu', 'Targeted products')}</span></Title>
        <div className="text-[11px]" style={{ color: FAINT }}>{L('Chọn một hoặc nhiều sản phẩm. Tỷ lệ mặc định theo phần còn lại của đơn, có thể sửa.', 'Pick one or several products. The split defaults to what is left of the order and can be changed.')}</div>
        <div className="flex flex-wrap gap-1.5">
          {groups.map(g => {
            const on = sel.includes(g.key);
            return (
              <button key={g.key} onClick={() => toggle(g.key)} className="text-xs font-semibold rounded-lg px-2.5 py-1.5"
                style={on ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#fff', color: '#374151', border: '1px solid #E5E7EB' }}>{g.name}</button>
            );
          })}
        </div>
        {sel.length > 0 && target && (
          <div className="space-y-2">
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #F3F4F6' }}>
              {sel.map(k => {
                const g = groups.find(x => x.key === k)!; const kg = target.kg != null ? target.kg * (shares[k] ?? 0) : null;
                return (
                  <div key={k} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
                    <span className="font-semibold flex-1 min-w-[120px]">{g.name}</span>
                    {sel.length > 1 && (
                      <span className="flex items-center gap-1" style={{ color: MUTED }}>
                        <input inputMode="numeric" value={pct[k] ?? ''} onChange={e => setPct(p => ({ ...p, [k]: e.target.value.replace(/[^0-9.]/g, '') }))} className="w-14 rounded px-1.5 py-1 text-right font-bold" style={inputStyle} />%
                      </span>
                    )}
                    <span className="font-bold" style={{ color: GREEN }}>{kg == null ? '—' : `${fmt(kg)} kg`}</span>
                    {kg != null && <span style={{ color: MUTED }}>≈ {bagsText(k, kg)}</span>}
                    <span style={{ color: FAINT }}>{L('còn phải làm', 'left')} {fmt(remaining[k])} kg</span>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-xs" style={{ borderTop: '1px solid #F3F4F6', backgroundColor: '#FCFBF8' }}>
                <span className="font-bold flex-1">{L('Tổng', 'Total')}: {target.kg == null ? '—' : `${fmt(target.kg)} kg`}</span>
                {target.block && <span style={{ color: MUTED }}>{L('Chặn bởi', 'Blocked by')} <b>{ingName(target.block)}</b></span>}
                {target.uncounted.length > 0 && <Chip tone="amber">{target.uncounted.length} {L('nguyên liệu chưa đếm', 'ingredient(s) not counted')}</Chip>}
              </div>
            </div>
            {shortForRemaining.length > 0 ? (
              <div className="text-[11px] space-y-0.5">
                <div className="font-bold" style={{ color: '#B45309' }}>{L('Để làm hết phần còn lại cần mua thêm:', 'To finish what is left, still to buy:')}</div>
                {shortForRemaining.map(s => (
                  <div key={s.code} style={{ color: MUTED }}>• {ingName(s.code)}: {s.uncounted ? L('chưa đếm', 'not counted') : `${fmt(s.short, 2)} ${ingUnit(s.code)}`}</div>
                ))}
              </div>
            ) : <div className="text-[11px] font-semibold" style={{ color: '#059669' }}>{L('Đủ nguyên liệu để làm hết phần còn lại.', 'Enough stock to finish what is left.')}</div>}
          </div>
        )}
      </Card>
    </div>
  );
}
