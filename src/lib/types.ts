export type UserRole = 'admin' | 'lab_manager' | 'assistant' | 'chef' | 'worker' | 'sales' | 'viewer';
export type Team = 'baby_mama' | 'hung' | 'entremet' | 'baker';
export type ImportType = 'daily' | 'cake_addon';
export type ImportStatus = 'draft' | 'published' | 'cancelled';
export type AssignmentStatus = 'pending' | 'in_progress' | 'done' | 'skip' | 'partial' | 'blocked';
export type SourceType = 'sales_order' | 'replenishment';

export const TEAMS: Team[] = ['baby_mama', 'hung', 'entremet', 'baker'];

export const TEAM_LABELS: Record<Team, { en: string; vi: string; color: string; bg: string }> = {
  baby_mama: { en: 'Team Baby Mama', vi: 'Team Baby Mama', color: '#7c3aed', bg: '#f5f3ff' },
  hung: { en: 'Team Hung', vi: 'Team Hưng', color: '#0369a1', bg: '#eff6ff' },
  entremet: { en: 'Team Entremet', vi: 'Team Entremet', color: '#b45309', bg: '#fffbeb' },
  baker: { en: 'Team Baker', vi: 'Team Baker', color: '#047857', bg: '#ecfdf5' },
};

// Map Odoo product tag strings → Team enum
export const ODOO_TEAM_MAP: Record<string, Team> = {
  'Team Babymama': 'baby_mama', 'Team BabyMama': 'baby_mama', 'team babymama': 'baby_mama',
  'Team Hung': 'hung', 'Team Hưng': 'hung', 'team hung': 'hung',
  'Team Entremet': 'entremet', 'team entremet': 'entremet',
  'Team Baker': 'baker', 'team baker': 'baker',
};

export const STATUS_META: Record<AssignmentStatus, { color: string; labelEn: string; labelVi: string }> = {
  pending: { color: '#6b7280', labelEn: 'To produce', labelVi: 'Chưa làm' },
  in_progress: { color: '#0369a1', labelEn: 'In progress', labelVi: 'Đang làm' },
  done: { color: '#047857', labelEn: 'Done', labelVi: 'Xong' },
  skip: { color: '#7c3aed', labelEn: 'In stock', labelVi: 'Có sẵn' },
  partial: { color: '#b45309', labelEn: 'Partial', labelVi: 'Một phần' },
  blocked: { color: '#dc2626', labelEn: 'Blocked', labelVi: 'Bị chặn' },
};

export interface Profile {
  id: string;
  full_name: string;
  role: UserRole;
  created_at: string;
  lab_profiles?: { team: Team | null } | null;
}

export interface LabImport {
  id: string;
  delivery_date: string;
  order_number: number;
  type: ImportType;
  shipped_from_lab: boolean;
  notes: string;
  status: ImportStatus;
  filename_sales: string | null;
  filename_repl: string | null;
  imported_at: string;
  imported_by: string | null;
  published_at: string | null;
}

export interface LabOrderLine {
  id: string;
  import_id: string;
  source_type: SourceType;
  order_ref: string;
  shop_name: string;
  product_sku: string;
  product_name_vi: string;
  team: string;
  variant_label: string;
  qty: number;
  delivery_date: string;
  delivery_time: string | null;
}

export interface LabAssignment {
  id: string;
  import_id: string;
  team: Team;
  product_id: string | null;
  product_name_vi: string;
  product_name_en: string;
  image_url: string | null;
  variant_label: string;
  total_qty: number;
  qty_to_produce: number;
  qty_produced: number;
  status: AssignmentStatus;
  exception_reason: string | null;
  sort_order: number;
  notes: string;
  updated_at: string;
  // joined
  lab_imports?: Pick<LabImport, 'delivery_date' | 'order_number' | 'type' | 'shipped_from_lab' | 'status'>;
  // breakdown from order_lines
  breakdown?: { shop_name: string; order_ref: string; qty: number; source_type: SourceType }[];
}
