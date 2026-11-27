import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A local HTTP server whose behaviour each test controls. */
export interface Fixture {
  url: string;
  port: number;
  status: number;
  body: string;
  delayMs: number;
  redirectTo?: string;
  hits: number;
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const fixture = { status: 200, body: 'ok WatchersNex fixture', delayMs: 0, hits: 0 } as Fixture;
  const server = http.createServer((req, res) => {
    fixture.hits += 1;
    setTimeout(() => {
      if (fixture.redirectTo && req.url === '/') {
        res.writeHead(302, { Location: fixture.redirectTo });
        res.end();
        return;
      }
      res.writeHead(fixture.status, { 'Content-Type': 'text/plain' });
      res.end(fixture.body);
    }, fixture.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fixture.port = port;
  fixture.url = `http://127.0.0.1:${port}/`;
  fixture.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fixture;
}

/** Allows exactly 127.0.0.1 (the fixture) and blocks every other private address. */
export const LOOPBACK_FIXTURE_ONLY = {
  isBlocked: (address: string) => address !== '127.0.0.1' && address !== '::ffff:127.0.0.1',
};
