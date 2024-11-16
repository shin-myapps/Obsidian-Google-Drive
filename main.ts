import { checkConnection, folderMimeType, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive Sync through our website or our readme/this plugin's settings. If you haven't already, PLEASE read through this plugin's readme or website CAREFULLY for instructions on how to use this plugin. If you don't know what you're doing, your data could get DELETED.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Push to Google Drive",
			() => push(this)
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection().then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				this.settings.lastSyncedAt = Date.now();
				const changesToken = await this.drive.getChangesStartToken();
				if (!changesToken) {
					return new Notice(
						"An error occurred fetching Google Drive changes token."
					);
				}
				this.settings.changesToken = changesToken;
				await this.saveSettings();
				this.ribbonIcon.removeClass("spin");
				this.syncing = false;
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async startSync() {
		if (!(await checkConnection())) {
			throw new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice: Notice) {
		this.settings.lastSyncedAt = Date.now();
		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice.hide();
	}
}

class DriveMismatchModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(app: App, proceed: (res: boolean) => void) {
		super(app);
		this.setTitle("Warning!");
		this.contentEl
			.createEl("p")
			.setText(
				"Your local vault does not currently match your Google Drive vault. We HIGHLY suggest cloning your Google Drive vault to the current vault BEFORE syncing as not doing so could lead to an extremely long initial sync time. Please check the readme or website for instructions on how to do this. However, you can still proceed if you wish for our plugin to handle the initial sync."
			);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel (recommended)")
					.setCta()
					.onClick(() => this.close())
			)
			.addButton((btn) =>
				btn.setButtonText("Proceed (not recommended)").onClick(() => {
					proceed(true);
					this.close();
				})
			);
	}

	onClose() {
		this.proceed(false);
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

		containerEl.createEl("a", {
			href: "https://ogd.richardxiong.com",
			text: "Get refresh token",
		});

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing. We suggest cloning your Google Drive vault to the current vault BEFORE syncing."
			)
			.addText((text) => {
				const cancel = () => {
					this.plugin.settings.refreshToken = "";
					text.setValue("");
					return this.plugin.saveSettings();
				};

				text.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						if (!value) {
							return this.plugin.debouncedSaveSettings();
						}
						if (!(await refreshAccessToken(this.plugin))) {
							text.setValue("");
							return;
						}

						const driveFiles = await this.plugin.drive.searchFiles({
							include: ["id", "properties", "mimeType"],
						});
						if (!driveFiles) {
							new Notice(
								"An error occurred fetching Google Drive files."
							);
							return cancel();
						}
						const drivePathSet = new Set(
							driveFiles.map(({ properties }) => properties.path)
						);

						const vaultFiles = this.app.vault
							.getAllLoadedFiles()
							.filter(({ path }) => path !== "/");
						const vaultPathSet = new Set(
							vaultFiles.map((file) => file.path)
						);

						const driveMismatch =
							driveFiles.find(
								({ properties, mimeType }) =>
									!vaultPathSet.has(properties.path) &&
									mimeType !== folderMimeType
							) ||
							vaultFiles.find(
								(file) => !drivePathSet.has(file.path)
							);

						if (driveMismatch) {
							const proceed = await new Promise((res) =>
								new DriveMismatchModal(this.app, res).open()
							);
							if (!proceed) return cancel();

							if (vaultFiles.length > 0) {
								new Notice(
									"Your current vault is not empty! If you want our plugin to handle the initial sync, you have to clear out the current vault. Check the readme or website for more details.",
									0
								);
								return cancel();
							}
						} else {
							const foldersInDriveNotInVault = driveFiles.filter(
								({ properties, mimeType }) =>
									!vaultPathSet.has(properties.path) &&
									mimeType === folderMimeType
							);
							await Promise.all(
								foldersInDriveNotInVault.map(({ properties }) =>
									this.app.vault.createFolder(properties.path)
								)
							);

							driveFiles.forEach(({ id, properties }) => {
								this.plugin.settings.driveIdToPath[id] =
									properties.path;
							});
							this.plugin.settings.lastSyncedAt = Date.now();
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return new Notice(
								"An error occurred fetching Google Drive changes token."
							);
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						new Notice(
							"Refresh token saved! Reload Obsidian to activate sync.",
							0
						);
					});
			});
	}
}
