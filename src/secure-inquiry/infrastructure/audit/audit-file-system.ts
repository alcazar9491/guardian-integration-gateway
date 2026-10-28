import { mkdir, open, type FileHandle } from 'node:fs/promises';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** The few filesystem operations the audit store needs; injectable so tests can simulate failures. */
export interface AuditFileSystem {
  /** Creates the directory and any missing parents (mode 0700 for new ones). */
  ensureDirectory(path: string): Promise<void>;
  /** Appends `data` and flushes it to disk before resolving; creates the file (mode 0600) if missing. */
  appendDurably(path: string, data: string): Promise<void>;
  /** The file's last byte, or undefined when it is missing or empty. */
  lastByte(path: string): Promise<number | undefined>;
  /** The file's lines; none when it is missing. */
  readLines(path: string): AsyncIterable<string>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function openExisting(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export const nodeAuditFileSystem: AuditFileSystem = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  },

  async appendDurably(path, data) {
    // 'a' is O_APPEND: every write lands at the end of the file, never over existing records.
    const handle = await open(path, 'a', FILE_MODE);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.datasync();
    } finally {
      await handle.close();
    }
  },

  async lastByte(path) {
    const handle = await openExisting(path);
    if (handle === undefined) return undefined;
    try {
      const { size } = await handle.stat();
      if (size === 0) return undefined;
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0];
    } finally {
      await handle.close();
    }
  },

  async *readLines(path) {
    const handle = await openExisting(path);
    if (handle === undefined) return;
    try {
      yield* handle.readLines({ encoding: 'utf8', autoClose: false });
    } finally {
      await handle.close();
    }
  },
};
