// Preview read-only guard (Axel, 2026-11-12 — UI redesign branch).
//
// A Vercel PREVIEW deployment of this app talks to the SAME Supabase project and the SAME Odoo
// database as production (the env vars are shared). So a button pressed on a preview would
// really write: a batch sent to stock, an Odoo MO, a purchase request…
//
// On a preview deployment (VERCEL_ENV=preview) everything below turns the app READ-ONLY:
//   - server: every outgoing non-GET request is refused, except Supabase auth (login / session
//     refresh), a short allowlist of read-only Supabase RPCs, and Odoo JSON-RPC (itself limited
//     to read methods in src/lib/odoo.ts);
//   - browser: the same rule is applied to window.fetch by an inline script (see layout.tsx).
//
// PRODUCTION IS NEVER AFFECTED: every check requires VERCEL_ENV === 'preview' (server) or a
// hostname that is not one of the production hostnames (browser). To let a preview write for a
// real test, set PREVIEW_WRITES=1 on that deployment — deliberately, never by default.

export const PROD_HOSTS = [
  'la-parisienne-lab.vercel.app',
  'la-parisienne-lab-la-parisienne-s-projects.vercel.app',
  'la-parisienne-lab-git-main-la-parisienne-s-projects.vercel.app',
];

export function isPreviewReadOnly(): boolean {
  return process.env.VERCEL_ENV === 'preview' && process.env.PREVIEW_WRITES !== '1';
}

// Supabase RPCs that only read (checked in pg_proc on 2026-11-12). Anything else is refused.
export const READ_ONLY_RPCS = ['lab_dashboard_stats', 'lab_event_sales_totals', 'lab_event_sales_agg', 'lab_mm_deliveries',
  // Online-sales Stats v2 (2026-11-14): pure SELECT aggregations (supabase/lab_v155_online_stats_v2.sql).
  'online_ads_attribution', 'online_service_stats', 'online_overview_extras'];

// Odoo ORM methods that only read.
export const ODOO_READ_METHODS = new Set([
  'search', 'read', 'search_read', 'search_count', 'read_group', 'fields_get', 'name_search', 'name_get',
  'check_access_rights', 'default_get',
]);

/** True when this request may leave a read-only preview. Shared by the server and the browser rule. */
export function previewAllows(method: string, url: string): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  let u: URL;
  try { u = new URL(url, 'http://local'); } catch { return false; }
  if (u.pathname.startsWith('/auth/v1/')) return true;                      // Supabase login / refresh
  if (u.pathname.endsWith('/jsonrpc')) return true;                          // Odoo — filtered by method in odoo.ts
  const rpc = u.pathname.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/i);
  if (rpc) return READ_ONLY_RPCS.includes(rpc[1]);
  return false;
}

export function previewRefusal(): Response {
  return new Response(JSON.stringify({ message: 'Preview (read-only): nothing was saved.', code: 'PREVIEW_READ_ONLY' }), {
    status: 403, headers: { 'Content-Type': 'application/json' },
  });
}

/** Wrap the server-side global fetch once. Called from src/instrumentation.ts. */
export function installServerPreviewGuard() {
  if (!isPreviewReadOnly()) return;
  const g = globalThis as any;
  if (g.__lpPreviewGuard) return;
  const original: typeof fetch = g.fetch.bind(globalThis);
  g.__lpPreviewGuard = true;
  g.fetch = (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const method = init?.method ?? (typeof input === 'object' && input?.method) ?? 'GET';
    if (!previewAllows(method, url)) {
      console.warn(`[preview] refused ${String(method).toUpperCase()} ${String(url).split('?')[0]}`);
      return Promise.resolve(previewRefusal());
    }
    return original(input, init);
  };
}

/** Inline script for the browser: same rule on window.fetch, on non-production hostnames only. */
export function browserPreviewGuardScript(): string {
  return `(function(){try{var P=${JSON.stringify(PROD_HOSTS)};var h=location.hostname;if(P.indexOf(h)>=0||!/\\.vercel\\.app$/.test(h))return;var R=${JSON.stringify(READ_ONLY_RPCS)};var o=window.fetch.bind(window);window.fetch=function(i,n){try{var u=new URL(typeof i==='string'?i:(i&&i.url)||String(i),location.href);var m=((n&&n.method)||(typeof i==='object'&&i&&i.method)||'GET').toUpperCase();var ok=m==='GET'||m==='HEAD'||m==='OPTIONS'||u.origin===location.origin||u.pathname.indexOf('/auth/v1/')===0;var r=u.pathname.match(/\\/rest\\/v1\\/rpc\\/([a-z0-9_]+)$/i);if(r)ok=R.indexOf(r[1])>=0;if(!ok){console.warn('[preview] refused',m,u.pathname);return Promise.resolve(new Response(JSON.stringify({message:'Preview (read-only): nothing was saved.',code:'PREVIEW_READ_ONLY'}),{status:403,headers:{'Content-Type':'application/json'}}));}}catch(e){}return o(i,n);};}catch(e){}})();`;
}
