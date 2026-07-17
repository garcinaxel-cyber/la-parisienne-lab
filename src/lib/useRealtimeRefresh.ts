'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type Sub = { table: string; events?: ('INSERT' | 'UPDATE' | 'DELETE')[]; filter?: string };

// Refresh the server-rendered page ONLY when a relevant row actually changes, via Supabase
// Realtime (websocket client ↔ Supabase). No polling → no extra Vercel invocations and no
// Supabase reads on a timer; a message is delivered only on a real DB change. Bursts are
// debounced into a single refresh so a multi-row import triggers one re-render, not many.
export function useRealtimeRefresh(channelName: string, subs: Sub[], enabled = true) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = JSON.stringify(subs); // stable dep so we don't resubscribe every render

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const channel = supabase.channel(channelName);
    const trigger = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    for (const s of JSON.parse(key) as Sub[]) {
      const events = s.events ?? ['*' as const];
      for (const ev of events) {
        channel.on(
          'postgres_changes' as any,
          { event: ev, schema: 'public', table: s.table, ...(s.filter ? { filter: s.filter } : {}) } as any,
          trigger,
        );
      }
    }
    channel.subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [channelName, key, enabled, router]);
}
