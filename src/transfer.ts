import type { Client } from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import type { SshFs } from './ssh-fs.js'

export type TransferType = 'download' | 'upload'

export interface TransferOptions {
  type: TransferType
  remotePath: string
  localPath: string
  chunkSize?: number
  onProgress?: (transferred: number, total: number) => void
  onData?: (count: number) => void
}

export interface TransferState {
  transferred: number
  total: number
  paused: boolean
  completed: boolean
  error?: Error
}

export class Transfer {
  private session: Client
  private options: TransferOptions
  private chunkSize: number
  private state: TransferState
  private aborted = false

  constructor(sshFs: SshFs, options: TransferOptions) {
    this.session = (sshFs as any).session
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

    const isDownload = this.options.type === 'download'

    try {
      if (isDownload) {
        await this.download()
      } else {
        await this.upload()
      }
      this.state.completed = true
    } catch (err) {
      this.state.error = err as Error
      throw err
    }
  }

  private async getRemoteFileSize(remotePath: string): Promise<number> {
    const output = await this.runExec(`stat -c %s "${remotePath}" 2>/dev/null || stat -f %z "${remotePath}" 2>/dev/null`)
    return parseInt(output.trim(), 10) || 0
  }

  private runExec(cmd: string, stdinData?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      this.session.exec(cmd, (err, stream) => {
        if (err) {
          return reject(err)
        }

        if (stdinData) {
          stream.stdin.write(stdinData)
          stream.stdin.end()
        }

        let out = Buffer.from('')
        stream.on('close', () => {
          resolve(out.toString())
        }).on('data', (data: Buffer) => {
          out = Buffer.concat([out, data])
        }).stderr.on('data', (data: Buffer) => {
          console.error('stderr:', data.toString())
        })
      })
    })
  }

  private async download(): Promise<void> {
    const { remotePath, localPath, onProgress, onData } = this.options

    const dir = path.dirname(localPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.state.total = await this.getRemoteFileSize(remotePath)

    return new Promise((resolve, reject) => {
      const cmd = `dd if="${remotePath}" bs=${this.chunkSize} 2>/dev/null`

      this.session.exec(cmd, (err, stream) => {
        if (err) {
          return reject(err)
        }

        const writeStream = fs.createWriteStream(localPath)
        let localTransferred = 0

        stream.on('data', (data: Buffer) => {
          if (this.state.paused || this.aborted) {
            return
          }

          writeStream.write(data)
          localTransferred += data.length
          this.state.transferred = localTransferred

          if (onProgress) {
            onProgress(localTransferred, this.state.total)
          }

          if (onData) {
            onData(data.length)
          }
        })

        stream.on('close', () => {
          writeStream.end(() => {
            resolve()
          })
        })

        stream.on('error', (err: Error) => {
          this.state.error = err
          writeStream.end()
          reject(err)
        })
      })
    })
  }

  private async upload(): Promise<void> {
    const { remotePath, localPath, onProgress, onData } = this.options

    const fileContent = fs.readFileSync(localPath)
    this.state.total = fileContent.length

    await this.runExec(`dd of="${remotePath}" bs=${this.chunkSize} 2>/dev/null`, fileContent)

    this.state.transferred = this.state.total

    if (onProgress) {
      onProgress(this.state.total, this.state.total)
    }

    if (onData) {
      onData(fileContent.length)
    }

    this.state.completed = true
  }

  pause(): void {
    this.state.paused = true
  }

  resume(): void {
    this.state.paused = false
  }

  getState(): TransferState {
    return { ...this.state }
  }

  destroy(): void {
    this.aborted = true
  }
}
