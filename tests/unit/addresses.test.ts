import { describe, expect, it } from 'vitest';
import { addressVerdict } from '@xbam/upstream';

/**
 * Telling the internet apart from this machine.
 *
 * The whole of server-side request forgery is this one question. An agent that
 * fetches an address somebody else chose can reach whatever the machine running
 * it can reach: the database on the Docker network, the cloud metadata service
 * holding credentials, an admin page on loopback that trusts anything arriving
 * locally. None of those are reachable from outside and all of them are
 * reachable from here.
 *
 * So the tests that matter are the ones for things that look public and are not.
 * Anybody can write `expect(refused('127.0.0.1'))`; the ways past a check like
 * this are octal octets, IPv4 addresses wearing an IPv6 hat, and ranges nobody
 * remembers are private.
 */

const allowed = (address: string) => addressVerdict(address).allowed;
const why = (address: string) => addressVerdict(address).why;

describe('addresses on the public internet', () => {
  it('allows ordinary ones', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '203.0.114.5', '172.32.0.1', '192.167.1.1']) {
      expect(allowed(address), address).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111', '[2606:4700::1]']) {
      expect(allowed(address), address).toBe(true);
    }
  });
});

describe('addresses that are this machine or its network', () => {
  it('refuses loopback, private ranges and the unspecified address', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.1',
      '198.18.0.1',
    ]) {
      expect(allowed(address), address).toBe(false);
      expect(why(address), address).not.toBe('');
    }
  });

  it('refuses the link-local range, which is where cloud metadata lives', () => {
    // 169.254.169.254 on AWS, Azure and GCP. The range matters more than the
    // address: metadata has moved before and will again.
    expect(allowed('169.254.169.254')).toBe(false);
    expect(why('169.254.169.254')).toMatch(/metadata/i);
    expect(allowed('169.254.0.1')).toBe(false);
  });

  it('refuses carrier-grade NAT, where another cloud keeps its metadata', () => {
    expect(allowed('100.100.100.200')).toBe(false);
    expect(allowed('100.64.0.1')).toBe(false);
    // The edges of the range: .63 and .128 are ordinary public space.
    expect(allowed('100.63.255.255')).toBe(true);
    expect(allowed('100.128.0.1')).toBe(true);
  });

  it('refuses documentation and other non-global ranges', () => {
    // The comment says "public internet", so the implementation has to mean
    // globally routable rather than merely "not RFC1918". These all look like
    // ordinary addresses and none of them is a destination.
    for (const address of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1', '2001:db8::1', '100::1']) {
      expect(allowed(address), address).toBe(false);
    }
    // And the neighbours of those ranges are still perfectly public.
    expect(allowed('203.0.114.5')).toBe(true);
    expect(allowed('198.51.101.1')).toBe(true);
    expect(allowed('192.0.3.1')).toBe(true);
  });

  it('sees the IPv4 destination inside a NAT64 address', () => {
    // 64:ff9b::/96 carries an IPv4 address inside it, so one there is an IPv4
    // destination wearing a third hat.
    expect(allowed('64:ff9b::7f00:1')).toBe(false); // 127.0.0.1
    expect(allowed('64:ff9b::5db8:d822')).toBe(true); // 93.184.216.34
  });

  it('refuses multicast and reserved space', () => {
    for (const address of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
      expect(allowed(address), address).toBe(false);
    }
  });

  it('refuses IPv6 loopback, private and link-local', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1']) {
      expect(allowed(address), address).toBe(false);
    }
  });

  it('says which one it refused, and not a different one', () => {
    // ::1 and :: are both twelve zero bytes followed by something, which is
    // also what an IPv4-compatible address looks like -- so a check in the
    // wrong order refuses ::1 with the words "0.0.0.0/8 is this network". Still
    // a refusal, still wrong, and the reason is the half a person can act on.
    expect(why('::1')).toMatch(/this machine/i);
    expect(why('::')).toMatch(/unspecified/i);
  });
});

describe('the ways past a check like this', () => {
  it('refuses an octal octet, which some resolvers read as loopback', () => {
    // "0177.0.0.1" is 127.0.0.1 to anything that parses octal, and looks like a
    // large public address to anything that does not. Refused as unparseable
    // rather than guessed at either way.
    expect(allowed('0177.0.0.1')).toBe(false);
    expect(allowed('010.0.0.1')).toBe(false);
    expect(allowed('0x7f.0.0.1')).toBe(false);
  });

  it('refuses an address with too few or too many parts', () => {
    // "127.1" is loopback to inet_aton. Not a four-part address, so not allowed.
    for (const address of ['127.1', '2130706433', '1.2.3.4.5', '1.2.3']) {
      expect(allowed(address), address).toBe(false);
    }
  });

  it('refuses an octet above 255', () => {
    expect(allowed('999.1.1.1')).toBe(false);
    expect(allowed('1.1.1.256')).toBe(false);
  });

  it('sees through an IPv4 address wearing an IPv6 hat', () => {
    // The one that catches people. A check that only knows the v6 ranges waves
    // ::ffff:127.0.0.1 straight through to loopback.
    expect(allowed('::ffff:127.0.0.1')).toBe(false);
    expect(why('::ffff:127.0.0.1')).toMatch(/this machine/i);
    expect(allowed('::ffff:169.254.169.254')).toBe(false);
    expect(allowed('::ffff:10.0.0.1')).toBe(false);
    // And still allows a mapped public address, rather than refusing the form.
    expect(allowed('::ffff:8.8.8.8')).toBe(true);
  });

  it('ignores a zone index, which only a local address has', () => {
    expect(allowed('fe80::1%eth0')).toBe(false);
  });

  it('refuses anything it cannot parse, rather than assuming it is fine', () => {
    // The direction this has to fail in. An address a future standard adds is
    // refused until somebody teaches this about it.
    for (const address of ['', '   ', 'not-an-address', 'gggg::1', '::fffff:1', '1:2:3:4:5:6:7:8:9']) {
      expect(allowed(address), JSON.stringify(address)).toBe(false);
    }
  });

  it('gives a reason for every refusal, because a silent no is unactionable', () => {
    for (const address of ['127.0.0.1', '169.254.169.254', 'nonsense', '::1']) {
      expect(why(address), address).not.toBe('');
    }
  });
});
