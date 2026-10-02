import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const prod = process.argv[2] === "production";

// Dev loop target: the vault's plugins dir. Override with PANIOLO_VAULT_PLUGINS.
const vaultPlugins =
	process.env.PANIOLO_VAULT_PLUGINS ?? "C:/Users/bkins/gh/meta/.obsidian/plugins";
const pluginDir = join(vaultPlugins, "paniolo-obsidian");

const external = [
	"obsidian",
	"electron",
	"@codemirror/autocomplete",
	"@codemirror/collab",
	"@codemirror/commands",
	"@codemirror/language",
	"@codemirror/lint",
	"@codemirror/search",
	"@codemirror/state",
	"@codemirror/view",
	"@lezer/common",
	"@lezer/highlight",
	"@lezer/lr",
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
];

const copyToVault = {
	name: "copy-to-vault",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(pluginDir, { recursive: true });
			for (const f of ["main.js", "manifest.json", "styles.css"]) {
				try {
					copyFileSync(f, join(pluginDir, f));
				} catch {
					// optional until the file exists
				}
			}
			console.log(`copied → ${pluginDir}`);
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external,
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	plugins: prod ? [] : [copyToVault],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
