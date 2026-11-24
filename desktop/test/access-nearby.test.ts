// Being found on the local network (electron/access/nearby.ts): what the announcement says, that the
// library is made only while something is announced, and which `pine:` addresses the app takes.
// A stand-in for the library: no multicast leaves the test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnnouncer, flushed, isPairAddress, type Mdns, type MdnsService, NEARBY_PORT, NEARBY_TYPE, txtOf } from "../electron/access/nearby.ts";

const ID = "A".repeat(43);
const SERVICE = "https://pine.example.workers.dev";
const NONCE = "n".repeat(22);

/** A stand-in for bonjour-service: what was published, withdrawn (with a goodbye) and destroyed, in order. */
function fakeLibrary() {
	const made: Array<{ published: any[]; services: MdnsService[]; destroyed: boolean }> = [];
	const log: string[] = [];
	const make = (): Mdns => {
		const one = { published: [] as any[], services: [] as MdnsService[], destroyed: false };
		made.push(one);
		return {
			publish: (config) => {
				one.published.push(config);
				log.push(`publish ${config.txt.nonce}`);
				const service: MdnsService = {
					records: () => [
						{ name: "_pine._tcp.local", type: "PTR", ttl: 28800, data: `${config.name}._pine._tcp.local` },
						{ name: `${config.name}._pine._tcp.local`, type: "SRV", ttl: 120, data: { port: config.port, target: "mac.local" } },
						{ name: `${config.name}._pine._tcp.local`, type: "TXT", ttl: 4500, data: config.txt },
					],
					stop: (done) => {
						log.push(`goodbye ${config.txt.nonce}`);
						setImmediate(() => done?.());
					},
				};
				one.services.push(service);
				return service;
			},
			destroy: () => {
				one.destroyed = true;
				log.push("destroy");
			},
		};
	};
	return { made, make, log };
}

const settled = () => new Promise((r) => setTimeout(r, 20));

test("nearby: the record says the version, the machine id, the service and the nonce, under _pine._tcp, and no name of the computer's", async () => {
	const lib = fakeLibrary();
	const announcer = createAnnouncer(lib.make);
	announcer.announce({ id: ID, service: SERVICE, nonce: NONCE });
	await settled();
	assert.equal(lib.made.length, 1);
	const [config] = lib.made[0].published;
	assert.equal(config.type, NEARBY_TYPE);
	assert.equal(config.protocol, "tcp");
	assert.equal(config.port, NEARBY_PORT);
	assert.equal(config.name, "Pine AAAAAAAA");
	assert.deepEqual(config.txt, { v: "1", id: ID, service: SERVICE, nonce: NONCE });
	assert.deepEqual(txtOf({ id: ID, service: SERVICE, nonce: NONCE }), config.txt);
});

test("nearby: a new nonce withdraws the record before with a goodbye, then publishes, with the cache-flush bit on the computer's own records", async () => {
	const lib = fakeLibrary();
	const announcer = createAnnouncer(lib.make);
	announcer.announce({ id: ID, service: SERVICE, nonce: "a".repeat(22) });
	announcer.announce({ id: ID, service: SERVICE, nonce: "b".repeat(22) });
	announcer.announce({ id: ID, service: SERVICE, nonce: "c".repeat(22) });
	await settled();
	assert.deepEqual(lib.log, [`publish ${"a".repeat(22)}`, `goodbye ${"a".repeat(22)}`, `publish ${"b".repeat(22)}`, `goodbye ${"b".repeat(22)}`, `publish ${"c".repeat(22)}`], "only one TXT record is served at a time");
	assert.equal(lib.made.length, 1, "one library, one socket");
	const records = lib.made[0].services.at(-1)!.records();
	assert.deepEqual(records.map((r) => [r.type, r.flush === true]), [["PTR", false], ["SRV", true], ["TXT", true]]);
	assert.deepEqual(flushed([{ name: "x", type: "PTR", ttl: 1, data: "y" }]), [{ name: "x", type: "PTR", ttl: 1, data: "y" }]);
});

test("nearby: nothing is made before an announcement; a stop says goodbye, then destroys the library (its socket)", async () => {
	const lib = fakeLibrary();
	const announcer = createAnnouncer(lib.make);
	announcer.announce(undefined);
	await settled();
	assert.equal(lib.made.length, 0);
	announcer.announce({ id: ID, service: SERVICE, nonce: NONCE });
	announcer.announce(undefined);
	await settled();
	assert.deepEqual(lib.log, [`publish ${NONCE}`, `goodbye ${NONCE}`, "destroy"]);
	announcer.announce({ id: ID, service: "https://other.example", nonce: NONCE });
	announcer.stop();
	await settled();
	assert.equal(lib.made.length, 2);
	assert.equal(lib.made[1].destroyed, true);
	assert.deepEqual(lib.log.slice(-2), [`goodbye ${NONCE}`, "destroy"]);
});

test("nearby: only pine://pair opens a pairing; the mobile app's links and anything else under pine: do not", () => {
	for (const ok of ["pine://pair", "pine://pair/", "PINE://pair", " pine://pair "]) assert.equal(isPairAddress(ok), true, ok);
	for (const no of ["pine://pair?service=https%3A%2F%2Fx&id=a&code=b", "pine://pair#x", "pine://pairs", "pine://other", "https://pine/pair", "pine:pair", ""]) assert.equal(isPairAddress(no), false, no);
});
