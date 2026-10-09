// Raw materials (Axel, 2026-10-08) — shared by the chef station tab, the purchasing space and the
// admin report. Phase 1: everything lives in the app, Odoo is only read (products, vendors, recipes).
// Client-safe: no server import here.

export type RawType = 'dry' | 'fresh' | 'frozen';
export type RawPack = { label: string; factor: number }; // factor = base units (kg / L) in one pack

export type RawMaterial = {
  tmplId: number; sku: string | null; name: string; uom: string;
  /** Vietnamese name from Odoo's vi_VN translation (Axel, 2026-10-08: "faut mettre les items en viet, les articles odoo"). */
  nameVi: string | null;
  type: RawType; sub: string; packs: RawPack[];
  visible: boolean; checked: boolean; purchased: boolean;
  vendorId: number | null; vendorName: string | null; vendors: { id: number; name: string }[];
};

export const RAW_TYPES: Record<RawType, { vi: string; en: string; subs: Record<string, [string, string]> }> = {
  // Sub-groups split further on 2026-10-09 (Axel: "Phụ gia & khác" held 124 items).
  dry: { vi: 'Khô', en: 'Dry', subs: {
    flour: ['Bột, gạo & đường', 'Flour, rice & sugar'], choco: ['Sô-cô-la & ca cao', 'Chocolate & cocoa'],
    nuts: ['Hạt', 'Nuts'], dried: ['Trái cây khô, mứt & đồ hộp', 'Dried, candied & canned fruit'],
    flavor: ['Hương liệu & chiết xuất', 'Flavourings & extracts'], color: ['Màu & trang trí', 'Colouring & decoration'],
    tea: ['Trà & cà phê', 'Tea & coffee'], drink: ['Rượu & siro', 'Alcohol & syrups'], spice: ['Gia vị, dầu & sốt', 'Spices, oils & sauces'],
    other: ['Phụ gia & khác', 'Additives & other'] } },
  fresh: { vi: 'Mát / tươi', en: 'Chilled / fresh', subs: {
    dairy: ['Sữa & kem', 'Dairy'], eggs: ['Trứng', 'Eggs'], fruit: ['Trái cây tươi', 'Fresh fruit'],
    veg: ['Rau củ & thảo mộc', 'Vegetables & herbs'], meat: ['Thịt & cá', 'Meat & fish'], other: ['Khác', 'Other'] } },
  frozen: { vi: 'Đông lạnh', en: 'Frozen', subs: {
    puree: ['Purée', 'Purée'], fruit: ['Trái cây đông lạnh', 'Frozen fruit'], other: ['Khác', 'Other'] } },
};

export function subLabel(type: RawType, sub: string, lang: 'vi' | 'en'): string {
  const s = RAW_TYPES[type]?.subs[sub] ?? RAW_TYPES[type]?.subs.other;
  return s ? (lang === 'vi' ? s[0] : s[1]) : sub;
}
// Name to show: the Odoo Vietnamese name for a Vietnamese screen, the Odoo (English) name otherwise.
export function rawName(m: { name: string; nameVi?: string | null }, lang: 'vi' | 'en'): string {
  return lang === 'vi' && m.nameVi ? m.nameVi : m.name;
}
export function typeLabel(type: RawType, lang: 'vi' | 'en'): string {
  return lang === 'vi' ? RAW_TYPES[type].vi : RAW_TYPES[type].en;
}

const has = (n: string, words: string[]) => words.some(w => n.includes(w));

