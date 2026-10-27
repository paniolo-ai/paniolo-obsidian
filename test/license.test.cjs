const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./load-ts.cjs");

test("signed token travels through stdin, never argv or output", async () => {
	const { runPaniolo } = loadTs("paniolo.ts");
	const token = "private-signed-token";
	const result = await runPaniolo(process.execPath, ["-e", "process.stdin.on('data', data => process.stdout.write(data.length.toString()))"], process.cwd(), 10_000, token);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, String(token.length));
	assert.equal(result.stderr, "");
});

test("license adapter passes only nonsecret status to the plugin", async () => {
	const calls = [];
	const { importLicenseToken, readLicenseStatus, licenseDescription } = loadTs("license.ts", {
		"./paniolo": {
			resolveBinary: () => "paniolo",
			runPaniolo: async (...args) => {
				calls.push(args);
				return args[1][1] === "import"
					? { code: 0, stdout: "Signed entitlement: current.", stderr: "" }
					: { code: 0, stdout: '{"state":"current","product":"wiki","features":["wiki.fix.bulk"]}', stderr: "" };
			},
		},
	});
	await importLicenseToken("", process.cwd(), "private-signed-token");
	const report = await readLicenseStatus("", process.cwd());
	assert.deepEqual(calls[0][1], ["license", "import"]);
	assert.equal(calls[0][4], "private-signed-token");
	assert.equal(calls[1][4], undefined);
	assert.equal(licenseDescription(report), "Wiki Pro active.");
	assert.equal(licenseDescription({ state: "expired" }), "Entitlement expired. Free features remain available.");
});

test("settings clears the pasted token before the CLI call and never saves it", async () => {
	class FileSystemAdapter { getBasePath() { return process.cwd(); } }
	class PluginSettingTab {
		constructor(app) { this.app = app; this.containerEl = { empty() {} }; }
	}
	class Setting {
		static items = [];
		constructor() { Setting.items.push(this); }
		setName(name) { this.name = name; return this; }
		setDesc(description) { this.description = description; return this; }
		addText(configure) {
			this.input = { value: "", type: "text" };
			configure({
				inputEl: this.input,
				setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }),
			});
			return this;
		}
		addButton(configure) {
			this.button = { setButtonText: () => this.button, onClick: (click) => { this.button.click = click; return this.button; } };
			configure(this.button);
			return this;
		}
	}
	let saved = false;
	let passed = "";
	const { PanioloSettingTab } = loadTs("settings.ts", {
		obsidian: { FileSystemAdapter, PluginSettingTab, Setting },
		"./non-git-vault": { readVaultWriterState: async () => "unregistered" },
		"./license": {
			readLicenseStatus: async () => ({ state: "none" }),
			licenseDescription: () => "Free features remain available.",
			importLicenseToken: async (_binary, _cwd, token) => { passed = token; },
		},
	});
	const plugin = { settings: { binaryPath: "" }, saveSettings: async () => { saved = true; } };
	new PanioloSettingTab({ vault: { adapter: new FileSystemAdapter() } }, plugin).display();
	const license = Setting.items.find((item) => item.name === "Wiki Pro entitlement");
	license.input.value = "private-signed-token";
	license.button.click();
	assert.equal(license.input.value, "");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(passed, "private-signed-token");
	assert.equal(saved, false);
	assert.equal(license.description.includes("private-signed-token"), false);
});
