import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // 前端 /api 代理到 Go 后端（默认 8088，避开 8080 上的 admin-system 服务）
      "/api": {
        target: "http://127.0.0.1:8088",
        changeOrigin: true,
        // 允许工作负载控制台的 WebSocket（/api/pod-exec）走同一代理
        ws: true,
      },
    },
  },
});
