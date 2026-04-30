import { createSshFs } from '../dist/esm/ssh-fs.js'
import { FolderTransfer } from '../dist/esm/folder-transfer.js'
import { Client } from 'ssh2'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import 'dotenv/config'

const TEST_HOST = process.env.TEST_HOST || 'localhost'
const TEST_PORT = parseInt(process.env.TEST_PORT, 10) || 22235
const TEST_USER = process.env.TEST_USER || 'root'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'root'
const WIN_TEST_HOST = process.env.WIN_TEST_HOST || ''
const WIN_TEST_PORT = parseInt(process.env.WIN_TEST_PORT || '22', 10)
const WIN_TEST_USER = process.env.WIN_TEST_USER || ''
const WIN_TEST_PASSWORD = process.env.WIN_TEST_PASSWORD || ''
const RUN_FOLDER_TRANSFER_INTEGRATION = process.env.RUN_FOLDER_TRANSFER_INTEGRATION === '1'
const RUN_FOLDER_TRANSFER_WINDOWS_INTEGRATION = process.env.RUN_FOLDER_TRANSFER_WINDOWS_INTEGRATION === '1'

const TIMESTAMP = Date.now()
const TEST_BASE_DIR = `/tmp/test-ssh-folder-transfer-${TIMESTAMP}`
const LOCAL_BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh2-scp-folder-transfer-'))
const TEST_TIMEOUT = 30000

function createMockChannel({ stdoutChunks = [], collectStdin = false, onStdinComplete } = {}) {
  const channel = new PassThrough()
  channel.stderr = new PassThrough()
  channel.stdin = collectStdin ? new PassThrough() : channel
  channel.close = () => {
    channel.emit('close', 0)
  }

  if (collectStdin) {
    const chunks = []
    channel.stdin.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    channel.stdin.on('finish', async () => {
      try {
        await onStdinComplete?.(Buffer.concat(chunks))
        channel.stderr.end()
        channel.emit('close', 0)
      } catch (error) {
        channel.stderr.write(String(error.message || error))
        channel.stderr.end()
        channel.emit('close', 1)
      }
    })
  } else {
    process.nextTick(() => {
      for (const chunk of stdoutChunks) {
        channel.write(chunk)
      }
      channel.end()
      channel.stderr.end()
      channel.emit('close', 0)
    })
  }

  return channel
}

function createFailureChannel(message) {
  const channel = new PassThrough()
  channel.stderr = new PassThrough()
  channel.stdin = channel
  channel.close = () => {
    channel.emit('close', 1)
  }

  process.nextTick(() => {
    channel.stderr.write(message)
    channel.stderr.end()
    channel.end()
    channel.emit('close', 1)
  })

  return channel
}

class MockClient {
  constructor(handlers) {
    this.handlers = handlers
    this.commands = []
  }

  exec(command, callback) {
    this.commands.push(command)
    const handler = this.handlers.shift()
    if (!handler) {
      callback(new Error(`Unexpected command: ${command}`))
      return
    }
    handler(command, callback)
  }
}

