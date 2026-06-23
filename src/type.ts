import type { Client } from 'ssh2'

export interface IconvDecoder {
  decode: (buf: Buffer, encoding: string) => string
}

export interface SshFsOptions {
  /** Pass an iconv-lite instance to support non-UTF-8 encodings (e.g. GBK). Must have a `decode(buf, encoding)` method. */
  iconv?: IconvDecoder
  /** Encoding to use when decoding command output (default: 'utf-8'). Only effective when `iconv` is provided. */
  encoding?: string
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

export type TransferType = 'download' | 'upload'

export interface TransferOptions {
  type: TransferType
  remotePath: string
  localPath: string
  chunkSize?: number
  /** Pass an iconv-lite instance to support non-UTF-8 encoding in folder transfers. Must expose `encode(str, encoding)` and `decode(buf, encoding)`. */
  iconv?: IconvDecoder & { encode: (str: string, encoding: string) => Buffer }
  /** Remote filesystem encoding (e.g. 'gbk'). When set, tar filename bytes are converted between this encoding and UTF-8. */
  encoding?: string
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

export class SshFs {
}

export function createSshFs(_session: Client, _options?: SshFsOptions): SshFs {
  return null as any
}
