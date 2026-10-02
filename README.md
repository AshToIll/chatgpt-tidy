# ChatGPT Tidy

简体中文 | [English](README.en.md) | [日本語](README.ja.md)

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

约 1 分 36 秒，演示安装、打开侧栏及主要功能。

https://github.com/user-attachments/assets/b4ebe07a-406b-48ff-8f92-5dfcd9c8c7ca

## 安装 0.5.1

使用 Chrome / Edge 116 或更新版本。正常使用请下载 [`chatgpt-tidy-0.5.1.zip`](https://github.com/AshToIll/chatgpt-tidy/releases/download/v0.5.1/chatgpt-tidy-0.5.1.zip) 安装包，解压到固定文件夹。

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。
2. 开启「开发者模式」，点击「加载已解压的扩展程序」，选择含 `manifest.json` 的文件夹。
3. 刷新 ChatGPT 网页，再点击浏览器扩展菜单中的 **ChatGPT Tidy**，即可展开侧栏。

如果使用 GitHub 的「Code → Download ZIP」下载源码，请解压后选择其中的 `src` 文件夹，而不是仓库根目录。

## 更新与备份

在 **设置 → 资料备份** 中，可将收藏栏与书签栏资料备份为 JSON 文件。

更新前请先导出备份，再用新版文件覆盖原安装目录，重新加载扩展并刷新 ChatGPT 网页。不要先卸载扩展或清空扩展数据。

换浏览器或电脑后，登录原来的 ChatGPT 账号，即可导入备份。

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