// First guess from the Odoo name only — purchasing checks and corrects it in the catalogue screen.
export function classifyRaw(rawName: string): { type: RawType; sub: string } {
  const n = ` ${rawName.toLowerCase()} `;
  const fruit = ['mango', 'xoài', 'passion', 'chanh leo', 'orange', ' cam ', 'lemon', 'lime', 'chanh', 'apple', 'táo', 'strawberr', 'dâu',
    'banana', 'chuối', 'pineapple', 'dứa', 'plum', 'mận', 'kumquat', 'quất', 'quýt', 'mandarin', 'cherr', 'raspberr', 'mâm xôi', 'blueberr', 'việt quất',
    'litchi', 'lychee', 'vải', 'peach', 'đào', 'grape', 'nho', 'kiwi', 'avocado', 'fruit', 'yuzu', 'pomelo', 'bưởi', 'watermelon', 'dưa hấu'];
  // Flavourings, syrups, alcohols and colourings are shelf products even when their name says "cherry" or "milk".
  const shelf = ['syrup', 'sirup', 'siro', 'flavor', 'flavour', 'aroma', 'arome', 'extract', 'essential oil', 'coloring', 'colouring', 'màu',
    'bailey', 'liqueur', 'jam', 'mứt', 'canned', ' can ', 'oil', 'dầu'];
  const veg = ['carrot', 'cà rốt', 'onion', 'hành', 'shallot', 'garlic', 'tỏi', 'celery', 'cucumber', 'dưa chuột', 'tomato', 'cà chua',
    'mushroom', 'nấm', 'pepper', 'ớt', 'parsley', 'thyme', 'rosemary', 'coriander', 'mint', 'minth', 'bạc hà', 'pandan leaves', 'lá dứa',
    'ginger', 'gừng', 'pumpkin', 'bí ', 'corn', 'ngô', 'flowers', 'hoa tươi'];
  const meat = ['bacon', 'beef', 'pork', 'heo', 'lợn', 'chicken', ' gà', 'ham ', 'jambon', 'sausage', 'hotdog', 'serrano', 'liver'];
  if (has(n, ['frozen', 'đông lạnh', 'purée', 'puree', 'ponthier', 'boiron']) && !has(n, ['jam', 'mứt', 'can '])) {
    return { type: 'frozen', sub: has(n, ['purée', 'puree']) ? 'puree' : has(n, [...fruit, 'berries', 'mulberr']) ? 'fruit' : 'other' };
  }
  if (has(n, ['egg', 'trứng'])) return { type: 'fresh', sub: 'eggs' };
  if (has(n, ['choco', 'cacao', 'cocoa', 'sô cô la', 'socola', 'ca cao']) && !has(n, ['syrup', 'siro', 'sauce'])) return { type: 'dry', sub: 'choco' };
  if (has(n, shelf) || has(n, ['powder', 'bột', 'dried', 'dry ', 'sấy', 'khô', 'tea', 'trà'])) {
    if (has(n, ['flour', 'bột mì', ' t45', ' t55', ' t65', 'sugar', 'đường', 'starch', 'tinh bột']) && !has(n, shelf)) return { type: 'dry', sub: 'flour' };
    if (has(n, ['coconut', 'dừa', 'almond', 'hazelnut', 'pistachio', 'cashew', 'walnut']) && !has(n, shelf) && !has(n, ['milk'])) return { type: 'dry', sub: 'nuts' };
    return { type: 'dry', sub: 'other' };
  }
  if (has(n, ['milk', 'sữa', 'cream', 'kem', 'butter', ' bơ ', 'mascarpone', 'cheese', 'phô mai', 'phomai', 'yogurt', 'yoghurt', 'whip'])
    && !has(n, ['condensed', 'đặc', 'coconut', 'peanut', 'đậu phộng', 'cashew', 'tartar', 'enhancer', 'butterfly', 'cannary'])) return { type: 'fresh', sub: 'dairy' };
  if (has(n, meat) || has(n, veg)) return { type: 'fresh', sub: 'other' };
  if (has(n, fruit)) return { type: 'fresh', sub: 'fruit' };
  if (has(n, ['nut', 'hạt', 'almond', 'hạnh nhân', 'hazelnut', 'phỉ', 'pistachio', 'macadamia', 'maccadamia', 'cashew', 'điều', 'walnut', 'óc chó',
    'pecan', 'sesame', 'vừng', 'peanut', 'lạc', 'đậu phộng', 'seeds', 'coconut', 'dừa'])) return { type: 'dry', sub: 'nuts' };
  if (has(n, ['flour', 'bột mì', ' t45', ' t55', ' t65', 'sugar', 'đường', 'starch', 'tinh bột'])) return { type: 'dry', sub: 'flour' };
  return { type: 'dry', sub: 'other' };
}

const UNIT_WORDS: Record<string, string> = {
  box: 'hộp', 'hộp': 'hộp', bag: 'túi', 'túi': 'túi', bao: 'bao', 'gói': 'gói', package: 'gói', pack: 'gói',
  can: 'lon', lon: 'lon', bottle: 'chai', chai: 'chai', carton: 'hộp', 'thùng': 'thùng', jar: 'hũ', 'hũ': 'hũ', container: 'hộp', tub: 'hộp',
};

