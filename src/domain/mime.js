import { Buffer } from 'node:buffer';

const CRLF = Buffer.from('\r\n');

/** Split a raw MIME message into headers + body. */
export function splitHeaderBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const index = text.indexOf('\r\n\r\n');
  const fallback = text.indexOf('\n\n');
  const cut = index >= 0 ? index : fallback;
  if (cut < 0) return { header: text.toString('utf8'), body: Buffer.alloc(0) };
  const step = index >= 0 ? 4 : 2;
  return { header: text.subarray(0, cut).toString('utf8'), body: text.subarray(cut + step) };
}

/** Parse a header block into a lower-cased name -> unfolded value map. */
export function parseHeaders(headerText) {
  const headers = {};
  const lines = String(headerText).split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) continue;
    current = line.slice(0, index).trim().toLowerCase();
    headers[current] = line.slice(index + 1).trim();
  }
  return headers;
}

/** Parse `type/subtype; key=value; key="quoted"` into `{ value, params }`. */
export function parseContentType(value) {
  const [rawType, ...rest] = String(value ?? '').split(';');
  const params = {};
  const extended = new Map();
  for (const chunk of rest) {
    const index = chunk.indexOf('=');
    if (index < 0) continue;
    const key = chunk.slice(0, index).trim().toLowerCase();
    let paramValue = chunk.slice(index + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    if (key.endsWith('*')) {
      // RFC 2231: filename*=utf-8''%E8%88%B9...  或分段 filename*0*= / filename*1=
      const base = key.replace(/\*\d*$/, '');
      const segment = /\*(\d+)$/.exec(key)?.[1];
      const decoded = segment === undefined ? decodeExtendedValue(paramValue) : decodePercent(paramValue);
      extended.set(segment === undefined ? base : `${base}#${segment}`, decoded);
      const joined = [...extended.entries()]
        .filter(([name]) => name.startsWith(base))
        .sort((a, b) => Number(a[0].split('#')[1] ?? -1) - Number(b[0].split('#')[1] ?? -1))
        .map(([, part]) => part)
        .join('');
      params[base] = joined;
      continue;
    }
    params[key] = decodeParameter(paramValue);
  }
  return { value: rawType.trim().toLowerCase(), params };
}

/** `utf-8''%E8%88%B9...` → 船期表.xls */
function decodeExtendedValue(value) {
  const match = /^([\w-]+)'([\w-]*)'(.*)$/.exec(value);
  if (!match) return decodePercent(value);
  const bytes = decodePercentArray(match[3]);
  try {
    return new TextDecoder(match[1].toLowerCase() === 'gb2312' ? 'gbk' : match[1]).decode(Buffer.from(bytes));
  } catch {
    return decodePercent(match[3]);
  }
}

function decodePercentArray(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(value.charCodeAt(index) & 0xff);
    }
  }
  return bytes;
}

function decodeParameter(value) {
  const rfc2231 = /^([\w-]+)\*0\*?=(.*)$/.exec(value);
  if (rfc2231) return decodePercent(rfc2231[2]);
  return decodeWords(value);
}

function decodePercent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Decode RFC 2047 encoded words (=?charset?B|Q?text?=). */
export function decodeWords(value) {
  return String(value).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const buffer =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : quotedPrintable(Buffer.from(text.replaceAll('_', ' ')));
      return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset.toLowerCase()).decode(buffer);
    } catch {
      return text;
    }
  });
}

/** Decode quoted-printable data. */
export function quotedPrintable(buffer) {
  const text = buffer.toString('latin1').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body, encoding) {
  const normalized = String(encoding ?? '').toLowerCase();
  if (normalized === 'base64') return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (normalized === 'quoted-printable') return quotedPrintable(body);
  return body;
}

/** Recursively walk a MIME message and pull out text bodies + attachments. */
export function parseMime(raw, depth = 0) {
  const { header, body } = splitHeaderBody(raw);
  const headers = parseHeaders(header);
  const contentType = parseContentType(headers['content-type'] ?? 'text/plain; charset=utf-8');
  const encoding = headers['content-transfer-encoding'];
  const disposition = parseContentType(headers['content-disposition'] ?? '');
  const rawName = disposition.params.filename ?? contentType.params.name ?? '';
  const filename = rawName || (disposition.value === 'attachment' ? fallbackName(contentType.value) : '');
  const decoded = decodeBody(body, encoding);

  if (contentType.value.startsWith('multipart/') && depth < 6) {
    const boundary = contentType.params.boundary;
    if (!boundary) return { headers, text: '', html: '', attachments: [] };
    const parts = splitMultipart(body, boundary);
    const out = { headers, text: '', html: '', attachments: [], inline: [] };
    for (const part of parts) {
      const child = parseMime(part, depth + 1);
      if (child.text) out.text += `${child.text}\n`;
      if (child.html) out.html += child.html;
      out.attachments.push(...child.attachments);
      out.inline.push(...(child.inline ?? []));
    }
    return out;
  }

  const charset = contentType.params.charset ?? 'utf-8';
  const text = decodeText(decoded, charset);
  const isAttachment = Boolean(filename) || disposition.value === 'attachment';
  if (isAttachment) {
    return {
      headers,
      text: '',
      html: '',
      attachments: [
        {
          filename: decodeWords(filename) || `attachment-${Date.now()}`,
          contentType: contentType.value || 'application/octet-stream',
          contentId: (headers['content-id'] ?? '').replace(/[<>]/g, ''),
          data: decoded,
        },
      ],
    };
  }
  return {
    headers,
    text: contentType.value === 'text/plain' ? text : '',
    html: contentType.value === 'text/html' ? text : '',
    attachments: [],
  };
}

const EXTENSIONS = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

function fallbackName(contentType) {
  const ext = EXTENSIONS[contentType] ?? '';
  return `attachment-${Date.now()}${ext ? `.${ext}` : ''}`;
}

function splitMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    const start = cursor + delimiter.length;
    const isEnd = body.subarray(start, start + 2).toString() === '--';
    if (isEnd) break;
    const next = body.indexOf(delimiter, start);
    if (next < 0) break;
    let part = body.subarray(start, next);
    if (part.subarray(0, 2).equals(CRLF)) part = part.subarray(2);
    if (part.subarray(-2).equals(CRLF)) part = part.subarray(0, part.length - 2);
    parts.push(part);
    cursor = next;
  }
  return parts;
}

function decodeText(buffer, charset) {
  const normalized = String(charset).toLowerCase();
  try {
    if (['utf-8', 'utf8'].includes(normalized)) return buffer.toString('utf8');
    if (['gbk', 'gb2312', 'gb18030'].includes(normalized)) return new TextDecoder('gbk').decode(buffer);
    return new TextDecoder(normalized).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}
