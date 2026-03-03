import type { Client, ExecOptions } from 'ssh2'

export interface SshFsOptions {
  enableSsh?: boolean
}

export interface FileInfo {
  type: string
  name: string
  size: number
  modifyTime: number
  accessTime: number
  mode: number
  rights: {
    user: string
    group: string
    other: string
  }
  owner: number
  group: number
}

export interface Stats {
  isDirectory: () => boolean
  isFile: () => boolean
  isBlockDevice: () => boolean
  isCharacterDevice: () => boolean
  isSymbolicLink: () => boolean
  isFIFO: () => boolean
  isSocket: () => boolean
  size: number
  mode: number
  uid: number
  gid: number
  atime: number
  mtime: number
}

export interface SshFs {
  getHomeDir(): Promise<string>
  rmdir(remotePath: string): Promise<unknown>
  rmrf(remotePath: string): Promise<unknown>
  touch(remotePath: string): Promise<unknown>
  cp(from: string, to: string): Promise<unknown>
  mv(from: string, to: string): Promise<unknown>
  runExec(cmd: string): Promise<string>
  getFolderSize(folderPath: string): Promise<{ size: string; count: number }>
  list(remotePath: string): Promise<FileInfo[]>
  mkdir(remotePath: string, options?: { mode?: number }): Promise<unknown>
  stat(remotePath: string): Promise<Stats>
  readlink(remotePath: string): Promise<string>
  realpath(remotePath: string): Promise<string>
  lstat(remotePath: string): Promise<Stats>
  chmod(remotePath: string, mode: number): Promise<unknown>
  rename(remotePath: string, remotePathNew: string): Promise<unknown>
  rmFolder(remotePath: string): Promise<unknown>
  rm(remotePath: string): Promise<unknown>
  readFile(remotePath: string): Promise<Buffer>
  writeFile(remotePath: string, str: Buffer | string, mode?: number): Promise<unknown>
}

function getMonthIndex(month: string): number {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return months.indexOf(month)
}

