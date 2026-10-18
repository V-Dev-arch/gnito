import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

type AddressRecord = { address: string; family: number };
type Resolver = (hostname: string) => Promise<AddressRecord[]>;

export interface PublicFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: string;
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!normalized || normalized.includes('%')) throw new Error('URL host is invalid.');
  return normalized;
}

export function isPublicIp(address: string): boolean {
  if (address.includes('%')) return false;
  try {
    let parsed: any = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}

const defaultResolver: Resolver = async hostname => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map(record => ({ address: record.address, family: record.family }));
};

export async function resolvePublicAddresses(hostname: string, resolver: Resolver = defaultResolver): Promise<AddressRecord[]> {
  const normalized = normalizeHostname(hostname);
  const literalFamily = isIP(normalized);
  const records = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await resolver(normalized);
  if (!records.length || records.length > 32 || records.some(record => !isPublicIp(record.address))) {
    throw new Error('URL must resolve only to public IP addresses; private, local, and special-use networks are blocked.');
  }
  return records;
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(makeAbortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function fetchPublicUrl(url: URL, options: {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
} = {}): Promise<PublicFetchResponse> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Only credential-free HTTP(S) URLs without fragments can be fetched.');
  }
  const hostname = normalizeHostname(url.hostname);
  const addresses = await withAbort(resolvePublicAddresses(hostname), options.signal);
  if (options.signal?.aborted) throw makeAbortError();

  const pinnedLookup = (requestedHost: string, lookupOptions: any, callback: (...args: any[]) => void) => {
    try {
      if (normalizeHostname(requestedHost) !== hostname) {
        callback(new Error('The network client attempted to resolve an unexpected hostname.'));
        return;
      }
      if (lookupOptions?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    } catch (error) { callback(error); }
  };

  const maxBytes = Math.max(1, options.maxBytes ?? 1_000_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const requestFn = url.protocol === 'https:' ? https.request : http.request;
  return new Promise<PublicFetchResponse>((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };
    const request = requestFn(url, {
      method: 'GET',
      headers: { 'Accept-Encoding': 'identity', ...options.headers },
      lookup: pinnedLookup as any,
      signal: options.signal,
      maxHeaderSize: 16 * 1024,
    }, response => {
      response.on('error', (error: Error) => fail(error));
      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      if (encoding && encoding !== 'identity') {
        fail(new Error('Compressed HTTP responses are not supported.'));
        return;
      }
      response.on('data', (chunk: Buffer | Uint8Array) => {
        if (settled) return;
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > maxBytes) { fail(new Error(`Response exceeded the ${maxBytes}-byte limit.`)); return; }
        chunks.push(data);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode || 0,
          headers: { get: (name: string) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value || null;
          } },
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(timeoutMs, () => fail(new Error('Request timed out.')));
    request.on('error', (error: Error) => fail(error));
    request.end();
  });
}
