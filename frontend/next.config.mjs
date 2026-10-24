/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{
      source: "/live-api/:path*",
      destination: `${process.env.EDGESENSE_API_URL || "http://127.0.0.1:8001"}/:path*`,
    }];
  },
};

export default nextConfig;
