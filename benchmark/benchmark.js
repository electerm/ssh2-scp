import { createSshFs } from '../dist/esm/ssh-fs.js'
import { Transfer } from '../dist/esm/transfer.js'
import { Client } from '@electerm/ssh2'
import fs from 'fs'
import path from 'path'
import 'dotenv/config'

const TEST_HOST = process.env.TEST_HOST || 'localhost'
const TEST_PORT = parseInt(process.env.TEST_PORT, 10) || 22234
const TEST_USER = process.env.TEST_USER || 'root'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'root'

const TIMESTAMP = Date.now()
const TEST_BASE_DIR = `/tmp/test-ssh-scp-${TIMESTAMP}`
const LOCAL_TEST_DIR = path.join(process.cwd(), `temp-benchmark-${TIMESTAMP}`)
const LOCAL_FILE = path.join(LOCAL_TEST_DIR, 'testfile_5M')
const REMOTE_FILE = `${TEST_BASE_DIR}/testfile_5M`
const FILE_SIZE = 5 * 1024 * 1024

let conn
let sshFs

async function connectSSH() {
  return new Promise((resolve, reject) => {
    conn = new Client()
    conn.on('ready', () => {
      console.log('SSH connected')
      sshFs = createSshFs(conn)
      resolve(sshFs)
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

function createTestFile(filePath, size) {
  const buffer = Buffer.alloc(size)
  fs.writeFileSync(filePath, buffer)
  console.log(`Created local test file: ${filePath} (${size} bytes)`)
}

function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`Deleted: ${filePath}`)
    }
  } catch (err) {
    console.error(`Failed to delete ${filePath}:`, err.message)
  }
}

async function benchmarkSCP(sshFs, localPath, remotePath, chunkSize = 32768) {
  const transfer = new Transfer(sshFs, {
    type: 'upload',
    localPath,
    remotePath,
    chunkSize
  })

  const startTime = Date.now()
  await transfer.startTransfer()
  const endTime = Date.now()

  const duration = (endTime - startTime) / 1000
  const speed = FILE_SIZE / duration

  return {
    method: `SCP (${chunkSize / 1024}k)`,
    duration: duration.toFixed(2),
    speed: (speed / 1024 / 1024).toFixed(2)
  }
}

async function benchmarkSFTP(sshFs, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    conn.sftp((err, sftp) => {
      if (err) {
        return reject(err)
      }

      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
          return reject(err)
        }

        const endTime = Date.now()
        const duration = (endTime - startTime) / 1000
        const speed = FILE_SIZE / duration

        resolve({
          method: 'SFTP',
          duration: duration.toFixed(2),
          speed: (speed / 1024 / 1024).toFixed(2)
        })
      })
    })
  })
}

async function runBenchmark() {
  console.log(`Connecting to ${TEST_HOST}:${TEST_PORT}...`)
  await connectSSH()

  try {
    await sshFs.rmrf(TEST_BASE_DIR)
  } catch (e) {}
  await sshFs.mkdir(TEST_BASE_DIR)

  if (!fs.existsSync(LOCAL_TEST_DIR)) {
    fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true })
  }

  console.log(`\nCreating ${FILE_SIZE / 1024 / 1024}M test file...`)
  createTestFile(LOCAL_FILE, FILE_SIZE)

  console.log('\n--- Benchmark Results ---\n')

  const results = []

  const chunkSizes = [32768, 102400]

  for (const chunkSize of chunkSizes) {
    const remoteFileScp = `${TEST_BASE_DIR}/testfile_5M_scp_${chunkSize}`
    console.log(`Running SCP transfer benchmark (chunkSize: ${chunkSize})...`)
    try {
      const scpResult = await benchmarkSCP(sshFs, LOCAL_FILE, remoteFileScp, chunkSize)
      results.push(scpResult)
      console.log(`${scpResult.method}: ${scpResult.duration}s, ${scpResult.speed} MB/s`)
    } catch (err) {
      console.error(`SCP (${chunkSize}) benchmark failed:`, err.message)
    }
  }

  const remoteFileSftp = `${TEST_BASE_DIR}/testfile_5M_sftp`
  console.log('\nRunning SFTP transfer benchmark...')
  try {
    const sftpResult = await benchmarkSFTP(sshFs, LOCAL_FILE, remoteFileSftp)
    results.push(sftpResult)
    console.log(`SFTP: ${sftpResult.duration}s, ${sftpResult.speed} MB/s`)
  } catch (err) {
    console.error('SFTP benchmark failed:', err.message)
  }

  console.log('\n--- Summary ---')
  console.table(results)

  console.log('\nCleaning up...')
  deleteFile(LOCAL_FILE)
  if (fs.existsSync(LOCAL_TEST_DIR)) {
    fs.rmdirSync(LOCAL_TEST_DIR)
  }

  try {
    await sshFs.rmrf(TEST_BASE_DIR)
    console.log('Remote test directory cleaned up')
  } catch (err) {
    console.error('Failed to clean remote directory:', err.message)
  }

  conn.end()
  console.log('\nBenchmark completed!')
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err)
  if (conn) conn.end()
  process.exit(1)
})
