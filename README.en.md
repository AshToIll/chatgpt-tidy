# ChatGPT Tidy

[简体中文](README.md) | English | [日本語](README.ja.md)

**Regular users: [Download the installation ZIP](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/chatgpt-tidy-0.5.2.zip) · [Installation steps](#install-052)** (no Node.js or other developer tools needed)

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

## Demo

A 42-second overview of the main features, with music.

https://github.com/user-attachments/assets/975fb313-f086-45f4-850d-7599ac3fd599

<details>
<summary>中文版展示视频</summary>

https://github.com/user-attachments/assets/b8192886-dc7d-4943-afb3-7040bbcdf5b8

</details>

[Download English MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-promo-en.mp4) | [下载中文版 MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-promo-zh.mp4)

## Install 0.5.2

Desktop Chrome / Edge 116 or later. The examples below use version 0.5.2.

**Installation video** (1 min 24 sec, Chinese on-screen text, with music): [Download MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-install-guide-zh.mp4)

### Regular installation

1. **Download:** Click **[Download the installation ZIP](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/chatgpt-tidy-0.5.2.zip)** on this page to get **`chatgpt-tidy-0.5.2.zip`**. On Releases, click the file with this exact name under **Assets**. **Do not click “Source code (zip)”**: it downloads with the same file name, but it contains source code and cannot be installed directly.
2. **Extract:** On Windows, right-click the ZIP → **Extract all** → **Extract**. On Mac, double-click the ZIP in Finder. This creates a folder named **`chatgpt-tidy-0.5.2`**. Put it somewhere that will not be cleaned up, such as a folder you create for browser extensions. Do not leave it in Downloads. Do not delete, move, or rename it afterwards: the browser loads the extension from this folder every time it starts.
3. **Open extensions:** Enter `chrome://extensions` in the Chrome address bar, or `edge://extensions` in Edge, then press Enter.
4. **Turn on Developer mode:** In Chrome, the **Developer mode** switch is at the top right. In Edge, it is at the bottom of the left sidebar (in a narrow window, click ☰ at the top left first). Leave it on afterwards.
5. **Load the folder:** Click **Load unpacked** → select the **whole `chatgpt-tidy-0.5.2` folder** (see the diagram below) → on Windows, click **Select Folder** at the bottom right. On Mac, click **Select** or **Open**, as shown in the dialog.
6. **Open Tidy:** Open [chatgpt.com](https://chatgpt.com) in the same browser and sign in → click the **ChatGPT Tidy icon** next to the address bar (a black flower shape with clock hands). Installation is complete when the side panel appears; refresh the page to start using it. If the icon is not on the toolbar, click the puzzle-shaped **Extensions** button 🧩 next to the address bar, then click **ChatGPT Tidy**. We recommend pinning it to the toolbar.

**Select this folder in step 5:** Select the whole folder, not a file. If you can see `manifest.json` directly inside it, you have the right one. Files may appear greyed-out or hidden in the selection dialog; this is normal.

```text
chatgpt-tidy-0.5.2/       ← Select this whole folder, then confirm
├── manifest.json
├── app/
├── assets/
└── …
```

**If installation fails:**

- **Manifest file is missing or unreadable:** You selected the wrong level, or downloaded Source code. Select the folder that shows `manifest.json` directly inside it.
- **Nothing happens when you click ChatGPT Tidy:** The side panel only opens on ChatGPT. Switch to your ChatGPT tab, refresh it, and click again.
- **The extension suddenly stops working:** Developer mode may have been turned off, which also disables extensions like this one. Turn Developer mode back on in the extensions page.

The Mac steps follow the browsers' standard interface; on-device macOS verification has not yet been completed. Follow the button names shown on your screen.

### Developer source installation

Regular users can skip this section. Extract the source package and load its **`src` folder**. Follow the other steps above.

| Download location | Downloaded file | Folder to load after extraction (example) |
| --- | --- | --- |
| Releases → Assets | `chatgpt-tidy-0.5.2-source.zip` | **`chatgpt-tidy-0.5.2-source/src`** |
| Code → Download ZIP | `chatgpt-tidy-main.zip` | **`chatgpt-tidy-main/src`** |
| Releases → Source code (zip) | `chatgpt-tidy-0.5.2.zip` (GitHub-generated source archive) | **`chatgpt-tidy-0.5.2/src`** |

```text
chatgpt-tidy-0.5.2-source/
└── src/                  ← Select this folder, then confirm
    ├── manifest.json
    ├── app/
    └── …
```

## Updates and backup

In the ChatGPT Tidy side panel, go to **Settings → Library backup** to back up your favorites and bookmarks as a JSON file.

To update:

1. Export a backup from **Settings → Library backup**.
2. Download and extract the new installation ZIP.
3. Open the new folder, select everything inside it, copy it, and paste it into your original installation folder. When asked about files with the same name, choose **Replace**.
4. In the extensions page, click the reload icon ↻ on the ChatGPT Tidy card, then refresh ChatGPT.

Do not uninstall the extension or clear its data first, and do not load the new version from a different folder: the browser treats it as a separate extension, and your existing favorites and bookmarks will not appear in it.

When moving to another browser or computer, install ChatGPT Tidy there using the steps above, sign in to the same ChatGPT account, and import your backup from the same place.

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
