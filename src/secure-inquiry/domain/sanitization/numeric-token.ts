export type GroupSeparator = ' ' | '-';

export const GROUP_SEPARATORS: readonly GroupSeparator[] = Object.freeze([' ', '-']);

const TOKEN_CHAR = String.raw`[\p{L}\p{N}_]`;

/**
 * Boundary rules 1 and 2: a number must not be glued to letters, digits or underscores,
 * and must not be part of a decimal number. Commas are deliberately treated as list
 * separators so comma-separated identifiers are still redacted.
 */
function standalone(body: string): string {
  return String.raw`(?<!${TOKEN_CHAR})(?<!\d\.)${body}(?!${TOKEN_CHAR})(?!\.\d)`;
}

export function contiguousDigits(minLength: number, maxLength: number = minLength): RegExp {
  const quantifier = minLength === maxLength ? `{${minLength}}` : `{${minLength},${maxLength}}`;
  return Object.freeze(new RegExp(standalone(String.raw`\d${quantifier}`), 'gu'));
}

/**
 * Boundary rule 3: the same separator followed or preceded by a digit means the match is a
 * window inside a longer grouped number, so it is rejected.
 */
export function groupedDigits(groupLengths: readonly number[], separator: GroupSeparator): RegExp {
  const groups = groupLengths.map((length) => String.raw`\d{${length}}`).join(separator);
  const body = String.raw`(?<!\d${separator})${groups}(?!${separator}\d)`;
  return Object.freeze(new RegExp(standalone(body), 'gu'));
}
