import type { Client, ClientChannel } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  TransferOptions,
  TransferState,
  TransferType
} from './type.js'

export type { TransferType, TransferOptions, TransferState }

export interface FolderTransferTarAdapter {
  c(options: { cwd: string; portable?: boolean }, filePaths: string[]): NodeJS.ReadableStream
  x(options: { cwd: string; strict?: boolean }): NodeJS.WritableStream
}

type RemotePlatform = 'posix' | 'windows'

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

  constructor(session: Client, tarAdapter: FolderTransferTarAdapter, options: TransferOptions) {
    this.session = session
    this.tarAdapter = tarAdapter
    this.runRemoteCommand = this.runExec.bind(this)
    this.options = options
    this.chunkSize = options.chunkSize || 32768
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

    await Promise.all([
      pipeline(channel, progressStream, extractStream),
      closePromise
    ])
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

    const packStream = this.tarAdapter.c({ cwd: localPath, portable: true }, ['.'])
    this.pauseTarget = packStream
    const progressStream = this.createProgressStream()
    const remoteStdin = this.getChannelWritable(channel)

    await Promise.all([
      pipeline(packStream, progressStream, remoteStdin),
      closePromise
    ])
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