function createFolderFixture(rootPath) {
  const files = [
    ['root.txt', 'root file'],
    ['level-1/alpha.txt', 'alpha'],
    ['level-1/beta.txt', 'beta'],
    ['level-1/level-2/gamma.txt', 'gamma'],
    ['level-1/level-2/level-3/delta.txt', 'delta'],
    ['level-1/space name.txt', 'space name'],
    ['.hidden/config.json', '{"enabled":true}']
  ]

  fs.mkdirSync(rootPath, { recursive: true })
  fs.mkdirSync(path.join(rootPath, 'empty-dir/deeper-empty'), { recursive: true })

  for (let index = 0; index < 30; index += 1) {
    const relativePath = `bulk/group-${index % 5}/file-${String(index).padStart(2, '0')}.bin`
    const content = crypto.randomBytes(8192 + index)
    fs.mkdirSync(path.dirname(path.join(rootPath, relativePath)), { recursive: true })
    fs.writeFileSync(path.join(rootPath, relativePath), content)
  }

  for (const [relativePath, content] of files) {
    const absolutePath = path.join(rootPath, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }
}

async function collectTarBuffer(sourcePath) {
  const chunks = []
  for await (const chunk of tar.c({ cwd: sourcePath, portable: true }, ['.'])) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function createManifest(rootPath) {
  const output = []

  async function walk(currentPath) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name)
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/')
      if (entry.isDirectory()) {
        output.push(`dir:${relativePath}`)
        await walk(absolutePath)
        continue
      }

      if (entry.isFile()) {
        const buffer = await fs.promises.readFile(absolutePath)
        const hash = crypto.createHash('md5').update(buffer).digest('hex')
        output.push(`file:${relativePath}:${buffer.length}:${hash}`)
      }
    }
  }

  await walk(rootPath)
  return output.sort()
}

async function extractTarBuffer(buffer, targetPath) {
  fs.mkdirSync(targetPath, { recursive: true })
  await pipeline(Readable.from(buffer), tar.x({ cwd: targetPath, strict: true }))
}

async function connectSSH() {
  return connectSSHWithConfig({
    host: TEST_HOST,
    port: TEST_PORT,
    username: TEST_USER,
    password: TEST_PASSWORD
  })
}

async function connectSSHWithConfig(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let settled = false
    const timeoutId = setTimeout(() => {
      settleReject(new Error(`SSH connection timed out: ${config.host}:${config.port}`))
    }, 10000)

    const cleanup = () => {
      clearTimeout(timeoutId)
    }

    const settleReject = error => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      try {
        conn.end()
      } catch {
      }
      try {
        conn.destroy?.()
      } catch {
      }
      reject(error)
    }

    conn.on('ready', () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({ conn, sftp: createSshFs(conn) })
    }).on('error', settleReject).connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 10000
    })
  })
}

function toPowerShellCommand(script) {
  return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''")
}

function normalizeWindowsRemotePath(value) {
  return value.trim().replace(/\\/g, '/').replace(/^\/([A-Za-z]:(?:\/|$))/, '$1')
}

async function runClientExec(conn, command) {
  return await new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''
      stream.on('data', chunk => {
        stdout += chunk.toString()
      })
      stream.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })
      stream.on('close', code => {
        if (typeof code === 'number' && code !== 0) {
          reject(new Error(stderr.trim() || `Command failed: ${command}`))
          return
        }

        resolve(stdout)
      })
    })
  })
}

