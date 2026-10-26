// Instant feedback on navigation (Axel 2026-10-26: "quand je navigue c'est vraiment lent"):
// clicking a menu item shows this at once while the server prepares the page, instead of the
// old screen staying frozen. The sidebar (layout) stays in place.
export default function Loading() {
  return (
    <div className="flex items-center justify-center py-24" aria-busy="true" aria-live="polite">
      <div className="h-8 w-8 rounded-full border-2 border-[#E8D9C0] border-t-[#7A4E2D] animate-spin" />
    </div>
  );
}
