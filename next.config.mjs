/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
    ],
        imageSizes: [16, 32, 48, 64, 80, 96, 112, 128, 144, 256, 384, 400, 800],
        // Every upload in this app writes a brand-new filename (fiches/*, variants, design photos
        // all use Date.now()/crypto.randomUUID() in the path, never overwrite an existing URL) --
        // so a stale long-lived cache entry can never happen, only wasted re-fetches of unchanged
        // images. Default minimumCacheTTL (60s) made Vercel's image optimizer re-pull the full-res
        // original from Supabase Storage every ~minute on realtime-refreshed pages (station view),
        // ~doubling Supabase egress after the thumb() rollout. See memory: supabase-egress-root-cause-diagnostic.
        minimumCacheTTL: 31536000, // 1 year -- safe because URLs are content-unique, not content-mutable
  },
};

export default nextConfig;
