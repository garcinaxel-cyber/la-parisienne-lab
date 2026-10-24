// Client helper: start the delivery-check follow-up in parallel (route handler, not a server action).
export function startFollowUp(lineId: string, photoUrl?: string | null, alreadyReported = false): Promise<{ ok?: boolean; error?: string }> {
  return fetch('/api/lab/delivery-follow-up', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ lineId, photoUrl: photoUrl ?? null, alreadyReported }),
  }).then(r => r.json()).catch(e => ({ error: String(e?.message ?? e) }));
}
