// Chef test recipes + chef losses (Axel, 2026-11-12) — shared types and constants (client-safe).
// Pilot on Team Hung first ("je veux tester sur son équipe d'abord"): only these teams see the two tabs.
export const CHEF_RD_TEAMS = ['hung'];

export type LossKind = 'fin' | 'raw' | 'pack' | 'test';
export type LossStatus = 'pending' | 'validated' | 'auto' | 'deleted';

// Odoo stock.scrap.reason.tag ids (read 2026-11-12). Vietnamese = the Odoo tag name, English = help.
export type LossReason = { id: number; vi: string; en: string };
export const REASONS_FINISHED: LossReason[] = [
  { id: 2, vi: 'bị vỡ', en: 'Broken' },
  { id: 15, vi: 'bị nứt', en: 'Cracked' },
  { id: 22, vi: 'bị mềm', en: 'Too soft' },
  { id: 1, vi: 'hàng bị ẩm', en: 'Damp' },
  { id: 13, vi: 'bánh xấu', en: 'Ugly / shape' },
  { id: 17, vi: 'bánh bị chảy', en: 'Melted' },
  { id: 24, vi: 'Sự cố tủ lạnh', en: 'Fridge failure' },
  { id: 6, vi: 'hết date', en: 'Expired' },
  { id: 7, vi: 'bị hỏng', en: 'Spoiled' },
];
export const REASONS_STOCK: LossReason[] = [
  { id: 6, vi: 'hết date', en: 'Expired' },
  { id: 7, vi: 'bị hỏng', en: 'Spoiled' },
  { id: 1, vi: 'hàng bị ẩm', en: 'Damp' },
  { id: 2, vi: 'bị vỡ', en: 'Broken / spilled' },
  { id: 24, vi: 'Sự cố tủ lạnh', en: 'Fridge failure' },
  { id: 5, vi: 'bị hôi', en: 'Bad smell' },
];
export const REASON_TEST: LossReason = { id: 3, vi: 'làm hàng thử', en: 'Test R&D' };

export type ChefLoss = {
  id: string; team: string; kind: LossKind; sku: string | null; tmplId: number | null; productId: number | null;
  name: string; uom: string | null; qty: number; beforeStock: boolean;
  reasonId: number | null; reason: string; note: string | null; photoUrl: string | null;
  testId: string | null; trialId: string | null; labDay: string;
  declaredBy: string | null; declaredById: string | null; declaredAt: string;
  status: LossStatus; validatedBy: string | null; validatedAt: string | null;
  odooState: 'pending' | 'done' | 'error' | null; odooError: string | null; odooScrapId: number | null; odooMoName: string | null;
};

// ── Test recipes ───────────────────────────────────────────────────────────
export type TestStage = 'idea' | 'testing' | 'sent' | 'approved' | 'odoo' | 'archived';
export const TEST_STAGES: { k: TestStage; vi: string; en: string }[] = [
  { k: 'idea', vi: 'Ý tưởng', en: 'Idea' },
  { k: 'testing', vi: 'Đang thử', en: 'Testing' },
  { k: 'sent', vi: 'Đã gửi văn phòng', en: 'Sent to office' },
  { k: 'approved', vi: 'Đã duyệt', en: 'Approved' },
  { k: 'odoo', vi: 'Đã lên Odoo', en: 'In Odoo' },
  { k: 'archived', vi: 'Tạm dừng', en: 'Paused' },
];
export const TEST_FAMILIES = ['Macaron', 'Biscuit Voyage', 'Chocolate', 'Cake', 'Entremet', 'Viennoiserie', 'Other'];

/** One ingredient line. qty = for ONE BATCH of the parent (final product batch, or sub-recipe batch). */
export type RecipeRow = { tmplId: number | null; productId: number | null; sku: string | null; name: string; uom: string; qty: number; kind?: 'raw' | 'packaging' };
/** An intermediate recipe used by the final product. src 'odoo' = an existing SM; 'new' = written here. */
export type RecipeSub = {
  key: string; name: string; src: 'odoo' | 'new';
  productId?: number | null; sku?: string | null;
  uom: string; qty: number;                // used per batch of the final product
  batchQty?: number; batchUom?: string;    // 'new' only: one batch of the sub-recipe makes batchQty batchUom
  rows?: RecipeRow[];                      // 'new' only: ingredients for one batch of the sub-recipe
};
export type Recipe = { subs: RecipeSub[]; direct: RecipeRow[] };
export type RecipeStep = { title: string; text: string; temp?: string | null; time?: string | null };

export type TestVersion = {
  id: string; n: number; note: string | null; yieldPcs: number; pieceWeightG: number | null;
  recipe: Recipe; steps: RecipeStep[]; isFinal: boolean; createdAt: string; createdBy: string | null; trialCount: number;
};
export type TestTrial = {
  id: string; versionN: number; pcs: number; stars: number | null; verdict: 'ok' | 'adjust' | 'failed' | null;
  note: string | null; photoUrl: string | null; labDay: string; madeBy: string | null; madeAt: string;
};
export type TestSummary = {
  id: string; name: string; family: string | null; collection: string | null; tags: string[]; stage: TestStage;
  startKind: 'new' | 'improve' | 'copy'; improveName: string | null; photoUrl: string | null; targetDate: string | null;
  pinned: boolean; lastVersion: number; trialCount: number; lastActivity: string; createdAt: string; createdBy: string | null;
  officeFeedback: string | null; officeFeedbackBy: string | null; officeFeedbackAt: string | null;
  /** lower-cased ingredient names of the latest version — for the search. */
  searchText: string;
};

/** Raw materials / packaging of one version for `pcs` pieces (intermediate recipes skipped: "coming soon"). */
export function trialConsumption(v: { yieldPcs: number; recipe: Recipe }, pcs: number): RecipeRow[] {
  const f = pcs / (v.yieldPcs || 1);
  const out = new Map<string, RecipeRow>();
  const add = (r: RecipeRow, q: number) => {
    if (!r.productId || !(q > 0)) return;
    const k = String(r.productId);
    const cur = out.get(k);
    if (cur) cur.qty += q; else out.set(k, { ...r, qty: q });
  };
  for (const r of v.recipe.direct ?? []) add(r, r.qty * f);
  for (const s of v.recipe.subs ?? []) {
    if (s.src !== 'new' || !s.rows?.length || !(s.batchQty && s.batchQty > 0)) continue;
    // A NEW sub-recipe is not an Odoo product: its own raw materials are consumed, in proportion.
    const subF = (s.qty * f) / s.batchQty;
    for (const r of s.rows) add(r, r.qty * subF);
  }
  return Array.from(out.values()).map(r => ({ ...r, qty: Math.round(r.qty * 10000) / 10000 }));
}
