// Runs once per server instance (Node and Edge). Only effect: on a Vercel PREVIEW deployment
// it makes the app read-only (see src/lib/preview-guard.ts). No-op in production and locally.
import { installServerPreviewGuard } from '@/lib/preview-guard';

export function register() {
  installServerPreviewGuard();
}
