import type { Client, ExecOptions } from 'ssh2'
import type {
  SshFsOptions,
  FileInfo,
  Stats
} from './type.js'

export type { SshFsOptions, FileInfo, Stats }

export class SshFs {
  private session: Client
  private _chunkSize: number | null = null

  async getChunkSize (): Promise<number> {
    return this.detectChunkSize()
  }

  constructor(session: Client, _options?: SshFsOptions) {
    this.session = session
  }

  private async detectChunkSize (): Promise<number> {
    this._chunkSize = 4 * 1024
    return this._chunkSize
  }

  private getExecOpts (): ExecOptions {
    return {}
  }

  private getMonthIndex (month: string): number {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return months.indexOf(month)
  }

  private parseMode (modeStr: string): number {
    const permMap: Record<string, number> = {
      '---': 0, '--x': 1, '-w-': 2, '-wx': 3,
      'r--': 4, 'r-x': 5, 'rw-': 6, 'rwx': 7
    }
    const perms = modeStr.slice(1, 10)
    const owner = permMap[perms.slice(0, 3)] || 0
    const group = permMap[perms.slice(3, 6)] || 0
    const other = permMap[perms.slice(6, 9)] || 0
    let fileType = 0o100000
    if (modeStr.startsWith('d')) fileType = 0o040000
    else if (modeStr.startsWith('l')) fileType = 0o120000
    else if (modeStr.startsWith('c')) fileType = 0o020000
    else if (modeStr.startsWith('b')) fileType = 0o060000
    else if (modeStr.startsWith('p')) fileType = 0o010000
    else if (modeStr.startsWith('s')) fileType = 0o140000
    return fileType | (owner << 6) | (group << 3) | other
  }

