import { App, Modal, Setting } from "obsidian";

/** Single text-input dialog (rename slug, etc.). */
export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private label: string,
		initial: string,
		private onSubmit: (v: string) => void,
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.label });
		new Setting(contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v.trim()));
			t.inputEl.focus();
			t.inputEl.select();
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
		});
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("ok").setCta().onClick(() => this.submit()),
		);
	}

	private submit(): void {
		this.close();
		this.onSubmit(this.value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Dropdown-choice dialog (target wiki, status value). */
export class ChoiceModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private label: string,
		private options: string[],
		private onSubmit: (v: string) => void,
	) {
		super(app);
		this.value = options[0] ?? "";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.label });
		new Setting(contentEl).addDropdown((dd) => {
			for (const o of this.options) dd.addOption(o, o);
			dd.setValue(this.value);
			dd.onChange((v) => (this.value = v));
		});
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("ok").setCta().onClick(() => this.submit()),
		);
	}

	private submit(): void {
		this.close();
		this.onSubmit(this.value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Yes/no confirmation (archive, delete). */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.heading });
		// Body is often a dry-run plan — pre-wrap so line breaks survive.
		const body = contentEl.createEl("div", { cls: "paniolo-confirm-body" });
		body.setText(this.body);
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("cancel").onClick(() => this.close()),
			)
			.addButton((b) =>
				b
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Scrollable text report (refs listing, delete hold-back report). */
export class ReportModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private text: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.heading });
		const pre = contentEl.createEl("pre", { cls: "paniolo-report" });
		pre.setText(this.text);
		new Setting(contentEl).addButton((b) =>
			b.setButtonText("close").onClick(() => this.close()),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
