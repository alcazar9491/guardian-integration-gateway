import { describe, expect, it } from 'vitest';
import { auditAssociatedData } from '../../../src/secure-inquiry/domain/audit-associated-data.js';

describe('auditAssociatedData', () => {
  it('encodes the record identity as a JSON array', () => {
    expect(auditAssociatedData({ auditId: 'audit-1', userRef: 'ref-1' })).toBe('["audit-1","ref-1"]');
  });

  it('is deterministic for the same identity', () => {
    const identity = { auditId: 'audit-1', userRef: 'ref-1' };

    expect(auditAssociatedData(identity)).toBe(auditAssociatedData({ ...identity }));
  });

  it.each([
    [{ auditId: 'a:b', userRef: 'c' }, { auditId: 'a', userRef: 'b:c' }],
    [{ auditId: 'a","b', userRef: 'c' }, { auditId: 'a', userRef: 'b","c' }],
    [{ auditId: 'ab', userRef: '' }, { auditId: 'a', userRef: 'b' }],
  ])('never collides for identities that naive concatenation would merge (%j vs %j)', (first, second) => {
    expect(auditAssociatedData(first)).not.toBe(auditAssociatedData(second));
  });

  it('ignores any other record field', () => {
    const identity = { auditId: 'audit-1', userRef: 'ref-1' };
    const recordLike = { ...identity, revision: 2, outcome: 'COMPLETED', sanitizedMessage: 'hello' };

    expect(auditAssociatedData(recordLike)).toBe(auditAssociatedData(identity));
  });
});
