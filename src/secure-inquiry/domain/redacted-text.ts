declare const redactedTextBrand: unique symbol;

/**
 * Text that has passed through the sanitizer. Only a MessageSanitizer may produce it,
 * so ports that leave the service (AI provider, audit plaintext) cannot receive raw input.
 */
export type RedactedText = string & { readonly [redactedTextBrand]: true };
