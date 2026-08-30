// Routes a Supabase Storage public image URL through Next.js's built-in image
// optimizer (/_next/image) so it's resized, compressed (WebP where supported) and
// cached at Vercel's edge, instead of the browser/CDN re-pulling the full-resolution
// original from Supabase Storage on every view. Pure URL rewrite -- call sites stay a
// plain <img src=...>, so display size/behavior (className, object-cover, etc.) is
// untouched. See memory: supabase-egress-root-cause-diagnostic.
//
// `size` should be roughly 2x the largest CSS display size (px) the image is ever shown
// at, for retina screens. Falls back to the original url untouched for non-Supabase/
// relative/data-URI sources (logos, QR codes, etc.) -- those aren't the egress problem,
// and a data: URI would break if passed through the optimizer.
export function thumb(url: string | null | undefined, size: number): string | undefined {
  if (!url) return url ?? undefined;
  if (!url.startsWith('http')) return url;
  return `/_next/image?url=${encodeURIComponent(url)}&w=${size}&q=75`;
}
