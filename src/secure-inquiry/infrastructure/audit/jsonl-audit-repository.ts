import { dirname } from 'node:path';
import { AuditPersistenceError, AuditReadError } from '../../application/errors.js';
import type { AuditReader, AuditScanResult } from '../../application/ports/audit-reader.js';
import type { AuditRepository } from '../../application/ports/audit-repository.js';
import type { AuditRecord, PersistedAuditRecord } from '../../domain/audit-record.js';
import { nodeAuditFileSystem, type AuditFileSystem } from './audit-file-system.js';
import { parseAuditLine, serializeAuditRecord } from './stored-audit-record.js';

const NEWLINE = 0x0a;

export interface JsonlAuditRepositoryOptions {
  readonly filePath: string;
  readonly fileSystem?: AuditFileSystem;
}

function toPersistenceError(error: unknown): AuditPersistenceError {
  return error instanceof AuditPersistenceError ? error : new AuditPersistenceError({ cause: error });
}

/**
 * Append-only JSON Lines audit store for a single process. Each revision is one durable line; the file is
 * never rewritten or truncated. Not safe for multiple processes, containers, or replicas sharing the file.
 */
export class JsonlAuditRepository implements AuditRepository, AuditReader {
  private readonly filePath: string;
  private readonly fileSystem: AuditFileSystem;
  // Appends run one at a time in call order. The tail swallows failures so one bad write never blocks the next.
  private tail: Promise<void> = Promise.resolve();
  private prepared = false;
  private closed = false;

  constructor({ filePath, fileSystem = nodeAuditFileSystem }: JsonlAuditRepositoryOptions) {
    this.filePath = filePath;
    this.fileSystem = fileSystem;
  }

  append(record: AuditRecord): Promise<void> {
    if (this.closed) {
      return Promise.reject(new AuditPersistenceError({ cause: new Error('Audit repository is closed') }));
    }

    let line: string;
    try {
      line = serializeAuditRecord(record);
    } catch (error) {
      return Promise.reject(toPersistenceError(error));
    }

    const write = this.tail.then(() => this.writeLine(line));
    this.tail = write.catch(() => undefined);
    return write.catch((error: unknown) => {
      throw toPersistenceError(error);
    });
  }

  /** Waits for pending appends; later appends are rejected. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  async findById(auditId: string): Promise<PersistedAuditRecord | undefined> {
    const { records } = await this.scan();
    return records.find((record) => record.auditId === auditId);
  }

  async scan(): Promise<AuditScanResult> {
    await this.tail;
    const latest = new Map<string, PersistedAuditRecord>();
    let invalidLines = 0;

    try {
      for await (const line of this.fileSystem.readLines(this.filePath)) {
        if (line.trim() === '') continue;
        const record = parseAuditLine(line);
        if (record === undefined) {
          invalidLines += 1;
          continue;
        }
        const current = latest.get(record.auditId);
        if (current === undefined || record.revision >= current.revision) latest.set(record.auditId, record);
      }
    } catch (error) {
      throw new AuditReadError({ cause: error });
    }

    return { records: [...latest.values()], invalidLines };
  }

  private async writeLine(line: string): Promise<void> {
    if (!this.prepared) {
      await this.prepare();
      this.prepared = true;
    }
    try {
      await this.fileSystem.appendDurably(this.filePath, line);
    } catch (error) {
      // A failed write may still have left part of the line on disk, so the tail is checked again next time.
      this.prepared = false;
      throw error;
    }
  }

  private async prepare(): Promise<void> {
    await this.fileSystem.ensureDirectory(dirname(this.filePath));
    // A crash or a failed append can leave a partial last line. Terminating it keeps the fragment on its own
    // (invalid) line instead of letting it swallow the next record.
    const lastByte = await this.fileSystem.lastByte(this.filePath);
    if (lastByte !== undefined && lastByte !== NEWLINE) {
      await this.fileSystem.appendDurably(this.filePath, '\n');
    }
  }
}
