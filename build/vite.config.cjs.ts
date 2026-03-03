import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    target: 'node22',
    lib: {
      entry: resolve(__dirname, '../src/index.ts'),
      name: 'ssh2Fs',
      formats: ['cjs'],
      fileName: 'index'
    },
    rollupOptions: {
      external: ['ssh2', 'stream', 'buffer', 'events'],
      output: {
        globals: {},
        exports: 'named'
      }
    },
    outDir: 'dist/cjs',
    emptyOutDir: true,
    minify: false
  }
})
