# ssh2-scp

Remote file system operations/file transfer over SSH2 session without SFTP

[中文](./README-CN.md)

## Features

- File operations via SSH2 shell/command session (no SFTP required)
- Supports all common file system operations
- Non-UTF-8 encoding support (e.g. GBK) via optional iconv-lite
- Both ESM and CJS exports
- TypeScript support

## Install

```bash
npm install ssh2-scp
```

## Usage

```javascript
import { Client } from 'ssh2'
import { createSshFs } from 'ssh2-scp'

const client = new Client()
client.on('ready', () => {
  const fs = createSshFs(client)
  
  // List directory
  const files = await fs.list('/path/to/dir')
  
  // Read file
  const content = await fs.readFile('/path/to/file.txt')
  
  // Write file
  await fs.writeFile('/path/to/file.txt', 'Hello World')
  
  // Get file stats
  const stat = await fs.stat('/path/to/file')
  console.log(stat.isFile(), stat.isDirectory(), stat.size)
  
  // ... and more
})
```

## API

### Constructor

```javascript
createSshFs(client, options?)
```

- `client` - An authenticated ssh2 Client instance
- `options` - Optional configuration object:
  - `iconv` - An iconv-lite instance for non-UTF-8 encoding support (must expose `decode(buf, encoding)`)
  - `encoding` - Target encoding name (default: `'utf-8'`). Only effective when `iconv` is provided

### Encoding Support

By default, ssh2-scp assumes the remote server uses UTF-8 encoding. If your server uses a different encoding (e.g. GBK on Chinese Windows systems), pass an `iconv-lite` instance to decode file names and command output correctly.

Install `iconv-lite` in your project:

```bash
npm install iconv-lite
```

```javascript
import iconv from 'iconv-lite'
import { createSshFs } from 'ssh2-scp'

// Create an SshFs instance with GBK encoding support
const fs = createSshFs(client, { iconv, encoding: 'gbk' })

// File names are now decoded from GBK to Unicode
const files = await fs.list('/path/to/dir')
console.log(files[0].name) // '测试文件.txt' instead of garbled bytes
```

> **Note:** `iconv-lite` is not bundled as a runtime dependency to keep the package lightweight. You only need to install it if you require non-UTF-8 encoding support.

### Methods

#### File Operations

- `readFile(remotePath)` - Read file content as string
- `writeFile(remotePath, content, mode?)` - Write string content to file
- `readFileBase64(remotePath)` - Read file as base64 encoded string
- `writeFileBase64(remotePath, base64Content)` - Write base64 content to file

#### Directory Operations

- `list(remotePath)` - List directory contents
- `mkdir(remotePath, options?)` - Create directory
- `rmdir(remotePath)` - Remove directory

#### File/Directory Manipulation

- `cp(from, to)` - Copy file or directory
- `mv(from, to)` - Move/rename file or directory
- `rename(oldPath, newPath)` - Rename file or directory
- `rm(remotePath)` - Remove file
- `touch(remotePath)` - Create empty file or update timestamp

#### File Info

- `stat(remotePath)` - Get file stats (follows symlinks)
- `lstat(remotePath)` - Get file stats (does not follow symlinks)
- `realpath(remotePath)` - Get canonical path
- `readlink(remotePath)` - Read symlink target
- `getFolderSize(folderPath)` - Get folder size and file count

#### Permissions

- `chmod(remotePath, mode)` - Change file permissions

#### Utilities

- `getHomeDir()` - Get home directory
- `runExec(command)` - Execute raw shell command

## Transfer

`Transfer` is for single-file uploads and downloads.

```javascript
import { Transfer } from 'ssh2-scp/transfer'

const transfer = new Transfer(fs, {
  type: 'download', // or 'upload'
  remotePath: '/remote/path',
  localPath: '/local/path',
  chunkSize: 32768,
  onProgress: (transferred, total) => {
    console.log(`Progress: ${transferred}/${total}`)
  }
})

await transfer.startTransfer()
```

### Transfer Options

- `type` - Transfer type: `'download'` or `'upload'`
- `remotePath` - Remote file path
- `localPath` - Local file path
- `chunkSize` - Chunk size for transfer (default: 32768)
- `onProgress` - Progress callback `(transferred, total) => void`
- `onData` - Data callback `(count) => void`

## Folder Transfer

`FolderTransfer` streams a tar archive over the SSH command channel. It is initialized from a raw `ssh2` `Client`, supports pause/resume, and targets both POSIX servers and Windows OpenSSH servers that provide `tar`.

Install a tar adapter explicitly if you want folder transfer support:

```bash
npm install tar
```

```javascript
import { Client } from 'ssh2'
import * as tar from 'tar'
import { FolderTransfer } from 'ssh2-scp/folder-transfer'

const client = new Client()
const transfer = new FolderTransfer(client, tar, {
  type: 'upload',
  localPath: '/local/folder',
  remotePath: '/remote/folder',
  chunkSize: 32768,
  onProgress: (transferred, total) => {
    console.log(`Progress: ${transferred}/${total}`)
  }
})

await transfer.startTransfer()
```

### FolderTransfer Encoding Support

When transferring folders to/from servers with non-UTF-8 filenames (e.g. GBK), pass `iconv` and `encoding` options. The filenames in the tar stream are converted in real-time using a streaming tar header transform — no remote-side tools required.

```javascript
import iconv from 'iconv-lite'

const transfer = new FolderTransfer(client, tar, {
  type: 'download',
  remotePath: '/remote/folder',
  localPath: '/local/folder',
  iconv,
  encoding: 'gbk'
})

await transfer.startTransfer()
// Local files now have correct UTF-8 names
```

### FolderTransfer Notes

- Constructor: `new FolderTransfer(client, tarAdapter, options)`
- `type` - Transfer type: `'download'` or `'upload'`
- `remotePath` - Remote folder path
- `localPath` - Local folder path
- `chunkSize` - Stream high water mark used by the tar pipeline
- `iconv` - An iconv-lite instance for encoding conversion (must expose `encode(str, enc)` and `decode(buf, enc)`)
- `encoding` - Remote filesystem encoding (e.g. `'gbk'`). Filenames in the tar stream are converted between this encoding and UTF-8
- `tarAdapter` - A tar-compatible object that exposes `c()` and `x()`; `tar` works out of the box
- `pause()` / `resume()` - Pause or continue the active stream
- `destroy()` - Abort the current folder transfer
- Windows remotes use PowerShell plus `tar`; Linux and other POSIX remotes use `tar` directly

## License

MIT
