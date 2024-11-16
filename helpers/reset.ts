import ObsidianGoogleDrive from "main";
import { batchAsyncs, folderMimeType, getSyncMessage } from "./drive";
import { Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import { pull } from "./pull";

export const reset = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const syncNotice = await t.startSync();

	await pull(t, true);

	const { vault } = t.app;

	const operations = Object.entries(t.settings.operations);
	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const filePathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	if (creates.length) {
		let files = creates
			.map(([path]) => vault.getAbstractFileByPath(path))
			.filter((file) => file instanceof TAbstractFile) as TAbstractFile[];

		const createdFolders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (createdFolders.length) {
			const maxDepth = Math.max(
				...createdFolders.map(({ path }) => path.split("/").length)
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split("/").length === depth
				);
				await Promise.all(
					foldersToDelete.map((folder) => t.deleteFile(folder))
				);
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + "/") &&
								path !== folder.path
						))
				);
			}
		}

		await Promise.all(files.map((file) => t.deleteFile(file)));
	}

	syncNotice.setMessage("Syncing (33%)");

	if (modifies.length) {
		let completed = 0;
		const files = modifies.map(([path]) =>
			vault.getFileByPath(path)
		) as TFile[];
		await batchAsyncs(
			files.map((file) => async () => {
				const onlineFile = await t.drive
					.getFile(filePathToId[file.path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				completed++;
				syncNotice.setMessage(
					getSyncMessage(33, 66, completed, files.length)
				);
				return t.modifyFile(file, onlineFile);
			})
		);
	}

	if (deletes.length) {
		const files = await t.drive.searchFiles({
			include: ["id", "mimeType", "properties"],
			matches: deletes.map(([path]) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const filePathToMimeType = Object.fromEntries(
			files.map((file) => [file.properties.path, file.mimeType])
		);

		const deletedFolders = deletes.filter(
			([path]) => filePathToMimeType[path] === folderMimeType
		);

		if (deletedFolders.length) {
			const batches: string[][] = new Array(
				Math.max(
					...deletedFolders.map(([path]) => path.split("/").length)
				)
			).fill([]);
			deletedFolders.forEach(([path]) => {
				batches[path.split("/").length - 1].push(path);
			});

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => t.createFolder(folder))
				);
			}
		}

		let completed = 0;

		const deletedFiles = deletes.filter(
			([path]) => filePathToMimeType[path] !== folderMimeType
		);

		await batchAsyncs(
			deletedFiles.map(([path]) => async () => {
				const onlineFile = await t.drive
					.getFile(filePathToId[path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				completed++;
				syncNotice.setMessage(
					getSyncMessage(66, 99, completed, deletedFiles.length)
				);
				return t.createFile(path, onlineFile);
			})
		);
	}

	t.settings.operations = {};

	await t.endSync(syncNotice);

	new Notice("Reset complete.");
};
