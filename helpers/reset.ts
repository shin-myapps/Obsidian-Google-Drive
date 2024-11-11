import ObsidianGoogleDrive from "main";
import { batchAsyncs } from "./drive";
import { Notice, TFile, TFolder } from "obsidian";
import { pull } from "./pull";

export const reset = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const syncNotice = t.startSync();

	const { vault } = t.app;

	const operations = Object.entries(t.settings.operations);
	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const filePathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	if (creates.length) {
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);
		const createdFiles = files.filter(
			(file) => file instanceof TFile
		) as TFile[];
		await Promise.all(
			createdFiles.map((file) => t.app.fileManager.trashFile(file))
		);

		const createdFolders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		const batches: TFolder[][] = new Array(
			Math.max(
				...createdFolders.map(({ path }) => path.split("/").length)
			)
		).fill([]);
		createdFolders.forEach((folder) => {
			batches[batches.length - folder.path.split("/").length].push(
				folder
			);
		});

		for (const batch of batches) {
			await Promise.all(
				batch.map((folder) => t.app.fileManager.trashFile(folder))
			);
		}
	}

	if (modifies.length) {
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
				await t.app.vault.modifyBinary(file, onlineFile);
			})
		);
	}

	if (deletes.length) {
		const files = deletes.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const deletedFolders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		const batches: TFolder[][] = new Array(
			Math.max(
				...deletedFolders.map(({ path }) => path.split("/").length)
			)
		).fill([]);
		deletedFolders.forEach((folder) => {
			batches[folder.path.split("/").length - 1].push(folder);
		});

		for (const batch of batches) {
			await Promise.all(
				batch.map((folder) => vault.createFolder(folder.path))
			);
		}

		const deletedFiles = files.filter(
			(file) => file instanceof TFile
		) as TFile[];

		await batchAsyncs(
			deletedFiles.map((file) => async () => {
				const onlineFile = await t.drive
					.getFile(filePathToId[file.path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				await t.app.vault.createBinary(file.path, onlineFile);
			})
		);
	}

	t.settings.operations = {};

	await pull(t, true);

	await t.endSync(syncNotice);
};
