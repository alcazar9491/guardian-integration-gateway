import type { RequestHandler } from 'express';
import { UnsupportedMediaTypeError } from './http-errors.js';

interface MediaType {
  readonly type: string;
  readonly charset: string | undefined;
}

function parseContentType(header: string): MediaType {
  const [type = '', ...parameters] = header.split(';');
  let charset: string | undefined;
  for (const parameter of parameters) {
    const [name = '', value = ''] = parameter.split('=');
    if (name.trim().toLowerCase() === 'charset') {
      charset = value.trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    }
  }
  return { type: type.trim().toLowerCase(), charset };
}

/**
 * Accepts `application/json` with no charset or `utf-8` only, and runs before the body is parsed. RFC 8259
 * requires UTF-8 between systems; body-parser would otherwise decode any `utf-*` charset, including UTF-7,
 * whose `+...-` sequences can disguise content.
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  const { type, charset } = parseContentType(req.get('content-type') ?? '');
  if (type === 'application/json' && (charset === undefined || charset === 'utf-8')) {
    next();
    return;
  }
  next(new UnsupportedMediaTypeError());
};
