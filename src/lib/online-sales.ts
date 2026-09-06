// Shared constant for the online-sales interface (2026-09-06). Kept in its own plain module —
// not in online-orders/actions.ts — because a 'use server' file may only export async
// functions; a route handler (online-order-payment-alert) needs this same pseudo shop_name too.
export const ONLINE_PUSH_KEY = '__online_sales__';