describe('FolderTransfer', { concurrency: false }, () => {
  test('uses PowerShell tar commands for Windows downloads', async () => {
    const sourcePath = path.join(LOCAL_BASE_DIR, 'mock-windows-download-source')
    const targetPath = path.join(LOCAL_BASE_DIR, 'mock-windows-download-target')
    createFolderFixture(sourcePath)
    const tarBuffer = await collectTarBuffer(sourcePath)
    const remotePath = '/C:/remote/folder'

    const client = new MockClient([
      (_command, callback) => {
        callback(null, createFailureChannel('uname is not recognized'))
      },
      (command, callback) => {
        assert.match(command, /powershell -NoProfile -Command/)
        callback(null, createMockChannel({ stdoutChunks: ['5.1\n'] }))
      },
      (command, callback) => {
        assert.match(command, /Get-ChildItem -LiteralPath 'C:\/remote\/folder'/)
        assert.doesNotMatch(command, /-File/)
        assert.match(command, /Where-Object \{ -not \$_\.PSIsContainer \}/)
        callback(null, createMockChannel({ stdoutChunks: ['4096\n'] }))
      },
      (command, callback) => {
        assert.match(command, /tar -cf - -C 'C:\/remote\/folder' \./)
        callback(null, createMockChannel({ stdoutChunks: [tarBuffer] }))
      }
    ])

    const transfer = new FolderTransfer(client, tar, {
      type: 'download',
      remotePath,
      localPath: targetPath,
      chunkSize: 1024
    })

    await transfer.startTransfer()

    assert.equal(transfer.getState().completed, true)
    assert.deepEqual(await createManifest(targetPath), await createManifest(sourcePath))
  })

  test('uses PowerShell tar commands for Windows uploads', async () => {
    const sourcePath = path.join(LOCAL_BASE_DIR, 'mock-windows-upload-source')
    const extractedPath = path.join(LOCAL_BASE_DIR, 'mock-windows-upload-extracted')
    const remotePath = '/C:/remote/folder'
    createFolderFixture(sourcePath)

    const client = new MockClient([
      (_command, callback) => {
        callback(null, createFailureChannel('uname is not recognized'))
      },
      (command, callback) => {
        assert.match(command, /powershell -NoProfile -Command/)
        callback(null, createMockChannel({ stdoutChunks: ['5.1\n'] }))
      },
      (command, callback) => {
        assert.match(command, /New-Item -ItemType Directory -Force -Path 'C:\/remote\/folder'/)
        assert.match(command, /tar -xf - -C 'C:\/remote\/folder'/)
        callback(null, createMockChannel({
          collectStdin: true,
          onStdinComplete: async buffer => {
            await extractTarBuffer(buffer, extractedPath)
          }
        }))
      }
    ])

    const transfer = new FolderTransfer(client, tar, {
      type: 'upload',
      remotePath,
      localPath: sourcePath,
      chunkSize: 1024
    })

    await transfer.startTransfer()

    assert.equal(transfer.getState().completed, true)
    assert.deepEqual(await createManifest(extractedPath), await createManifest(sourcePath))
  })

  test('uploads and downloads nested folders with pause and resume', async (t) => {
    if (!RUN_FOLDER_TRANSFER_INTEGRATION) {
      t.skip('Set RUN_FOLDER_TRANSFER_INTEGRATION=1 to run SSH folder transfer integration coverage')
      return
    }

    const sourcePath = path.join(LOCAL_BASE_DIR, 'integration-source')
    const downloadPath = path.join(LOCAL_BASE_DIR, 'integration-download')
    const remotePath = `${TEST_BASE_DIR}/remote-folder`
    createFolderFixture(sourcePath)

    let connection
    try {
      connection = await connectSSH()
    } catch (error) {
      t.skip(`SSH test server unavailable: ${error.message || error}`)
      return
    }

    const { conn, sftp } = connection
    try {
      try {
        await sftp.rmrf(TEST_BASE_DIR)
      } catch {
      }
      await sftp.mkdir(TEST_BASE_DIR)

      let uploadPaused = false
      let uploadResumed = false
      let uploadChunks = 0
      let uploadTransfer

      uploadTransfer = new FolderTransfer(conn, tar, {
        type: 'upload',
        remotePath,
        localPath: sourcePath,
        chunkSize: 4096,
        onData: () => {
          uploadChunks += 1
          if (uploadPaused) {
            return
          }
          uploadPaused = true
          uploadTransfer.pause()
          setTimeout(() => {
            uploadResumed = true
            uploadTransfer.resume()
          }, 50)
        }
      })

      await uploadTransfer.startTransfer()

      assert.equal(uploadTransfer.getState().completed, true)
      assert.equal(uploadPaused, true)
      assert.equal(uploadResumed, true)
      assert.ok(uploadChunks > 0)

      const remoteFile = await sftp.readFile(`${remotePath}/level-1/level-2/gamma.txt`)
      assert.equal(remoteFile, 'gamma')

      let downloadPaused = false
      let downloadResumed = false
      let downloadTransfer
      downloadTransfer = new FolderTransfer(conn, tar, {
        type: 'download',
        remotePath,
        localPath: downloadPath,
        chunkSize: 4096,
        onData: () => {
          if (downloadPaused) {
            return
          }
          downloadPaused = true
          downloadTransfer.pause()
          setTimeout(() => {
            downloadResumed = true
            downloadTransfer.resume()
          }, 50)
        }
      })

      await downloadTransfer.startTransfer()

      assert.equal(downloadTransfer.getState().completed, true)
      assert.equal(downloadPaused, true)
      assert.equal(downloadResumed, true)
      assert.deepEqual(await createManifest(downloadPath), await createManifest(sourcePath))
    } finally {
      conn.end()
    }
  }, TEST_TIMEOUT)

  test('uploads and downloads nested folders against Windows server', async (t) => {
    if (!RUN_FOLDER_TRANSFER_WINDOWS_INTEGRATION) {
      t.skip('Set RUN_FOLDER_TRANSFER_WINDOWS_INTEGRATION=1 to run Windows SSH folder transfer coverage')
      return
    }

    if (!WIN_TEST_HOST || !WIN_TEST_USER || !WIN_TEST_PASSWORD) {
      t.skip('Set WIN_TEST_HOST/WIN_TEST_PORT/WIN_TEST_USER/WIN_TEST_PASSWORD to run Windows SSH coverage')
      return
    }

    const sourcePath = path.join(LOCAL_BASE_DIR, 'windows-integration-source')
    const downloadPath = path.join(LOCAL_BASE_DIR, 'windows-integration-download')
    createFolderFixture(sourcePath)

    let connection
    try {
      connection = await connectSSHWithConfig({
        host: WIN_TEST_HOST,
        port: WIN_TEST_PORT,
        username: WIN_TEST_USER,
        password: WIN_TEST_PASSWORD
      })
    } catch (error) {
      t.skip(`Windows SSH test server unavailable: ${error.message || error}`)
      return
    }

    const { conn } = connection
    const tempDir = normalizeWindowsRemotePath((await runClientExec(conn, toPowerShellCommand('$env:TEMP | Out-String'))).trim().replace(/[\\/]+$/, ''))
    const remotePath = `/${tempDir}/ssh2-scp-folder-transfer-${TIMESTAMP}`
    const normalizedRemotePath = normalizeWindowsRemotePath(remotePath)
    try {
      await runClientExec(conn, toPowerShellCommand(`if (Test-Path -LiteralPath '${escapePowerShell(normalizedRemotePath)}') { Remove-Item -LiteralPath '${escapePowerShell(normalizedRemotePath)}' -Recurse -Force }`))

      const uploadTransfer = new FolderTransfer(conn, tar, {
        type: 'upload',
        remotePath,
        localPath: sourcePath,
        chunkSize: 4096
      })

      await uploadTransfer.startTransfer()
      assert.equal(uploadTransfer.getState().completed, true)

      const remoteContent = await runClientExec(conn, toPowerShellCommand(`Get-Content -LiteralPath '${escapePowerShell(`${normalizedRemotePath}/level-1/level-2/gamma.txt`)}' -Raw | Out-String`))
      assert.equal(remoteContent.trim(), 'gamma')

      const downloadTransfer = new FolderTransfer(conn, tar, {
        type: 'download',
        remotePath,
        localPath: downloadPath,
        chunkSize: 4096
      })

      await downloadTransfer.startTransfer()
      assert.equal(downloadTransfer.getState().completed, true)
      assert.deepEqual(await createManifest(downloadPath), await createManifest(sourcePath))
    } finally {
      try {
        await runClientExec(conn, toPowerShellCommand(`if (Test-Path -LiteralPath '${escapePowerShell(normalizedRemotePath)}') { Remove-Item -LiteralPath '${escapePowerShell(normalizedRemotePath)}' -Recurse -Force }`))
      } catch {
      }
      conn.end()
    }
  }, TEST_TIMEOUT)
})

process.on('exit', () => {
  try {
    fs.rmSync(LOCAL_BASE_DIR, { recursive: true, force: true })
  } catch {
  }
})