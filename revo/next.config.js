/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/emptyModule.js' },
      path: { browser: './src/lib/emptyModule.js' },
    },
  },
};

module.exports = nextConfig;
