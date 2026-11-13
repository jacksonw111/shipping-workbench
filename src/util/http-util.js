import { Buffer } from 'node:buffer';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body into a Buffer with a hard size ceiling. */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '上传内容超过 64MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(res, status, { error: error.message ?? String(error), details: error.details });
}

/** Parse `multipart/form-data`; returns `{ files: [...], fields: {...} }`. */
export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!match) throw new HttpError(400, '缺少 multipart boundary');
  const boundary = `--${match[1] ?? match[2]}`.trim();
  const parts = [];
  let cursor = body.indexOf(boundary);
  if (cursor < 0) throw new HttpError(400, '上传内容不是合法的 multipart');
  while (cursor >= 0) {
    const start = cursor + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(boundary, start);
    if (next < 0) break;
    const segment = body.subarray(start + 2, next - 2); // strip CRLF around the part
    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const rawHeaders = segment.subarray(0, headerEnd).toString('utf8');
      const data = segment.subarray(headerEnd + 4);
      const disposition = /content-disposition:([^\r\n]*)/i.exec(rawHeaders)?.[1] ?? '';
      const name = /name="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
      const type = /content-type:([^\r\n]*)/i.exec(rawHeaders)?.[1]?.trim();
      if (name) parts.push({ name, filename, contentType: type, data });
    }
    cursor = next;
  }
  const files = parts.filter((part) => part.filename !== undefined);
  const fields = {};
  for (const part of parts) {
    if (part.filename === undefined) fields[part.name] = part.data.toString('utf8');
  }
  return { files, fields };
}

/** Minimal cookie jar value parser. */
export function parseCookies(header) {
  const out = {};
  for (const chunk of String(header ?? '').split(';')) {
    const index = chunk.indexOf('=');
    if (index > 0) out[chunk.slice(0, index).trim()] = chunk.slice(index + 1).trim();
  }
  return out;
}
