import ky from "ky";
import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { TAbstractFile, TFolder } from "obsidian";

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
}

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

export const folderMimeType = "application/vnd.google-apps.folder";

const BLACKLISTED_CONFIG_FILES = [
	"graph.json",
	"workspace.json",
	"workspace-mobile.json",
];

const WHITELISTED_PLUGIN_FILES = [
	"manifest.json",
	"styles.css",
	"main.js",
	"data.json",
];

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === "string") return `='${search}'`;
	if ("contains" in search) return ` contains '${search.contains}'`;
	if ("not" in search) return `!='${search.not}'`;
};

const queryHandlers = {
	name: (name: StringSearch) => "name" + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		"mimeType" + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${parent}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${query}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties).map(
			([key, value]) =>
				`properties has { key='${key}' and value='${value}' }`
		),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ("eq" in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ("gt" in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ("lt" in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveKy(t);

	const getQuery = (matches: QueryMatch[], includeVaultProperties = true) =>
		encodeURIComponent(
			`(${matches
				.map((match) => {
					const entries = Object.entries(match).flatMap(
						([key, value]) =>
							value === undefined
								? []
								: Array.isArray(value)
								? value.map((v) => [key, v])
								: [[key, value]]
					);
					return `(${entries
						.map(([key, value]) =>
							queryHandlers[key as keyof QueryMatch](
								value as never
							)
						)
						.join(" and ")})`;
				})
				.join(
					" or "
				)}) and trashed=false${
					includeVaultProperties
						? ` and properties has { key='vault' and value='${t.app.vault.getName()}' }`
						: ""
				}`
				//)}) and trashed=false and properties has { key='vault' and value='${t.app.vault.getName()}' }`
		);

	const paginateFiles = async ({
		matches,
		pageToken,
		order = "descending",
		pageSize = 30,
		include = [
			"id",
			"name",
			"mimeType",
			"starred",
			"description",
			"properties",
		],
	}: {
		matches?: QueryMatch[];
		order?: "ascending" | "descending";
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					","
				)})&pageSize=${pageSize}&q=${
					matches ? getQuery(matches) : "trashed=false"
				}${
					matches?.find(({ query }) => query)
						? ""
						: "&orderBy=name" +
						  (order === "ascending" ? "" : " desc")
				}${pageToken ? "&pageToken=" + pageToken : ""}`
			)
			.json<any>();
		if (!files) return;
		return files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: "ascending" | "descending";
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files as FileMetadata[];

		return files.files.filter(
			({ properties }) => properties?.obsidian !== "vault"
		) as FileMetadata[];
	};

	const getRootFolderId = async (): Promise<string | undefined> => {
		// Create or re-use nested path: Google Drive > Obsidian > RichardX366 > [VaultName]

		// 2) First level:
		const obsidianId = await createFolder({ name: "Obsidian", parent: "root" });
		if (!obsidianId) return;

		// 3) Second level:
		const userId = await createFolder({ name: "RichardX366", parent: obsidianId });
		if (!userId) return;

		// 4) Vault level:
		const vaultFolderId = await createFolder({
			name: t.app.vault.getName(),
			parent: userId,
			description: "Obsidian Vault: " + t.app.vault.getName(),
			properties: { obsidian: "vault", vault: t.app.vault.getName() },
			modifiedTime: new Date().toISOString(),
		});
		if (!vaultFolderId) return;

		return vaultFolderId;
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		// ─── look for an existing folder with this name under `parent` ───
		// (this stops duplicates)
		const isVaultFolder = properties?.obsidian === "vault";
		const existing = await searchFiles(
			{ matches: [
				{ name, mimeType: folderMimeType, parent },
			] },
			isVaultFolder // only add vault filter for vault folders
		);
		if (existing?.length) {
			return existing[0].id as string;
		}

		/*if (!properties) {
			properties = {};
		}
		else {
			// Only add vault name if it's *not* a shared parent folder
			if (!properties.vault) {
				properties.vault = t.app.vault.getName();
			}
		}*/

		// Only add vault name if it's *not* a shared parent folder
		if (properties && !properties.vault && properties.obsidian === "vault") {
			properties.vault = t.app.vault.getName();
		}

		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
					modifiedTime,
				},
			})
			.json<any>();
		if (!folder) return;
		return folder.id as string;
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, "id">>
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!metadata) metadata = {};
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = t.app.vault.getName();
		}

		const form = new FormData();
		form.append(
			"metadata",
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: "application/json" }
			)
		);
		form.append("file", file);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: form,
			})
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, "id">> = {}
	) => {
		const form = new FormData();
		form.append(
			"metadata",
			new Blob([JSON.stringify(newMetadata)], {
				type: "application/json",
			})
		);
		form.append("file", newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`,
				{
					body: form,
				}
			)
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, "id">>
	) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<any>();
		if (!result) return;
		return result.id as string;
	};

	const deleteFile = async (id: string) => {
		const result = await drive.delete(`drive/v3/files/${id}`);
		if (!result.ok) return;
		return true;
	};

	const getFile = (id: string) =>
		drive.get(`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`);

	const getFileMetadata = (id: string) =>
		drive.get(`drive/v3/files/${id}`).json<FileMetadata>();

	const idFromPath = async (path: string) => {
		const files = await searchFiles({
			matches: [{ properties: { path } }],
		});
		if (!files?.length) return;
		return files[0].id as string;
	};

	const idsFromPaths = async (paths: string[]) => {
		const files = await searchFiles({
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) return;
		return files.map((file) => ({
			id: file.id,
			path: file.properties.path,
		}));
	};

	const batchDelete = async (ids: string[]) => {
		const body = new FormData();

		// Loop through file IDs to create each delete request
		ids.forEach((fileId, index) => {
			const deleteRequest = [
				`--batch_boundary`,
				"Content-Type: application/http",
				"",
				`DELETE /drive/v3/files/${fileId} HTTP/1.1`,
				"",
				"",
			].join("\r\n");

			body.append(`request_${index + 1}`, deleteRequest);
		});

		body.append("", "--batch_boundary--");

		const result = await drive
			.post(`batch/drive/v3`, {
				headers: {
					"Content-Type": "multipart/mixed; boundary=batch_boundary",
				},
				body,
			})
			.text();
		if (!result) return;
		return result;
	};

	const getChangesStartToken = async () => {
		const result = await drive
			.get(`drive/v3/changes/startPageToken`)
			.json<any>();
		if (!result) return;
		return result.startPageToken as string;
	};

	const getChanges = async (startToken: string) => {
		if (!startToken) return [];

		const request = (token: string) =>
			drive
				.get(
					`drive/v3/changes?${new URLSearchParams({
						pageToken: token,
						pageSize: "1000",
						includeRemoved: "true",
					}).toString()}`
				)
				.json<any>();

		const result = await request(startToken);
		if (!result) return;
		while (result.nextPageToken) {
			const nextPage = await request(result.nextPageToken);
			if (!nextPage) return;
			result.changes.push(...nextPage.changes);
			result.newStartPageToken = nextPage.newStartPageToken;
			result.nextPageToken = nextPage.nextPageToken;
		}

		return result.changes as {
			kind: string;
			removed: boolean;
			file: FileMetadata;
			fileId: string;
			time: string;
		}[];
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split("/").length)
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
	};

	const getConfigFilesToSync = async () => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const [configFiles, plugins] = await Promise.all([
			adapter.list(vault.configDir),
			adapter.list(vault.configDir + "/plugins"),
		]);

		await Promise.all(
			configFiles.files
				.filter(
					(path) =>
						!BLACKLISTED_CONFIG_FILES.includes(
							fileNameFromPath(path)
						)
				)
				.map(async (path) => {
					const file = await adapter.stat(path);
					if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
						configFilesToSync.push(path);
					}
				})
				.concat(
					plugins.folders.map(async (plugin) => {
						const files = await adapter.list(plugin);
						await Promise.all(
							files.files
								.filter((path) =>
									WHITELISTED_PLUGIN_FILES.includes(
										fileNameFromPath(path)
									)
								)
								.map(async (path) => {
									const file = await adapter.stat(path);
									if (
										(file?.mtime || 0) >
										t.settings.lastSyncedAt
									) {
										configFilesToSync.push(path);
									}
								})
						);
					})
				)
		);

		return configFilesToSync;
	};

	return {
		paginateFiles,
		searchFiles,
		getRootFolderId,
		createFolder,
		uploadFile,
		updateFile,
		updateFileMetadata,
		deleteFile,
		getFile,
		getFileMetadata,
		idFromPath,
		idsFromPaths,
		getChangesStartToken,
		getChanges,
		batchDelete,
		checkConnection,
		deleteFilesMinimumOperations,
		getConfigFilesToSync,
	};
};

export const checkConnection = async () => {
	try {
		const result = await ky.get("https://ogds.vercel.app/api/ping");
		return result.ok;
	} catch {
		return false;
	}
};

export const batchAsyncs = async (
	requests: (() => Promise<any>)[],
	batchSize = 10
) => {
	const results = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		results.push(...(await Promise.all(batch.map((request) => request()))));
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

export const fileNameFromPath = (path: string) => path.split("/").slice(-1)[0];

/**
 * @returns Batches in increasing order of depth
 */
export const foldersToBatches: {
	(folders: string[]): string[][];
	(folders: TFolder[]): TFolder[][];
} = (folders) => {
	const batches: (typeof folders)[] = new Array(
		Math.max(
			...folders.map(
				(folder) =>
					(folder instanceof TFolder ? folder.path : folder).split(
						"/"
					).length
			)
		)
	)
		.fill(0)
		.map(() => []);

	folders.forEach((folder) => {
		batches[
			(folder instanceof TFolder ? folder.path : folder).split("/")
				.length - 1
		].push(folder as any);
	});

	return batches as any;
};
