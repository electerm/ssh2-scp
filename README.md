# ssh2-scp

Remote file system operations over SSH2 session without SFTP

[中文](./README-CN.md)

## Features

- File operations via SSH2 shell/command session (no SFTP required)
- Supports all common file system operations
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
createSshFs(client)
```

- `client` - An authenticated ssh2 Client instance

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
- `remotePath` - Remote file/folder path
- `localPath` - Local file/folder path
- `chunkSize` - Chunk size for transfer (default: 32768)
- `onProgress` - Progress callback `(transferred, total) => void`
- `onData` - Data callback `(count) => void`

## License

MIT
