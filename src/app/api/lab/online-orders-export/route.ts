import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';

// Tracking export by date range (Axel, 2026-09-11) — reproduces the columns of her old
// Excel tracker ("QUẢN LÝ ĐƠN HÀNG ONLINE"), rebuilt from lab_online_orders + its line
// tables instead of hand-entry. One difference from the old sheet by design: the old single
// free-text "TRẠNG THÁI ĐƠN HÀNG" column is kept as the app's 3 separate signals (lab
// delivered / shop delivered / payment status) rather than collapsed back into one field
// (Axel, 2026-09-11: "met les 3 signaux separe c'est ok").
//
// Read-only, GET params: from=YYYY-MM-DD, to=YYYY-MM-DD (delivery_date range, inclusive),
// lang=vi|en (header language, defaults vi).

function normalizePhoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits.slice(-9);
}

const HEADERS = {
  vi: ['Ngày nhận', 'Ngày giao', 'Kênh', 'Shop', 'Khách hàng', 'SĐT', 'Loại khách', 'Sản phẩm',
    'Tiền hàng', 'Phụ phí', 'Phí giao hàng', 'Tổng thu', 'Thanh toán', 'Đã thu', 'Mã đơn Odoo',
    'Lab đã giao', 'Shop đã giao', 'Nguồn', 'Ghi chú'],
  en: ['Order date', 'Delivery date', 'Channel', 'Shop', 'Customer', 'Phone', 'Customer type', 'Items',
    'Merchandise', 'Extra fees', 'Delivery fee', 'Grand total', 'Payment', 'Amount paid', 'Odoo ref',
    'Lab delivered', 'Shop delivered', 'Source', 'Notes'],
} as const;

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

