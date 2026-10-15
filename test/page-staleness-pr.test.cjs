const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

const { preparePagePr, publishPagePr } = loadTs("page-staleness-pr.ts", { "./paniolo": { runPaniolo: () => {} } });
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("a default-branch page joins a new topic PR only after saved bytes and focused checks", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "paniolo-obsidian-pr-"));
	const repo = path.join(root, "repo");
	const remote = path.join(root, "remote.git");
	const page = path.join(repo, "wiki", "a.md");
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	try {
		fs.mkdirSync(path.dirname(page), { recursive: true });
		fs.writeFileSync(page, "# API\nold\n");
		execFileSync("git", ["init", "--bare", remote]);
		execFileSync("git", ["init", "-b", "main", repo]);
		git("config", "user.name", "Paniolo Test");
		git("config", "user.email", "test@example.invalid");
		git("add", "--", "wiki/a.md");
		git("commit", "-m", "seed");
		git("remote", "add", "origin", remote);
		git("push", "-u", "origin", "main");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		let pr = [];
		let blockScan = false;
		const calls = [];
		const run = async (binary, args, cwd) => {
			calls.push([binary, args]);
			if (binary === "gh") {
				if (args[1] === "list") return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
				if (args[1] === "create") return { code: 0, stdout: "https://example.test/pr/1\n", stderr: "" };
			}
			if (binary === "paniolo") return { code: blockScan && args[0] === "scan" ? 1 : 0, stdout: "{}", stderr: "" };
			const result = spawnSync(binary, args, { cwd, encoding: "utf8" });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		};
		const wikis = [{ name: "wiki", repoPath: "repo", wikiRoot: "repo/wiki" }];
		const route = await preparePagePr(root, "wiki:wiki/a.md", page, digest("# API\nold\n"), "R1", wikis, run);
		assert.match(route.branch, /^codex\/stale-page-R1-/);
		assert.equal(git("branch", "--show-current"), route.branch);
		assert.equal(git("show", "main:wiki/a.md"), "# API\nold");
		fs.writeFileSync(page, "# API\nnew\n");
		const seedHead = git("rev-parse", "HEAD");
		blockScan = true;
		await assert.rejects(publishPagePr(route, digest("# API\nnew\n"), "A1", root, "paniolo", () => digest("# API\nnew\n"), run), /page scan failed/);
		assert.equal(git("rev-parse", "HEAD"), seedHead, "failed scan must not commit");
		blockScan = false;
		const url = await publishPagePr(route, digest("# API\nnew\n"), "A1", root, "paniolo", () => digest("# API\nnew\n"), run);
		assert.equal(url, "https://example.test/pr/1");
		assert.equal(git("show", "HEAD:wiki/a.md"), "# API\nnew");
		assert.equal(git("status", "--porcelain"), "");
		assert.ok(calls.some(([binary, args]) => binary === "paniolo" && args[0] === "scan"));
		assert.ok(calls.some(([binary, args]) => binary === "paniolo" && args[0] === "wiki"));
		assert.ok(calls.some(([binary, args]) => binary === "gh" && args[1] === "create"));
		const same = await preparePagePr(root, "wiki:wiki/a.md", page, digest("# API\nnew\n"), "R2", wikis, run);
		assert.equal(same.branch, route.branch);
		pr = [{ url, state: "OPEN", headRefName: route.branch, isCrossRepository: false }];
		fs.writeFileSync(page, "# API\nnewer\n");
		const joined = await publishPagePr(same, digest("# API\nnewer\n"), "A2", root, "paniolo", () => digest("# API\nnewer\n"), run);
		assert.equal(joined, url);
		assert.equal(calls.filter(([binary, args]) => binary === "gh" && args[1] === "create").length, 1);
		fs.writeFileSync(page, "# API\ndirty\n");
		await assert.rejects(preparePagePr(root, "wiki:wiki/a.md", page, digest("# API\ndirty\n"), "R3", wikis, run), /existing page changes/);
	} finally {
		assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
		fs.rmSync(root, { recursive: true, force: true });
	}
});
