// Internal note (EN + VI) in the chatter of a customer invoice the app has just changed
// (Axel, 2026-10-17: accounting must see WHY quantities moved). Created as a mail.message with
// subtype "Note" so it is internal and keeps its HTML (message_post over RPC would escape it).
// Best-effort: a failed note never fails the Odoo operation that already happened.
import { odooExecuteWrite } from '@/lib/odoo';

const NOTE_SUBTYPE_ID = 2; // mail.mt_note (checked live 17/10)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function vnDate(): string {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export type InvoiceNoteInput = {
  invoiceId: number;
  orderRef: string;
  reasonEn: string;
  reasonVi: string;
  changes: { code: string; name?: string; from: number; to: number }[];
  docs: string[]; // Odoo documents created (returns, scraps, deliveries…)
  byName?: string;
};

export async function postInvoiceNote(n: InvoiceNoteInput): Promise<boolean> {
  try {
    const items = n.changes.map(c => `<li>${esc(c.code)}${c.name ? ' ' + esc(c.name) : ''}: ${c.from} → ${c.to}</li>`).join('');
    const body =
      `<p><b>Adjusted by Lab app / Điều chỉnh bởi app Lab</b> — ${esc(n.orderRef)} · ${vnDate()}${n.byName ? ' · ' + esc(n.byName) : ''}</p>` +
      `<p>Reason / Lý do: ${esc(n.reasonEn)} / ${esc(n.reasonVi)}</p>` +
      (items ? `<ul>${items}</ul>` : '') +
      (n.docs.length ? `<p>Odoo: ${esc(n.docs.join(' · '))}</p>` : '') +
      `<p>Invoice left in draft — accounting re-posts it / Hóa đơn để nháp — kế toán xác nhận lại.</p>`;
    await odooExecuteWrite('mail.message', 'create', [{
      model: 'account.move', res_id: n.invoiceId, message_type: 'comment', subtype_id: NOTE_SUBTYPE_ID, body,
    }]);
    return true;
  } catch {
    return false;
  }
}
