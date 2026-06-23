import { createSshFs } from '../dist/esm/ssh-fs.js'
import { Client } from '@electerm/ssh2'
import iconv from 'iconv-lite'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import 'dotenv/config'

const TEST_HOST = process.env.TEST_HOST || 'localhost'
const TEST_PORT = parseInt(process.env.TEST_PORT, 10) || 22235
const TEST_USER = process.env.TEST_USER || 'root'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'root'

const TIMESTAMP = Date.now()
const TEST_BASE_DIR = `/tmp/test-encoding-${TIMESTAMP}`

const TEST_TIMEOUT = 10000

let conn

async function connectSSH () {
  return new Promise((resolve, reject) => {
    conn = new Client()
    conn.on('ready', () => {
      console.log('SSH connected')
      resolve()
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

before(async () => {
  console.log(`Connecting to ${TEST_HOST}:${TEST_PORT}...`)
  console.log(`Test base: ${TEST_BASE_DIR}`)
  await connectSSH()
  // Create test directory using default UTF-8 instance
  const sftp = createSshFs(conn)
  try { await sftp.rmrf(TEST_BASE_DIR) } catch (e) {}
  await sftp.mkdir(TEST_BASE_DIR)
}, TEST_TIMEOUT)

after(async () => {
  // Cleanup: remove test dir using default instance
  if (conn) {
    try {
      const sftp = createSshFs(conn)
      await sftp.rmrf(TEST_BASE_DIR)
    } catch (e) {}
    conn.end()
    console.log('\nSSH connection closed')
  }
})

describe('Encoding support - real server', { concurrency: false }, () => {
  test('create files with GBK-encoded names and list with iconv', async () => {
    // "测试文件" in GBK: \xb2\xe2\xca\xd4\xce\xc4\xbc\xfe
    const gbkHex = 'b2e2cad4cec4bcfe'
    const gbkName = '测试文件'
    const fileName = `${gbkName}.txt`

    // Create a file with GBK-encoded name on the remote server using printf
    // The shell will write raw GBK bytes into the filename
    await new Promise((resolve, reject) => {
      conn.exec(
        `cd "${TEST_BASE_DIR}" && printf '\\xb2\\xe2\\xca\\xd4\\xce\\xc4\\xbc\\xfe.txt' | xargs touch`,
        (err, stream) => {
          if (err) return reject(err)
          let stderr = ''
          stream.on('close', (code) => {
            if (code !== 0) reject(new Error(`exit code ${code}: ${stderr}`))
            else resolve()
          }).on('data', () => {}).stderr.on('data', (d) => {
            stderr += d.toString()
          })
        }
      )
    })

    // List with GBK-aware SshFs
    const gbkSftp = createSshFs(conn, { iconv, encoding: 'gbk' })
    const list = await gbkSftp.list(TEST_BASE_DIR)

    console.log('GBK decoded listing:')
    for (const f of list) console.log(`  ${f.type} ${f.name}`)

    assert.ok(list.length > 0, 'Expected at least one file')
    const found = list.find(f => f.name === fileName)
    assert.ok(found, `Expected to find "${fileName}" in listing, got: ${list.map(f => f.name).join(', ')}`)
    assert.equal(found.type, '-')
  }, TEST_TIMEOUT)

  test('UTF-8 SshFs sees garbled name for GBK-encoded file', async () => {
    // Default UTF-8 instance should see mojibake
    const utf8Sftp = createSshFs(conn)
    const list = await utf8Sftp.list(TEST_BASE_DIR)

    console.log('UTF-8 raw listing (mojibake expected):')
    for (const f of list) console.log(`  ${f.type} ${f.name}`)

    assert.ok(list.length > 0, 'Expected at least one file')
    // The GBK bytes interpreted as UTF-8 should NOT equal the correct Chinese name
    const hasCorrectName = list.some(f => f.name === '测试文件.txt')
    assert.ok(!hasCorrectName, 'UTF-8 instance should not correctly decode GBK filename')
  }, TEST_TIMEOUT)

  test('list mixed directory with UTF-8 and GBK filenames', async () => {
    // Create a normal UTF-8 file
    const utf8Name = `utf8-${TIMESTAMP}.txt`
    await new Promise((resolve, reject) => {
      conn.exec(
        `touch "${TEST_BASE_DIR}/${utf8Name}"`,
        (err, stream) => {
          if (err) return reject(err)
          stream.on('close', () => resolve()).on('data', () => {})
        }
      )
    })

    // GBK-aware list should see both files
    const gbkSftp = createSshFs(conn, { iconv, encoding: 'gbk' })
    const list = await gbkSftp.list(TEST_BASE_DIR)

    console.log('Mixed directory listing (GBK decode):')
    for (const f of list) console.log(`  ${f.type} ${f.name}`)

    const names = list.map(f => f.name)
    assert.ok(names.includes(utf8Name), `Expected "${utf8Name}" in listing`)
    assert.ok(names.includes('测试文件.txt'), `Expected "测试文件.txt" in listing`)
  }, TEST_TIMEOUT)

  test('runExec with GBK output decoding', async () => {
    // Write GBK content to a file and cat it back
    const content = '你好世界'
    const gbkBuf = iconv.encode(content, 'gbk')
    // Write raw GBK bytes to a temp file
    const hexStr = [...gbkBuf].map(b => '\\x' + b.toString(16).padStart(2, '0')).join('')
    await new Promise((resolve, reject) => {
      conn.exec(
        `printf '${hexStr}' > "${TEST_BASE_DIR}/gbk-content.txt"`,
        (err, stream) => {
          if (err) return reject(err)
          stream.on('close', () => resolve()).on('data', () => {})
        }
      )
    })

    // Read back with GBK-aware SshFs
    const gbkSftp = createSshFs(conn, { iconv, encoding: 'gbk' })
    const result = await gbkSftp.runExec(`cat "${TEST_BASE_DIR}/gbk-content.txt"`)
    assert.equal(result, content)
  }, TEST_TIMEOUT)
})
