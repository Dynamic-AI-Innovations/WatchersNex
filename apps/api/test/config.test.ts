import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

describe('configuration', () => {
  it('applies safe defaults to a minimal valid environment', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config).toMatchObject({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('refuses to start without a database URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('names an invalid variable without echoing its value', () => {
    let message = '';
    try {
      loadConfig({ DATABASE_URL: 'mysql://user:hunter2@host/db' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('hunter2');
  });
});
