import { createSshFs } from '../dist/esm/index.js'
import { Transfer } from '../dist/esm/transfer.js'
import { Client } from 'ssh2'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const TEST_HOST = 'localhost'
const TEST_PORT = 22235
const TEST_USER = 'root'
const TEST_PASSWORD = 'root'

const TIMESTAMP = Date.now()
const TEST_BASE_DIR = `/tmp/test-ssh-fs-${TIMESTAMP}`
const LOCAL_TEST_DIR = `/tmp/local-test-ssh-fs-${TIMESTAMP}`

const TEST_TIMEOUT = 10000
const RUNNER_TIMEOUT = 60000

let sftp
let conn
let testTimer

function resetTimer() {
  if (testTimer) clearTimeout(testTimer)
  testTimer = setTimeout(() => {
    console.error('\nTest runner timeout!')
    if (conn) conn.end()
    process.exit(1)
  }, RUNNER_TIMEOUT)
}

async function connectSSH() {
  return new Promise((resolve, reject) => {
    conn = new Client()
    conn.on('ready', () => {
      console.log('SSH connected')
      sftp = createSshFs(conn)
      resolve(sftp)
    }).on('error', (err) => {
      reject(err)
    }).connect({
      host: TEST_HOST,
      port: TEST_PORT,
      username: TEST_USER,
      password: TEST_PASSWORD,
      readyTimeout: 10000
    })
  })
}

