import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // this folder is the whole app: do not go looking for lockfiles in parent folders
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};
export default nextConfig;
