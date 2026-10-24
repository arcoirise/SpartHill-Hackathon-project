/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Only publish the assessment endpoints; never expose reset or legacy pose APIs.
    return ["health", "recommend", "telemetry", "zones"].map((path) => ({
      source: `/live-api/${path}`,
      destination: `${process.env.EDGESENSE_API_URL || "http://127.0.0.1:8001"}/${path}`,
    }));
  },
};

export default nextConfig;
