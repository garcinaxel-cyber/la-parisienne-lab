/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
    ],
        imageSizes: [16, 32, 48, 64, 80, 96, 112, 128, 144, 256, 384, 400, 800],
  },
};

export default nextConfig;
