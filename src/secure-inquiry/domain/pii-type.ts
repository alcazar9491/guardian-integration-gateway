export const PII_TYPES = ['EMAIL', 'CREDIT_CARD', 'SSN'] as const;

export type PiiType = (typeof PII_TYPES)[number];
