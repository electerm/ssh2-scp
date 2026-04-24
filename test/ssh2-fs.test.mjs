import { createSshFs, parseModeFromLongname } from '../dist/esm/ssh-fs.js'
import { Client } from 'ssh2'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import 'dotenv/config'

const TEST_HOST = process.env.TEST_HOST || 'localhost'
const TEST_PORT = parseInt(process.env.TEST_PORT, 10) || 22235
const TEST_USER = process.env.TEST_USER || 'root'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'root'

const TIMESTAMP = Date.now()
const TEST_BASE_DIR = `/tmp/test-ssh-fs-${TIMESTAMP}`

const TEST_TIMEOUT = 10000

let sftp
let conn

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

before(async () => {
  console.log(`Connecting to ${TEST_HOST}:${TEST_PORT}...`)
  console.log(`Test base: ${TEST_BASE_DIR}`)
  await connectSSH()
  try { await sftp.rmrf(TEST_BASE_DIR) } catch (e) {}
  await sftp.mkdir(TEST_BASE_DIR)
}, TEST_TIMEOUT)

after(() => {
  if (conn) {
    conn.end()
    console.log('\nSSH connection closed')
  }
})

describe('parseModeFromLongname', () => {
  test('regular file -rw-r--r-- returns 33188 (0o100644)', () => {
    assert.strictEqual(parseModeFromLongname('-rw-r--r--'), 33188)
  })

  test('executable file -rwxr-xr-x returns 0o100755', () => {
    assert.strictEqual(parseModeFromLongname('-rwxr-xr-x'), 0o100755)
  })

  test('directory drwxr-xr-x returns 0o040755', () => {
    assert.strictEqual(parseModeFromLongname('drwxr-xr-x'), 0o040755)
  })

  test('symlink lrwxrwxrwx returns 0o120777', () => {
    assert.strictEqual(parseModeFromLongname('lrwxrwxrwx'), 0o120777)
  })

  test('block device brw-rw---- returns 0o060660', () => {
    assert.strictEqual(parseModeFromLongname('brw-rw----'), 0o060660)
  })

  test('char device crw-rw-rw- returns 0o020666', () => {
    assert.strictEqual(parseModeFromLongname('crw-rw-rw-'), 0o020666)
  })

  test('fifo prw-r--r-- returns 0o010644', () => {
    assert.strictEqual(parseModeFromLongname('prw-r--r--'), 0o010644)
  })

  test('socket srwxrwxrwx returns 0o140777', () => {
    assert.strictEqual(parseModeFromLongname('srwxrwxrwx'), 0o140777)
  })

  test('all permissions denied ---------- returns 0o100000', () => {
    assert.strictEqual(parseModeFromLongname('----------'), 0o100000)
  })

  test('handles setuid/setgid chars as non-dash (permission bit set)', () => {
    // e.g. -rwsr-xr-x (setuid bit visible as 's' in owner-execute position)
    const mode = parseModeFromLongname('-rwsr-xr-x')
    // position 4 is 's' which is not '-', so execute bit is set
    assert.ok(mode & 0o100) // owner execute bit should be set
  })

  test('empty string returns 0', () => {
    assert.strictEqual(parseModeFromLongname(''), 0)
  })

  test('null returns 0', () => {
    assert.strictEqual(parseModeFromLongname(null), 0)
  })
})

