import { defineConfig } from 'vite'
import { resolve } from 'path'
import { writeFileSync } from 'fs'

export default defineConfig({
  plugins: [
    {
      name: 'write-cjs-package-json',
      writeBundle() {
        writeFileSync(
          resolve(__dirname, '../dist/cjs/package.json'),
          JSON.stringify({ type: 'commonjs' }, null, 2)
        )
      }
    }
  ],
  build: {
    target: 'node22',
    lib: {
      entry: {
        'ssh-fs': resolve(__dirname, '../src/ssh-fs.ts'),
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
