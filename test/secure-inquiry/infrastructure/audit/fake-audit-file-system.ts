import { Readable } from 'node:stream';
import type { AuditFileSystem } from '../../../../src/secure-inquiry/infrastructure/audit/audit-file-system.js';

export function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated filesystem failure`), { code });
}

function linesOf(values: readonly string[]): AsyncIterable<string> {
  return Readable.from(values);
}

/** In-memory AuditFileSystem recording every append; override any operation to simulate failures. */
export function fakeAuditFileSystem(overrides: Partial<AuditFileSystem> = {}) {
  const writes: string[] = [];
  const fileSystem: AuditFileSystem = {
    ensureDirectory: () => Promise.resolve(),
    appendDurably: (_path, data) => {
      writes.push(data);
      return Promise.resolve();
    },
    lastByte: () => Promise.resolve(undefined),
    readLines: () => linesOf(writes.join('').split('\n').filter((line) => line !== '')),
    ...overrides,
  };
  return { fileSystem, writes };
}