async function runTests() {
  resetTimer()
  console.log(`Connecting to ${TEST_HOST}:${TEST_PORT}...`)
  await connectSSH()
  resetTimer()

  try { await sftp.rmrf(TEST_BASE_DIR) } catch (e) {}
  await sftp.mkdir(TEST_BASE_DIR)
  resetTimer()

  if (!fs.existsSync(LOCAL_TEST_DIR)) {
    fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true })
  }

  let passed = 0
  let failed = 0

  async function test(name, fn) {
    console.log(`\n▶ ${name}`)
    resetTimer()
    try {
      const timeoutMs = TEST_TIMEOUT
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), timeoutMs))
      ])
      console.log(`  ✔ ${name}`)
      passed++
    } catch (err) {
      console.log(`  ✖ ${name}`)
      console.log(`  Error: ${err.message}`)
      failed++
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed')
  }

  await test('should download small file', async () => {
    const remotePath = `${TEST_BASE_DIR}/small-file.txt`
    const localPath = path.join(LOCAL_TEST_DIR, 'downloaded-small.txt')
    const content = 'Hello, World!'

    await sftp.writeFile(remotePath, content)

    const transfer = new Transfer(sftp, {
      type: 'download',
      remotePath,
      localPath,
      chunkSize: 1024
    })

    await transfer.startTransfer()

    const state = transfer.getState()
    assert(state.completed, 'Transfer should be completed')
    assert(fs.existsSync(localPath), 'Local file should exist')

    const downloadedContent = fs.readFileSync(localPath, 'utf8')
    assert(downloadedContent === content, 'Content should match')

    transfer.destroy()
  })

  await test('should call onData callback during download', async () => {
    const remotePath = `${TEST_BASE_DIR}/ondata-test.txt`
    const localPath = path.join(LOCAL_TEST_DIR, 'ondata-test.txt')
    const content = 'OnData callback test content'

    await sftp.writeFile(remotePath, content)

    let onDataCalled = false

    const transfer = new Transfer(sftp, {
      type: 'download',
      remotePath,
      localPath,
      chunkSize: 512,
      onData: (count) => {
        onDataCalled = true
      }
    })

    await transfer.startTransfer()

    assert(onDataCalled, 'onData should be called')

    transfer.destroy()
  })

  await test('should upload small file', async () => {
    const localPath = path.join(LOCAL_TEST_DIR, 'upload-small.txt')
    const remotePath = `${TEST_BASE_DIR}/uploaded-small.txt`
    const content = 'Upload Test Content'

    fs.writeFileSync(localPath, content)

    const transfer = new Transfer(sftp, {
      type: 'upload',
      remotePath,
      localPath,
      chunkSize: 1024
    })

    await transfer.startTransfer()

    const state = transfer.getState()
    assert(state.completed, 'Transfer should be completed')

    const uploadedContent = await sftp.readFile(remotePath)
    assert(uploadedContent.toString() === content, 'Content should match')

    transfer.destroy()
  })

  await test('should call onData callback during upload', async () => {
    const localPath = path.join(LOCAL_TEST_DIR, 'ondata-upload.txt')
    const remotePath = `${TEST_BASE_DIR}/ondata-upload.txt`
    const content = 'OnData upload test'

    fs.writeFileSync(localPath, content)

    let onDataCalled = false

    const transfer = new Transfer(sftp, {
      type: 'upload',
      remotePath,
      localPath,
      chunkSize: 512,
      onData: (count) => {
        onDataCalled = true
      }
    })

    await transfer.startTransfer()

    assert(onDataCalled, 'onData should be called')

    transfer.destroy()
  })

  await test('should upload and download big binary file with correct MD5', async () => {
    const localPath = path.join(LOCAL_TEST_DIR, 'big-binary.bin')
    const remotePath = `${TEST_BASE_DIR}/big-binary.bin`
    const fileSize = 5 * 1024 * 1024
    const buffer = Buffer.alloc(fileSize)
    for (let i = 0; i < fileSize; i++) {
      buffer[i] = Math.floor(Math.random() * 256)
    }
    fs.writeFileSync(localPath, buffer)

    const originalMd5 = crypto.createHash('md5').update(buffer).digest('hex')

    const uploadTransfer = new Transfer(sftp, {
      type: 'upload',
      remotePath,
      localPath,
      chunkSize: 32768
    })

    const uploadStart = Date.now()
    await uploadTransfer.startTransfer()
    const uploadTime = Date.now() - uploadStart
    const uploadSpeed = (fileSize / 1024 / 1024 / (uploadTime / 1000)).toFixed(2)
    console.log(`    Upload: ${uploadSpeed} MB/s (${uploadTime}ms)`)

    assert(uploadTransfer.getState().completed, 'Upload should be completed')

    const downloadPath = path.join(LOCAL_TEST_DIR, 'big-binary-downloaded.bin')
    const downloadTransfer = new Transfer(sftp, {
      type: 'download',
      remotePath,
      localPath: downloadPath,
      chunkSize: 32768
    })

    const downloadStart = Date.now()
    await downloadTransfer.startTransfer()
    const downloadTime = Date.now() - downloadStart
    const downloadSpeed = (fileSize / 1024 / 1024 / (downloadTime / 1000)).toFixed(2)
    console.log(`    Download: ${downloadSpeed} MB/s (${downloadTime}ms)`)

    assert(downloadTransfer.getState().completed, 'Download should be completed')

    const downloadedBuffer = fs.readFileSync(downloadPath)
    const downloadedMd5 = crypto.createHash('md5').update(downloadedBuffer).digest('hex')

    assert(downloadedMd5 === originalMd5, `MD5 should match: ${originalMd5} vs ${downloadedMd5}`)

    uploadTransfer.destroy()
    downloadTransfer.destroy()
  })

  console.log(`\n▶ File Transfer (SSH-based)`)
  console.log(`  ✔ passed: ${passed}, failed: ${failed}`)

  if (testTimer) clearTimeout(testTimer)
  if (conn) {
    conn.end()
    console.log('\nSSH connection closed')
  }
  try {
    fs.rmSync(LOCAL_TEST_DIR, { recursive: true, force: true })
  } catch (e) {}

  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(err => {
  console.error('Test runner error:', err)
  if (testTimer) clearTimeout(testTimer)
  process.exit(1)
})
