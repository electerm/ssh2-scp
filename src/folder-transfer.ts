import type { Client, ClientChannel } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  TransferOptions,
  TransferState,
  TransferType,
  IconvDecoder
} from './type.js'

export type { TransferType, TransferOptions, TransferState }

export interface FolderTransferTarAdapter {
  c(options: { cwd: string; portable?: boolean }, filePaths: string[]): NodeJS.ReadableStream
  x(options: { cwd: string; strict?: boolean }): NodeJS.WritableStream
}

type RemotePlatform = 'posix' | 'windows'

type IconvEncoder = IconvDecoder & { encode: (str: string, encoding: string) => Buffer }

const TAR_HEADER_SIZE = 512
const TAR_NAME_OFFSET = 0
const TAR_NAME_SIZE = 100
const TAR_PREFIX_OFFSET = 345
const TAR_PREFIX_SIZE = 155
const TAR_CHKSUM_OFFSET = 148
const TAR_CHKSUM_SIZE = 8
const TAR_MAGIC_OFFSET = 257
const TAR_MAGIC_SIZE = 8

export class FolderTransfer {
  private session: Client
  private tarAdapter: FolderTransferTarAdapter
  private runRemoteCommand: (cmd: string) => Promise<string>
  private options: TransferOptions
  private chunkSize: number
  private state: TransferState
  private aborted = false
  private platformPromise: Promise<RemotePlatform> | null = null
  private pauseTarget: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | null = null
  private activeChannel: ClientChannel | null = null
  private iconv?: IconvEncoder
  private encoding: string

  constructor(session: Client, tarAdapter: FolderTransferTarAdapter, options: TransferOptions) {
    this.session = session
    this.tarAdapter = tarAdapter
    this.runRemoteCommand = this.runExec.bind(this)
    this.options = options
    this.chunkSize = options.chunkSize || 32768
    this.iconv = options.iconv as IconvEncoder | undefined
    this.encoding = (options.encoding || 'utf-8').toLowerCase().replace(/[^a-z0-9-]/g, '')
    this.state = {
      transferred: 0,
      total: 0,
      paused: false,
      completed: false
    }
  }

  async startTransfer(): Promise<void> {
    if (this.state.completed || this.state.error || this.aborted) {
      return
    }

    try {
      if (this.options.type === 'download') {
        await this.download()
      } else {
        await this.upload()
      }
      this.state.completed = true
    } catch (err) {
      this.state.error = err as Error
      throw err
    } finally {
      this.pauseTarget = null
      this.activeChannel = null
    }
  }

  pause(): void {
    this.state.paused = true
    this.pauseTarget?.pause()
  }

  resume(): void {
    this.state.paused = false
    this.pauseTarget?.resume()
  }

  getState(): TransferState {
    return { ...this.state }
  }

  destroy(): void {
    this.aborted = true
    this.pauseTarget?.destroy?.(this.createAbortError())
    this.activeChannel?.close()
  }

  private createAbortError(): Error {
    return new Error('Folder transfer aborted')
  }

  private needsEncodingConversion(): boolean {
    return !!this.iconv && this.encoding !== 'utf-8' && this.encoding !== 'utf8' && this.encoding !== 'ascii'
  }

