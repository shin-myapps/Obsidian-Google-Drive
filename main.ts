import { FileMetadata, folderMimeType, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	lastSyncedAt: number;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	lastSyncedAt: 0,
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
				"Please add your refresh token to Obsidian Google Drive."
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Sync with Google Drive",
			() => {
				if (this.syncing) return;
				new Notice(`Syncing...`);
				this.obsidianToGoogleDrive();
			}
		);

		this.addCommand({
			id: "sync",
			name: "Sync to Google Drive",
			callback: () => {
				if (this.syncing) return;
				new Notice(`Syncing...`);
				this.obsidianToGoogleDrive();
			},
		});

		this.googleDriveToObsidian().then(() => {
			this.app.workspace.onLayoutReady(() =>
				this.registerEvent(
					vault.on("create", this.handleCreate.bind(this))
				)
			);
			this.registerEvent(
				vault.on("delete", this.handleDelete.bind(this))
			);
			this.registerEvent(
				vault.on("modify", this.handleModify.bind(this))
			);
			this.registerEvent(
				vault.on("rename", this.handleRename.bind(this))
			);
		});
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

	async handleCreate(file: TFile) {
		this.settings.operations[file.path] = "create";
		await this.saveSettings();
	}

	async handleDelete(file: TFile) {
		this.settings.operations[file.path] = "delete";
		await this.saveSettings();
	}

	async handleModify(file: TFile) {
		if (this.settings.operations[file.path] === "create") return;
		this.settings.operations[file.path] = "modify";
		await this.saveSettings();
	}

	async handleRename(file: TFile, oldName: string) {
		this.settings.operations[oldName] = "delete";
		this.settings.operations[file.path] = "create";
		await this.saveSettings();
	}

	async startSync() {
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
	}

	async endSync() {
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
	}

	async obsidianToGoogleDrive() {
		this.startSync();

		const { vault } = this.app;

		const operations = Object.entries(this.settings.operations);
		const deletes = operations.filter(([_, op]) => op === "delete");
		const creates = operations.filter(([_, op]) => op === "create");
		const modifies = operations.filter(([_, op]) => op === "modify");

		if (deletes.length) {
			const ids = await this.drive.idsFromPaths(
				deletes.map(([path]) => path)
			);
			if (!ids) {
				return new Notice(
					"An error occurred fetching Google Drive files."
				);
			}
			if (ids.length) {
				const deleteRequest = await this.drive.batchDelete(
					ids.map(({ id }) => id)
				);
				if (!deleteRequest) {
					return new Notice(
						"An error occurred deleting Google Drive files."
					);
				}
			}
		}

		if (creates.length) {
			const files = creates.map(([path]) =>
				vault.getAbstractFileByPath(path)
			);

			const existingFolders = await this.drive.searchFiles({
				matches: [{ mimeType: folderMimeType }],
			});
			if (!existingFolders) {
				return new Notice(
					"An error occurred fetching Google Drive files."
				);
			}

			const pathsToIds = Object.fromEntries(
				existingFolders.map((folder) => [
					folder.properties.path,
					folder.id,
				])
			);

			const folders = (
				files.filter((file) => file instanceof TFolder) as TFolder[]
			).sort(
				(a, b) => a.path.split("/").length - b.path.split("/").length
			);
			const notes = files.filter(
				(file) => file instanceof TFile
			) as TFile[];

			for (const folder of folders) {
				const id = await this.drive.createFolder({
					name: folder.name,
					parent: folder.parent
						? pathsToIds[folder.parent.path]
						: undefined,
					properties: { path: folder.path },
				});
				if (!id) {
					return new Notice(
						"An error occurred creating Google Drive folders."
					);
				}
				pathsToIds[folder.path] = id;
			}

			await Promise.all(
				notes.map(async (note) => {
					const id = await this.drive.uploadFile(
						new Blob([await vault.readBinary(note)]),
						note.name,
						note.parent ? pathsToIds[note.parent.path] : undefined,
						{ properties: { path: note.path } }
					);
					if (!id) {
						return new Notice(
							"An error occurred creating Google Drive files."
						);
					}
				})
			);
		}

		if (modifies.length) {
			const files = modifies.map(([path]) =>
				vault.getFileByPath(path)
			) as TFile[];

			const driveFiles = await this.drive.searchFiles({
				matches: files.map(({ path }) => ({ properties: { path } })),
			});
			if (!driveFiles) {
				return new Notice(
					"An error occurred fetching Google Drive files."
				);
			}

			const pathToId = Object.fromEntries(
				driveFiles.map((folder) => [folder.properties.path, folder.id])
			);

			await Promise.all(
				files.map(async (file) => {
					const id = await this.drive.updateFile(
						pathToId[file.path],
						new Blob([await vault.readBinary(file)])
					);
					if (!id) {
						return new Notice(
							"An error occurred modifying Google Drive files."
						);
					}
				})
			);
		}

		this.settings.operations = {};
		this.settings.lastSyncedAt = Date.now();
		await this.saveSettings();

		new Notice("Sync complete!");
		this.endSync();
	}

	async googleDriveToObsidian() {
		this.startSync();

		await refreshAccessToken(this);

		const recentlyModified = await this.drive.searchFiles({
			include: ["id"],
			matches: [
				{
					modifiedTime: {
						gt: new Date(this.settings.lastSyncedAt).toISOString(),
					},
				},
			],
		});
		if (!recentlyModified) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		if (!recentlyModified.length) {
			this.settings.lastSyncedAt = Date.now();
			await this.saveSettings();
			return this.endSync();
		}

		const files = await this.drive.searchFiles({
			include: ["id", "modifiedTime", "properties", "mimeType"],
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const newFiles = files.filter(
			({ modifiedTime }) =>
				new Date(modifiedTime).getTime() > this.settings.lastSyncedAt
		);

		const newFolders = newFiles
			.filter(({ mimeType }) => mimeType === folderMimeType)
			.sort(
				(a, b) =>
					a.properties.path.split("/").length -
					b.properties.path.split("/").length
			);

		for (const folder of newFolders) {
			this.app.vault.createFolder(folder.properties.path);
		}

		const newNotes = newFiles.filter(
			({ mimeType }) => mimeType !== folderMimeType
		);

		await Promise.all(
			newNotes.map(async (file: FileMetadata) => {
				const localFile = this.app.vault.getFileByPath(
					file.properties.path
				);
				const content = await this.drive.getFile(file.id).arrayBuffer();

				if (localFile) {
					return this.app.vault.modifyBinary(localFile, content);
				}

				this.app.vault.createBinary(file.properties.path, content);
			})
		);

		const localFiles = this.app.vault.getAllLoadedFiles();
		const deletedFiles = localFiles.filter(
			(file) =>
				!files.find(({ properties }) => properties.path === file.path)
		);
		await Promise.all(
			deletedFiles.map((file) => this.app.vault.delete(file))
		);

		this.settings.lastSyncedAt = Date.now();
		await this.saveSettings();

		this.endSync();

		new Notice(
			"Files have been synced from Google Drive, please refresh Obsidian!"
		);
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
			href: "https://obsidian.richardxiong.com",
			text: "Get Refresh Token",
		});

		new Setting(containerEl)
			.setName("Refresh Token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing."
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						await this.plugin.saveSettings();
						new Notice(
							"Refresh token saved. Reload Obsidian to sync!"
						);
					})
			);
	}
}
