// Server-side push sender (phase 3, 2026-09-04). Mirrors zalo.ts's posture: best-effort, never
// throws into the caller — a push failure must never break the sync/publish path that creates
// the actual production card. Skips silently (pushConfigured() === false) until Axel sets
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY in Vercel, so shipping this file is safe before those env
// vars exist — nothing sends, nothing breaks.
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) { configured = false; return false; }
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@laparisienne.vn';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return ensureConfigured();
}

// Sends to every subscription on file for one team, cleans up subscriptions the push service
// reports as gone (404/410 — the standard "this endpoint no longer exists" response), and never
// throws — a subscription that's merely temporarily failing (network blip, 5xx) is left alone.
export async function sendTeamPush(
  supabase: SupabaseClient,
  team: string,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  if (!ensureConfigured()) return;
  try {
    const { data: subs } = await supabase
      .from('lab_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('team', team);
    if (!subs?.length) return;

    const deadIds: string[] = [];
    await Promise.all(subs.map(async (s: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) deadIds.push(s.id);
      }
    }));
    if (deadIds.length) await supabase.from('lab_push_subscriptions').delete().in('id', deadIds);
  } catch { /* best-effort — never let a push failure break the caller */ }
}
