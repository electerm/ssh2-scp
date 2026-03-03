import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    target: 'node22',
    lib: {
      entry: {
        index: resolve(__dirname, '../src/index.ts'),
        transfer: resolve(__dirname, '../src/transfer.ts')
      },
      name: 'ssh2Fs',
      formats: ['cjs'],
      fileName: '[name]'
    },
    rollupOptions: {
      external: ['ssh2', 'stream', 'buffer', 'events', 'fs', 'path'],
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
