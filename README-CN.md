# ssh2-scp

通过 SSH2 会话进行远程文件系统操作/文件传输（无需 SFTP）。

[English](./README.md)

## 特性

- 通过 SSH2 shell/command 会话进行文件操作（无需 SFTP）
- 支持所有常用文件系统操作
- 支持非 UTF-8 编码（如 GBK），通过可选的 iconv-lite 实现
- 同时支持 ESM 和 CJS 导出
- 支持 TypeScript

## 安装

```bash
npm install ssh2-scp
```

## 使用方法

```javascript
import { Client } from 'ssh2'
import { createSshFs } from 'ssh2-scp'

const client = new Client()
client.on('ready', () => {
  const fs = createSshFs(client)
  
  // 列出目录
  const files = await fs.list('/path/to/dir')
  
  // 读取文件
  const content = await fs.readFile('/path/to/file.txt')
  
  // 写入文件
  await fs.writeFile('/path/to/file.txt', 'Hello World')
  
  // 获取文件信息
  const stat = await fs.stat('/path/to/file')
  console.log(stat.isFile(), stat.isDirectory(), stat.size)
  
  // ... 更多操作
})
```

## API

### 构造函数

```javascript
createSshFs(client, options?)
```

- `client` - 已认证的 ssh2 Client 实例
- `options` - 可选配置对象：
  - `iconv` - 用于非 UTF-8 编码支持的 iconv-lite 实例（需提供 `decode(buf, encoding)` 方法）
  - `encoding` - 目标编码名称（默认：`'utf-8'`），仅在提供了 `iconv` 时生效

### 编码支持

默认情况下，ssh2-scp 假设远程服务器使用 UTF-8 编码。如果服务器使用其他编码（例如中文 Windows 系统的 GBK），可以传入 `iconv-lite` 实例来正确解码文件名和命令输出。

安装 `iconv-lite`：

```bash
npm install iconv-lite
```

```javascript
import iconv from 'iconv-lite'
import { createSshFs } from 'ssh2-scp'

// 创建支持 GBK 编码的 SshFs 实例
const fs = createSshFs(client, { iconv, encoding: 'gbk' })

// 文件名会从 GBK 正确解码为 Unicode
const files = await fs.list('/path/to/dir')
console.log(files[0].name) // '测试文件.txt'，而不是乱码
```

> **注意：** 为了保持包的轻量，`iconv-lite` 不作为运行时依赖打包。只有在需要非 UTF-8 编码支持时才需要安装它。

### 方法

#### 文件操作

- `readFile(remotePath)` - 读取文件内容为字符串
- `writeFile(remotePath, content, mode?)` - 写入字符串内容到文件
- `readFileBase64(remotePath)` - 读取文件为 base64 编码字符串
- `writeFileBase64(remotePath, base64Content)` - 写入 base64 内容到文件

#### 目录操作

- `list(remotePath)` - 列出目录内容
- `mkdir(remotePath, options?)` - 创建目录
- `rmdir(remotePath)` - 删除目录

#### 文件/目录操作

- `cp(from, to)` - 复制文件或目录
- `mv(from, to)` - 移动/重命名文件或目录
- `rename(oldPath, newPath)` - 重命名文件或目录
- `rm(remotePath)` - 删除文件
- `touch(remotePath)` - 创建空文件或更新时间戳

#### 文件信息

- `stat(remotePath)` - 获取文件信息（跟随符号链接）
- `lstat(remotePath)` - 获取文件信息（不跟随符号链接）
- `realpath(remotePath)` - 获取规范路径
- `readlink(remotePath)` - 读取符号链接目标
- `getFolderSize(folderPath)` - 获取文件夹大小和文件数量

#### 权限

- `chmod(remotePath, mode)` - 更改文件权限

#### 工具

- `getHomeDir()` - 获取主目录
- `runExec(command)` - 执行原始 shell 命令

## 文件传输

`Transfer` 仅用于单文件上传和下载。

```javascript
import { Transfer } from 'ssh2-scp/transfer'

const transfer = new Transfer(fs, {
  type: 'download', // 或 'upload'
  remotePath: '/远程/路径',
  localPath: '/本地/路径',
  chunkSize: 32768,
  onProgress: (transferred, total) => {
    console.log(`进度: ${transferred}/${total}`)
  }
})

await transfer.startTransfer()
```

### 传输选项

- `type` - 传输类型：`'download'`（下载）或 `'upload'`（上传）
- `remotePath` - 远程文件路径
- `localPath` - 本地文件路径
- `chunkSize` - 传输块大小（默认：32768）
- `onProgress` - 进度回调函数 `(transferred, total) => void`
- `onData` - 数据回调函数 `(count) => void`

## 文件夹传输

`FolderTransfer` 会通过 SSH 命令通道流式传输 tar 归档。它直接从原始 `ssh2` `Client` 初始化，支持暂停/恢复，并同时支持 POSIX 服务器和带有 `tar` 的 Windows OpenSSH 服务器。

如果要使用文件夹传输，需要自行安装 tar 适配器：

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
    console.log(`进度: ${transferred}/${total}`)
  }
})

await transfer.startTransfer()
```

### FolderTransfer 编码支持

在向非 UTF-8 文件名的服务器（如 GBK）传输文件夹时，可以传入 `iconv` 和 `encoding` 选项。文件名会在 tar 流中实时转换，通过流式 tar 头解析实现，无需远程服务器安装额外工具。

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
// 本地文件名已正确转为 UTF-8
```

### FolderTransfer 说明

- 构造方式：`new FolderTransfer(client, tarAdapter, options)`
- `type` - 传输类型：`'download'` 或 `'upload'`
- `remotePath` - 远程文件夹路径
- `localPath` - 本地文件夹路径
- `chunkSize` - tar 流管道使用的 high water mark
- `iconv` - 用于编码转换的 iconv-lite 实例（需提供 `encode(str, enc)` 和 `decode(buf, enc)` 方法）
- `encoding` - 远程文件系统编码（如 `'gbk'`），tar 流中的文件名会在该编码与 UTF-8 之间转换
- `tarAdapter` - 兼容 tar 的对象，需要提供 `c()` 和 `x()`；可直接传入 `tar`
- `pause()` / `resume()` - 暂停或继续当前流式传输
- `destroy()` - 中止当前文件夹传输
- Windows 远端通过 PowerShell 加 `tar` 执行，Linux / 其他 POSIX 远端直接使用 `tar`

## 许可证

MIT