describe('SSH File System', { concurrency: false }, () => {
  test('list directory', async () => {
    const list = await sftp.list(TEST_BASE_DIR)
    console.log('Directory listing:', list)
    assert.ok(Array.isArray(list))
  }, TEST_TIMEOUT)

  test('touch creates file', async () => {
    const p = `${TEST_BASE_DIR}/a.txt`
    await sftp.touch(p)
    const r = await sftp.runExec(`test -f "${p}" && echo OK`)
    assert.strictEqual(r.trim(), 'OK')
  }, TEST_TIMEOUT)

  test('writeFile and readFile', async () => {
    const p = `${TEST_BASE_DIR}/b.txt`
    await sftp.writeFile(p, 'hi')
    const r = await sftp.readFile(p)
    assert.strictEqual(r, 'hi')
  }, TEST_TIMEOUT)

  test('writeFile and readFile medium file (100KB)', async () => {
    const p = `${TEST_BASE_DIR}/medium-${TIMESTAMP}.txt`
    const content = 'B'.repeat(100 * 1024) // 100KB
    await sftp.writeFile(p, content)
    const r = await sftp.readFile(p)
    const size = await sftp.getChunkSize()
    console.log('chunk size:', size)
    assert.strictEqual(r, content)
  }, TEST_TIMEOUT)

  test('mkdir creates directory', async () => {
    const p = `${TEST_BASE_DIR}/sub`
    await sftp.mkdir(p)
    const r = await sftp.runExec(`test -d "${p}" && echo OK`)
    assert.strictEqual(r.trim(), 'OK')
  }, TEST_TIMEOUT)

  test('rename', async () => {
    await sftp.runExec(`touch "${TEST_BASE_DIR}/old.txt"`)
    await sftp.rename(`${TEST_BASE_DIR}/old.txt`, `${TEST_BASE_DIR}/new.txt`)
    const r = await sftp.runExec(`test -f "${TEST_BASE_DIR}/new.txt" && echo OK`)
    assert.strictEqual(r.trim(), 'OK')
  }, TEST_TIMEOUT)

  test('chmod', async () => {
    const p = `${TEST_BASE_DIR}/b.txt`
    await sftp.chmod(p, 0o755)
    const st = await sftp.stat(p)
    assert.strictEqual((st.mode & 0o777), 0o755)
  }, TEST_TIMEOUT)

  test('lstat for symbolic link', async () => {
    const link = `${TEST_BASE_DIR}/link-test`
    await sftp.runExec(`ln -s "${TEST_BASE_DIR}/b.txt" "${link}"`)
    const st = await sftp.lstat(link)
    assert.strictEqual(st.isSymbolicLink(), true)
    assert.strictEqual(st.isFile(), false)
  }, TEST_TIMEOUT)

  test('realpath', async () => {
    const r = await sftp.realpath('.')
    assert.ok(r.startsWith('/'))
  }, TEST_TIMEOUT)

  test('getHomeDir', async () => {
    const r = await sftp.getHomeDir()
    console.log('Home dir:', r)
    assert.ok(r.startsWith('/'))
  }, TEST_TIMEOUT)

  test('readlink', async () => {
    const link = `${TEST_BASE_DIR}/link`
    await sftp.runExec(`ln -s "${TEST_BASE_DIR}/b.txt" "${link}"`)
    const r = await sftp.readlink(link)
    assert.ok(r.length > 0)
  }, TEST_TIMEOUT)

  test('getFolderSize', async () => {
    const r = await sftp.getFolderSize(TEST_BASE_DIR)
    console.log('Folder size:', r)
    assert.ok(r.size.length > 0)
  }, TEST_TIMEOUT)

  test('cp', async () => {
    const from = `${TEST_BASE_DIR}/b.txt`
    const to = `${TEST_BASE_DIR}/cp-test-${TIMESTAMP}.txt`
    await sftp.cp(from, to)
    const list = await sftp.list(TEST_BASE_DIR)
    const names = list.map(f => f.name)
    assert.ok(names.includes(`cp-test-${TIMESTAMP}.txt`), `Expected cp-test-${TIMESTAMP}.txt in ${names.join(', ')}`)
  }, TEST_TIMEOUT)

  test('mv', async () => {
    const from = `${TEST_BASE_DIR}/a.txt`
    const to = `${TEST_BASE_DIR}/moved-a-${TIMESTAMP}.txt`
    await sftp.mv(from, to)
    const list = await sftp.list(TEST_BASE_DIR)
    const names = list.map(f => f.name)
    assert.ok(names.includes(`moved-a-${TIMESTAMP}.txt`), `Expected moved-a-${TIMESTAMP}.txt in ${names.join(', ')}`)
  }, TEST_TIMEOUT)

  test('runExec', async () => {
    const r = await sftp.runExec('echo hello')
    assert.strictEqual(r.trim(), 'hello')
  }, TEST_TIMEOUT)

  test('rm', async () => {
    const p = `${TEST_BASE_DIR}/rmtest.txt`
    await sftp.runExec(`touch "${p}"`)
    await sftp.rm(p)
    const r = await sftp.runExec(`test -f "${p}" || echo gone`)
    assert.strictEqual(r.trim(), 'gone')
  }, TEST_TIMEOUT)

  test('rmrf', async () => {
    await sftp.mkdir(`${TEST_BASE_DIR}/todel`)
    await sftp.rmrf(`${TEST_BASE_DIR}/todel`)
    const r = await sftp.runExec(`test -d "${TEST_BASE_DIR}/todel" || echo gone`)
    assert.strictEqual(r.trim(), 'gone')
  }, TEST_TIMEOUT)

  test('rmdir', async () => {
    await sftp.mkdir(`${TEST_BASE_DIR}/emptydir`)
    await sftp.rmFolder(`${TEST_BASE_DIR}/emptydir`)
    const r = await sftp.runExec(`test -d "${TEST_BASE_DIR}/emptydir" || echo gone`)
    assert.strictEqual(r.trim(), 'gone')
  }, TEST_TIMEOUT)

  test('final list', async () => {
    const list = await sftp.list(TEST_BASE_DIR)
    console.log('\nFinal files:')
    for (const f of list) console.log(`  ${f.type} ${f.name}`)
    assert.ok(list.length > 0)
  }, TEST_TIMEOUT)
})

console.log(`\n✓ Test base: ${TEST_BASE_DIR}`)
console.log('Files NOT deleted')
