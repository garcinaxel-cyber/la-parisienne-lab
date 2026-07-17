'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type Sub = { table: string; events?: ('INSERT' | 'UPDATE' | 'DELETE')[]; filter?: string };

// Refresh the server-rendered page ONLY when a relevant row actually changes, via Supabase
// Realtime (websocket client ↔ Supabase). No polling → no reads on a timer; a message is
// delivered only on a real DB change, and bursts are debounced into a single refresh.
// The Realtime socket is explicitly authenticated with the user's token — otherwise
// RLS-protected rows are never delivered (the anon socket sees nothing).
export function useRealtimeRefresh(channelName: string, subs: Sub[], enabled = true) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = JSON.stringify(subs); // stable dep so we don't resubscribe every render

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const trigger = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session?.access_token) supabase.realtime.setAuth(data.session.access_token);
      const ch = supabase.channel(channelName);
      for (const s of JSON.parse(key) as Sub[]) {
        for (const ev of s.events ?? ['*' as const]) {
          ch.on(
            'postgres_changes' as any,
            { event: ev, schema: 'public', table: s.table, ...(s.filter ? { filter: s.filter } : {}) } as any,
            trigger,
          );
        }
      }
      ch.subscribe();
      channel = ch;
    })();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      if (channel) supabase.removeChannel(channel);
    };
  }, [channelName, key, enabled, router]);
}