  private runCmd (cmd: string, timeout = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout>
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId)
      }
      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error(`Command timed out: ${cmd}`))
      }, timeout)
      this.session.exec(cmd, (err, stream) => {
        cleanup()
        if (err) {
          reject(err)
        } else {
          let out = Buffer.from('')
          stream.on('end', () => {
            resolve(out.toString())
          }).on('data', (data: Buffer) => {
            out = Buffer.concat([out, data])
          }).stderr.on('data', (data: Buffer) => {
            reject(data.toString())
          })
        }
      })
    })
  }

  private rmFolderCmd (remotePath: string) {
    return this.runCmd(`rmdir "${remotePath}"`)
  }

  private rmCmd (remotePath: string) {
    return this.runCmd(`rm "${remotePath}"`)
  }

  async getHomeDir (): Promise<string> {
    return this.realpath('.')
  }

  async rmdir (remotePath: string): Promise<unknown> {
    try {
      return await this.rmrf(remotePath)
    } catch (err) {
      console.error('rm -rf dir error', err)
      return this.removeDirectoryRecursively(remotePath)
    }
  }

  private async removeDirectoryRecursively (remotePath: string) {
    try {
      const contents = await this.listFiles(remotePath)
      for (const item of contents) {
        if (item.name === '.' || item.name === '..') continue
        const itemPath = `${remotePath}/${item.name}`
        if (item.type === 'd') {
          await this.removeDirectoryRecursively(itemPath)
        } else {
          await this.rmCmd(itemPath)
        }
      }
      await this.rmFolderCmd(remotePath)
    } catch (e) {
      // Directory may not exist, ignore
    }
  }

  rmrf (remotePath: string) {
    return this.runCmd(`rm -rf "${remotePath}"`)
  }

  touch (remotePath: string) {
    return this.runCmd(`touch "${remotePath}"`)
  }

  cp (from: string, to: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cmd = `cp -r "${from}" "${to}"`
      this.session.exec(cmd, this.getExecOpts(), (err) => {
        if (err) reject(err)
        else resolve(1)
      })
    })
  }

  mv (from: string, to: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cmd = `mv "${from}" "${to}"`
      this.session.exec(cmd, this.getExecOpts(), (err) => {
        if (err) reject(err)
        else resolve(1)
      })
    })
  }

  runExec (cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.session.exec(cmd, this.getExecOpts(), (err, stream) => {
        if (err) {
          reject(err)
        } else {
          let out = Buffer.from('')
          stream.on('end', () => {
            resolve(out.toString())
          }).on('data', (data: Buffer) => {
            out = Buffer.concat([out, data])
          }).stderr.on('data', (data: Buffer) => {
            reject(data.toString())
          })
        }
      })
    })
  }

  async getFolderSize (folderPath: string): Promise<{ size: string; count: number }> {
    try {
      const output = await this.runCmd(`du -sh "${folderPath}"`)
      const size = output.trim().split('\t')[0] || '0'
      return { size, count: 0 }
    } catch {
      return { size: '0', count: 0 }
    }
  }

  private async listFiles (remotePath: string): Promise<FileInfo[]> {
    const output = await this.runCmd(`ls -la "${remotePath}"`)
    const lines = output.trim().split('\n')
    const result: FileInfo[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || i === 0) continue

      const parts = line.split(/\s+/)
      if (parts.length < 9) continue

      const name = parts.slice(8).join(' ')
      if (name === '.' || name === '..') continue

      const type = parts[0].charAt(0)
      const mode = parseInt(parts[0].slice(1), 8)
      const owner = parseInt(parts[2], 10)
      const group = parseInt(parts[3], 10)
      const size = parseInt(parts[4], 10)
      const month = parts[5]
      const day = parts[6]
      const timeOrYear = parts[7]

      let mtime = 0
      const now = new Date()
      const year = now.getFullYear()
      if (timeOrYear.includes(':')) {
        const [hour, minute] = timeOrYear.split(':').map(Number)
        mtime = new Date(year, this.getMonthIndex(month), parseInt(day, 10), hour, minute).getTime()
      } else {
        mtime = new Date(parseInt(timeOrYear, 10), this.getMonthIndex(month), parseInt(day, 10)).getTime()
      }

      result.push({
        type,
        name,
        size,
        modifyTime: mtime,
        accessTime: mtime,
        mode,
        rights: {
          user: parts[0].substring(1, 4),
          group: parts[0].substring(4, 7),
          other: parts[0].substring(7, 10)
        },
        owner,
        group
      })
    }

    return result
  }

  list (remotePath: string): Promise<FileInfo[]> {
    return this.listFiles(remotePath)
  }

  async mkdir (remotePath: string, options: { mode?: number } = {}) {
    const cmd = options.mode
      ? `mkdir -m ${options.mode.toString(8)} -p "${remotePath}"`
      : `mkdir -p "${remotePath}"`
    return this.runCmd(cmd)
  }

  async stat (remotePath: string): Promise<Stats> {
    const isSymlink = await this.runCmd(`test -L "${remotePath}" && echo 1 || echo 0`).then(r => r.trim() === '1')
    const output = await this.runCmd(`ls -la "${remotePath}"`)
    const parts = output.trim().split(/\s+/)
    if (parts.length < 9) {
      return {
        size: 0, mode: 0, uid: 0, gid: 0, atime: 0, mtime: 0,
        isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
        isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false
      }
    }
    const size = parseInt(parts[4], 10)
    const modeStr = parts[0]
    const mode = this.parseMode(modeStr)
    const uid = parseInt(parts[2], 10)
    const gid = parseInt(parts[3], 10)
    return {
      size,
      mode,
      uid,
      gid,
      atime: 0,
      mtime: 0,
      isFile: () => modeStr.startsWith('-'),
      isDirectory: () => modeStr.startsWith('d'),
      isSymbolicLink: () => isSymlink,
      isBlockDevice: () => modeStr.startsWith('b'),
      isCharacterDevice: () => modeStr.startsWith('c'),
      isFIFO: () => modeStr.startsWith('p'),
      isSocket: () => modeStr.startsWith('s')
    }
  }

  readlink (remotePath: string) {
    return this.runCmd(`readlink "${remotePath}"`).then(output => output.trim())
  }

  realpath (remotePath: string) {
    return this.runCmd(`readlink -f "${remotePath}"`).then(output => output.trim())
      .catch(() => this.runCmd(`cd "${remotePath}" && pwd`).then(output => output.trim()))
  }

  async lstat (remotePath: string): Promise<Stats> {
    const output = await this.runCmd(`ls -ld "${remotePath}"`)
    const isSymlink = output.trim().startsWith('l')
    const lsOutput = await this.runCmd(`ls -la "${remotePath}"`)
    const parts = lsOutput.trim().split(/\s+/)
    if (parts.length < 9) {
      return {
        size: 0, mode: 0, uid: 0, gid: 0, atime: 0, mtime: 0,
        isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
        isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false
      }
    }
    const size = parseInt(parts[4], 10)
    const modeStr = parts[0]
    const mode = this.parseMode(modeStr)
    const uid = parseInt(parts[2], 10)
    const gid = parseInt(parts[3], 10)
    return {
      size,
      mode,
      uid,
      gid,
      atime: 0,
      mtime: 0,
      isFile: () => !isSymlink && modeStr.startsWith('-'),
      isDirectory: () => !isSymlink && modeStr.startsWith('d'),
      isSymbolicLink: () => isSymlink,
      isBlockDevice: () => modeStr.startsWith('b'),
      isCharacterDevice: () => modeStr.startsWith('c'),
      isFIFO: () => modeStr.startsWith('p'),
      isSocket: () => modeStr.startsWith('s')
    }
  }

  chmod (remotePath: string, mode: number) {
    return this.runCmd(`chmod ${mode.toString(8)} "${remotePath}"`)
  }

  rename (remotePath: string, remotePathNew: string) {
    return this.runCmd(`mv "${remotePath}" "${remotePathNew}"`)
  }

  rmFolder (remotePath: string) {
    return this.rmFolderCmd(remotePath)
  }

  rm (remotePath: string) {
    return this.rmCmd(remotePath)
  }

  async readFile (remotePath: string, options?: { chunkSize?: number }): Promise<string> {
    const defaultChunkSize = await this.detectChunkSize()
    const chunkSize = options?.chunkSize ?? defaultChunkSize
    const lsOutput = await this.runCmd(`ls -la "${remotePath}"`)
    const parts = lsOutput.trim().split(/\s+/)
    const fileSize = parts.length >= 5 ? parseInt(parts[4], 10) : 0

    if (fileSize <= chunkSize) {
      const output = await this.runCmd(`cat "${remotePath}"`)
      return output
    }

    const chunks: string[] = []
    for (let offset = 0; offset < fileSize; offset += chunkSize) {
      try {
        const cmd = `dd if="${remotePath}" bs=1K skip=${Math.floor(offset / 1024)} count=${Math.ceil(chunkSize / 1024)} 2>/dev/null`
        const chunkOutput = await this.runCmd(cmd)
        if (chunkOutput) {
          chunks.push(chunkOutput)
        }
      } catch {
        return this.runCmd(`cat "${remotePath}"`)
      }
    }

    return chunks.join('')
  }

  async writeFile (remotePath: string, str: string, mode?: number, _options?: { chunkSize?: number }): Promise<void> {
    const defaultChunkSize = await this.detectChunkSize()
    const data = Buffer.from(str)
    const sizeThreshold = defaultChunkSize

    if (data.length <= sizeThreshold) {
      const escapedContent = str.replace(/'/g, "'\\''")
      const cmd = `printf '%s' '${escapedContent}' > "${remotePath}"`
      await this.runCmd(cmd)
    } else {
      const tempBase = `/tmp/ssh-fs-${Date.now()}`
      await this.runCmd(`mkdir -p "${tempBase}"`)
      try {
        const chunkSize = defaultChunkSize
        for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.slice(i, i + chunkSize)
          const chunkFile = `${tempBase}/c${Math.floor(i / chunkSize)}`
          const escapedChunk = chunk.toString('binary').replace(/'/g, "'\\''")
          await this.runCmd(`printf '%s' '${escapedChunk}' > "${chunkFile}"`)
        }
        await this.runCmd(`cat ${tempBase}/c* > "${remotePath}"`)
      } finally {
        await this.runCmd(`rm -rf "${tempBase}"`)
      }
    }

    if (mode) {
      await this.runCmd(`chmod ${mode.toString(8)} "${remotePath}"`)
    }
  }
}

export function createSshFs (session: Client, options?: SshFsOptions): SshFs {
  return new SshFs(session, options)
}
