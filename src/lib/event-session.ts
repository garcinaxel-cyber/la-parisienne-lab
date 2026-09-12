import { createHash, createHmac } from 'crypto';
import { cookies } from 'next/headers';

// Event-shop access (Axel, 2026-09-12): a single PIN per event, no Supabase auth account at
// all. Staff reach it via a discreet button inside their OWN shop's already-authenticated
// portal session — this cookie only ever LAYERS a different shopName resolution on top of that
// existing session (see requireShopSession/requireShopOrStaffSession in shop/actions.ts), it
// never replaces it and never grants access on its own without a real shop/staff session first.
//
// Signed (not just stored) so a client can't hand-craft `{eventId: "<any other event>"}` — HMAC
// keyed off the service-role key (already server-only/secret, never sent to the browser), same
// "reuse what's already a private secret" posture as hashManagerPin's plain sha256 for PINs
// (that one only ever needs to be verified against a stored hash, never signed).

const COOKIE_NAME = 'lab_event_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days — an event can run a few days without re-entering the PIN daily

function signingSecret(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'lab-event-session-fallback';
}

function sign(eventId: string): string {
  return createHmac('sha256', signingSecret()).update(eventId).digest('hex');
}

export function hashEventPin(pin: string): string {
  return createHash('sha256').update(pin.trim()).digest('hex');
}

export function setEventSessionCookie(eventId: string): void {
  cookies().set(COOKIE_NAME, `${eventId}.${sign(eventId)}`, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE_SECONDS,
  });
}

export function clearEventSessionCookie(): void {
  cookies().set(COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

// Returns the event id carried by the cookie ONLY if its signature checks out — never trust the
// raw cookie value. Does not check whether the event is still active; callers re-verify that
// against lab_event_shops (an event closed after the cookie was set must stop working immediately).
export function readEventIdFromCookie(): string | null {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!id || !sig || sig !== sign(id)) return null;
  return id;
}
