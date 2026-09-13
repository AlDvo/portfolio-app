import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Публикация на GitHub Pages по адресу https://AlDvo.github.io/portfolio-app/.
  base: '/portfolio-app/',
  resolve: {
    alias: {
      // SheetJS xlsx: ESM-обёртка (xlsx.mjs) не имеет default-экспорта —
      // принудительно берём CJS-сборку, чтобы единый default-импорт
      // работал и в браузере (Rollup/commonjs), и в Node (tsx).
      xlsx: fileURLToPath(new URL('./node_modules/xlsx/xlsx.js', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // cbr.ru не отдаёт CORS-заголовки; ключевую ставку (для флоатеров)
      // браузер получает через этот прокси.
      '/cbr-keyrate': {
        target: 'https://www.cbr.ru',
        changeOrigin: true,
        rewrite: () => '/hd_base/KeyRate/?UniDbQuery.Posted=True',
      },
    },
  },
  preview: {
    proxy: {
      '/cbr-keyrate': {
        target: 'https://www.cbr.ru',
        changeOrigin: true,
        rewrite: () => '/hd_base/KeyRate/?UniDbQuery.Posted=True',
      },
    },
  },
})