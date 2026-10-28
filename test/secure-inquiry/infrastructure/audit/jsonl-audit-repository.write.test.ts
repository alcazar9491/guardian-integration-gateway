import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditPersistenceError } from '../../../../src/secure-inquiry/application/errors.js';
import {
  nodeAuditFileSystem,
  type AuditFileSystem,
} from '../../../../src/secure-inquiry/infrastructure/audit/audit-file-system.js';
import { JsonlAuditRepository } from '../../../../src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import {
  parseAuditLine,
  serializeAuditRecord,
  toStoredRecord,
} from '../../../../src/secure-inquiry/infrastructure/audit/stored-audit-record.js';
import { auditRecordFixture } from './audit-record-fixture.js';
import { errnoError, fakeAuditFileSystem } from './fake-audit-file-system.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'guardian-audit-'));
  filePath = join(directory, 'audit.jsonl');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fileLines(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf8');
  expect(content.endsWith('\n')).toBe(true);
  return content.slice(0, -1).split('\n');
}

function renderError(error: unknown): string {
  const failure = error as Error;
  return `${String(failure)} ${failure.stack ?? ''} ${String(failure.cause)}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('JsonlAuditRepository write path', () => {
  it('creates the missing directory and file on first append', async () => {
    const nestedPath = join(directory, 'nested', 'deeper', 'audit.jsonl');
    const record = auditRecordFixture();

    await new JsonlAuditRepository({ filePath: nestedPath }).append(record);

    const lines = await fileLines(nestedPath);
    expect(lines).toHaveLength(1);
    expect(parseAuditLine(lines[0] ?? '')).toEqual(toStoredRecord(record));
  });

  it.skipIf(process.platform === 'win32')('creates the file as 0600 and the directory as 0700', async () => {
    const nestedDirectory = join(directory, 'private');
    const nestedPath = join(nestedDirectory, 'audit.jsonl');

    await new JsonlAuditRepository({ filePath: nestedPath }).append(auditRecordFixture());

    expect((await stat(nestedPath)).mode & 0o777).toBe(0o600);
    expect((await stat(nestedDirectory)).mode & 0o777).toBe(0o700);
  });

  it('appends each revision as its own line and never rewrites earlier content', async () => {
    const repository = new JsonlAuditRepository({ filePath });
    const pending = auditRecordFixture();
    await repository.append(pending);
    const before = await readFile(filePath, 'utf8');

    await repository.append({ ...pending, revision: 2, outcome: 'COMPLETED' });

    const after = await readFile(filePath, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(await fileLines(filePath)).toHaveLength(2);
  });

  it('keeps every record, unbroken and in call order, under 200 concurrent appends', async () => {
    const repository = new JsonlAuditRepository({ filePath });
    const records = Array.from({ length: 200 }, () => auditRecordFixture());

    await Promise.all(records.map((record) => repository.append(record)));

    const parsed = (await fileLines(filePath)).map((line) => parseAuditLine(line));
    expect(parsed).toHaveLength(200);
    expect(parsed.map((record) => record?.auditId)).toEqual(records.map((record) => record.auditId));
  });

  it('terminates a torn last line from a previous crash so the next record stays intact', async () => {
    const fragment = serializeAuditRecord(auditRecordFixture()).slice(0, 60);
    await writeFile(filePath, fragment);
    const repository = new JsonlAuditRepository({ filePath });
    const first = auditRecordFixture();
    const second = auditRecordFixture();

    await repository.append(first);
    await repository.append(second);

    const lines = await fileLines(filePath);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(fragment);
    expect(parseAuditLine(lines[0] ?? '')).toBeUndefined();
    expect(parseAuditLine(lines[1] ?? '')?.auditId).toBe(first.auditId);
    expect(parseAuditLine(lines[2] ?? '')?.auditId).toBe(second.auditId);
  });

  it.each([
    ['an empty file', ''],
    ['a newline-terminated file', serializeAuditRecord(auditRecordFixture())],
  ])('adds no extra line to %s', async (_label, initialContent) => {
    await writeFile(filePath, initialContent);

    await new JsonlAuditRepository({ filePath }).append(auditRecordFixture());

    const lines = await fileLines(filePath);
    expect(lines.every((line) => parseAuditLine(line) !== undefined)).toBe(true);
  });

  it('rejects with AuditPersistenceError when the target path is a directory', async () => {
    await mkdir(filePath);

    await expect(new JsonlAuditRepository({ filePath }).append(auditRecordFixture())).rejects.toBeInstanceOf(
      AuditPersistenceError,
    );
  });

  it.each(['ENOSPC', 'EACCES', 'EROFS'])(
    'maps %s to AuditPersistenceError without leaking record content, and keeps accepting appends',
    async (code) => {
      let calls = 0;
      const { fileSystem, writes } = fakeAuditFileSystem({
        appendDurably: (_path, data) => {
          calls += 1;
          if (calls === 2) return Promise.reject(errnoError(code));
          writes.push(data);
          return Promise.resolve();
        },
      });
      const repository = new JsonlAuditRepository({ filePath, fileSystem });
      const [first, failing, third] = [auditRecordFixture(), auditRecordFixture(), auditRecordFixture()];

      const results = await Promise.allSettled([
        repository.append(first),
        repository.append(failing),
        repository.append(third),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      const error = (results[1] as PromiseRejectedResult).reason as AuditPersistenceError;
      expect(error).toBeInstanceOf(AuditPersistenceError);
      expect((error.cause as NodeJS.ErrnoException).code).toBe(code);
      expect(renderError(error)).not.toContain(failing.sanitizedMessage);
      expect(renderError(error)).not.toContain(failing.encryptedMessage.ciphertext);
      expect(writes.map((line) => parseAuditLine(line.trimEnd())?.auditId)).toEqual([first.auditId, third.auditId]);
    },
  );

  it('terminates the fragment a failed append left on disk so the next record stays intact', async () => {
    let failures = 0;
    const fileSystem: AuditFileSystem = {
      ...nodeAuditFileSystem,
      // writeFile does not roll back bytes it already wrote: a mid-write ENOSPC leaves an unterminated prefix.
      appendDurably: async (path, data) => {
        if (failures === 0) {
          failures += 1;
          await nodeAuditFileSystem.appendDurably(path, data.slice(0, 40));
          throw errnoError('ENOSPC');
        }
        await nodeAuditFileSystem.appendDurably(path, data);
      },
    };
    const repository = new JsonlAuditRepository({ filePath, fileSystem });
    const [torn, next] = [auditRecordFixture(), auditRecordFixture()];

    await expect(repository.append(torn)).rejects.toBeInstanceOf(AuditPersistenceError);
    await repository.append(next);

    const { records, invalidLines } = await repository.scan();
    expect(records.map((record) => record.auditId)).toEqual([next.auditId]);
    expect(invalidLines).toBe(1);
    expect(await repository.findById(next.auditId)).toEqual(toStoredRecord(next));
  });

  it('retries directory preparation after a failed first attempt', async () => {
    let attempts = 0;
    const { fileSystem, writes } = fakeAuditFileSystem({
      ensureDirectory: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(errnoError('EACCES')) : Promise.resolve();
      },
    });
    const repository = new JsonlAuditRepository({ filePath, fileSystem });

    await expect(repository.append(auditRecordFixture())).rejects.toBeInstanceOf(AuditPersistenceError);
    await repository.append(auditRecordFixture());

    expect(attempts).toBe(2);
    expect(writes).toHaveLength(1);
  });

  it('refuses an invalid record without writing anything and keeps accepting appends', async () => {
    const { fileSystem, writes } = fakeAuditFileSystem();
    const repository = new JsonlAuditRepository({ filePath, fileSystem });
    const invalid = auditRecordFixture({ createdAt: 'not-a-date' });

    await expect(repository.append(invalid)).rejects.toBeInstanceOf(AuditPersistenceError);
    await repository.append(auditRecordFixture());

    expect(writes).toHaveLength(1);
  });

  it('never starts an append before the previous one has finished', async () => {
    const firstWrite = deferred();
    const started: string[] = [];
    const { fileSystem } = fakeAuditFileSystem({
      appendDurably: (_path, data) => {
        started.push(parseAuditLine(data.trimEnd())?.auditId ?? 'invalid');
        return started.length === 1 ? firstWrite.promise : Promise.resolve();
      },
    });
    const repository = new JsonlAuditRepository({ filePath, fileSystem });
    const [first, second] = [auditRecordFixture(), auditRecordFixture()];

    const appends = [repository.append(first), repository.append(second)];
    await new Promise((resolve) => setImmediate(resolve));

    expect(started).toEqual([first.auditId]);
    firstWrite.resolve();
    await Promise.all(appends);
    expect(started).toEqual([first.auditId, second.auditId]);
  });

  it('close() waits for pending appends and rejects later ones', async () => {
    const slowWrite = deferred();
    const { fileSystem, writes } = fakeAuditFileSystem({
      appendDurably: (_path, data) =>
        slowWrite.promise.then(() => {
          writes.push(data);
        }),
    });
    const repository = new JsonlAuditRepository({ filePath, fileSystem });
    const pending = repository.append(auditRecordFixture());
    let closed = false;

    const closing = repository.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    slowWrite.resolve();
    await Promise.all([pending, closing]);
    expect(writes).toHaveLength(1);
    await expect(repository.append(auditRecordFixture())).rejects.toBeInstanceOf(AuditPersistenceError);
  });
});
