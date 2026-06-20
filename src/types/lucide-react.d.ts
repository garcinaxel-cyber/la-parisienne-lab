declare module 'lucide-react' {
  import type { FC, SVGProps } from 'react';
  export type LucideProps = SVGProps<SVGSVGElement> & { size?: number | string };
  export type LucideIcon = FC<LucideProps>;

  export const AlertCircle: LucideIcon;
  export const Loader2: LucideIcon;
  export const Ban: LucideIcon;
  export const CheckCircle2: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronLeft: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const ChevronUp: LucideIcon;
  export const ClipboardList: LucideIcon;
  export const Clock: LucideIcon;
  export const FileSpreadsheet: LucideIcon;
  export const FlaskConical: LucideIcon;
  export const LayoutDashboard: LucideIcon;
  export const LogOut: LucideIcon;
  export const Minus: LucideIcon;
  export const MoreVertical: LucideIcon;
  export const Package: LucideIcon;
  export const Play: LucideIcon;
  export const Plus: LucideIcon;
  export const Save: LucideIcon;
  export const Send: LucideIcon;
  export const Upload: LucideIcon;
  export const UserCog: LucideIcon;
  export const Users: LucideIcon;
  export const X: LucideIcon;
}
