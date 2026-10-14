import { describe, expect, it } from 'vitest';
import { parseDotEnv } from '../src/common/dotenv';

describe('.env parsing for the API', () => {
  it('reads KEY=VALUE, ignores comments and blanks, strips quotes, keeps = inside values', () => {
    const env = parseDotEnv('# comment\n\nNUTEX_BACKEND=google\nGOOGLE_SERVICE_ACCOUNT_KEY_FILE="C:\\secrets\\sa.json"\nSESSION_SECRET=abc=def==\nEMPTY=\r\nQUOTED=\'x y\'\n');
    expect(env).toEqual({ NUTEX_BACKEND: 'google', GOOGLE_SERVICE_ACCOUNT_KEY_FILE: 'C:\\secrets\\sa.json', SESSION_SECRET: 'abc=def==', EMPTY: '', QUOTED: 'x y' });
  });
});
