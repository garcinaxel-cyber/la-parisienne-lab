// Server-only Zalo webhook helper — best-effort, never throws
export async function sendZaloWebhook(url: string, text: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, message: text }),
    });
  } catch { /* silent — notifications are best-effort */ }
}
