# Google Drive Sync

This is an unofficial sync plugin for Obsidian, specifically for Google Drive.

## Disclaimer

-   **This is NOT the [official sync service](https://obsidian.md/sync) provided by Obsidian.**

## !!!Caution!!!

**ALWAYS backup your vault before using this plugin.**

## Features

-   Syncing both ways (from Obsidian to Google Drive and back)
-   Cross-device support
-   Obsidian iOS app support

## Notes

-   Do NOT manually upload files into the generated Obsidian Google Drive folder or use some other method of Google Drive sync
    -   Our plugin cannot see these files, and it will likely break functionality, potentially causing data loss
    -   Instead, use this plugin on any device you wish to sync the vault between
-   Do NOT manually change files outside of the Obsidian app
    -   Our plugin tracks file changes through the Obsidian API, and if you change files outside of the app, the plugin will not be able to track these changes
-   INITIAL activation of this plugin on a vault will DELETE ALL LOCAL FILES IN THE VAULT and REPLACE them with the files on Google Drive
    -   If you wish to keep those files, move them to another vault and copy them back in after syncing
    -   If there is no Google Drive vault, the plugin will create one and delete the contents of the local vault
    -   This is ONLY on the first activation or when the client is behind Google Drive's files
-   We suggest only editing Obsidian notes on one device at a time to avoid conflicts and syncing before editing on another device

## Setup

Note: Instructions are also on this plugin's homepage with images at [https://obsidian.richardxiong.com](https://obsidian.richardxiong.com)

1. Visit this plugin's homepage at [https://obsidian.richardxiong.com](https://obsidian.richardxiong.com)
2. Click `Sign In` at the top right and log in with your Google account
3. Copy the refresh token that appears after logging in
4. Enable the Google Drive Sync plugin in Obsidian
5. Paste the refresh token into the plugin settings in Obsidian
6. Reload the Obsidian app

## Use

-   After setup, the plugin will automatically sync your vault with Google Drive whenever Obsidian is open
    -   This sync is from Google Drive TO Obsidian, not the other way around (pulling cloud files)
    -   The plugin prioritizes changes on Google Drive over changes on the local vault, wiping local changes if the Google Drive files are newer
-   To sync local changes to Google Drive, click the sync button on the ribbon or run the `Sync to Google Drive` command from the command palette
    -   While you do not have to sync before you close Obsidian, we suggest doing so to ensure that Google Drive is up to date
    -   If a device syncs to Google Drive, other devices will delete their local changes the next time they open Obsidian
-   Make sure to sync with an adequate internet connection
    -   Closing the app or losing connection while syncing could lead to data corruption

Privacy Policy: [https://obsidian.richardxiong.com/privacy](https://obsidian.richardxiong.com/privacy)
