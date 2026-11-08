/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    lockDistDir: false,
  },
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/emptyModule.js' },
      path: { browser: './src/lib/emptyModule.js' },
    },
  },
};

module.exports = nextConfig;
