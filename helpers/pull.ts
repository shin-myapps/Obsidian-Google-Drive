import ObsidianGoogleDrive from "main";
import { Notice, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	FileMetadata,
	folderMimeType,
	getSyncMessage,
} from "./drive";
import { refreshAccessToken } from "./ky";

export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices?: boolean
) => {
	let syncNotice: any = null;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = t.startSync();
	}

	const { vault, fileManager } = t.app;

	if (!t.accessToken.token) await refreshAccessToken(t);

	const recentlyModified = await t.drive.searchFiles({
		include: ["id", "modifiedTime", "properties", "mimeType"],
		matches: [
			{
				modifiedTime: {
					gt: new Date(t.settings.lastSyncedAt).toISOString(),
				},
			},
		],
	});
	if (!recentlyModified) {
		return new Notice("An error occurred fetching Google Drive files.");
	}

	const changes = await t.drive.getChanges(t.settings.changesToken);
	if (!changes) {
		return new Notice("An error occurred fetching Google Drive changes.");
	}

	const deletions = changes
		.filter(({ removed }) => removed)
		.map(({ fileId }) => {
			const path = t.settings.driveIdToPath[fileId];
			if (!path) return;
			delete t.settings.driveIdToPath[fileId];

			const file = vault.getAbstractFileByPath(path);

			if (!file && t.settings.operations[path] === "delete") {
				delete t.settings.operations[path];
				return;
			}
			return file;
		});

	if (!recentlyModified.length && !deletions.length) {
		if (silenceNotices) return;
		t.endSync(syncNotice);
		return new Notice("You're up to date!");
	}

	const pathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	const updateMap = () => {
		recentlyModified.forEach(({ id, properties }) => {
			pathToId[properties.path] = id;
		});

		t.settings.driveIdToPath = Object.fromEntries(
			Object.entries(pathToId).map(([path, id]) => [id, path])
		);
	};

	updateMap();

	const deleteFiles = async () => {
		const deletedFiles = deletions.filter(
			(file) => file instanceof TFile
		) as TFile[];

		await Promise.all(
			deletedFiles.map((file) => {
				if (t.settings.operations[file.path] === "modify") {
					if (!pathToId[file.path]) {
						t.settings.operations[file.path] = "create";
					}
					return;
				}
				return fileManager.trashFile(file);
			})
		);

		const deletedFolders = deletions
			.filter((folder) => folder instanceof TFolder)
			.filter((folder: TFolder) => {
				if (pathToId[folder.path]) return;
				if (folder.children.length) {
					if (!pathToId[folder.path]) {
						t.settings.operations[folder.path] = "create";
					}
					return;
				}
				return true;
			}) as TFolder[];

		if (deletedFolders.length) {
			const batches: TFolder[][] = new Array(
				Math.max(
					...deletedFolders.map(({ path }) => path.split("/").length)
				)
			).fill([]);

			deletedFolders.forEach((folder) => {
				batches[batches.length - folder.path.split("/").length].push(
					folder
				);
			});

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => fileManager.trashFile(folder))
				);
			}
		}
	};

	await deleteFiles();

	syncNotice.setMessage("Syncing (33%)");

	const upsertFiles = async () => {
		const newFolders = recentlyModified.filter(
			({ mimeType }) => mimeType === folderMimeType
		);

		if (newFolders.length) {
			const batches: FileMetadata[][] = new Array(
				Math.max(
					...newFolders.map(
						({ properties }) => properties.path.split("/").length
					)
				)
			).fill([]);

			newFolders.forEach((folder) => {
				batches[folder.properties.path.split("/").length - 1].push(
					folder
				);
			});

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => {
						delete t.settings.operations[folder.properties.path];
						if (vault.getFolderByPath(folder.properties.path))
							return;
						return vault.createFolder(folder.properties.path);
					})
				);
			}
		}

		let completed = 0;

		const newNotes = recentlyModified.filter(
			({ mimeType }) => mimeType !== folderMimeType
		);

		await batchAsyncs(
			newNotes.map((file: FileMetadata) => async () => {
				const localFile = vault.getFileByPath(file.properties.path);
				const operation = t.settings.operations[file.properties.path];

				completed++;

				if (localFile && operation === "modify") {
					return;
				}

				if (localFile && operation === "create") {
					t.settings.operations[file.properties.path] = "modify";
					return;
				}

				const content = await t.drive.getFile(file.id).arrayBuffer();

				syncNotice.setMessage(
					getSyncMessage(33, 100, completed, newNotes.length)
				);

				if (localFile) {
					return vault.modifyBinary(localFile, content);
				}

				vault.createBinary(file.properties.path, content);
			})
		);
	};

	await upsertFiles();

	if (silenceNotices) return true;

	await t.endSync(syncNotice);

	new Notice("Files have been synced from Google Drive!");
};
