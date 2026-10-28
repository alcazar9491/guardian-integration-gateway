# PII sanitization

The sanitizer redacts emails, credit card numbers, and SSN-like identifiers before a message leaves the gateway. It lives in the domain layer (`src/secure-inquiry/domain/sanitization/`), has no dependencies on frameworks, I/O, or logging, and returns the same output for the same input every time.

| Type | Label |
|---|---|
| Email | `<REDACTED: EMAIL>` |
| Credit card | `<REDACTED: CREDIT_CARD>` |
| SSN or standalone 9-digit identifier | `<REDACTED: SSN>` |

## Pipeline

1. **Detect.** Each detector scans the original message independently and returns spans (`type`, `start`, `end`). Spans never carry the matched value.
2. **Resolve.** Overlapping spans are merged by the precedence rule below.
3. **Redact.** One left-to-right pass replaces each span with its label.
4. **Count.** Findings report how many redactions of each type were made. Counts only, never values.

Non-string input throws `InvalidSanitizerInputError` with a fixed message that never echoes the input. Nothing in the sanitizer logs.

## Precedence rule

1. No detector ever sees another detector's output.
2. Spans that share at least one character merge, transitively, into one redaction covering their union. No fragment of a detected value survives.
3. The merged redaction takes the type of its longest span. Equal lengths are broken by fixed priority: EMAIL > CREDIT_CARD > SSN.
4. Spans are sorted by `(start, end descending, priority)`, so the result never depends on detector registration order.
5. Labels contain no digits and no `@`, so sanitizing already-sanitized text changes nothing.

Example: `123456789@example.com` produces an EMAIL span and a contained 9-digit span. They merge, the email is longer, and the result is `<REDACTED: EMAIL>`.

## Numeric boundary rule

A number is only redacted when it is a complete token:

1. **Not glued** to a letter, digit, or underscore (Unicode-aware). `ID123456789` is not redacted.
2. **Not part of a decimal.** `0.123456789` and `123456789.50` are not redacted. Commas are list separators, so `123456789,987654321` redacts both.
3. **Not a window of a longer grouped number.** A grouped match is rejected when its own separator plus a digit continues it on either side. `4111 1111 1111 1111 2222` is not a card; `123-45-6789 2026` still redacts the SSN because the space is not the SSN's separator.

## Supported formats

| Type | Matches | Examples |
|---|---|---|
| Email | ASCII `local@domain.tld`, local part up to 64 characters, dotted domain labels, alphabetic TLD | `john.doe+tag@mail.example.co.uk` |
| Credit card | 13–19 contiguous digits, or 4-4-4-4, 4-4-4-4-3, 4-6-5 (Amex), 4-6-4 (Diners) with one consistent space or hyphen separator | `4111111111111111`, `4111-1111-1111-1111`, `3782 822463 10005` |
| SSN | 3-2-4 with one consistent space or hyphen separator, or 9 contiguous digits | `123-45-6789`, `123 45 6789`, `123456789` |

Deliberate non-goals:

- **No Luhn check.** A mistyped card number is still sensitive; over-redaction is preferred to leaking.
- **No SSN validity rules** (area 000/666/9xx, group 00). The assessment treats every standalone 9-digit identifier as sensitive.

## Limitations of regex-based detection

Regular expressions see the shape of text, never its meaning.

- **Context-blind false positives.** An order number with 9 digits or a 13-digit millisecond timestamp is redacted as PII.
- **Formatting false negatives.** Fullwidth or Arabic-Indic digits, non-breaking spaces, dot separators, mixed separators, double spaces, and values split across lines are not detected. Two grouped card numbers joined by a single space read as one long number and are not detected.
- **Trivial evasion.** A zero-width character between digits, spelled-out values (`john at example dot com`), and encodings (base64, URL encoding such as `john%40example.com`, HTML entities) bypass detection.
- **Narrow coverage.** Names, addresses, phone numbers, IBANs, and dates of birth are out of scope. Non-ASCII email local parts (`josé@ejemplo.com`), quoted local parts, and IP-literal domains are not matched.
- **ReDoS risk, mitigated.** Patterns use bounded quantifiers and only start at token boundaries, so scanning stays linear. A test runs five 100,000-character adversarial inputs within a generous time bound. The HTTP layer also caps messages at 5,000 characters.

The known gaps are pinned by tests under "documented limitations", so a behaviour change is a deliberate decision rather than an accident.

In production, regex detection is the fast, deterministic first layer. It would be complemented by checksum validation, context-aware entity recognition (for example Microsoft Presidio or a cloud DLP service), Unicode normalization with offset mapping, and allow-lists.
