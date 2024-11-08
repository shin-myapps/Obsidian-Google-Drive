import { folderMimeType } from "./constants";
import { drive } from "./ky";

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
}

type StringSearch = string | { contains: string } | { not: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
}

const queryHandlers = {
	name: (name: StringSearch) => {
		if (typeof name === "string") return `name='${name}'`;
		if ("contains" in name) return `name contains '"${name.contains}"'`;
		if ("not" in name) return `name != '${name.not}'`;
	},
	mimeType: (mimeType: StringSearch) => {
		if (typeof mimeType === "string") return `mimeType='${mimeType}'`;
		if ("contains" in mimeType)
			return `mimeType contains '${mimeType.contains}'`;
		if ("not" in mimeType) return `mimeType != '${mimeType.not}'`;
	},
	parent: (parent: string) => `'${parent}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${query}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties).map(
			([key, value]) =>
				`properties has { key='${key}' and value='${value}' }`
		),
};

const getQuery = (matches: QueryMatch[]) =>
	encodeURIComponent(
		`(${matches
			.map((match) => {
				const entries = Object.entries(match).flatMap(([key, value]) =>
					value === undefined
						? []
						: Array.isArray(value)
						? value.map((v) => [key, v])
						: [[key, value]]
				);
				return `(${entries
					.map(([key, value]) =>
						queryHandlers[key as keyof QueryMatch](value as never)
					)
					.join(" and ")})`;
			})
			.join(" or ")}) and trashed=false`
	);

export const paginateFiles = async ({
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
			)})&pageSize=${pageSize}${
				matches ? "&q=" + getQuery(matches) : ""
			}${
				matches?.find(({ query }) => query)
					? ""
					: "&orderBy=name" + (order === "ascending" ? "" : " desc")
			}${pageToken ? "&pageToken=" + pageToken : ""}`
		)
		.json<any>();
	if (!files) return;
	return files as {
		nextPageToken?: string;
		files: FileMetadata[];
	};
};

export const searchFiles = async (
	matches: QueryMatch[],
	order: "ascending" | "descending" = "descending"
) => {
	const files = await drive
		.get(
			`drive/v3/files?pageSize=1000${
				matches?.find(({ query }) => query)
					? ""
					: "&orderBy=name" + (order === "ascending" ? "" : " desc")
			}&fields=files(id,name,mimeType,starred,description,properties)&q=${getQuery(
				matches
			)}`
		)
		.json<any>();
	if (!files) return;
	return files.files as FileMetadata[];
};

export const getRootFolderId = async () => {
	const files = await searchFiles([
		{ properties: { obsidian: "vault" }, mimeType: folderMimeType },
	]);
	if (!files) return;
	if (!files.length) {
		const rootFolder = await drive
			.post(`drive/v3/files`, {
				json: {
					name: "Obsidian",
					mimeType: folderMimeType,
					properties: { obsidian: "vault" },
				},
			})
			.json<any>();
		if (!rootFolder) return;
		return rootFolder.id as string;
	} else {
		return files[0].id as string;
	}
};

export const createFolder = async ({
	name,
	parent,
	description,
	properties,
}: {
	name: string;
	description?: string;
	parent?: string;
	properties?: Record<string, string>;
}) => {
	if (!parent) {
		parent = await getRootFolderId();
		if (!parent) return;
	}
	const folder = await drive
		.post(`drive/v3/files`, {
			json: {
				name,
				mimeType: folderMimeType,
				description,
				parents: [parent],
				properties,
			},
		})
		.json<any>();
	if (!folder) return;
	return folder.id as string;
};

export const uploadFile = async (
	file: Blob,
	name: string,
	parent?: string,
	metadata?: Partial<Omit<FileMetadata, "id">>
) => {
	if (!parent) {
		parent = await getRootFolderId();
		if (!parent) return;
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

export const updateFile = async (
	id: string,
	newContent: Blob,
	newMetadata: Partial<Omit<FileMetadata, "id">> = {}
) => {
	const form = new FormData();
	form.append(
		"metadata",
		new Blob([JSON.stringify(newMetadata)], { type: "application/json" })
	);
	form.append("file", newContent);

	const result = await drive
		.patch(`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`, {
			body: form,
		})
		.json<any>();
	if (!result) return;

	return result.id as string;
};

export const updateFileMetadata = async (
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

export const deleteFile = async (id: string) => {
	const result = await drive.delete(`drive/v3/files/${id}`);
	if (!result.ok) return;
	return true;
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getFile = (id: string) =>
	drive.get(`drive/v3/files/${id}?alt=media`);
