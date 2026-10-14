const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { countFromCli, countFromQmdHit, countLabel } = loadTs("staleness-count.ts");

test("qmd counts preserve zero, positive, snapshot, and unavailable provenance", () => {
	const zero = countFromQmdHit({ unresolvedStalenessCount: 0, stalenessGeneration: 3, stalenessSource: "active-writer" });
	const positive = countFromQmdHit({ unresolvedStalenessCount: 4, stalenessGeneration: 4, stalenessSource: "active-writer" });
	const snapshot = countFromQmdHit({ unresolvedStalenessCount: 2, stalenessGeneration: 2, stalenessSource: "snapshot" });
	const unavailable = countFromQmdHit({ unresolvedStalenessCount: null, stalenessGeneration: null, stalenessSource: "unavailable" });
	assert.equal(countLabel(zero), "0 open entries");
	assert.equal(countLabel(positive), "4 open entries");
	assert.equal(countLabel(snapshot), "2 open entries (snapshot)");
	assert.equal(countLabel(unavailable), "Open entries unavailable");
	assert.equal(countFromQmdHit({}).count, null);
	assert.equal(countFromQmdHit({ unresolvedStalenessCount: 0 }).count, null);
});

test("targeted count refuses another page and never converts unavailable to zero", () => {
	const target = "wiki:wiki/page.md";
	assert.deepEqual(countFromCli(JSON.stringify({ target, status: "available", source: "active-writer", count: 3, generation: 8 }), target), {
		count: 3, generation: 8, source: "active-writer",
	});
	assert.equal(countFromCli(JSON.stringify({ target, status: "unavailable", count: null }), target).count, null);
	assert.throws(() => countFromCli(JSON.stringify({ target: "wiki:wiki/other.md", status: "available", source: "active-writer", count: 0 }), target));
	assert.throws(() => countFromCli(JSON.stringify({ target, status: "available", source: "active-writer", count: Number.MAX_SAFE_INTEGER + 1 }), target));
});
