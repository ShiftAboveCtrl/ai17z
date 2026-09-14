import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing AI17Z publishes reaches the network unless somebody says so.
 *
 * AI17Z holds the keys to every provider configured, a database of everything
 * its agents know, and a browser profile signed in to somebody's accounts. None
 * of that belongs on a network interface by default, and the documentation has
 * said so the whole time: "AI17Z binds to loopback and stays there. The
 * interface, the API and the database are published on 127.0.0.1 only."
 *
 * It was not true. `"${AI17Z_WEB_PORT:-8080}:80"` carries no bind address, and
 * a published port without one is published on 0.0.0.0 -- so the interface, the
 * API and Postgres were on every interface of the machine, which on a server is
 * the open internet. `docker compose config` said `host_ip` was absent and
 * nothing looked.
 *
 * Found by generating the real configuration and reading it, which is the only
 * way to see this: the compose file reads as though it names a port, and the
 * default is what Docker does with a name that has no address in front of it.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const compose = read('docker-compose.yml');
const template = read('.env.example');
const doctorSh = read('doctor-ai17z.sh');

/** Every `ports:` entry, as written. */
const published = [...compose.matchAll(/^\s*- "([^"]+)"\s*$/gm)]
  .map((m) => m[1]!)
  .filter((entry) => /:\d+("|$)|:\$\{/.test(entry) && entry.includes(':'));

describe('what AI17Z publishes, and where', () => {
  it('publishes something at all, so this is not passing on an empty list', () => {
    expect(published.length).toBeGreaterThanOrEqual(3);
  });

  it('gives every published port a bind address', () => {
    // Three colon-separated parts: address, host port, container port. Two
    // parts is host:container, which Docker publishes on 0.0.0.0.
    //
    // The expansions are collapsed first, because `${AI17Z_WEB_PORT:-8080}`
    // contains a colon of its own -- so counting them raw finds three parts in
    // a two-part entry and this passes for a file that publishes on every
    // interface. Found by mutating the file and watching this test not care.
    for (const entry of published) {
      const parts = entry.replace(/\$\{[^}]*\}/g, 'X').split(':');
      expect(parts.length, `published without an address: ${entry}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('defaults every one of them to loopback', () => {
    for (const entry of published) {
      expect(entry, `not loopback by default: ${entry}`).toMatch(/\$\{AI17Z_BIND_HOST:-127\.0\.0\.1\}/);
    }
  });

  it('covers the interface, the API and the database', () => {
    // Named, because "every port in the file" is only reassuring if the file
    // still has the three that matter in it.
    const joined = published.join('\n');
    expect(joined).toMatch(/:80"?$|:80$/m); // the interface
    expect(joined).toMatch(/:8787/); // the API
    expect(joined).toMatch(/:5432/); // the database
  });

  it('says in the template what changing it means', () => {
    expect(template).toContain('AI17Z_BIND_HOST=127.0.0.1');
    // Not just the name: what it costs.
    expect(template).toMatch(/ssh -L/);
    expect(template).toMatch(/keys to every provider|signed in/i);
  });

  it('reports a non-loopback bind every time doctor runs', () => {
    // The other half of the documented promise: "if you configure a
    // non-loopback bind, ai17z doctor warns about it" -- which was also not
    // implemented.
    expect(doctorSh).toContain('AI17Z_BIND_HOST');
    expect(doctorSh).toContain('Reachable from');
    // A person has to be able to act on it, so it is NEEDS ACTION with a
    // sentence, not a PASS with a footnote.
    const section = doctorSh.slice(doctorSh.indexOf('Where those services can be reached'));
    expect(section.slice(0, 1200)).toContain('NEEDS ACTION');
  });

  it('still lets somebody choose otherwise, deliberately', () => {
    // A default is not a prohibition. Somebody running this behind their own
    // firewall gets to say so -- once, in their own .env, where they can see it.
    expect(compose).toContain('${AI17Z_BIND_HOST:-127.0.0.1}');
  });
});
