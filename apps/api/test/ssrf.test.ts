import { describe, expect, it } from 'vitest';
import { isBlockedAddress, parseTargetUrl, resolveTarget, TargetRejected } from '../src/monitoring/ssrf.js';

describe('SSRF guard: address ranges', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '240.0.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', // IPv4-mapped
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1',
    'not-an-ip', '',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001::200e', '172.32.0.1', '11.0.0.1'])(
    'allows public %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('SSRF guard: URLs', () => {
  it.each([
    ['ftp://example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['https://user:pass@example.com/', 'credentials'],
    ['http://example.com:22/', 'port'],
    ['http://example.com:25/', 'port'],
    ['not a url', 'host'],
  ])('rejects %s (%s)', (url, reason) => {
    expect(() => parseTargetUrl(url)).toThrow(TargetRejected);
    try {
      parseTargetUrl(url);
    } catch (error) {
      expect((error as TargetRejected).reason).toBe(reason);
    }
  });

  it('accepts standard and high ports', () => {
    expect(parseTargetUrl('https://example.com/health').hostname).toBe('example.com');
    expect(parseTargetUrl('http://example.com:8080/').port).toBe('8080');
  });

  it.each(['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/'])(
    'normalises and blocks the encoded loopback or metadata address %s',
    async (raw) => {
      const url = parseTargetUrl(raw);
      await expect(resolveTarget(url.hostname)).rejects.toMatchObject({ reason: 'blocked' });
    },
  );

  it('blocks a host name that resolves to loopback', async () => {
    await expect(resolveTarget('localhost')).rejects.toMatchObject({ reason: 'blocked' });
  });

  it('reports an unresolvable host as a DNS problem', async () => {
    await expect(resolveTarget('does-not-exist.invalid')).rejects.toMatchObject({ reason: 'dns' });
  });
});
