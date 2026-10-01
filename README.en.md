# ChatGPT Tidy

[简体中文](README.md) | English | [日本語](README.ja.md)

A small extension to keep ChatGPT conversations tidy on the web. Built for personal use and shared with anyone who finds it helpful.

It started with title organization and now includes:

- **Time display**: Show conversation and message timestamps, plus message numbers.
- **Title organization**: Preview and organize titles for one conversation or a batch, using date-based naming rules.
- **Favorites**: Save conversations, organize them into groups, and jump back to the originals.
- **Bookmarks**: Mark important messages, organize them into groups, and jump to them.
- **Search**: Find conversations by keyword or conversation date.
- **Export**: Export conversations or bookmarked messages as Markdown, TXT, JSON, or PDF.
- **Settings**: Choose the interface language (Simplified Chinese, Traditional Chinese, English, or Japanese), time zone, and color theme, and back up your library.

This is an independent personal project, not affiliated with OpenAI. Changes to the ChatGPT website may affect its features.

## Install 0.5.1

Use Chrome / Edge 116 or later. Download the [`chatgpt-tidy-0.5.1.zip`](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.1/chatgpt-tidy-0.5.1.zip) installation package and extract it to a permanent folder.

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.
3. Refresh the ChatGPT page, then click **ChatGPT Tidy** in the browser extensions menu to open the side panel.

If you download the source using GitHub’s **Code → Download ZIP**, extract it and select the `src` folder inside, not the repository root.

## Updates and backup

Go to **Settings → Library backup** to back up your favorites and bookmarks as a JSON file.

Before updating, export a backup. Replace the files in the original installation folder with the new version, reload the extension, and refresh ChatGPT. Do not uninstall the extension or clear its data first.

When moving to another browser or computer, sign in to the same ChatGPT account to import your backup.

If your account has multiple personal or team workspaces, switch to the workspace used when creating the backup before importing it.

## Development

To develop or modify the extension, load the `src` folder in your browser.

With **Node >=24**, run these commands from the repository root:

```sh
npm ci
npm run verify
```

Runtime libraries and fonts are included in the source. See the [development docs](docs/README.md) for architecture, storage, build, and release instructions.

## License

This project is MIT-licensed and originated from ChatGPT Chats Timestamp by EryetChen, with the upstream copyright notice retained. Third-party code and fonts have their own licenses; see `src/THIRD_PARTY_LICENSES.md`. Keep the included license materials when redistributing.
