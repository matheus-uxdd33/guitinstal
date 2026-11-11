'use strict';

/**
 * Early-access queue storage. The browser never holds a list of addresses and
 * this function never returns one: each registration is stored under a
 * sha256(email) key in the project's private Blob store, and the only thing
 * handed back is a status plus the unsubscribe code for that address.
 */

const crypto = require('node:crypto');
const { get, put, del } = require('@vercel/blob');

const ROOT = 'waitlist';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_SHAPE = /^[0-9a-f]{32}$/;
const MAX_BODY = 16 * 1024;

function pathnameFor(email) {
  return `${ROOT}/${crypto.createHash('sha256').update(email).digest('hex')}.json`;
}

function send(status, body) {
  return { status, body };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readRecord(pathname) {
  const found = await get(pathname, { access: 'private', useCache: false });
  if (!found || found.statusCode !== 200) return null;
  try {
    return JSON.parse(await new Response(found.stream).text());
  } catch {
    return null;
  }
}

function sameCode(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function register(payload) {
  const email = String(payload?.email || '').trim().toLowerCase();

  if (!EMAIL_SHAPE.test(email) || email.length > 254) {
    return send(400, { ok: false, error: 'That email address is not valid.' });
  }
  if (payload.consent !== true) {
    return send(400, { ok: false, error: 'Consent is required before an address can be stored.' });
  }

  const pathname = pathnameFor(email);
  const existing = await readRecord(pathname);
  if (existing?.unsubscribeCode) {
    return send(200, { ok: true, alreadyOnList: true, unsubscribeCode: existing.unsubscribeCode });
  }

  await put(
    pathname,
    JSON.stringify({
      email,
      consent: true,
      storedAt: new Date().toISOString(),
      unsubscribeCode: crypto.randomBytes(16).toString('hex'),
    }),
    {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
    },
  );

  const stored = await readRecord(pathname);
  if (!stored?.unsubscribeCode) {
    return send(502, { ok: false, error: 'The address could not be written to storage.' });
  }
  return send(200, { ok: true, alreadyOnList: false, unsubscribeCode: stored.unsubscribeCode });
}

async function optOut(payload) {
  const email = String(payload?.email || '').trim().toLowerCase();
  const code = String(payload?.code || '').trim().toLowerCase();

  if (!EMAIL_SHAPE.test(email) || !CODE_SHAPE.test(code)) {
    return send(400, { ok: false, error: 'An email address and its unsubscribe code are required.' });
  }

  const pathname = pathnameFor(email);
  const record = await readRecord(pathname);
  if (!record || !sameCode(record.unsubscribeCode, code)) {
    return send(404, { ok: false, error: 'No queue entry matches that address and code.' });
  }

  await del(pathname);
  if (await readRecord(pathname)) {
    return send(502, { ok: false, error: 'The address could not be removed from storage.' });
  }
  return send(200, { ok: true, removed: true });
}

module.exports = async function handler(request, response) {
  let result;
  try {
    if (request.method !== 'POST') {
      result = send(405, { ok: false, error: 'Use POST.' });
    } else if (!String(request.headers['content-type'] || '').includes('json')) {
      result = send(415, { ok: false, error: 'Send JSON.' });
    } else {
      const raw = await readBody(request);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        result = send(400, { ok: false, error: 'Send a JSON object.' });
      } else {
        // Vercel gives the function the request path, so the shared module can
        // serve /api/waitlist and /api/opt-out without a second copy.
        result = String(request.url || '').includes('opt') ? await optOut(payload) : await register(payload);
      }
    }
  } catch {
    result = send(500, { ok: false, error: 'Storage is unavailable right now.' });
  }

  response.writeHead(result.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(result.body));
};
