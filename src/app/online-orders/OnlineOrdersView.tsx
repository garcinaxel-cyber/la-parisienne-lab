'use client';
import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Minus, X, Loader2, Bell, Settings, CalendarDays } from 'lucide-react';
import { SHOP_NAMES_ALL } from '@/lib/shops';
import { thumb } from '@/lib/img-thumb';
import { useI18n } from '@/lib/i18n';
import { pushSupport, getExistingPushSubscription, requestPushSubscription, unsubscribeCurrentPush } from '@/lib/push-client';
import * as actions from './actions';
import type { OnlineProduct, OnlineOrderItem, OnlineOrderSummary, OnlineAnalytics, ExtraFeeType } from './actions';

const NAVY = '#1A4731';
const GOLD = '#C9A84C';
const CREAM = '#FFF4CC';
const CREAM_DARK = '#F5E89A';
const INK = '#1A2C24';
const INK_LIGHT = '#6B7280';
const BORDER = '#E0D49A';
const TABBAR = '#163D29';

// Online orders are always fulfilled by a shop — the Lab itself is never a valid target
// (Axel review 2026-09-06). Server-side guard in submitOnlineOrderAction mirrors this.
const ONLINE_SHOPS = SHOP_NAMES_ALL.filter(s => s !== 'Lab');

// Client-side downscale before any upload (design photo or payment screenshot): a phone
// screenshot is 2–5 MB, the same picture at 1200px JPEG is ~100–250 KB. Keeps Supabase
// storage/egress flat and the upload instant on shop wifi. Falls back to the original file
// if the browser can't decode it.
async function compressImage(file: File, maxSide = 1200, quality = 0.72): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

// ── Bilingual labels (Axel, 2026-09-06: "met son interface anglais viet aussi") — same
// localStorage-backed toggle as the rest of the app (useI18n), default VI for her, EN for Axel.
const L = {
  vi: {
    titleOrder: 'Đơn hàng Online',
    titleTrack: 'Theo dõi đơn hàng',
    titleStats: 'Thống kê doanh thu',
    tabOrder: 'Đặt hàng',
    tabTrack: 'Theo dõi',
    tabStats: 'Thống kê',
    items: 'SP',
    bell: 'Thông báo',
    channelLabel: 'Kênh bán hàng',
    channelHint: 'Nguồn khách hàng — dùng để thống kê, không quyết định shop xử lý đơn.',
    shopLabel: 'Shop xử lý đơn (tạo trên Odoo)',
    addProduct: 'Thêm sản phẩm',
    searchPh: 'Tìm sản phẩm theo tên...',
    unitPrice: 'Đơn giá (₫)',
    cakeMsg: 'Lời nhắn trên bánh (ví dụ: Happy Birthday Linh)',
    designNotes: 'Ghi chú thiết kế bánh...',
    designPhoto: 'Ảnh thiết kế khác',
    designPhotoHint: 'Mẫu gốc ở trên. Chỉ thêm ảnh tham khảo nếu khách muốn thiết kế KHÁC mẫu gốc.',
    customerInfo: 'Thông tin khách hàng',
    custName: 'Tên khách hàng',
    custPhone: 'Số điện thoại',
    address: 'Địa chỉ giao hàng',
    extraNotes: 'Ghi chú thêm...',
    payment: 'Thanh toán',
    deliveryFee: 'Phí giao hàng',
    total: 'Tổng cộng',
    paid: '✓ Đã TT',
    unpaid: 'Chưa TT',
    partial: 'Cọc 1 phần',
    depositAmount: 'Số tiền đã cọc (₫)',
    creating: 'Đang tạo đơn...',
    submit: 'Tạo đơn & gửi Odoo',
    errChannel: 'Chọn hoặc nhập kênh bán hàng',
    errEmpty: 'Giỏ hàng trống',
    okOdoo: 'Đã tạo đơn Odoo: ',
    okSaved: 'Đã lưu đơn hàng',
    fAll: 'Tất cả',
    fUndelivered: 'Chưa giao',
    fLate: '⚠ Trễ hạn',
    noOrders: 'Chưa có đơn hàng nào.',
    deliveryDateGroup: 'Giao ngày',
    noDeliveryDate: 'Chưa có ngày giao',
    jumpToDate: 'Đi tới ngày',
    clearDate: 'Xem gần đây',
    tomorrow: 'Ngày mai',
    overdue: 'Trễ hạn giao',
    noOdoo: 'Chưa có Odoo',
    latePay: '⚠ Trễ thanh toán',
    walkIn: 'Khách lẻ',
    paidFull: '✓ Đã thanh toán',
    unpaidFull: 'Chưa thanh toán',
    labDelivered: '✓ Lab đã giao',
    labNot: 'Lab chưa giao',
    shopDelivered: '✓ Shop đã giao',
    shopNot: 'Shop chưa giao',
    today: 'Hôm nay',
    thisMonth: 'Tháng này',
    orders: 'đơn',
    last14: 'Doanh thu 14 ngày qua',
    trendAria: 'Xu hướng doanh thu 14 ngày',
    byShop: 'CA theo shop',
    byCat: 'CA theo danh mục sản phẩm',
    byChannel: 'CA theo kênh bán hàng',
    noData: 'Chưa có dữ liệu.',
    channelAdd: 'Thêm kênh mới...',
    priceLabel: 'Giá bán (₫)',
    listPrice: 'Giá niêm yết',
    lineNote: 'Ghi chú cho sản phẩm này...',
    payProof: 'Ảnh chuyển khoản',
    payProofDrop: '📎 Kéo thả hoặc chọn ảnh chuyển khoản',
    uploading: 'Đang tải ảnh...',
    sourceLabel: 'Nguồn hàng',
    srcLab: '🏭 Đặt lab (tạo Odoo)',
    srcStock: '🏪 Kho shop (không Odoo)',
    srcLabHint: 'Lab sản xuất → giao shop → shop giao khách. Tạo đơn Odoo + thẻ sản xuất.',
    srcStockHint: 'Hàng đã có sẵn tại shop (nhận từ REP). KHÔNG tạo Odoo, KHÔNG sản xuất — shop lấy từ kho giao khách và vẫn bấm bán tại quầy như bình thường.',
    submitStock: 'Lưu đơn bán từ kho',
    savingStock: 'Đang lưu...',
    okStock: 'Đã lưu đơn bán từ kho — shop đã được thông báo',
    stockBadge: '🏪 Kho shop',
    importBadge: '📥 Nhập từ lịch sử',
    needsItemsBadge: '✏️ Cần bổ sung chi tiết',
    reconstructTitle: 'Bổ sung chi tiết đơn hàng cũ',
    reconstructHint: 'Văn bản gốc: ',
    reconstructSearchPh: 'Tìm sản phẩm để thay thế...',
    reconstructSave: 'Lưu chi tiết',
    reconstructCancel: 'Huỷ',
    reconstructSaving: 'Đang lưu...',
    reconstructEmpty: 'Chưa chọn sản phẩm nào',
    saleDate: 'Ngày bán',
    bySource: 'Đặt lab / Kho shop',
    srcLabShort: 'Đặt lab',
    srcStockShort: 'Kho shop',
    period: 'Khoảng thời gian',
    p14: '14 ngày', p30: '30 ngày', p90: '90 ngày', p365: '12 tháng',
    rangeTotal: 'Doanh thu trong kỳ',
    revenueTrend: 'Doanh thu theo thời gian',
    perWeek: 'theo tuần', perMonth: 'theo tháng', perDay: 'theo ngày',
    feesLabel: 'Phụ phí thêm',
    manageFees: 'Quản lý',
    feesRow: 'Phụ phí',
    feeBadge: 'Phụ phí',
    addFeeType: 'Loại khác',
    manageFeesTitle: 'Quản lý phụ phí',
    manageFeesHint: 'Danh sách dùng chung cho mọi người có quyền vào Đặt hàng Online — thêm, đổi giá hoặc xoá bất cứ lúc nào.',
    newFeeNamePh: 'Tên phụ phí mới...',
    newFeePricePh: 'Giá',
    addBtn: 'Thêm',
  },
  en: {
    titleOrder: 'Online orders',
    titleTrack: 'Order tracking',
    titleStats: 'Revenue stats',
    tabOrder: 'Order',
    tabTrack: 'Track',
    tabStats: 'Stats',
    items: 'items',
    bell: 'Notifications',
    channelLabel: 'Sales channel',
    channelHint: 'Where the customer came from — for reporting only; it does not decide which shop handles the order.',
    shopLabel: 'Shop handling the order (Odoo document)',
    addProduct: 'Add products',
    searchPh: 'Search a product by name...',
    unitPrice: 'Unit price (₫)',
    cakeMsg: 'Message on the cake (e.g. Happy Birthday Linh)',
    designNotes: 'Cake design notes...',
    designPhoto: 'Different design photo',
    designPhotoHint: 'Original design shown above. Add a reference photo only if the customer wants a DIFFERENT design.',
    customerInfo: 'Customer',
    custName: 'Customer name',
    custPhone: 'Phone number',
    address: 'Delivery address',
    extraNotes: 'Additional notes...',
    payment: 'Payment',
    deliveryFee: 'Delivery fee',
    total: 'Total',
    paid: '✓ Paid',
    unpaid: 'Unpaid',
    partial: 'Deposit',
    depositAmount: 'Deposit amount (₫)',
    creating: 'Creating order...',
    submit: 'Create order & send to Odoo',
    errChannel: 'Pick or type a sales channel',
    errEmpty: 'Cart is empty',
    okOdoo: 'Odoo order created: ',
    okSaved: 'Order saved',
    fAll: 'All',
    fUndelivered: 'Not delivered',
    fLate: '⚠ Overdue',
    noOrders: 'No orders yet.',
    deliveryDateGroup: 'Delivery',
    noDeliveryDate: 'No delivery date',
    jumpToDate: 'Jump to date',
    clearDate: 'Show recent',
    tomorrow: 'Tomorrow',
    overdue: 'Overdue',
    noOdoo: 'No Odoo doc',
    latePay: '⚠ Late payment',
    walkIn: 'Walk-in customer',
    paidFull: '✓ Paid',
    unpaidFull: 'Unpaid',
    labDelivered: '✓ Lab delivered',
    labNot: 'Lab not delivered',
    shopDelivered: '✓ Shop delivered',
    shopNot: 'Shop not delivered',
    today: 'Today',
    thisMonth: 'This month',
    orders: 'orders',
    last14: 'Revenue, last 14 days',
    trendAria: '14-day revenue trend',
    byShop: 'Revenue by shop',
    byCat: 'Revenue by product category',
    byChannel: 'Revenue by sales channel',
    noData: 'No data yet.',
    channelAdd: 'Add a new channel...',
    priceLabel: 'Price (₫)',
    listPrice: 'List price',
    lineNote: 'Note for this item...',
    payProof: 'Payment screenshot',
    payProofDrop: '📎 Drop or pick the payment screenshot',
    uploading: 'Uploading...',
    sourceLabel: 'Stock source',
    srcLab: '🏭 Lab order (creates Odoo)',
    srcStock: '🏪 Shop stock (no Odoo)',
    srcLabHint: 'Lab produces → delivers to the shop → shop delivers the customer. Creates the Odoo document + production card.',
    srcStockHint: 'Product already on the shop shelf (from the REP). NO Odoo document, NO production — the shop hands it over from its stock and still rings it in the POS as usual.',
    submitStock: 'Save shop-stock sale',
    savingStock: 'Saving...',
    okStock: 'Shop-stock sale saved — the shop has been notified',
    stockBadge: '🏪 Shop stock',
    importBadge: '📥 Imported (history)',
    needsItemsBadge: '✏️ Detail needed',
    reconstructTitle: 'Fill in this historical order',
    reconstructHint: 'Original text: ',
    reconstructSearchPh: 'Search a product to replace it...',
    reconstructSave: 'Save detail',
    reconstructCancel: 'Cancel',
    reconstructSaving: 'Saving...',
    reconstructEmpty: 'No product picked yet',
    saleDate: 'Sale date',
    bySource: 'Lab orders / Shop stock',
    srcLabShort: 'Lab orders',
    srcStockShort: 'Shop stock',
    period: 'Period',
    p14: '14 days', p30: '30 days', p90: '90 days', p365: '12 months',
    rangeTotal: 'Revenue in period',
    revenueTrend: 'Revenue over time',
    perWeek: 'weekly', perMonth: 'monthly', perDay: 'daily',
    feesLabel: 'Extra fees',
    manageFees: 'Manage',
    feesRow: 'Extra fees',
    feeBadge: 'Fee',
    addFeeType: 'Other',
    manageFeesTitle: 'Manage extra fees',
    manageFeesHint: 'Shared with everyone who has access to online orders — add, reprice, or remove anytime.',
    newFeeNamePh: 'New fee name...',
    newFeePricePh: 'Price',
    addBtn: 'Add',
  },
} as const;
type LKey = keyof typeof L.vi;
function useL() {
  const { lang, setLang } = useI18n();
  const d = (lang === 'en' ? L.en : L.vi) as Record<LKey, string>;
  return { tr: (k: LKey) => d[k], lang, setLang };
}