export function createSshFs(session: Client, options?: SshFsOptions): SshFs {
  const enableSsh = options?.enableSsh ?? true

  const runCmd = (cmd: string, timeout = 30000): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!enableSsh) {
        return reject(new Error(`do not support ${cmd.split(' ')[0]} operation in sftp only mode`))
      }
      let timeoutId: ReturnType<typeof setTimeout>
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId)
      }
      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error(`Command timed out: ${cmd}`))
      }, timeout)
      session.exec(cmd, (err, stream) => {
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

  const getExecOpts = (): ExecOptions => {
    return {}
  }

  const removeDirectoryRecursively = async (remotePath: string) => {
    try {
      const contents = await list(remotePath)
      for (const item of contents) {
        if (item.name === '.' || item.name === '..') continue
        const itemPath = `${remotePath}/${item.name}`
        if (item.type === 'd') {
          await removeDirectoryRecursively(itemPath)
        } else {
          await rmCmd(itemPath)
        }
      }
      await rmFolderCmd(remotePath)
    } catch (e) {
      // Directory may not exist, ignore
    }
  }

  const list = async (remotePath: string): Promise<FileInfo[]> => {
    const output = await runCmd(`ls -la "${remotePath}"`)
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
        mtime = new Date(year, getMonthIndex(month), parseInt(day, 10), hour, minute).getTime()
      } else {
        mtime = new Date(parseInt(timeOrYear, 10), getMonthIndex(month), parseInt(day, 10)).getTime()
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

  const rmFolderCmd = (remotePath: string) => {
    return runCmd(`rmdir "${remotePath}"`)
  }

  const rmCmd = (remotePath: string) => {
    return runCmd(`rm "${remotePath}"`)
  }

  return {
    getHomeDir() {
      return this.realpath('.')
    },

    async rmdir(remotePath: string) {
      try {
        return await this.rmrf(remotePath)
      } catch (err) {
        console.error('rm -rf dir error', err)
        return removeDirectoryRecursively(remotePath)
      }
    },

    rmrf(remotePath: string) {
      return runCmd(`rm -rf "${remotePath}"`)
    },

    touch(remotePath: string) {
      return runCmd(`touch "${remotePath}"`)
    },

    cp(from: string, to: string) {
      return new Promise((resolve, reject) => {
        if (!enableSsh) {
          return reject(new Error('do not support copy operation in sftp only mode'))
        }
        const cmd = `cp -r "${from}" "${to}"`
        session.exec(cmd, getExecOpts(), (err) => {
          if (err) reject(err)
          else resolve(1)
        })
      })
    },

    mv(from: string, to: string) {
      return new Promise((resolve, reject) => {
        if (!enableSsh) {
          return reject(new Error('do not support move operation in sftp mode'))
        }
        const cmd = `mv "${from}" "${to}"`
        session.exec(cmd, getExecOpts(), (err) => {
          if (err) reject(err)
          else resolve(1)
        })
      })
    },

    runExec(cmd: string) {
      return new Promise((resolve, reject) => {
        if (!enableSsh) {
          return reject(new Error(`do not support ${cmd.split(' ')[0]} operation in sftp mode`))
        }
        session.exec(cmd, getExecOpts(), (err, stream) => {
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
    },

    async getFolderSize(folderPath: string) {
      const output = await this.runExec(`du -sh "${folderPath}" && find "${folderPath}" -type f | wc -l`)
      const lines = output.trim().split('\n')
      const size = lines[0]?.split('\t')[0] || '0'
      const count = parseInt(lines[1] || '0', 10)
      return { size, count }
    },

    list(remotePath: string) {
      return list(remotePath)
    },

    async mkdir(remotePath: string, options: { mode?: number } = {}) {
      const cmd = options.mode
        ? `mkdir -m ${options.mode.toString(8)} -p "${remotePath}"`
        : `mkdir -p "${remotePath}"`
      return runCmd(cmd)
    },

    async stat(remotePath: string): Promise<Stats> {
      const isSymlink = await runCmd(`test -L "${remotePath}" && echo 1 || echo 0`).then(r => r.trim() === '1')
      const output = await runCmd(`stat -c '%s %h %u %g %Y %Y %a' "${remotePath}"`)
      const parts = output.trim().split(/\s+/)
      if (parts.length < 7) {
        return {
          size: 0, mode: 0, uid: 0, gid: 0, atime: 0, mtime: 0,
          isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
          isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false
        }
      }
      const [size, _nlink, uid, gid, atime, mtime, modeOct] = parts
      const mode = parseInt(modeOct, 8)
      return {
        size: parseInt(size, 10),
        mode,
        uid: parseInt(uid, 10),
        gid: parseInt(gid, 10),
        atime: parseInt(atime, 10) * 1000,
        mtime: parseInt(mtime, 10) * 1000,
        isFile: () => (mode & 0o170000) === 0o100000,
        isDirectory: () => (mode & 0o170000) === 0o040000,
        isSymbolicLink: () => isSymlink,
        isBlockDevice: () => (mode & 0o170000) === 0o060000,
        isCharacterDevice: () => (mode & 0o170000) === 0o020000,
        isFIFO: () => (mode & 0o170000) === 0o010000,
        isSocket: () => (mode & 0o170000) === 0o140000
      }
    },

    readlink(remotePath: string) {
      return runCmd(`readlink "${remotePath}"`).then(output => output.trim())
    },

    realpath(remotePath: string) {
      return runCmd(`realpath "${remotePath}"`).then(output => output.trim())
    },

    async lstat(remotePath: string): Promise<Stats> {
      const output = await runCmd(`ls -ld "${remotePath}"`)
      const isSymlink = output.trim().startsWith('l')
      const statOutput = await runCmd(`stat -c '%s %h %u %g %Y %Y %a' "${remotePath}"`)
      const parts = statOutput.trim().split(/\s+/)
      if (parts.length < 7) {
        return {
          size: 0, mode: 0, uid: 0, gid: 0, atime: 0, mtime: 0,
          isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false,
          isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false
        }
      }
      const [size, _nlink, uid, gid, atime, mtime, modeOct] = parts
      const mode = parseInt(modeOct, 8)
      return {
        size: parseInt(size, 10),
        mode,
        uid: parseInt(uid, 10),
        gid: parseInt(gid, 10),
        atime: parseInt(atime, 10) * 1000,
        mtime: parseInt(mtime, 10) * 1000,
        isFile: () => !isSymlink && (mode & 0o170000) === 0o100000,
        isDirectory: () => !isSymlink && (mode & 0o170000) === 0o040000,
        isSymbolicLink: () => isSymlink,
        isBlockDevice: () => (mode & 0o170000) === 0o060000,
        isCharacterDevice: () => (mode & 0o170000) === 0o020000,
        isFIFO: () => (mode & 0o170000) === 0o010000,
        isSocket: () => (mode & 0o170000) === 0o140000
      }
    },

    chmod(remotePath: string, mode: number) {
      return runCmd(`chmod ${mode.toString(8)} "${remotePath}"`)
    },

    rename(remotePath: string, remotePathNew: string) {
      return runCmd(`mv "${remotePath}" "${remotePathNew}"`)
    },

    rmFolder(remotePath: string) {
      return rmFolderCmd(remotePath)
    },

    rm(remotePath: string) {
      return rmCmd(remotePath)
    },

    async readFile(remotePath: string): Promise<Buffer> {
      const output = await this.runExec(`cat "${remotePath}"`)
      return Buffer.from(output, 'binary')
    },

    writeFile(remotePath: string, str: Buffer | string, mode?: number) {
      const escapedContent = typeof str === 'string'
        ? str.replace(/'/g, "'\\''")
        : str.toString('binary').replace(/'/g, "'\\''")
      const cmd = mode
        ? `printf '%s' '${escapedContent}' | tee "${remotePath}" > /dev/null && chmod ${mode.toString(8)} "${remotePath}"`
        : `printf '%s' '${escapedContent}' > "${remotePath}"`
      return runCmd(cmd)
    }
  }
}
