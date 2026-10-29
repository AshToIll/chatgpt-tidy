# ChatGPT Tidy

简体中文 | [English](README.en.md) | [日本語](README.ja.md)

**普通用户：[下载普通用户安装包](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/chatgpt-tidy-0.5.2.zip) · [安装步骤](#安装-052)**（不需要安装 Node.js 等开发工具）

一个用于把网页版 ChatGPT 会话变整洁的小扩展，个人自用，也分享给有需要的人。

最初只是为了标题整理这个模块，现在已包含以下更多功能：

- **时间显示**：显示会话与消息时间、消息编号。
- **标题整理**：预览并整理当前或批量会话的标题，按日期规则统一命名。
- **收藏**：收藏会话，分组整理，支持跳转原会话。
- **书签**：标记重要消息，分组管理，支持跳转消息。
- **搜索**：按关键词或会话日期查找会话。
- **导出**：将会话或书签消息导出为 Markdown、TXT、JSON 或 PDF。
- **设置**：调整界面语言（简体中文、繁体中文、英文、日文）、时区、主题配色，资料备份。

这是独立的个人项目，与 OpenAI 无隶属关系；ChatGPT 网页变化可能影响功能。

## 使用演示

约 42 秒，展示主要功能，含配乐。

https://github.com/user-attachments/assets/b8192886-dc7d-4943-afb3-7040bbcdf5b8

<details>
<summary>English demo</summary>

https://github.com/user-attachments/assets/975fb313-f086-45f4-850d-7599ac3fd599

</details>

[下载中文版 MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-promo-zh.mp4) | [Download English MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-promo-en.mp4)

## 安装 0.5.2

电脑端 Chrome / Edge 116 或更新版本。以下以 0.5.2 为例。

**安装视频**（约 1 分 24 秒，中文配字、含配乐）：[下载 MP4](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/ChatGPT-Tidy-install-guide-zh.mp4)

### 普通用户安装

1. **下载**：在本页点击 **[下载普通用户安装包](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.2/chatgpt-tidy-0.5.2.zip)**，得到 **`chatgpt-tidy-0.5.2.zip`**。从 Releases 下载时，在 **Assets** 中点这个文件名。**不要点「Source code (zip)」**：它下载后文件名相同，但里面是源码，不能直接安装。
2. **解压**：Windows 右键 ZIP →「全部解压缩」→「提取」；Mac 在 Finder 中双击 ZIP。解压后得到 **`chatgpt-tidy-0.5.2` 文件夹**。找个不会被清理的地方放好，比如自己新建一个「浏览器插件」文件夹，不要留在「下载」里。之后不要删除、移动或改名，浏览器每次启动都要从这里读取插件。
3. **打开扩展管理页**：Chrome 地址栏输入 `chrome://extensions`；Edge 输入 `edge://extensions`，然后按回车。
4. **开启开发者模式**：Chrome 在页面右上角打开「开发者模式」；Edge 在左侧栏底部打开「开发人员模式」（窗口较窄时先点左上角 ☰）。英文界面为 Developer mode。以后也请保持开启。
5. **加载文件夹**：Chrome 点「加载未打包的扩展程序」，Edge 点「加载解压缩的扩展」（英文界面为 Load unpacked）→ 选中 **`chatgpt-tidy-0.5.2` 整个文件夹**（见下方示意图）→ Windows 点右下角「选择文件夹」；Mac 点「选择」或「打开」。
6. **打开插件**：在同一个浏览器打开 [chatgpt.com](https://chatgpt.com)，登录 ChatGPT → 点地址栏右侧的 **ChatGPT Tidy 图标**（黑色花朵形，中间有时钟指针），看到侧栏即完成安装，刷新网页即可使用。如果工具栏上没有这个图标，先点地址栏右侧拼图形状的「扩展」按钮 🧩，再点列表里的 **ChatGPT Tidy**，推荐把它固定到工具栏。

**第 5 步选这一层**：选整个文件夹，不选里面的文件。打开后能直接看到 `manifest.json`，就是选对了。选择窗口里的文件显示为灰色或不显示，是正常的。

```text
chatgpt-tidy-0.5.2/       ← 选这个整个文件夹，然后确认
├── manifest.json
├── app/
├── assets/
└── ……
```

**装不上时：**

- 提示「清单文件缺失或不可读取」（Edge 为「清单文件丢失或不可读取」，英文为 Manifest file is missing or unreadable）：选错了层级，或下载成了 Source code。请重新选择能直接看到 `manifest.json` 的那个文件夹。
- 点 ChatGPT Tidy 没有反应：侧栏只在 ChatGPT 网页上打开。请先切换到 ChatGPT 的标签页，刷新后再点。
- 插件突然不能用了：可能关闭了开发者模式，浏览器会同时停用这类插件。回到扩展管理页，重新打开开发者模式即可。

Mac 步骤按浏览器常规界面整理，尚未完成 macOS 真机验收；按钮名称以实际画面为准。

### 开发者源码包安装

普通用户不需要这一节。源码包解压后，加载里面的 **`src` 文件夹**。其余步骤同上。

| 下载来源 | 下载文件 | 解压后加载的文件夹（示例） |
| --- | --- | --- |
| Releases → Assets | `chatgpt-tidy-0.5.2-source.zip` | **`chatgpt-tidy-0.5.2-source/src`** |
| Code → Download ZIP | `chatgpt-tidy-main.zip` | **`chatgpt-tidy-main/src`** |
| Releases → Source code (zip) | `chatgpt-tidy-0.5.2.zip`（GitHub 自动生成的源码包） | **`chatgpt-tidy-0.5.2/src`** |

```text
chatgpt-tidy-0.5.2-source/
└── src/                  ← 选这个文件夹
    ├── manifest.json
    ├── app/
    └── ……
```

## 更新与备份

在 ChatGPT Tidy 侧栏的 **设置 → 资料备份** 中，可将收藏栏与书签栏资料备份为 JSON 文件。

更新步骤：

1. 在 **设置 → 资料备份** 先导出一份备份。
2. 下载并解压新版安装包。
3. 打开新版文件夹，全选里面的所有内容并复制，粘贴到原来的安装文件夹；提示同名文件时选择「替换」。
4. 回到扩展管理页，点 ChatGPT Tidy 卡片上的刷新图标 ↻，再刷新 ChatGPT 网页。

不要先卸载扩展或清空扩展数据，也不要把新版放到另一个文件夹再加载：浏览器会把它当成另一个插件，原来的收藏和书签不会出现在里面。

换浏览器或电脑后，先按上面的步骤装好 ChatGPT Tidy，再登录原来的 ChatGPT 账号，即可在同一位置导入备份。

如果账号下有多个个人／团队空间，请先切回备份时使用的那个空间，再导入。

## 开发

开发或修改源码时，在浏览器中加载其中的 `src` 文件夹。

使用 **Node >=24**，在仓库根目录执行：

```sh
npm ci
npm run verify
```

运行库和字体已包含在源码中。架构、存储、构建和发布步骤见 [开发文档](docs/README.md)。

## 许可

本项目采用 MIT 许可，起源于 EryetChen 的 ChatGPT Chats Timestamp，保留上游版权。第三方代码和字体遵循各自许可，见 `src/THIRD_PARTY_LICENSES.md`；分发时请保留随附许可材料。
