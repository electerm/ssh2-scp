import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/'],
      exclude: ['test/'],
      rollupTypes: true
    })
  ],
  build: {
    target: 'node22',
    lib: {
      entry: {
        'ssh-fs': resolve(__dirname, '../src/ssh-fs.ts'),
        transfer: resolve(__dirname, '../src/transfer.ts')
      },
      name: 'ssh2Fs',
      formats: ['es'],
      fileName: '[name]'
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