// Packs written in the Odoo name ("2kg/hộp", "1 kg/bag", "20 small bags/package, 1 kg per bag", "Mascarpone 500g").
// A pack equal to one base unit (1 kg box when the product is counted in kg) is useless and skipped.
export function parsePacks(rawName: string, uom: string): RawPack[] {
  const n = rawName.toLowerCase();
  const base = uom.toLowerCase();
  const out: RawPack[] = [];
  const toBase = (v: number, u: string) => {
    const unit = u.toLowerCase();
    if ((unit === 'g' || unit === 'gr') && base === 'kg') return v / 1000;
    if (unit === 'kg' && base === 'kg') return v;
    if (unit === 'ml' && base === 'l') return v / 1000;
    if ((unit === 'l' || unit === 'liter' || unit === 'litre') && base === 'l') return v;
    return null;
  };
  const multi = /(\d+)\s*small bags?\s*\/\s*package[^\d]*(\d+(?:[.,]\d+)?)\s*(kg|g)\s*per bag/.exec(n);
  if (multi) {
    const f = toBase(Number(multi[1]) * Number(multi[2].replace(',', '.')), multi[3]);
    if (f && f !== 1) out.push({ label: `gói ${fmtQty(f)} ${uom}`, factor: f });
  }
  const re = /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|l|liter|litre)\s*\/\s*([a-zà-ỹ]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(n))) {
    const f = toBase(Number(m[1].replace(',', '.')), m[2]);
    const word = UNIT_WORDS[m[3]] ?? m[3];
    if (f && Math.abs(f - 1) > 1e-9 && !out.some(p => p.factor === f)) out.push({ label: `${word} ${fmtQty(f)} ${uom}`, factor: f });
  }
  if (!out.length) {
    const g = /\b(\d{2,4})\s*(g|gr|ml)\b/.exec(n);
    if (g) { const f = toBase(Number(g[1]), g[2]); if (f && f !== 1) out.push({ label: `hộp ${g[1]} ${g[2] === 'ml' ? 'ml' : 'g'}`, factor: f }); }
  }
  return out;
}

export function fmtQty(v: number): string {
  return (Math.round(v * 1000) / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
}

export const TEAM_SHORT: Record<string, { vi: string; en: string; color: string; bg: string }> = {
  baby_mama: { vi: 'Baby Mama', en: 'Baby Mama', color: '#7c3aed', bg: '#f5f3ff' },
  hung: { vi: 'Hưng', en: 'Hung', color: '#0369a1', bg: '#eff6ff' },
  entremet: { vi: 'Entremet', en: 'Entremet', color: '#b45309', bg: '#fffbeb' },
  baker: { vi: 'Baker', en: 'Baker', color: '#047857', bg: '#ecfdf5' },
};

// 'to_approve' (Axel, 2026-10-08): a request sent by a team member waits for the team lead
// (lab_profiles.is_team_lead — Hưng for team hung) before purchasing sees it.
export type PurchaseStatus = 'to_approve' | 'pending' | 'ordered' | 'received' | 'cancelled';
export type PurchaseLine = {
  id: string; requestId: string; requestNo: number; team: string; requestedBy: string | null; createdAt: string;
  tmplId: number | null; sku: string | null; name: string; uom: string; qty: number;
  brand: string | null; brandStrict: boolean; note: string | null;
  isNew: boolean; photoUrl: string | null; newState: 'open' | 'linked' | 'to_create' | null;
  vendorId: number | null; vendorName: string | null;
  status: PurchaseStatus; poRef: string | null; orderedAt: string | null; orderedBy: string | null;
  receivedAt: string | null; receivedBy: string | null; cancelledAt: string | null;
  approvedAt: string | null; approvedBy: string | null; requestedQty: number | null; rejectedByLead: boolean; rejectReason: string | null; cancelledBy: string | null;
};

export type WithdrawalLine = { id: string; tmplId: number | null; sku: string | null; name: string; uom: string; qty: number;
  packLabel: string | null; packCount: number | null; correctedQty: number | null; correctedBy: string | null };
export type Withdrawal = { id: string; no: number; team: string; takenBy: string | null; createdAt: string; lines: WithdrawalLine[] };

// Odoo vendor names are long legal names ("CHI NHÁNH CÔNG TY TNHH ... TẠI HÀ NỘI") — a short form for lists.
export function shortVendor(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.trim();
  if (/ngon cổ điển/i.test(s)) return 'Classic Fine Foods (CFF)';
  s = s.replace(/^(chi nhánh\s+)?(cty|công ty)\s+(tnhh|cổ phần|cp)?\s*/i, '')
    .replace(/^(chi nhánh\s+)/i, '').replace(/\s+tại\s+(tp\.?\s*)?hà nội$/i, '')
    .replace(/^(thương mại|tm|đầu tư|sx tm xnk|xnk|thương mại và dịch vụ|tư vấn đầu tư và thương mại dịch vụ)\s+/i, '');
  return s.length > 34 ? s.slice(0, 33) + '…' : s;
}

// Lab-local (Hanoi) date/time labels.
export function vnDayTime(iso: string | null | undefined): { day: string; time: string; ymd: string } {
  if (!iso) return { day: '', time: '', ymd: '' };
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.day}/${p.month}`, time: `${p.hour}:${p.minute}`, ymd: `${p.year}-${p.month}-${p.day}` };
}
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}
