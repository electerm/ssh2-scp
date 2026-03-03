import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/'],
      exclude: ['test/'],
      rollupTypes: true,
      skipDiagnostics: true
    })
  ],
  build: {
    target: 'node22',
    lib: {
      entry: resolve(__dirname, '../src/index.ts'),
      name: 'ssh2Fs',
      formats: ['es'],
      fileName: 'index'
    },
    rollupOptions: {
      external: ['ssh2', 'stream', 'buffer', 'events', 'fs', 'path'],
      output: {
        globals: {}
      }
    },
    outDir: 'dist/esm',
    emptyOutDir: true,
    minify: false
  }
})
