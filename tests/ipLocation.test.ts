import assert from "node:assert/strict";
import test from "node:test";
import { clientIpForRequest, locationForRequest, mergeIpLocations, normalizeIp } from "../src/ipLocation.js";
import { recordAssoc, associationsFor } from "../src/safety.js";
import { deleteUser, noteUser, userForIdentity } from "../src/users.js";
import { storeDelete } from "../src/store.js";

test("Cloudflare client headers replace the proxy IP and expose approximate location fields", () => {
  const req = {
    ip: "172.16.0.10",
    socket: { remoteAddress: "172.16.0.11" },
    headers: {
      "cf-ray": "abc123-IAD",
      "cf-connecting-ip": "203.0.113.42",
      "cf-ipcity": "New%20York",
      "cf-region": "New York",
      "cf-region-code": "ny",
      "cf-ipcountry": "us",
      "cf-ipcontinent": "na",
      "cf-postal-code": "10001",
      "cf-timezone": "America/New_York",
      "cf-iplatitude": "40.7128",
      "cf-iplongitude": "-74.0060"
    }
  };

  assert.equal(clientIpForRequest(req), "203.0.113.42");
  const location = locationForRequest(req);
  assert.ok(location);
  const { updatedAt, ...locationWithoutTimestamp } = location;
  assert.deepEqual(locationWithoutTimestamp, {
    ip: "203.0.113.42",
    source: "cloudflare",
    city: "New York",
    region: "New York",
    regionCode: "NY",
    countryCode: "US",
    continent: "NA",
    postalCode: "10001",
    timezone: "America/New_York",
    latitude: 40.71,
    longitude: -74.01
  });
  assert.equal(typeof updatedAt, "number");
});

test("invalid Cloudflare headers fall back to the existing normalized proxy address", () => {
  const req = {
    ip: "::ffff:198.51.100.9",
    socket: { remoteAddress: "198.51.100.10" },
    headers: { "cf-connecting-ip": "not-an-ip" }
  };
  assert.equal(clientIpForRequest(req), "198.51.100.9");
  assert.equal(locationForRequest({ headers: {} }), null);
  assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
});

test("location merges are bounded and keep the newest fields for each IP", () => {
  const merged = mergeIpLocations([
    { ip: "203.0.113.1", source: "cloudflare", city: "Old City", updatedAt: 10 },
    { ip: "203.0.113.1", source: "cloudflare", city: "New City", countryCode: "US", updatedAt: 20 }
  ]);
  assert.deepEqual(merged, [{ ip: "203.0.113.1", source: "cloudflare", city: "New City", countryCode: "US", updatedAt: 20 }]);
});

test("user and safety association records retain the approximate IP location", async () => {
  const identity = `ip-location-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ip = "198.51.100.44";
  const location = { ip, source: "cloudflare" as const, city: "Boston", countryCode: "US", updatedAt: Date.now() };
  try {
    await noteUser(identity, ip, "Test User-Agent", location);
    await recordAssoc(identity, undefined, ip, location);
    assert.equal((await userForIdentity(identity)).ipLocations?.[0]?.city, "Boston");
    assert.equal((await associationsFor(identity)).ipLocations?.[0]?.countryCode, "US");
  } finally {
    await deleteUser(identity);
    await storeDelete(`safety:assoc:${identity}`);
  }
});