function fmtVnd(v: number): string {
  return `${Math.round(v).toLocaleString('vi-VN')} ₫`;
}
function fmtDayLabel(key: string, lang: 'vi' | 'en'): string {
  // key is 'YYYY-MM-DD'; build the Date via local components to avoid UTC off-by-one.
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
}
function fmtCompactVnd(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M ₫`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k ₫`;
  return `${Math.round(v)} ₫`;
}

type CartLine = OnlineOrderItem & { key: string; nameVi: string; imageUrl: string | null; isCake: boolean; listPrice: number | null };
type Tab = 'order' | 'track' | 'stats';

export default function OnlineOrdersView({ fullName, isAdmin }: { fullName: string; isAdmin: boolean }) {
  const { tr } = useL();
  const [tab, setTab] = useState<Tab>('order');
  const today = new Date().toISOString().slice(0, 10);
  // ── Order form state ──
  const [shop, setShop] = useState(ONLINE_SHOPS[0]);
  // 'lab' = existing flow (Odoo doc + production card); 'shop_stock' = sale served from the shop's
  // own shelf — records only, zero Odoo/production (Axel, 2026-09-07).
  const [source, setSource] = useState<'lab' | 'shop_stock'>('lab');
  const [channel, setChannel] = useState('');
  const [channels, setChannels] = useState<string[]>([]);
  const [newChannel, setNewChannel] = useState('');
  async function loadChannels() {
    const res = await actions.listOnlineChannelsAction();
    if (res.channels) setChannels(res.channels);
  }
  useEffect(() => { loadChannels(); }, []);
  async function addChannel() {
    const n = newChannel.trim();
    if (!n) return;
    await actions.addOnlineChannelAction(n);
    setNewChannel(''); setChannel(n); loadChannels();
  }
  async function deleteChannel(n: string) {
    await actions.deleteOnlineChannelAction(n);
    if (channel === n) setChannel('');
    loadChannels();
  }
  // ── Extra fees (nến, nón...) — shared list, never touches Odoo/production (lab_v75) ──
  const [feeTypes, setFeeTypes] = useState<ExtraFeeType[]>([]);
  async function loadFeeTypes() {
    const res = await actions.listExtraFeeTypesAction();
    if (res.fees) setFeeTypes(res.fees);
  }
  useEffect(() => { loadFeeTypes(); }, []);
  type FeeLine = { key: string; feeTypeId: string | null; emoji: string | null; label: string; qty: number; unitPrice: number };
  const [feeCart, setFeeCart] = useState<FeeLine[]>([]);
  function addFeeToCart(f: ExtraFeeType) {
    setFeeCart(prev => {
      const existing = prev.find(l => l.feeTypeId === f.id);
      if (existing) return prev.map(l => l.feeTypeId === f.id ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, { key: f.id, feeTypeId: f.id, emoji: f.emoji, label: f.label, qty: 1, unitPrice: f.defaultPrice }];
    });
  }
  function updateFeeLine(key: string, patch: Partial<FeeLine>) {
    setFeeCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function removeFeeLine(key: string) {
    setFeeCart(prev => prev.filter(l => l.key !== key));
  }
  const [manageFeesOpen, setManageFeesOpen] = useState(false);
  const [newFeeEmoji, setNewFeeEmoji] = useState('🎁');
  const [newFeeLabel, setNewFeeLabel] = useState('');
  const [newFeePrice, setNewFeePrice] = useState('');
  async function addFeeType() {
    const label = newFeeLabel.trim();
    if (!label) return;
    await actions.addExtraFeeTypeAction({ emoji: newFeeEmoji.trim() || null, label, defaultPrice: Number(newFeePrice) || 0 });
    setNewFeeLabel(''); setNewFeePrice(''); loadFeeTypes();
  }
  async function updateFeeTypePrice(id: string, price: number) {
    setFeeTypes(prev => prev.map(f => f.id === id ? { ...f, defaultPrice: price } : f));
    await actions.updateExtraFeeTypeAction({ id, defaultPrice: price });
  }
  async function updateFeeTypeLabel(id: string, label: string) {
    setFeeTypes(prev => prev.map(f => f.id === id ? { ...f, label } : f));
    await actions.updateExtraFeeTypeAction({ id, label });
  }
  async function deleteFeeType(id: string) {
    setFeeTypes(prev => prev.filter(f => f.id !== id));
    setFeeCart(prev => prev.filter(l => l.feeTypeId !== id));
    await actions.deleteExtraFeeTypeAction(id);
  }

  const [deliveryDate, setDeliveryDate] = useState(today);
  const [readyTime, setReadyTime] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid' | 'partial'>('unpaid');
  const [amountPaid, setAmountPaid] = useState('0');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    // Empty query = closed list (Axel, 2026-09-06: the dropdown used to list the whole catalogue
    // and there was no way out of it). Results only appear once she types, and close on
    // Escape / tap outside / pick.
    if (!query.trim()) { setResults([]); setSearching(false); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await actions.searchOnlineProductsAction(query);
      setResults(res.products ?? []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function addToCart(p: OnlineProduct) {
    const key = `${p.ficheId}:${p.variantId ?? ''}`;
    setCart(prev => {
      const existing = prev.find(l => l.key === key);
      if (existing) return prev.map(l => l.key === key ? { ...l, qty: l.qty + 1 } : l);
      return [...prev, {
        key, ficheId: p.ficheId, variantId: p.variantId, qty: 1, unitPrice: p.price ?? 0,
        message: null, designNotes: null, designPhotoUrl: null, lineNote: null,
        nameVi: p.nameVi, imageUrl: p.imageUrl, isCake: p.isCake, listPrice: p.price,
      }];
    });
    setQuery(''); setResults([]); setSearchOpen(false);
  }
  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function removeLine(key: string) {
    setCart(prev => prev.filter(l => l.key !== key));
  }
  async function onDesignPhoto(key: string, file: File) {
    const fd = new FormData(); fd.append('file', await compressImage(file));
    const res = await actions.uploadOnlineDesignPhotoAction(fd);
    if (res.url) updateLine(key, { designPhotoUrl: res.url });
  }

  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0), [cart]);
  const feesTotal = useMemo(() => feeCart.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0), [feeCart]);
  const grandTotal = cartTotal + feesTotal + (Number(deliveryFee) || 0);

  async function handleSubmit() {
    if (!channel.trim()) { setSubmitMsg({ kind: 'error', text: tr('errChannel') }); return; }
    if (!cart.length) { setSubmitMsg({ kind: 'error', text: tr('errEmpty') }); return; }
    setSubmitting(true); setSubmitMsg(null);
    if (source === 'shop_stock') {
      const res = await actions.submitShopStockSaleAction({
        shop, channel: channel.trim(), saleDate: deliveryDate,
        customerName: customerName || null, customerPhone: customerPhone || null,
        deliveryAddress: deliveryAddress || null, notes: notes || null,
        deliveryFee: Number(deliveryFee) || 0, paymentStatus, amountPaid: Number(amountPaid) || 0,
        items: cart.map(l => ({ ficheId: l.ficheId, variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, lineNote: l.lineNote ?? null })),
        fees: feeCart.map(l => ({ emoji: l.emoji, label: l.label, qty: l.qty, unitPrice: l.unitPrice })),
      });
      setSubmitting(false);
      if (res.error) { setSubmitMsg({ kind: 'error', text: res.error }); return; }
      setSubmitMsg({ kind: 'ok', text: tr('okStock') });
    } else {
      const res = await actions.submitOnlineOrderAction({
        shop, channel: channel.trim(), deliveryDate, readyTime: readyTime || null,
        customerName: customerName || null, customerPhone: customerPhone || null,
        deliveryAddress: deliveryAddress || null, notes: notes || null,
        deliveryFee: Number(deliveryFee) || 0, paymentStatus, amountPaid: Number(amountPaid) || 0,
        items: cart.map(({ key, nameVi, imageUrl, isCake, listPrice, ...rest }) => rest),
        fees: feeCart.map(l => ({ emoji: l.emoji, label: l.label, qty: l.qty, unitPrice: l.unitPrice })),
      });
      setSubmitting(false);
      if (res.error) { setSubmitMsg({ kind: 'error', text: res.error }); return; }
      if (res.warning) { setSubmitMsg({ kind: 'warn', text: res.warning }); }
      else setSubmitMsg({ kind: 'ok', text: res.orderRef ? `${tr('okOdoo')}${res.orderRef}` : tr('okSaved') });
    }
    setCart([]); setFeeCart([]); setChannel(''); setCustomerName(''); setCustomerPhone(''); setDeliveryAddress(''); setNotes('');
    setDeliveryFee('0'); setPaymentStatus('unpaid'); setAmountPaid('0');
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: CREAM }}>
      <Header fullName={fullName} count={cart.length} tab={tab} />
      <div className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-xl mx-auto px-4 py-4">
          {tab === 'order' && (
            <OrderTab
              source={source} setSource={setSource}
              shop={shop} setShop={setShop} channel={channel} setChannel={setChannel}
              channels={channels} newChannel={newChannel} setNewChannel={setNewChannel} addChannel={addChannel} deleteChannel={deleteChannel}
              deliveryDate={deliveryDate} setDeliveryDate={setDeliveryDate}
              readyTime={readyTime} setReadyTime={setReadyTime}
              customerName={customerName} setCustomerName={setCustomerName}
              customerPhone={customerPhone} setCustomerPhone={setCustomerPhone}
              deliveryAddress={deliveryAddress} setDeliveryAddress={setDeliveryAddress}
              notes={notes} setNotes={setNotes}
              deliveryFee={deliveryFee} setDeliveryFee={setDeliveryFee}
              paymentStatus={paymentStatus} setPaymentStatus={setPaymentStatus}
              amountPaid={amountPaid} setAmountPaid={setAmountPaid}
              cart={cart} updateLine={updateLine} removeLine={removeLine} onDesignPhoto={onDesignPhoto}
              query={query} setQuery={setQuery} results={results} searching={searching} addToCart={addToCart}
              searchOpen={searchOpen} setSearchOpen={setSearchOpen}
              feeTypes={feeTypes} feeCart={feeCart} addFeeToCart={addFeeToCart} updateFeeLine={updateFeeLine} removeFeeLine={removeFeeLine}
              manageFeesOpen={manageFeesOpen} setManageFeesOpen={setManageFeesOpen}
              newFeeEmoji={newFeeEmoji} setNewFeeEmoji={setNewFeeEmoji} newFeeLabel={newFeeLabel} setNewFeeLabel={setNewFeeLabel}
              newFeePrice={newFeePrice} setNewFeePrice={setNewFeePrice} addFeeType={addFeeType}
              updateFeeTypePrice={updateFeeTypePrice} updateFeeTypeLabel={updateFeeTypeLabel} deleteFeeType={deleteFeeType}
              cartTotal={cartTotal} feesTotal={feesTotal} grandTotal={grandTotal}
              submitting={submitting} submitMsg={submitMsg} onSubmit={handleSubmit}
            />
          )}
          {tab === 'track' && <TrackTab isAdmin={isAdmin} />}
          {tab === 'stats' && <StatsTab />}
        </div>
      </div>
      <TabBar tab={tab} setTab={setTab} />
    </div>
  );
}

