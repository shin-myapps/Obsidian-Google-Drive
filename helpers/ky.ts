import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";

const getHooks = (t: ObsidianGoogleDrive): Hooks => ({
	beforeRequest: [
		async (request) => {
			if (t.accessToken.token) {
				if (t.accessToken.expiresAt - Date.now() < 60000) {
					await refreshAccessToken(t);
				}
				request.headers.set(
					"Authorization",
					`Bearer ${t.accessToken.token}`
				);
			}
			return request;
		},
	],
	afterResponse: [
		async (request, options, response) => {
			if (!response.ok) {
				new Notice(`Error: ${await response.text()}`);
				return new Response();
			}
			return response;
		},
	],
});

export const getDriveKy = (t: ObsidianGoogleDrive) => {
	return ky.extend({
		prefixUrl: "https://www.googleapis.com",
		hooks: getHooks(t),
	});
};

export const refreshAccessToken = async (t: ObsidianGoogleDrive) => {
	try {
		const { expires_in, access_token } = await ky
			.post("https://obsidian.richardxiong.com/api/access", {
				json: { refresh_token: t.settings.refreshToken },
			})
			.json<any>();

		t.accessToken = {
			token: access_token,
			expiresAt: Date.now() + expires_in * 1000,
		};
	} catch (e: any) {
		t.settings.refreshToken = "";
		t.accessToken = {
			token: "",
			expiresAt: 0,
		};

		new Notice(
			"Something is wrong with your refresh token, please reset it."
		);
		await t.saveSettings();
	}
};
