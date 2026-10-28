import { z } from 'zod';

export const MAX_USER_ID_LENGTH = 128;
export const MAX_MESSAGE_LENGTH = 5000;

export const secureInquiryRequestSchema = z.strictObject({
  userId: z.string().trim().min(1).max(MAX_USER_ID_LENGTH),
  message: z
    .string()
    .min(1)
    .max(MAX_MESSAGE_LENGTH)
    .refine((message) => message.trim().length > 0, 'Message must not be blank'),
});

export type SecureInquiryRequest = z.infer<typeof secureInquiryRequestSchema>;