  /**
   * Creates a Transform stream that converts filename encoding in tar headers.
   * Handles both USTAR headers and PAX extended headers.
   * For PAX headers, parses the key=value pairs and converts the `path` value.
   * For USTAR headers, converts the name/prefix fields directly.
   * Recomputes checksums and sizes after modification.
   */
  private createTarEncodingTransform (srcEnc: string, dstEnc: string): Transform {
    const iconv = this.iconv!
    let remaining = Buffer.alloc(0)
    let skipBytes = 0

    const convertPath = (buf: Buffer): Buffer => {
      try {
        return iconv.encode(iconv.decode(buf, srcEnc), dstEnc)
      } catch {
        return buf
      }
    }

    return new Transform({
      transform (chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
        const buf = remaining.length > 0 ? Buffer.concat([remaining, chunk]) : Buffer.from(chunk)
        let pos = 0
        const parts: Buffer[] = []

        while (pos < buf.length) {
          if (skipBytes > 0) {
            const n = Math.min(skipBytes, buf.length - pos)
            parts.push(buf.subarray(pos, pos + n))
            pos += n
            skipBytes -= n
            continue
          }

          if (pos + TAR_HEADER_SIZE > buf.length) break

          const block = buf.subarray(pos, pos + TAR_HEADER_SIZE)

          // End-of-archive sentinel
          if (block[0] === 0 && block.every(b => b === 0)) {
            parts.push(buf.subarray(pos))
            remaining = Buffer.alloc(0)
            callback(null, Buffer.concat(parts))
            return
          }

          const magic = block.subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC_SIZE)
            .toString('ascii').replace(/\0/g, '').trim()

          if (magic !== 'ustar') {
            parts.push(block)
            pos += TAR_HEADER_SIZE
            continue
          }

          // Read the typeflag to identify PAX extended headers
          const typeflag = String.fromCharCode(block[156])

          // Parse size from header (needed for both PAX data and file data)
          const sizeStr = block.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim()
          const dataSize = parseInt(sizeStr, 8) || 0
          const dataBlocks = Math.ceil(dataSize / TAR_HEADER_SIZE) * TAR_HEADER_SIZE

          // Handle PAX extended headers: typeflag 'x' or 'g'
          if ((typeflag === 'x' || typeflag === 'g') && dataSize > 0) {
            const totalBlocks = TAR_HEADER_SIZE + dataBlocks
            if (pos + totalBlocks > buf.length) break // need more data

            // Read the PAX payload
            const paxData = buf.subarray(pos + TAR_HEADER_SIZE, pos + TAR_HEADER_SIZE + dataSize)
            const paxStr = paxData.toString('utf-8')
            const paxLines = paxStr.split('\n').filter(l => l.length > 0)

            let modified = false
            const newLines: string[] = []

            for (const line of paxLines) {
              const spaceIdx = line.indexOf(' ')
              if (spaceIdx === -1) { newLines.push(line); continue }

              const kv = line.substring(spaceIdx + 1)
              const eqIdx = kv.indexOf('=')
              if (eqIdx === -1) { newLines.push(line); continue }

              const keyword = kv.substring(0, eqIdx)
              const value = kv.substring(eqIdx + 1)

              if (keyword === 'path') {
                // Convert the path encoding
                const valueBuf = Buffer.from(value, 'utf-8')
                const converted = convertPath(valueBuf)
                if (!converted.equals(valueBuf)) {
                  const newValue = converted.toString('utf-8')
                  const newKv = `${keyword}=${newValue}`
                  const newLine = `${Buffer.byteLength(newKv, 'utf-8') + 1} ${newKv}`
                  newLines.push(newLine)
                  modified = true
                  continue
                }
              }

              newLines.push(line)
            }

            if (modified) {
              const newPaxPayload = Buffer.from(newLines.join('\n') + '\n', 'utf-8')
              const header = Buffer.alloc(TAR_HEADER_SIZE)
              block.copy(header)

              // Update size in header
              const newSizeStr = newPaxPayload.length.toString(8).padStart(11, '0') + '\0'
              Buffer.from(newSizeStr).copy(header, 124)

              // Recompute checksum
              header.fill(0x20, TAR_CHKSUM_OFFSET, TAR_CHKSUM_OFFSET + TAR_CHKSUM_SIZE)
              let sum = 0
              for (let i = 0; i < TAR_HEADER_SIZE; i++) sum += header[i]
              Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(header, TAR_CHKSUM_OFFSET)

              parts.push(header)
              pos += TAR_HEADER_SIZE

              // Align new payload to 512-byte boundary
              const newBlocks = Math.ceil(newPaxPayload.length / TAR_HEADER_SIZE) * TAR_HEADER_SIZE
              const padded = Buffer.alloc(newBlocks)
              newPaxPayload.copy(padded)
              parts.push(padded)
              pos += dataBlocks // skip original data blocks
              continue
            }

            // No modification needed — pass through header + data
            parts.push(buf.subarray(pos, pos + totalBlocks))
            pos += totalBlocks
            continue
          }

          // Regular USTAR header — convert filename in name/prefix fields
          const header = Buffer.from(block)
          const nameBytes = header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_SIZE)
          const prefixBytes = header.subarray(TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_SIZE)
          const nameEnd = nameBytes.indexOf(0)
          const prefixEnd = prefixBytes.indexOf(0)
          const nameLen = nameEnd === -1 ? TAR_NAME_SIZE : nameEnd
          const prefixLen = prefixEnd === -1 ? TAR_PREFIX_SIZE : prefixEnd

          let fullPath: Buffer
          if (prefixLen > 0) {
            fullPath = Buffer.concat([prefixBytes.subarray(0, prefixLen), Buffer.from('/'), nameBytes.subarray(0, nameLen)])
          } else {
            fullPath = nameBytes.subarray(0, nameLen)
          }

          const converted = convertPath(fullPath)
          if (!converted.equals(fullPath)) {
            header.fill(0, TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_SIZE)
            header.fill(0, TAR_PREFIX_OFFSET, TAR_PREFIX_OFFSET + TAR_PREFIX_SIZE)

            if (converted.length <= TAR_NAME_SIZE) {
              converted.copy(header, TAR_NAME_OFFSET)
            } else {
              const str = converted.toString('utf-8')
              const ls = str.lastIndexOf('/')
              if (ls > 0 && ls < str.length - 1) {
                const pre = converted.subarray(0, ls)
                const nm = converted.subarray(ls + 1)
                if (pre.length <= TAR_PREFIX_SIZE && nm.length <= TAR_NAME_SIZE) {
                  pre.copy(header, TAR_PREFIX_OFFSET)
                  nm.copy(header, TAR_NAME_OFFSET)
                }
              }
            }

            const tmp = Buffer.from(header)
            tmp.fill(0x20, TAR_CHKSUM_OFFSET, TAR_CHKSUM_OFFSET + TAR_CHKSUM_SIZE)
            let sum = 0
            for (let i = 0; i < TAR_HEADER_SIZE; i++) sum += tmp[i]
            Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ').copy(header, TAR_CHKSUM_OFFSET)
          }

          parts.push(header)
          pos += TAR_HEADER_SIZE
          skipBytes = dataBlocks
        }

        remaining = pos < buf.length ? buf.subarray(pos) : Buffer.alloc(0)
        callback(null, parts.length > 0 ? Buffer.concat(parts) : undefined)
      },

      flush (callback) {
        callback(null, remaining.length > 0 ? remaining : undefined)
      }
    })
  }

  private async download(): Promise<void> {
    const { remotePath, localPath } = this.options
    const platform = await this.getRemotePlatform()
    const normalizedRemotePath = this.normalizeRemotePath(remotePath, platform)

    fs.mkdirSync(localPath, { recursive: true })
    this.state.total = await this.getRemoteFolderSize(normalizedRemotePath, platform)

    const channel = await this.execStream(this.buildDownloadCommand(normalizedRemotePath, platform))
    this.activeChannel = channel
    this.pauseTarget = channel
    const closePromise = this.waitForChannelClose(channel)

    const progressStream = this.createProgressStream()
    const extractStream = this.tarAdapter.x({ cwd: localPath, strict: true })

    if (this.needsEncodingConversion()) {
      const encodingTransform = this.createTarEncodingTransform(this.encoding, 'utf-8')
      await Promise.all([
        pipeline(channel, progressStream, encodingTransform, extractStream),
        closePromise
      ])
    } else {
      await Promise.all([
        pipeline(channel, progressStream, extractStream),
        closePromise
      ])
    }
  }

  private async upload(): Promise<void> {
    const { remotePath, localPath } = this.options
    const localStats = fs.statSync(localPath)
    if (!localStats.isDirectory()) {
      throw new Error(`Local path is not a directory: ${localPath}`)
    }

    const platform = await this.getRemotePlatform()
    const normalizedRemotePath = this.normalizeRemotePath(remotePath, platform)
    this.state.total = await this.getLocalFolderSize(localPath)

    const channel = await this.execStream(this.buildUploadCommand(normalizedRemotePath, platform))
    this.activeChannel = channel
    const closePromise = this.waitForChannelClose(channel)

    const packStream = this.tarAdapter.c({ cwd: localPath }, ['.'])
    this.pauseTarget = packStream
    const progressStream = this.createProgressStream()
    const remoteStdin = this.getChannelWritable(channel)

    if (this.needsEncodingConversion()) {
      const encodingTransform = this.createTarEncodingTransform('utf-8', this.encoding)
      await Promise.all([
        pipeline(packStream, progressStream, encodingTransform, remoteStdin),
        closePromise
      ])
    } else {
      await Promise.all([
        pipeline(packStream, progressStream, remoteStdin),
        closePromise
      ])
    }
  }

  private async getRemotePlatform(): Promise<RemotePlatform> {
    if (!this.platformPromise) {
      this.platformPromise = this.runRemoteCommand('uname -s')
        .then(output => {
          const value = output.trim().toLowerCase()
          const platform: RemotePlatform = value.includes('windows') ? 'windows' : 'posix'
          return platform
        })
        .catch(async () => {
          await this.runRemoteCommand(this.toPowerShellCommand('$PSVersionTable.PSVersion.ToString() | Out-String'))
          return 'windows' as const
        })
    }

    return await this.platformPromise
  }

  private async getRemoteFolderSize(remotePath: string, platform: RemotePlatform): Promise<number> {
    const output = platform === 'windows'
      ? await this.runRemoteCommand(this.toPowerShellCommand(`$sum=(Get-ChildItem -LiteralPath '${this.escapePowerShell(remotePath)}' -Recurse -Force | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum; if ($null -eq $sum) { '0' } else { [int64]$sum }`))
      : await this.runRemoteCommand(`find "${this.escapePosix(remotePath)}" -type f -exec stat -c %s {} + 2>/dev/null | awk '{s+=\$1} END {print s+0}' || find "${this.escapePosix(remotePath)}" -type f -exec stat -f %z {} + 2>/dev/null | awk '{s+=\$1} END {print s+0}'`)

    return parseInt(output.trim(), 10) || 0
  }

  private normalizeRemotePath(remotePath: string, platform: RemotePlatform): string {
    if (platform !== 'windows') {
      return remotePath
    }

    const trimmedPath = remotePath.trim().replace(/\\/g, '/')
    return trimmedPath.replace(/^\/([A-Za-z]:(?:\/|$))/, '$1')
  }

  private async getLocalFolderSize(localPath: string): Promise<number> {
    const stack = [localPath]
    let total = 0

    while (stack.length > 0) {
      const currentPath = stack.pop() as string
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name)
        if (entry.isDirectory()) {
          stack.push(entryPath)
          continue
        }

        if (entry.isFile()) {
          const stats = await fs.promises.stat(entryPath)
          total += stats.size
        }
      }
    }

    return total
  }

  private createProgressStream(): Transform {
    return new Transform({
      highWaterMark: this.chunkSize,
      transform: (chunk, _encoding, callback) => {
        if (this.aborted) {
          callback(this.createAbortError())
          return
        }

        const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
        this.state.transferred += byteLength

        if (this.options.onProgress) {
          const visibleTransferred = this.state.total > 0
            ? Math.min(this.state.transferred, this.state.total)
            : this.state.transferred
          this.options.onProgress(visibleTransferred, this.state.total)
        }

        if (this.options.onData) {
          this.options.onData(byteLength)
        }

        callback(null, chunk)
      }
    })
  }

  private buildDownloadCommand(remotePath: string, platform: RemotePlatform): string {
    if (platform === 'windows') {
      return this.toPowerShellCommand(`& { tar -cf - -C '${this.escapePowerShell(remotePath)}' . }`)
    }

    return `tar -cf - -C "${this.escapePosix(remotePath)}" .`
  }

  private buildUploadCommand(remotePath: string, platform: RemotePlatform): string {
    if (platform === 'windows') {
      return this.toPowerShellCommand(`& { New-Item -ItemType Directory -Force -Path '${this.escapePowerShell(remotePath)}' | Out-Null; tar -xf - -C '${this.escapePowerShell(remotePath)}' }`)
    }

    return `mkdir -p "${this.escapePosix(remotePath)}" && tar -xf - -C "${this.escapePosix(remotePath)}"`
  }

  private escapePosix(value: string): string {
    return value.replace(/(["\\`$])/g, '\\$1')
  }

  private escapePowerShell(value: string): string {
    return value.replace(/'/g, "''")
  }

  private toPowerShellCommand(script: string): string {
    return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`
  }

  private getChannelWritable(channel: ClientChannel): NodeJS.WritableStream {
    const withStdin = channel as ClientChannel & { stdin?: NodeJS.WritableStream }
    return withStdin.stdin || channel
  }

  private execStream(cmd: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.session.exec(cmd, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        resolve(channel)
      })
    })
  }

  private runExec(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.session.exec(cmd, (err, channel) => {
        if (err) {
          reject(err)
          return
        }

        let stdout = ''
        let stderr = ''
        channel.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString()
        })
        channel.stderr.on('data', chunk => {
          stderr += chunk.toString()
        })
        channel.on('close', (code: number | undefined) => {
          if (code && code !== 0) {
            reject(new Error(stderr.trim() || `Command failed: ${cmd}`))
            return
          }
          if (stderr.trim()) {
            reject(new Error(stderr.trim()))
            return
          }
          resolve(stdout)
        })
      })
    })
  }

  private waitForChannelClose(channel: ClientChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false

      const settle = (error?: Error) => {
        if (settled) {
          return
        }

        settled = true
        if (error) {
          reject(error)
          return
        }

        resolve()
      }

      const handleExit = (code?: number) => {
        if (this.aborted) {
          settle(this.createAbortError())
          return
        }

        if (typeof code === 'number' && code !== 0) {
          settle(new Error(stderr.trim() || `Remote command failed with exit code ${code}`))
          return
        }

        settle()
      }

      channel.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })
      channel.on('exit', handleExit)
      channel.on('close', handleExit)
      channel.on('error', (error: Error) => {
        settle(error)
      })
    })
  }
}
