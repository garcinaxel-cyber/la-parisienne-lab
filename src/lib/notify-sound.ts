'use client';
// Short two-tone chime for the station "new order" alert — synthesized via the Web Audio API
// rather than an mp3 asset (2026-09-04, Axel: point 2 of the notification plan). No file to
// source/host, and a synthesized soft two-note chime avoids the "cheap"-sounding canned beep an
// arbitrary mp3 could produce. A single shared AudioContext is reused for the whole session and
// armed on the very first tap anywhere on the page — browsers refuse to play audio until a real
// user gesture has happened, and a chef taps the screen within seconds of opening the station
// view anyway, so by the time an order actually arrives the context is already unlocked.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  return ctx;
}

// Call once on mount to arm the context on the session's first pointer interaction.
export function armNotifySound() {
  const c = getCtx();
  if (!c) return;
  const unlock = () => { if (c.state === 'suspended') c.resume().catch(() => {}); };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
}

export function playNewOrderChime() {
  const c = getCtx();
  if (!c) return;
  try {
    if (c.state === 'suspended') c.resume().catch(() => {});
    const now = c.currentTime;
    // Two soft sine notes, short and unobtrusive rather than a harsh alarm beep.
    ([{ freq: 784.0, start: 0 }, { freq: 1046.5, start: 0.14 }] as const).forEach(({ freq, start }) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.22, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.35);
      osc.connect(gain).connect(c.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.4);
    });
  } catch { /* best-effort — a missed chime must never break the station view */ }
}
