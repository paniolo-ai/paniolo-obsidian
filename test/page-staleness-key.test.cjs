const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { pageKeyForPath } = loadTs("page-staleness-key.ts");
const wiki = { name: "paniolo-wiki", repoPath: "repos/paniolo-wiki", wikiRoot: "repos/paniolo-wiki/wiki" };

test("Windows and WSL page paths resolve to the same canonical repo key", () => {
	assert.deepEqual(pageKeyForPath("C:\\meta\\paniolo", "C:\\meta\\paniolo\\repos\\paniolo-wiki\\wiki\\page.md", [wiki]), {
		target: "paniolo-wiki:wiki/page.md",
	});
	assert.deepEqual(pageKeyForPath("/home/me/paniolo", "/home/me/paniolo/repos/paniolo-wiki/wiki/page.md", [wiki]), {
		target: "paniolo-wiki:wiki/page.md",
	});
});

test("loose notes, raw snapshots, and ambiguous wiki roots cannot claim a page key", () => {
	const root = "/home/me/paniolo";
	assert.match(pageKeyForPath(root, `${root}/notes/page.md`, [wiki]).reason, /outside/);
	assert.match(pageKeyForPath(root, `${root}/repos/paniolo-wiki/raw/page.md`, [wiki]).reason, /outside/);
	assert.match(pageKeyForPath(root, `${root}/repos/paniolo-wiki/wiki/page.md`, [wiki, { ...wiki, name: "alias" }]).reason, /multiple/);
});
