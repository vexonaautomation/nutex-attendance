import { randomBytes, randomInt, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 2 ** 14;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // burn comparable time so unknown users are not distinguishable by latency
    await scrypt(password, Buffer.alloc(16), KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generatePassword(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export const PASSWORD_MIN_LENGTH = 8;

/**
 * Password rules for every password an administrator or a user sets: at least 8 characters, letters and digits, and not
 * simply the username. Returns a human readable problem, or null when the password is acceptable.
 */
export function passwordProblem(password: string, username = ''): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > 200) return 'Password is too long';
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain both letters and digits';
  if (username && password.toLowerCase() === username.toLowerCase()) return 'Password must not be the same as the username';
  return null;
}

const FRIENDLY = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** a password that is easy to read out or type (no 0/O, 1/l/I) and always satisfies passwordProblem: letters + digits */
export function generateFriendlyPassword(length = 12): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < length; i++) out += FRIENDLY[randomInt(FRIENDLY.length)];
    if (passwordProblem(out) === null) return out;
  }
}
