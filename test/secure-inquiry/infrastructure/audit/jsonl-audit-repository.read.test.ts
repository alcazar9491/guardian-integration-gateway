import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditReadError } from '../../../../src/secure-inquiry/application/errors.js';
import { JsonlAuditRepository } from '../../../../src/secure-inquiry/infrastructure/audit/jsonl-audit-repository.js';
import {
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

describe('JsonlAuditRepository read path', () => {
  it('treats a missing file as an empty store', async () => {
    const repository = new JsonlAuditRepository({ filePath });

    await expect(repository.scan()).resolves.toEqual({ records: [], invalidLines: 0 });
    await expect(repository.findById('missing')).resolves.toBeUndefined();
  });

  it('returns the latest revision of each record', async () => {
    const repository = new JsonlAuditRepository({ filePath });
    const pending = auditRecordFixture();
    const other = auditRecordFixture();
    const completed = { ...pending, revision: 2, outcome: 'COMPLETED' as const };

    await repository.append(pending);
    await repository.append(other);
    await repository.append(completed);

    const { records, invalidLines } = await repository.scan();
    expect(records).toHaveLength(2);
    expect(invalidLines).toBe(0);
    await expect(repository.findById(pending.auditId)).resolves.toEqual(toStoredRecord(completed));
    await expect(repository.findById(other.auditId)).resolves.toEqual(toStoredRecord(other));
  });

  it('picks the highest revision even when lines are out of order', async () => {
    const pending = auditRecordFixture();
    const completed = { ...pending, revision: 2, outcome: 'PROVIDER_FAILURE' as const };
    await writeFile(filePath, serializeAuditRecord(completed) + serializeAuditRecord(pending));

    const record = await new JsonlAuditRepository({ filePath }).findById(pending.auditId);

    expect(record?.revision).toBe(2);
    expect(record?.outcome).toBe('PROVIDER_FAILURE');
  });

  it('skips and counts malformed, torn, and tampered lines without throwing', async () => {
    const valid = auditRecordFixture();
    const validLine = serializeAuditRecord(valid);
    const tampered = serializeAuditRecord(auditRecordFixture()).replace(/\}\n$/, ',"originalMessage":"hi"}\n');
    await writeFile(
      filePath,
      [
        'this is not json\n',
        validLine,
        '\n',
        tampered,
        '{"schemaVersion":1,"auditId":"x"}\n',
        validLine.slice(0, 50),
      ].join(''),
    );

    const { records, invalidLines } = await new JsonlAuditRepository({ filePath }).scan();

    expect(records).toEqual([toStoredRecord(valid)]);
    expect(invalidLines).toBe(4);
  });

  it('sees records whose append is still pending (read-after-write within the process)', async () => {
    const repository = new JsonlAuditRepository({ filePath });
    const record = auditRecordFixture();

    const appending = repository.append(record);
    const found = await repository.findById(record.auditId);
    await appending;

    expect(found?.auditId).toBe(record.auditId);
  });

  it('maps read failures to AuditReadError', async () => {
    const { fileSystem } = fakeAuditFileSystem({
      readLines: () => {
        throw errnoError('EACCES');
      },
    });
    const repository = new JsonlAuditRepository({ filePath, fileSystem });

    const failure = repository.scan();

    await expect(failure).rejects.toBeInstanceOf(AuditReadError);
    await expect(failure).rejects.toMatchObject({ cause: { code: 'EACCES' } });
  });

  it('re-reads the file on every scan instead of caching', async () => {
    const repository = new JsonlAuditRepository({ filePath });
    const first = auditRecordFixture();
    const second = auditRecordFixture();
    await repository.append(first);
    await appendFile(filePath, serializeAuditRecord(second));

    const { records } = await repository.scan();

    expect(records.map((record) => record.auditId)).toEqual([first.auditId, second.auditId]);
  });
});
