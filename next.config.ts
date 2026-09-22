import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Expose the OpenAI-compatible gateway at /v1/* in addition to /api/v1/*.
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },
};

export default nextConfig;