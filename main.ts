import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon(
			"refresh-cw",
			"Syncing",
			(evt: MouseEvent) => {
				new Notice("This is a notice!");
			}
		);

		ribbonIconEl.addClass("spin");

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("create", (file) => console.log(file))
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Refresh Token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing."
			)
			.addButton((button) =>
				button.setButtonText("Get Refresh Token").onClick(() => {
					window.open("https://obsidian.richardxiong.com");
				})
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
