import { SshFs, parseModeFromLongname } from '../dist/esm/ssh-fs.js'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Creates a mock SSH client that captures executed commands
 */
function createMockClient() {
  const commands = []
  const mockClient = {
    exec: (cmd, callback) => {
      commands.push(cmd)
      // Simulate successful execution
      const mockStream = {
        on: (event, handler) => {
          if (event === 'data') {
            handler(Buffer.from(''))
          }
          if (event === 'end') {
            handler()
          }
          return mockStream
        },
        stderr: {
          on: () => mockStream
        }
      }
      callback(null, mockStream)
    },
    getCommands: () => [...commands],
    clearCommands: () => { commands.length = 0 }
  }
  return mockClient
}

describe('SshFs maskMode', { concurrency: false }, () => {
  test('chmod strips file-type bits from regular file mode', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o100644 is a regular file with rw-r--r-- permissions
    await sftp.chmod('/test/file.txt', 0o100644)

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    // Should strip file-type bits, leaving only 0o644
    assert.equal(commands[0], 'chmod 644 "/test/file.txt"')
  })

  test('chmod strips file-type bits from directory mode', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o040755 is a directory with rwxr-xr-x permissions
    await sftp.chmod('/test/dir', 0o040755)

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    // Should strip file-type bits, leaving only 0o755
    assert.equal(commands[0], 'chmod 755 "/test/dir"')
  })

  test('chmod strips file-type bits from symlink mode', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o120777 is a symlink with rwxrwxrwx permissions
    await sftp.chmod('/test/link', 0o120777)

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    // Should strip file-type bits, leaving only 0o777
    assert.equal(commands[0], 'chmod 777 "/test/link"')
  })

  test('chmod preserves pure permission bits unchanged', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o755 is already pure permission bits
    await sftp.chmod('/test/file.txt', 0o755)

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    assert.equal(commands[0], 'chmod 755 "/test/file.txt"')
  })

  test('mkdir with mode strips file-type bits', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o040755 is a directory mode from parseModeFromLongname
    await sftp.mkdir('/test/newdir', { mode: 0o040755 })

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    // Should strip file-type bits, leaving only 0o755
    assert.equal(commands[0], 'mkdir -m 755 -p "/test/newdir"')
  })

  test('mkdir with pure permission bits works correctly', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // 0o755 is already pure permission bits
    await sftp.mkdir('/test/newdir', { mode: 0o755 })

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    assert.equal(commands[0], 'mkdir -m 755 -p "/test/newdir"')
  })

  test('mkdir without mode does not include -m flag', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    await sftp.mkdir('/test/newdir')

    const commands = mockClient.getCommands()
    assert.equal(commands.length, 1)
    assert.equal(commands[0], 'mkdir -p "/test/newdir"')
  })

  test('writeFile with mode strips file-type bits', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    // Write a small file with mode that includes file-type bits
    await sftp.writeFile('/test/file.txt', 'content', 0o100755)

    const commands = mockClient.getCommands()
    // Should have printf command and chmod command
    assert.ok(commands.length >= 2)
    const chmodCmd = commands.find(cmd => cmd.startsWith('chmod'))
    assert.ok(chmodCmd, 'Expected chmod command')
    // Should strip file-type bits, leaving only 0o755
    assert.equal(chmodCmd, 'chmod 755 "/test/file.txt"')
  })

  test('writeFile with pure permission bits works correctly', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    await sftp.writeFile('/test/file.txt', 'content', 0o644)

    const commands = mockClient.getCommands()
    assert.ok(commands.length >= 2)
    const chmodCmd = commands.find(cmd => cmd.startsWith('chmod'))
    assert.ok(chmodCmd, 'Expected chmod command')
    assert.equal(chmodCmd, 'chmod 644 "/test/file.txt"')
  })

  test('writeFile without mode does not include chmod', async () => {
    const mockClient = createMockClient()
    const sftp = new SshFs(mockClient)

    await sftp.writeFile('/test/file.txt', 'content')

    const commands = mockClient.getCommands()
    const chmodCmd = commands.find(cmd => cmd.startsWith('chmod'))
    assert.equal(chmodCmd, undefined, 'Should not have chmod command')
  })
})

describe('parseModeFromLongname', () => {
  test('regular file -rw-r--r-- returns 0o100644', () => {
    assert.equal(parseModeFromLongname('-rw-r--r--'), 0o100644)
  })

  test('executable file -rwxr-xr-x returns 0o100755', () => {
    assert.equal(parseModeFromLongname('-rwxr-xr-x'), 0o100755)
  })

  test('directory drwxr-xr-x returns 0o040755', () => {
    assert.equal(parseModeFromLongname('drwxr-xr-x'), 0o040755)
  })

  test('symlink lrwxrwxrwx returns 0o120777', () => {
    assert.equal(parseModeFromLongname('lrwxrwxrwx'), 0o120777)
  })

  test('maskMode with 0o7777 correctly strips file-type bits', () => {
    // Verify that masking works as expected
    const regularFileMode = 0o100644
    const masked = regularFileMode & 0o7777
    assert.equal(masked, 0o644)

    const directoryMode = 0o040755
    const maskedDir = directoryMode & 0o7777
    assert.equal(maskedDir, 0o755)

    const symlinkMode = 0o120777
    const maskedLink = symlinkMode & 0o7777
    assert.equal(maskedLink, 0o777)
  })
})