function Header({ fullName, count, tab }: { fullName: string; count: number; tab: Tab }) {
  const { tr, lang, setLang } = useL();
  const dateLabel = new Date().toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const [bellState, setBellState] = useState<'off' | 'on' | 'busy'>('off');
  useEffect(() => {
    getExistingPushSubscription().then(sub => setBellState(sub ? 'on' : 'off'));
  }, []);
  async function toggleBell() {
    if (bellState === 'busy') return;
    setBellState('busy');
    if (bellState === 'on') {
      const endpoint = await unsubscribeCurrentPush();
      if (endpoint) await actions.unsubscribeOnlinePushAction(endpoint);
      setBellState('off');
      return;
    }
    const result = await requestPushSubscription();
    if (result.ok) { await actions.subscribeOnlinePushAction(result.subscription); setBellState('on'); }
    else setBellState('off');
  }
  const titles: Record<Tab, string> = { order: tr('titleOrder'), track: tr('titleTrack'), stats: tr('titleStats') };
  return (
    <div style={{ backgroundColor: NAVY, color: '#FFFAEE' }} className="px-4 pt-3.5 pb-3 sticky top-0 z-10">
      <div className="flex items-center gap-2.5">
        <div style={{ width: 34, height: 34, borderRadius: '50%', backgroundColor: GOLD }} className="flex items-center justify-center text-base flex-shrink-0">🛍️</div>
        <div className="flex-1 min-w-0">
          <div style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 16, lineHeight: 1.15 }}>{titles[tab]}</div>
          <div style={{ fontSize: 11, color: '#F0D98A', marginTop: 1 }}>{dateLabel}{fullName ? ` · ${fullName}` : ''}</div>
        </div>
        {tab === 'order' && count > 0 && (
          <div style={{ backgroundColor: GOLD, color: NAVY, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999 }}>{count} {tr('items')}</div>
        )}
        {pushSupport() !== 'unsupported' && (
          <button onClick={toggleBell} style={{ color: bellState === 'on' ? GOLD : 'rgba(255,255,255,0.5)' }} aria-label={tr('bell')}>
            {bellState === 'busy' ? <Loader2 size={18} className="animate-spin" /> : <Bell size={18} fill={bellState === 'on' ? GOLD : 'none'} />}
          </button>
        )}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.25)' }} aria-label="Language">
          {(['vi', 'en'] as const).map(lg => (
            <button key={lg} onClick={() => setLang(lg)} style={{
              fontSize: 10.5, fontWeight: 700, padding: '3px 7px', letterSpacing: '.03em',
              backgroundColor: lang === lg ? GOLD : 'transparent', color: lang === lg ? NAVY : 'rgba(255,255,255,0.7)',
            }}>{lg.toUpperCase()}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { tr } = useL();
  const items: { key: Tab; icon: string; label: string }[] = [
    { key: 'order', icon: '🧾', label: tr('tabOrder') },
    { key: 'track', icon: '📦', label: tr('tabTrack') },
    { key: 'stats', icon: '📊', label: tr('tabStats') },
  ];
  return (
    <div style={{ backgroundColor: TABBAR }} className="flex fixed bottom-0 left-0 right-0 z-10">
      {items.map(it => (
        <button key={it.key} onClick={() => setTab(it.key)} className="flex-1 text-center py-2.5"
          style={{ color: tab === it.key ? GOLD : '#8FAE9E', fontWeight: tab === it.key ? 700 : 500, fontSize: 11.5, borderTop: `2px solid ${tab === it.key ? GOLD : 'transparent'}` }}>
          <div>{it.icon}</div>{it.label}
        </button>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{children}</div>;
}

function OrderTab(props: any) {
  const {
    source, setSource,
    shop, setShop, channel, setChannel, channels, newChannel, setNewChannel, addChannel, deleteChannel,
    deliveryDate, setDeliveryDate, readyTime, setReadyTime,
    customerName, setCustomerName, customerPhone, setCustomerPhone, deliveryAddress, setDeliveryAddress,
    notes, setNotes, deliveryFee, setDeliveryFee, paymentStatus, setPaymentStatus, amountPaid, setAmountPaid,
    cart, updateLine, removeLine, onDesignPhoto, query, setQuery, results, searching, addToCart, searchOpen, setSearchOpen,
    feeTypes, feeCart, addFeeToCart, updateFeeLine, removeFeeLine, manageFeesOpen, setManageFeesOpen,
    newFeeEmoji, setNewFeeEmoji, newFeeLabel, setNewFeeLabel, newFeePrice, setNewFeePrice, addFeeType,
    updateFeeTypePrice, updateFeeTypeLabel, deleteFeeType,
    cartTotal, feesTotal, grandTotal, submitting, submitMsg, onSubmit,
  } = props;
  const { tr } = useL();

  const isStock = source === 'shop_stock';
  return (
    <div>
      <SectionLabel>{tr('sourceLabel')}</SectionLabel>
      <div className="grid grid-cols-2 gap-2 mb-1.5">
        {([['lab', tr('srcLab')], ['shop_stock', tr('srcStock')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setSource(k)}
            style={{
              backgroundColor: source === k ? (k === 'shop_stock' ? '#B45309' : NAVY) : '#fff',
              color: source === k ? '#FFFAEE' : INK, border: source === k ? 'none' : `1px solid ${BORDER}`,
              fontSize: 12.5, fontWeight: source === k ? 700 : 500, padding: '9px 8px', borderRadius: 10,
            }}>{label}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: isStock ? '#B45309' : INK_LIGHT, marginBottom: 16, fontWeight: isStock ? 600 : 400 }}>
        {isStock ? tr('srcStockHint') : tr('srcLabHint')}
      </div>

      <SectionLabel>{tr('channelLabel')}</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-2">
        {channels.map((c: string) => (
          <span key={c} className="inline-flex items-center rounded-full overflow-hidden"
            style={{ border: channel === c ? 'none' : `1px solid ${BORDER}`, backgroundColor: channel === c ? NAVY : '#fff' }}>
            <button onClick={() => setChannel(c)}
              style={{ color: channel === c ? '#FFFAEE' : INK, fontSize: 12.5, fontWeight: channel === c ? 600 : 500, padding: '7px 6px 7px 14px' }}>{c}</button>
            <button onClick={() => deleteChannel(c)} aria-label="remove"
              style={{ color: channel === c ? '#F0D98A' : INK_LIGHT, padding: '7px 9px 7px 3px', lineHeight: 0 }}><X size={11} /></button>
          </span>
        ))}
        <span className="inline-flex items-center rounded-full" style={{ border: `1px dashed ${BORDER}`, backgroundColor: '#fff' }}>
          <input value={newChannel} onChange={(e: any) => setNewChannel(e.target.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') { e.preventDefault(); addChannel(); } }}
            placeholder={tr('channelAdd')} className="text-sm outline-none bg-transparent"
            style={{ padding: '7px 4px 7px 14px', width: 150, fontSize: 12.5 }} />
          <button onClick={addChannel} disabled={!newChannel.trim()} aria-label="add"
            style={{ color: newChannel.trim() ? NAVY : INK_LIGHT, padding: '7px 10px 7px 4px', lineHeight: 0 }}><Plus size={13} /></button>
        </span>
      </div>
      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 16 }}>{tr('channelHint')}</div>

      <SectionLabel>{tr('shopLabel')}</SectionLabel>
      <div className="flex flex-wrap gap-2 mb-4">
        {ONLINE_SHOPS.map((s: string) => (
          <button key={s} onClick={() => setShop(s)}
            style={{
              backgroundColor: shop === s ? NAVY : '#fff', color: shop === s ? '#FFFAEE' : INK,
              border: shop === s ? 'none' : `1px solid ${BORDER}`, fontSize: 12.5, fontWeight: shop === s ? 600 : 500,
              padding: '7px 14px', borderRadius: 999,
            }}>{s}</button>
        ))}
      </div>

      <SectionLabel>{tr('addProduct')}</SectionLabel>
      <div className="relative mb-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <Search size={14} color={INK_LIGHT} />
          <input value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} placeholder={tr('searchPh')}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); (e.target as HTMLInputElement).blur(); } }}
            className="flex-1 text-sm outline-none" />
          {searching && <Loader2 size={14} className="animate-spin" color={INK_LIGHT} />}
          {!searching && query && (
            <button onMouseDown={e => e.preventDefault()} onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="clear"><X size={14} color={INK_LIGHT} /></button>
          )}
        </div>
        {searchOpen && query.trim() && results.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg shadow-lg max-h-64 overflow-y-auto" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {results.map((p: OnlineProduct) => (
              <button key={`${p.ficheId}:${p.variantId}`} onMouseDown={e => e.preventDefault()} onClick={() => addToCart(p)}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
                {p.imageUrl ? <img src={p.imageUrl} className="w-8 h-8 rounded object-cover" /> : <div className="w-8 h-8 rounded" style={{ backgroundColor: CREAM }} />}
                <span>{p.nameVi}{p.isCake ? ' 🎂' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {cart.length > 0 && (
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          {cart.map((l: CartLine) => (
            <div key={l.key} className="p-3" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
              <div className="flex items-center gap-2.5">
                {l.imageUrl
                  ? <img src={thumb(l.imageUrl, 112)} alt="" loading="lazy" className="w-12 h-12 rounded-lg object-cover shrink-0" style={{ border: `1px solid ${BORDER}` }} />
                  : <div className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: CREAM }}>{l.isCake ? '🎂' : '🥐'}</div>}
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.nameVi}</div>
                </div>
                <button onClick={() => removeLine(l.key)}><X size={14} color={INK_LIGHT} /></button>
              </div>
              <div className="flex items-center justify-between mt-2" style={{ fontSize: 11, color: INK_LIGHT }}>
                <span>{tr('priceLabel')}</span>
                {l.listPrice != null && <span>{tr('listPrice')}: <b style={{ color: INK }}>{fmtVnd(l.listPrice)}</b></span>}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Minus size={12} color={NAVY} /></button>
                  <span style={{ fontSize: 13.5, fontWeight: 700, width: 18, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => updateLine(l.key, { qty: l.qty + 1 })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Plus size={12} color={NAVY} /></button>
                </div>
                <input type="number" min={0} value={l.unitPrice} onChange={e => updateLine(l.key, { unitPrice: Number(e.target.value) })}
                  placeholder={tr('unitPrice')} className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 64, textAlign: 'right' }}>{fmtCompactVnd(l.qty * (Number(l.unitPrice) || 0))}</div>
              </div>
              <input value={l.lineNote ?? ''} onChange={e => updateLine(l.key, { lineNote: e.target.value })}
                placeholder={tr('lineNote')} maxLength={300}
                className="w-full px-2 py-1.5 rounded text-sm mt-2" style={{ border: `1px solid ${BORDER}` }} />
              {l.isCake && !isStock && (
                <div className="mt-2 space-y-2">
                  <input value={l.message ?? ''} onChange={e => updateLine(l.key, { message: e.target.value })}
                    placeholder={tr('cakeMsg')} maxLength={200}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <textarea value={l.designNotes ?? ''} onChange={e => updateLine(l.key, { designNotes: e.target.value })}
                    placeholder={tr('designNotes')} maxLength={400} rows={2}
                    className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                  <div style={{ fontSize: 11, color: INK_LIGHT }}>{tr('designPhotoHint')}</div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs cursor-pointer" style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT }}>
                      🖼️ {tr('designPhoto')}
                      <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onDesignPhoto(l.key, f); }} />
                    </label>
                    {l.designPhotoUrl && <img src={thumb(l.designPhotoUrl, 112)} className="w-10 h-10 rounded object-cover" style={{ border: `1px solid ${BORDER}` }} />}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <SectionLabel>{tr('feesLabel')}</SectionLabel>
        <button onClick={() => setManageFeesOpen(true)} className="inline-flex items-center gap-1 rounded-full"
          style={{ color: NAVY, backgroundColor: CREAM, fontSize: 11, fontWeight: 700, padding: '4px 9px 4px 8px', marginBottom: 8 }}>
          <Settings size={11} />{tr('manageFees')}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        {feeTypes.map((f: ExtraFeeType) => (
          <button key={f.id} onClick={() => addFeeToCart(f)} className="inline-flex items-center gap-1.5 rounded-full"
            style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', fontSize: 12.5, fontWeight: 600, padding: '7px 12px', color: INK }}>
            {f.emoji ? `${f.emoji} ` : ''}{f.label} <span style={{ color: INK_LIGHT, fontWeight: 500 }}>+{fmtCompactVnd(f.defaultPrice)}</span>
          </button>
        ))}
        <button onClick={() => setManageFeesOpen(true)} className="inline-flex items-center gap-1 rounded-full"
          style={{ border: `1px dashed ${BORDER}`, fontSize: 12.5, fontWeight: 600, padding: '7px 12px 7px 10px', color: INK_LIGHT }}>
          <Plus size={12} />{tr('addFeeType')}
        </button>
      </div>

      {feeCart.length > 0 && (
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          {feeCart.map((l: any) => (
            <div key={l.key} className="p-3" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
              <div className="flex items-center gap-2.5">
                <div className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: CREAM }}>{l.emoji ?? '🎁'}</div>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{l.label}</div>
                  <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: '#9C7C2C', backgroundColor: CREAM, borderRadius: 5, padding: '2px 6px' }}>{tr('feeBadge')}</span>
                </div>
                <button onClick={() => removeFeeLine(l.key)}><X size={14} color={INK_LIGHT} /></button>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateFeeLine(l.key, { qty: Math.max(1, l.qty - 1) })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Minus size={12} color={NAVY} /></button>
                  <span style={{ fontSize: 13.5, fontWeight: 700, width: 18, textAlign: 'center' }}>{l.qty}</span>
                  <button onClick={() => updateFeeLine(l.key, { qty: l.qty + 1 })}
                    style={{ width: 24, height: 24, borderRadius: 6, backgroundColor: CREAM }} className="flex items-center justify-center"><Plus size={12} color={NAVY} /></button>
                </div>
                <input type="number" min={0} value={l.unitPrice} onChange={(e: any) => updateFeeLine(l.key, { unitPrice: Number(e.target.value) })}
                  className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
                <div style={{ fontSize: 13.5, fontWeight: 700, minWidth: 64, textAlign: 'right' }}>{fmtCompactVnd(l.qty * (Number(l.unitPrice) || 0))}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {manageFeesOpen && (
        <div className="fixed inset-0 z-30 flex items-end justify-center" style={{ backgroundColor: 'rgba(26,44,36,0.42)' }} onClick={() => setManageFeesOpen(false)}>
          <div onClick={(e: any) => e.stopPropagation()} className="w-full max-w-xl rounded-t-2xl p-4" style={{ backgroundColor: '#FFFEFB', maxHeight: '82vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between mb-1">
              <span style={{ fontSize: 14.5, fontWeight: 700 }}>⚙ {tr('manageFeesTitle')}</span>
              <button onClick={() => setManageFeesOpen(false)}><X size={16} color={INK_LIGHT} /></button>
            </div>
            <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 12 }}>{tr('manageFeesHint')}</div>
            {feeTypes.map((f: ExtraFeeType) => (
              <div key={f.id} className="flex items-center gap-2 py-2" style={{ borderBottom: `1px solid ${CREAM_DARK}` }}>
                <span style={{ fontSize: 17, width: 22, textAlign: 'center' }}>{f.emoji ?? '🎁'}</span>
                <input value={f.label} onChange={(e: any) => updateFeeTypeLabel(f.id, e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded text-sm min-w-0" style={{ border: `1px solid ${BORDER}` }} />
                <input type="number" value={f.defaultPrice} onChange={(e: any) => updateFeeTypePrice(f.id, Number(e.target.value) || 0)}
                  className="px-2 py-1.5 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}`, width: 84 }} />
                <button onClick={() => deleteFeeType(f.id)}><X size={14} color={INK_LIGHT} /></button>
              </div>
            ))}
            <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: `1px dashed ${BORDER}` }}>
              <input value={newFeeEmoji} onChange={(e: any) => setNewFeeEmoji(e.target.value)} maxLength={4}
                className="px-2 py-1.5 rounded text-sm text-center" style={{ border: `1px solid ${BORDER}`, width: 44 }} />
              <input value={newFeeLabel} onChange={(e: any) => setNewFeeLabel(e.target.value)} placeholder={tr('newFeeNamePh')}
                className="flex-1 px-2 py-1.5 rounded text-sm min-w-0" style={{ border: `1px solid ${BORDER}` }} />
              <input type="number" value={newFeePrice} onChange={(e: any) => setNewFeePrice(e.target.value)} placeholder={tr('newFeePricePh')}
                className="px-2 py-1.5 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}`, width: 84 }} />
              <button onClick={addFeeType} disabled={!newFeeLabel.trim()}
                style={{ backgroundColor: NAVY, color: '#FFFAEE', fontSize: 12.5, fontWeight: 700, padding: '8px 12px', borderRadius: 8, opacity: newFeeLabel.trim() ? 1 : 0.4 }}>
                + {tr('addBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionLabel>{tr('customerInfo')}</SectionLabel>
      <div className="rounded-xl p-3 mb-4 space-y-2" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <input value={customerName} onChange={(e: any) => setCustomerName(e.target.value)} placeholder={tr('custName')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input value={customerPhone} onChange={(e: any) => setCustomerPhone(e.target.value)} placeholder={tr('custPhone')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <input value={deliveryAddress} onChange={(e: any) => setDeliveryAddress(e.target.value)} placeholder={tr('address')}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        <div className="flex gap-2">
          <input type="date" value={deliveryDate} onChange={(e: any) => setDeliveryDate(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
          {!isStock && <input type="time" value={readyTime} onChange={(e: any) => setReadyTime(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />}
        </div>
        <textarea value={notes} onChange={(e: any) => setNotes(e.target.value)} placeholder={tr('extraNotes')} rows={2}
          className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
      </div>

      <SectionLabel>{tr('payment')}</SectionLabel>
      <div className="rounded-xl p-3 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {feesTotal > 0 && (
          <div className="flex justify-between items-center mb-2">
            <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('feesRow')}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtVnd(feesTotal)}</span>
          </div>
        )}
        <div className="flex justify-between items-center mb-2">
          <span style={{ fontSize: 13, color: INK_LIGHT }}>{tr('deliveryFee')}</span>
          <input type="number" min={0} value={deliveryFee} onChange={(e: any) => setDeliveryFee(e.target.value)}
            className="w-28 px-2 py-1 rounded text-sm text-right" style={{ border: `1px solid ${BORDER}` }} />
        </div>
        <div className="flex justify-between items-center mb-3">
          <span style={{ fontSize: 14.5, fontWeight: 700 }}>{tr('total')}</span>
          <span style={{ fontSize: 17, fontWeight: 700, color: NAVY }}>{fmtVnd(grandTotal)}</span>
        </div>
        <div className="flex gap-2 mb-2">
          {(['paid', 'unpaid', 'partial'] as const).map(s => (
            <button key={s} onClick={() => setPaymentStatus(s)}
              style={{
                flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 700, padding: '8px 0', borderRadius: 8,
                backgroundColor: paymentStatus === s ? '#047857' : CREAM, color: paymentStatus === s ? '#fff' : INK_LIGHT,
                border: paymentStatus === s ? 'none' : `1px solid ${BORDER}`,
              }}>
              {s === 'paid' ? tr('paid') : s === 'unpaid' ? tr('unpaid') : tr('partial')}
            </button>
          ))}
        </div>
        {paymentStatus === 'partial' && (
          <input type="number" min={0} value={amountPaid} onChange={(e: any) => setAmountPaid(e.target.value)}
            placeholder={tr('depositAmount')} className="w-full px-2 py-1.5 rounded text-sm" style={{ border: `1px solid ${BORDER}` }} />
        )}
      </div>

      {submitMsg && (
        <div className="rounded-lg p-2.5 mb-3 text-sm" style={{
          backgroundColor: submitMsg.kind === 'ok' ? '#F0FDF4' : submitMsg.kind === 'warn' ? '#FFFBEB' : '#FDECEC',
          color: submitMsg.kind === 'ok' ? '#047857' : submitMsg.kind === 'warn' ? '#b45309' : '#dc2626',
        }}>{submitMsg.text}</div>
      )}

      <button onClick={onSubmit} disabled={submitting || !cart.length}
        style={{ backgroundColor: isStock ? '#B45309' : GOLD, color: isStock ? '#fff' : NAVY, opacity: submitting || !cart.length ? 0.6 : 1 }}
        className="w-full text-center text-[15px] font-bold py-3.5 rounded-xl mb-4">
        {submitting ? (isStock ? tr('savingStock') : tr('creating')) : (isStock ? tr('submitStock') : tr('submit'))}
      </button>
    </div>
  );
}

// Reconstruction panel (Axel, 2026-09-08): lets the seller replace a historical import's single
// generic no-SKU revenue line with real catalog items, if she still remembers the order. Reuses
// the same product search as the order-creation tab; deliberately minimal (no delivery-date,
// shop, cake-message fields -- this only ever edits WHAT was sold, never re-triggers anything).
type ReconstructLine = { key: string; ficheId: string; variantId: string | null; sku: string | null; nameVi: string; qty: number; unitPrice: number };

function ReconstructPanel({ order, onDone, onCancel }: { order: OnlineOrderSummary; onDone: () => void; onCancel: () => void }) {
  const { tr } = useL();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<ReconstructLine[]>([]);
  const [saving, setSaving] = useState(false);
  const originalText = order.items.map(i => i.nameVi).join(', ');

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await actions.searchOnlineProductsAction(q);
      setResults(res.products ?? []);
      setSearching(false);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  function addLine(p: OnlineProduct) {
    setLines(ls => [...ls, { key: `${p.ficheId}:${p.variantId}:${ls.length}`, ficheId: p.ficheId, variantId: p.variantId, sku: p.sku, nameVi: p.nameVi, qty: 1, unitPrice: p.price ?? 0 }]);
    setQuery('');
  }
  function removeLine(key: string) { setLines(ls => ls.filter(l => l.key !== key)); }
  function updateQty(key: string, qty: number) { setLines(ls => ls.map(l => l.key === key ? { ...l, qty: Math.max(1, qty) } : l)); }
  function updatePrice(key: string, unitPrice: number) { setLines(ls => ls.map(l => l.key === key ? { ...l, unitPrice: Math.max(0, unitPrice) } : l)); }

  async function save() {
    if (!lines.length) return;
    setSaving(true);
    await actions.replaceOnlineOrderLinesAction(order.orderBatchId, lines.map(l => ({ ficheId: l.ficheId, variantId: l.variantId, sku: l.sku, nameVi: l.nameVi, qty: l.qty, unitPrice: l.unitPrice })));
    setSaving(false);
    onDone();
  }

  return (
    <div className="rounded-lg p-3 mb-2" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#6D28D9', marginBottom: 4 }}>{tr('reconstructTitle')}</div>
      <div style={{ fontSize: 11.5, color: INK_LIGHT, marginBottom: 8, fontStyle: 'italic' }}>{tr('reconstructHint')}{originalText}</div>

      <div className="relative mb-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <Search size={13} color={INK_LIGHT} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('reconstructSearchPh')}
            className="flex-1 text-sm outline-none" style={{ fontSize: 12.5 }} />
          {searching && <Loader2 size={13} className="animate-spin" color={INK_LIGHT} />}
        </div>
        {query.trim() && results.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg shadow-lg max-h-56 overflow-y-auto" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {results.map(p => (
              <button key={`${p.ficheId}:${p.variantId}`} onMouseDown={e => e.preventDefault()} onClick={() => addLine(p)}
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-gray-50" style={{ borderBottom: `1px solid ${CREAM_DARK}`, fontSize: 12.5 }}>
                {p.nameVi}{p.isCake ? ' 🎂' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <div style={{ fontSize: 11.5, color: INK_LIGHT, marginBottom: 8 }}>{tr('reconstructEmpty')}</div>
      ) : (
        <div className="space-y-1.5 mb-2">
          {lines.map(l => (
            <div key={l.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
              <span className="flex-1 min-w-0 truncate" style={{ fontSize: 12 }}>{l.nameVi}</span>
              <input type="number" min={1} value={l.qty} onChange={e => updateQty(l.key, Number(e.target.value))}
                className="text-center rounded" style={{ width: 36, fontSize: 12, border: `1px solid ${BORDER}`, padding: '2px 0' }} />
              <input type="number" min={0} value={l.unitPrice} onChange={e => updatePrice(l.key, Number(e.target.value))}
                className="text-right rounded" style={{ width: 76, fontSize: 12, border: `1px solid ${BORDER}`, padding: '2px 4px' }} />
              <button onClick={() => removeLine(l.key)}><X size={13} color={INK_LIGHT} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} style={{ fontSize: 12, fontWeight: 600, color: INK_LIGHT, padding: '6px 12px' }}>{tr('reconstructCancel')}</button>
        <button onClick={save} disabled={!lines.length || saving}
          style={{ fontSize: 12, fontWeight: 700, color: '#fff', backgroundColor: '#6D28D9', padding: '6px 14px', borderRadius: 8, opacity: !lines.length || saving ? 0.5 : 1 }}>
          {saving ? tr('reconstructSaving') : tr('reconstructSave')}
        </button>
      </div>
    </div>
  );
}

function TrackTab({ isAdmin }: { isAdmin: boolean }) {
  const { tr, lang } = useL();
  const [orders, setOrders] = useState<OnlineOrderSummary[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'undelivered' | 'unpaid' | 'late'>('all');
  // Every hook stays above the early `if (!orders) return` below (Rules of Hooks — the payment
  // proof hook briefly sat after it and crashed the tab once orders loaded, 2026-09-06).
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  // Calendar jump (Axel, 2026-09-08): default view stays the last-200-by-created_at list exactly
  // as before; picking a date here re-queries that single delivery_date only, so finding a given
  // day no longer means scrolling past a long, growing history (imports included).
  const [jumpDate, setJumpDate] = useState('');
  const [reconstructing, setReconstructing] = useState<string | null>(null);

  async function load(deliveryDate?: string) {
    const res = await actions.getMyOnlineOrdersAction(deliveryDate ? { deliveryDate } : undefined);
    setOrders(res.orders ?? []);
  }
  useEffect(() => { load(jumpDate || undefined); }, [jumpDate]);

  if (!orders) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const isLate = (o: OnlineOrderSummary) => o.paymentStatus !== 'paid' && (o.labDelivered || o.shopDelivered) && Date.now() - new Date(o.createdAt).getTime() > 24 * 3600 * 1000;
  const filtered = orders.filter(o => {
    if (filter === 'undelivered') return !o.labDelivered || !o.shopDelivered;
    if (filter === 'unpaid') return o.paymentStatus !== 'paid';
    if (filter === 'late') return isLate(o);
    return true;
  });

  // Group by delivery date so orders shipping on different days are never mixed in one
  // undifferentiated list — the tracking tab was previously sorted only by created_at, which
  // hid which day each order actually needs to go out.
  const todayKey = new Date().toISOString().slice(0, 10);
  const tomorrowKey = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const groups = new Map<string, OnlineOrderSummary[]>();
  for (const o of filtered) {
    const key = (o.deliveryDate || '').slice(0, 10);
    const arr = groups.get(key) ?? [];
    arr.push(o); groups.set(key, arr);
  }
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1; // no-date group always last
    if (!b) return -1;
    return a.localeCompare(b);
  });
  function groupLabel(key: string): string {
    if (!key) return tr('noDeliveryDate');
    if (key === todayKey) return `${tr('today')} · ${fmtDayLabel(key, lang)}`;
    if (key === tomorrowKey) return `${tr('tomorrow')} · ${fmtDayLabel(key, lang)}`;
    if (key < todayKey) return `${tr('overdue')} · ${fmtDayLabel(key, lang)}`;
    return fmtDayLabel(key, lang);
  }

  async function toggleShopDelivered(o: OnlineOrderSummary) {
    await actions.setShopDeliveredAction(o.orderBatchId, !o.shopDelivered);
    load(jumpDate || undefined);
  }
  async function onProof(o: OnlineOrderSummary, file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    setUploadingFor(o.orderBatchId);
    const fd = new FormData(); fd.append('file', await compressImage(file));
    await actions.uploadPaymentProofAction(o.orderBatchId, fd);
    setUploadingFor(null);
    load(jumpDate || undefined);
  }
  async function cyclePayment(o: OnlineOrderSummary) {
    const next = o.paymentStatus === 'unpaid' ? 'partial' : o.paymentStatus === 'partial' ? 'paid' : 'unpaid';
    await actions.setPaymentStatusAction(o.orderBatchId, next, next === 'paid' ? o.total + o.deliveryFee : o.amountPaid);
    load(jumpDate || undefined);
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <CalendarDays size={14} style={{ color: INK_LIGHT, flexShrink: 0 }} />
          <input type="date" value={jumpDate} onChange={e => setJumpDate(e.target.value)}
            aria-label={tr('jumpToDate')}
            style={{ border: 'none', outline: 'none', fontSize: 12.5, fontWeight: 600, color: INK, background: 'transparent' }} />
        </div>
        {jumpDate && (
          <button onClick={() => setJumpDate('')} style={{
            fontSize: 11.5, fontWeight: 700, color: '#8a7326', backgroundColor: CREAM, border: `1px solid ${BORDER}`,
            padding: '6px 10px', borderRadius: 8, whiteSpace: 'nowrap',
          }}>{tr('clearDate')}</button>
        )}
      </div>
      <div className="flex gap-2 mb-3 overflow-x-auto">
        {([['all', tr('fAll')], ['undelivered', tr('fUndelivered')], ['unpaid', tr('unpaid')], ['late', tr('fLate')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            backgroundColor: filter === k ? NAVY : '#fff', color: filter === k ? '#FFFAEE' : INK,
            border: filter === k ? 'none' : `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>
      {filtered.length === 0 && <div className="text-center py-10 text-sm" style={{ color: INK_LIGHT }}>{tr('noOrders')}</div>}
      <div className="space-y-4">
        {groupKeys.map(key => (
          <div key={key || '__none__'}>
            <div className="flex items-center gap-2 mb-2 px-0.5">
              <span style={{
                fontSize: 11.5, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase',
                color: key && key < todayKey ? '#dc2626' : INK_LIGHT,
              }}>{groupLabel(key)}</span>
              <span style={{ height: 1, flex: 1, backgroundColor: CREAM_DARK }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: INK_LIGHT }}>{groups.get(key)!.length}</span>
            </div>
            <div className="space-y-2.5">
              {groups.get(key)!.map(o => {
                const late = isLate(o);
                return (
                  <div key={o.orderBatchId} className="rounded-xl p-3" style={{ border: `1px solid ${late ? '#f3b8b8' : BORDER}`, backgroundColor: '#fff' }}>
              <div className="flex justify-between items-start mb-2">
                <div className="flex gap-1.5 items-center flex-wrap">
                  <span style={{ backgroundColor: NAVY, color: '#FFFAEE', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{o.shopName}</span>
                  {o.source === 'excel_import' ? (
                    <span style={{ backgroundColor: '#EDE9FE', color: '#6D28D9', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{tr('importBadge')}</span>
                  ) : o.source === 'shop_stock' ? (
                    <span style={{ backgroundColor: '#FEF3C7', color: '#B45309', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{tr('stockBadge')}</span>
                  ) : o.orderRef ? (
                    <span style={{ backgroundColor: CREAM, color: '#8a7326', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{o.orderRef}</span>
                  ) : (
                    <span style={{ backgroundColor: '#FDECEC', color: '#dc2626', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{tr('noOdoo')}</span>
                  )}
                  {o.channel && <span style={{ color: INK_LIGHT, fontSize: 10.5 }}>{o.channel}</span>}
                </div>
                {late && <span style={{ backgroundColor: '#FDECEC', color: '#dc2626', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>{tr('latePay')}</span>}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{o.customerName || tr('walkIn')}{o.customerPhone ? ` · ${o.customerPhone}` : ''}</div>
              <div style={{ fontSize: 12, color: INK_LIGHT, marginBottom: 9 }}>{o.items.map(i => `${i.nameVi} ×${i.qty}`).join(', ')}</div>
              {o.source === 'excel_import' && o.items.length > 0 && o.items.every(i => !i.sku) && (
                <button onClick={() => setReconstructing(reconstructing === o.orderBatchId ? null : o.orderBatchId)}
                  className="mb-2" style={{
                    display: 'inline-flex', alignItems: 'center', backgroundColor: '#EDE9FE', color: '#6D28D9',
                    fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999, border: 'none',
                  }}>{tr('needsItemsBadge')}</button>
              )}
              {reconstructing === o.orderBatchId && (
                <ReconstructPanel order={o} onDone={() => { setReconstructing(null); load(jumpDate || undefined); }} onCancel={() => setReconstructing(null)} />
              )}
              <div className="flex justify-between items-center mb-2">
                <span style={{ fontSize: 15, fontWeight: 700, color: NAVY }}>{fmtVnd(o.total + o.deliveryFee)}</span>
                <button onClick={() => cyclePayment(o)} style={{
                  backgroundColor: o.paymentStatus === 'paid' ? '#F0FDF4' : CREAM, border: o.paymentStatus === 'paid' ? 'none' : `1px solid ${BORDER}`,
                  color: o.paymentStatus === 'paid' ? '#047857' : '#b45309', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                }}>
                  {o.paymentStatus === 'paid' ? tr('paidFull') : o.paymentStatus === 'partial' ? tr('partial') : tr('unpaidFull')}
                </button>
              </div>
              <div className="flex items-center gap-2 mb-2"
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); onProof(o, e.dataTransfer.files?.[0]); }}>
                {o.paymentProofUrl && (
                  <a href={o.paymentProofUrl} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={thumb(o.paymentProofUrl, 128)} alt={tr('payProof')} loading="lazy" className="w-10 h-10 rounded-md object-cover" style={{ border: `1px solid ${BORDER}` }} />
                  </a>
                )}
                <label className="flex-1 text-center py-1.5 rounded-lg cursor-pointer" style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT, fontSize: 11.5, backgroundColor: '#FFFDF5' }}>
                  {uploadingFor === o.orderBatchId ? tr('uploading') : (o.paymentProofUrl ? `✓ ${tr('payProof')}` : tr('payProofDrop'))}
                  <input type="file" accept="image/*" className="hidden" onChange={e => onProof(o, e.target.files?.[0])} />
                </label>
              </div>
              <div style={{ height: 1, backgroundColor: CREAM_DARK, marginBottom: 9 }} />
              <div className="flex gap-2">
                {o.source !== 'shop_stock' && <div className="flex-1 text-center py-1.5 rounded-lg" style={{
                  backgroundColor: o.labDelivered ? '#F0FDF4' : CREAM, color: o.labDelivered ? '#047857' : INK_LIGHT,
                  border: o.labDelivered ? 'none' : `1px solid ${BORDER}`, fontSize: 11.5, fontWeight: o.labDelivered ? 700 : 600,
                }}>{o.labDelivered ? tr('labDelivered') : tr('labNot')}</div>}
                <button onClick={() => toggleShopDelivered(o)} className="flex-1 text-center py-1.5 rounded-lg" style={{
                  backgroundColor: o.shopDelivered ? '#F0FDF4' : CREAM, color: o.shopDelivered ? '#047857' : INK_LIGHT,
                  border: o.shopDelivered ? 'none' : `1px solid ${BORDER}`, fontSize: 11.5, fontWeight: o.shopDelivered ? 700 : 600,
                }}>{o.shopDelivered ? tr('shopDelivered') : tr('shopNot')}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsTab() {
  const { tr } = useL();
  const [range, setRange] = useState<14 | 30 | 90 | 365>(14);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [data, setData] = useState<OnlineAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    actions.getOnlineAnalyticsAction(range).then(res => { if (alive) { setData(res.data ?? null); setLoading(false); } });
    return () => { alive = false; };
  }, [range]);
  if (!data) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const maxShop = Math.max(1, ...data.byShop.map(s => s.total));
  const maxCat = Math.max(1, ...data.byCategory.map(c => c.total));
  const maxChannel = Math.max(1, ...data.byChannel.map(c => c.total));
  const sumShop = data.byShop.reduce((a, s) => a + s.total, 0) || 1;
  const sumCat = data.byCategory.reduce((a, c) => a + c.total, 0) || 1;
  const sumChannel = data.byChannel.reduce((a, c) => a + c.total, 0) || 1;
  const pct = (v: number, sum: number) => `${Math.round((v / sum) * 100)}%`;
  // Bar chart geometry (viewBox 320×110). A sqrt scale (not linear) keeps ordinary days
  // legible even when one outlier day dwarfs the rest — a single 3.3M day used to crush every
  // ~50k day down to an invisible sliver. Hover/tap a bar (or read the callout, defaulted to
  // the peak day) to see its exact date and amount.
  const series = data.series;
  const maxSeries = Math.max(1, ...series.map(d => d.total));
  const CH = { w: 320, h: 116, top: 20, bottom: 22, left: 2, right: 2 };
  const plotH = CH.h - CH.top - CH.bottom;
  const slot = (CH.w - CH.left - CH.right) / Math.max(1, series.length);
  const barW = Math.max(2, slot * 0.62);
  const barH = (v: number) => v <= 0 ? 0 : Math.max(2.5, Math.sqrt(v / maxSeries) * plotH);
  const MAX_LABELS = 6;
  const labelStep = Math.max(1, Math.ceil(series.length / MAX_LABELS));
  const labelIdx = new Set<number>();
  for (let i = 0; i < series.length; i += labelStep) labelIdx.add(i);
  if (series.length > 0) labelIdx.add(series.length - 1);
  const peakIdx = series.length ? series.reduce((best, d, i) => d.total > series[best].total ? i : best, 0) : -1;
  const shownIdx = activeIdx ?? (peakIdx >= 0 && series[peakIdx]?.total > 0 ? peakIdx : null);
  const shownDay = shownIdx !== null ? series[shownIdx] : null;
  const granularity = data.rangeDays <= 30 ? tr('perDay') : data.rangeDays <= 90 ? tr('perWeek') : tr('perMonth');
  const SHOP_HUES = [NAVY, '#2D6A4F', '#5C9179', '#8CB4A2', '#BBD4C7'];

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>{tr('today')}</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.todayTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.todayCount} {tr('orders')}</div>
        </div>
        <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <div style={{ fontSize: 11, color: INK_LIGHT, fontWeight: 600, marginBottom: 4 }}>{tr('thisMonth')}</div>
          <div style={{ fontSize: 19, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(data.monthTotal)}</div>
          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600, marginTop: 2 }}>{data.monthCount} {tr('orders')}</div>
        </div>
      </div>

      <SectionLabel>{tr('period')}</SectionLabel>
      <div className="flex gap-2 mb-3 overflow-x-auto">
        {([[14, tr('p14')], [30, tr('p30')], [90, tr('p90')], [365, tr('p365')]] as const).map(([d, label]) => (
          <button key={d} onClick={() => setRange(d)} style={{
            backgroundColor: range === d ? NAVY : '#fff', color: range === d ? '#FFFAEE' : INK,
            border: range === d ? 'none' : `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
        {loading && <Loader2 size={14} className="animate-spin self-center" color={INK_LIGHT} />}
      </div>

      <div className="rounded-xl p-3.5 mb-4" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', opacity: loading ? 0.6 : 1 }}>
        <div className="flex justify-between items-baseline mb-1">
          <SectionLabel>{tr('revenueTrend')} · {granularity}</SectionLabel>
          <div style={{ fontSize: 11, color: INK_LIGHT }}>{tr('rangeTotal')}: <b style={{ color: NAVY }}>{fmtVnd(data.rangeTotal)}</b> · {data.rangeCount} {tr('orders')}</div>
        </div>
        <div style={{ fontSize: 11.5, color: shownDay ? NAVY : INK_LIGHT, fontWeight: 700, marginBottom: 3, minHeight: 15 }}>
          {shownDay ? `${shownDay.label} — ${fmtVnd(shownDay.total)}` : ' '}
        </div>
        <svg viewBox={`0 0 ${CH.w} ${CH.h}`} width="100%" height={CH.h} role="img" aria-label={tr('trendAria')}
          onMouseLeave={() => setActiveIdx(null)}>
          <line x1={CH.left} x2={CH.w - CH.right} y1={CH.top + plotH} y2={CH.top + plotH} stroke={BORDER} />
          {series.map((d, i) => {
            const h = barH(d.total);
            const x = CH.left + i * slot + (slot - barW) / 2;
            const isShown = shownIdx === i;
            return (
              <g key={d.key}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => setActiveIdx(cur => cur === i ? null : i)}
                style={{ cursor: 'pointer' }}>
                {/* Wider invisible hit-area so short/zero bars are still easy to hover/tap. */}
                <rect x={CH.left + i * slot} y={CH.top} width={slot} height={plotH} fill="transparent" />
                <rect x={x} y={CH.top + plotH - h} width={barW} height={h} rx={1.5}
                  fill={d.total > 0 ? (isShown ? NAVY : GOLD) : CREAM_DARK} />
                {labelIdx.has(i) && (
                  <text x={x + barW / 2} y={CH.h - 8} fontSize={8.5}
                    fill={isShown ? NAVY : INK_LIGHT} fontWeight={isShown ? 700 : 400}
                    textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>{d.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <SectionLabel>{tr('bySource')}</SectionLabel>
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        {data.bySource.map(sv => (
          <div key={sv.source} className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
            <div style={{ fontSize: 11, color: sv.source === 'shop_stock' ? '#B45309' : INK_LIGHT, fontWeight: 700, marginBottom: 4 }}>{sv.source === 'shop_stock' ? tr('srcStockShort') : tr('srcLabShort')}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: NAVY }}>{fmtCompactVnd(sv.total)} <span style={{ fontSize: 12, color: INK_LIGHT, fontWeight: 600 }}>· {pct(sv.total, data.rangeTotal || 1)}</span></div>
            <div style={{ fontSize: 11, color: INK_LIGHT, marginTop: 2 }}>{sv.count} {tr('orders')}</div>
          </div>
        ))}
      </div>

      <SectionLabel>{tr('byShop')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byShop.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byShop.map((s, i) => (
          <div key={s.shop}>
            <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{s.shop}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtCompactVnd(s.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(s.total, sumShop)}</span></span>
            </div>
            <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${(s.total / maxShop) * 100}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
            </div>
          </div>
        ))}
      </div>

      <SectionLabel>{tr('byCat')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byCategory.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byCategory.map((c, i) => {
          const open = openCat === c.category;
          return (
          <div key={c.category}>
            <button onClick={() => setOpenCat(open ? null : c.category)} className="w-full text-left">
              <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
                <span style={{ fontWeight: 600 }}>{open ? '▾' : '▸'} {c.category} <span style={{ color: INK_LIGHT, fontWeight: 500, fontSize: 11 }}>({c.products.length})</span></span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtCompactVnd(c.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(c.total, sumCat)}</span></span>
              </div>
              <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
                <div style={{ width: `${(c.total / maxCat) * 100}%`, height: '100%', backgroundColor: SHOP_HUES[i % SHOP_HUES.length], borderRadius: 5 }} />
              </div>
            </button>
            {open && (
              <div className="mt-2 mb-1 rounded-lg" style={{ backgroundColor: '#FFFDF5', border: `1px solid ${CREAM_DARK}` }}>
                {c.products.map((p, j) => (
                  <div key={`${p.sku ?? p.name}-${j}`} className="flex justify-between items-center px-2.5 py-1.5" style={{ fontSize: 12, borderTop: j ? `1px solid ${CREAM_DARK}` : 'none' }}>
                    <span className="min-w-0 truncate" style={{ paddingRight: 8 }}>{p.name}{p.sku ? <span style={{ color: INK_LIGHT, fontSize: 10.5 }}> · {p.sku}</span> : null}</span>
                    <span className="shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>×{p.qty} · <b>{fmtCompactVnd(p.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11 }}>· {pct(p.total, c.total || 1)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>

      <SectionLabel>{tr('byChannel')}</SectionLabel>
      <div className="rounded-xl p-3.5 mb-4 space-y-2.5" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        {data.byChannel.length === 0 && <div style={{ fontSize: 13, color: INK_LIGHT }}>{tr('noData')}</div>}
        {data.byChannel.map((c, i) => (
          <div key={c.channel}>
            <div className="flex justify-between mb-1" style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>{c.channel}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}><b>{fmtCompactVnd(c.total)}</b> <span style={{ color: INK_LIGHT, fontSize: 11.5 }}>· {pct(c.total, sumChannel)}</span></span>
            </div>
            <div style={{ backgroundColor: CREAM, borderRadius: 5, height: 8, overflow: 'hidden' }}>
              <div style={{ width: `${(c.total / maxChannel) * 100}%`, height: '100%', backgroundColor: GOLD, borderRadius: 5 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