export async function GET(req: NextRequest) {
  const supabaseAuth = createClient();
  const { data: { session } } = await getSafeSession(supabaseAuth);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: profile } = await supabaseAuth.from('profiles').select('role').eq('id', session.user.id).single();
  if (!profile || !['online_sales', 'admin', 'shop_manager'].includes(profile.role)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const lang: 'vi' | 'en' = req.nextUrl.searchParams.get('lang') === 'en' ? 'en' : 'vi';
  const today = new Date().toISOString().split('T')[0];
  const from = (req.nextUrl.searchParams.get('from') || today).slice(0, 10);
  const to = (req.nextUrl.searchParams.get('to') || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 400 });
  }

  const supabase = service();
  if (!supabase) return NextResponse.json({ error: 'Server not configured' }, { status: 500 });

  const { data: orders } = await supabase.from('lab_online_orders').select('*')
    .gte('delivery_date', from).lte('delivery_date', to).order('delivery_date');
  const rows = orders ?? [];

  // Whole-table phone history for new/returning, same logic as getMyOnlineOrdersAction —
  // the table is small (order-level, not per-line), so one extra unfiltered select is cheap
  // and lets an order's "first ever" status be found even if its previous order falls
  // outside this export's date range.
  const { data: allForPhones } = await supabase.from('lab_online_orders').select('order_batch_id, customer_phone, created_at');
  const byPhoneKey = new Map<string, { order_batch_id: string; created_at: string }[]>();
  for (const r of allForPhones ?? []) {
    const key = normalizePhoneKey(r.customer_phone);
    if (!key) continue;
    const arr = byPhoneKey.get(key) ?? []; arr.push(r); byPhoneKey.set(key, arr);
  }

  const batchIds = rows.map(o => o.order_batch_id);
  const labBatchIds = rows.filter(o => (o.source ?? 'lab') === 'lab').map(o => o.order_batch_id);
  const [{ data: labLines }, { data: stockLines }] = await Promise.all([
    labBatchIds.length
      ? supabase.from('lab_manual_cakes')
          .select('order_batch_id, product_name_vi, qty, unit_price, matched_order_ref, cancelled_at')
          .in('order_batch_id', labBatchIds)
      : Promise.resolve({ data: [] as any[] }),
    batchIds.length
      ? supabase.from('lab_online_sale_lines').select('order_batch_id, product_name_vi, qty, unit_price, is_fee').in('order_batch_id', batchIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const linesByBatch = new Map<string, any[]>();
  for (const l of [...(labLines ?? []).map((l: any) => ({ ...l, _mc: true, is_fee: false })), ...(stockLines ?? [])]) {
    const arr = linesByBatch.get(l.order_batch_id) ?? []; arr.push(l); linesByBatch.set(l.order_batch_id, arr);
  }
  const orderRefs = Array.from(new Set((labLines ?? [])
    .map((l: any) => l.matched_order_ref).filter((r: string | null): r is string => !!r && r !== '__pending_create__')));
  const { data: deliveries } = orderRefs.length
    ? await supabase.from('lab_delivery_orders').select('order_ref, status').in('order_ref', orderRefs).eq('status', 'validated')
    : { data: [] as any[] };
  const labDeliveredRefs = new Set((deliveries ?? []).map((d: any) => d.order_ref));

  const srcLabel = { lab: lang === 'en' ? 'Lab order' : 'Đặt lab', shop_stock: lang === 'en' ? 'Shop stock' : 'Kho shop', excel_import: lang === 'en' ? 'Imported' : 'Nhập lịch sử' } as const;
  const payLabel = { paid: lang === 'en' ? 'Paid' : 'Đã TT đủ', partial: lang === 'en' ? 'Deposit' : 'Cọc 1 phần', unpaid: lang === 'en' ? 'Unpaid' : 'Chưa TT' } as const;

  const aoa: (string | number)[][] = [[...HEADERS[lang]]];
  for (const o of rows) {
    const ls = linesByBatch.get(o.order_batch_id) ?? [];
    const productLines = ls.filter((l: any) => !l.is_fee);
    const feeLines = ls.filter((l: any) => l.is_fee);
    const merch = productLines.reduce((s: number, l: any) => s + (l.qty ?? 0) * (l.unit_price ?? 0), 0);
    const feeTotal = feeLines.reduce((s: number, l: any) => s + (l.qty ?? 0) * (l.unit_price ?? 0), 0);
    const deliveryFee = Number(o.delivery_fee ?? 0);
    const source: 'lab' | 'shop_stock' | 'excel_import' = o.source === 'shop_stock' ? 'shop_stock' : o.source === 'excel_import' ? 'excel_import' : 'lab';
    const orderRef = productLines.find((l: any) => l.matched_order_ref && l.matched_order_ref !== '__pending_create__')?.matched_order_ref ?? null;
    const labDelivered = source === 'shop_stock' ? true : (orderRef ? labDeliveredRefs.has(orderRef) : false);

    const phoneKey = normalizePhoneKey(o.customer_phone);
    const priorOrderCount = phoneKey
      ? (byPhoneKey.get(phoneKey) ?? []).filter(r => r.order_batch_id !== o.order_batch_id && r.created_at < o.created_at).length
      : 0;
    const override: boolean | null = o.customer_returning_override ?? null;
    const isReturning = override != null ? override : priorOrderCount > 0;
    const manual = override != null;
    const customerType = !o.customer_phone
      ? ''
      : isReturning
        ? `${lang === 'en' ? 'Returning' : 'Khách cũ'}${manual ? ` (${lang === 'en' ? 'confirmed' : 'đã xác nhận'})` : priorOrderCount > 0 ? ` (${priorOrderCount})` : ''}`
        : (lang === 'en' ? 'New' : 'Khách mới');

    aoa.push([
      (o.created_at ?? '').slice(0, 10),
      o.delivery_date ?? '',
      o.channel ?? '',
      o.shop_name ?? '',
      o.customer_name ?? '',
      o.customer_phone ?? '',
      customerType,
      productLines.map((l: any) => `${l.product_name_vi} ×${l.qty}`).join(', '),
      merch,
      feeTotal,
      deliveryFee,
      merch + feeTotal + deliveryFee,
      payLabel[o.payment_status as 'paid' | 'partial' | 'unpaid'] ?? o.payment_status ?? '',
      Number(o.amount_paid ?? 0),
      orderRef ?? '',
      labDelivered ? (lang === 'en' ? 'Yes' : 'Có') : (lang === 'en' ? 'No' : 'Chưa'),
      o.shop_delivered ? (lang === 'en' ? 'Yes' : 'Có') : (lang === 'en' ? 'No' : 'Chưa'),
      srcLabel[source],
      o.notes ?? '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 11 }, { wch: 11 }, { wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 13 }, { wch: 20 },
    { wch: 40 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 28 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, lang === 'en' ? 'Online orders' : 'Đơn hàng online');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Online_orders_${from}_${to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
