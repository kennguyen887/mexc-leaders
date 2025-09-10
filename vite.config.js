import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://7382bdf9.whale-futures.pages.dev',
        changeOrigin: true,
        secure: true,
        // giữ nguyên đường dẫn /api/**
        // (nếu backend không có prefix /api thì mới cần rewrite)
        // rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
