'use client';
// Client-side push subscribe/unsubscribe primitives (phase 3, 2026-09-04). Deliberately knows
// nothing about the station's server actions — StationView.tsx hands the resulting subscription
// JSON to subscribePushAction itself (same dynamic-import-from-./actions pattern it already uses
// for analytics), so this file stays a plain, reusable browser-API wrapper.

const APPLICATION_SERVER_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

export type PushSupport = 'unsupported' | 'not-configured' | 'ready';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (!APPLICATION_SERVER_KEY) return 'not-configured'; // Vercel env vars not set yet
  return 'ready';
}

// Base64url (the VAPID key format) -> Uint8Array, as required by pushManager.subscribe().
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(Array.from(raw).map(c => c.charCodeAt(0)));
}

// Existing subscription, without prompting — used on mount so the bell icon reflects reality
// across reloads instead of always starting "off".
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() === 'unsupported') return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

export type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
export type RequestResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: 'unsupported' | 'not-configured' | 'denied' | 'invalid' };

// Prompts the browser's native permission dialog (must be called from a real user tap — a
// bell-icon click, never on mount) and creates/reuses a push subscription. Wrapped end-to-end:
// pushManager.subscribe() can throw (e.g. iOS Safari when the app hasn't been added to the home
// screen, even though the feature-detection above passes) — that must surface as a normal
// "didn't work" result to the caller, not an unhandled rejection with a bell icon stuck showing
// nothing happened.
export async function requestPushSubscription(): Promise<RequestResult> {
  const support = pushSupport();
  if (support !== 'ready') return { ok: false, reason: support };

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(APPLICATION_SERVER_KEY!) as BufferSource,
    });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return { ok: false, reason: 'invalid' };
    return { ok: true, subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export async function unsubscribeCurrentPush(): Promise<string | null> {
  try {
    const sub = await getExistingPushSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch { return null; }
}
