# 第三方代码与字体

导出所需的库和字体均随扩展本地提供，不在运行时从 CDN 加载。PDF/ZIP 库在导出计算线程中按需加载，字体按本次内容读取分片。

| 组件 | 版本 | 许可与材料 | 用途 |
| --- | --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | [MIT](vendor/licenses/pdf-lib-1.17.1-LICENSE.md)；内嵌组件见来源索引 | PDF 生成、字体/图片嵌入和链接注释。 |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | 上游 MIT 声明；[随附 notices](vendor/licenses/pdf-lib-fontkit-1.1.1-NOTICES.txt) | 解析和嵌入 Unicode 字体。 |
| [regenerator-runtime](https://github.com/facebook/regenerator/tree/main/packages/runtime) | 0.14.1 | [MIT](vendor/REGENERATOR-RUNTIME-LICENSE.txt) | fontkit 的 OpenType 布局运行时。 |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | [MIT OR GPL-3.0-or-later](vendor/licenses/jszip-3.10.1-LICENSE.markdown)，本项目按 MIT 使用 | 多文件 ZIP。 |
| [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) | 本地 400/500 分片 | [SIL OFL 1.1](assets/fonts/OFL-NotoSansSC.txt) | PDF 中英日正文。 |
| [Noto Sans 多语言家族](https://github.com/google/fonts/tree/main/ofl) | 本地 400/500 分片 | [各家族 SIL OFL 1.1](assets/fonts/SOURCES.md) | PDF 多语言字体回退。 |
| [Noto Emoji](https://fonts.google.com/noto/specimen/Noto+Emoji) | Regular | [SIL OFL 1.1](assets/fonts/OFL-NotoEmoji.txt) | PDF 单色 Emoji。 |

## 保留的材料

- 项目与原项目版权：根目录 `LICENSE`，安装包也包含该文件。
- 运行库及内嵌组件：[来源索引](vendor/licenses/SOURCES.md)、[文件与 SHA-256 清单](vendor/licenses/SOURCES.json)及 `vendor/licenses/` 内的许可原文。
- pdf-lib 内嵌 tslib 1.11.1 的 [Apache-2.0](vendor/licenses/tslib-1.11.1-LICENSE.txt) 与 [版权声明](vendor/licenses/tslib-1.11.1-CopyrightNotice.txt)。
- 字体：[来源与各家族原文](assets/fonts/SOURCES.md)、[本地指纹和内嵌记录](assets/fonts/SOURCES.json)。

## 已知说明

本项目使用 @pdf-lib/fontkit 1.1.1，上游声明采用 MIT 许可；已保留可取得的版权与许可材料，上游发布包未附完整顶层 LICENSE 文件。这项已知情况随项目说明，不作为反复阻断本项目发布的事项。

部分旧依赖的完整 notice 与字体的历史生成输入尚未全部找回，具体范围保留在上述来源索引中；不改写许可原文，也不声称已完成全部传递依赖审计。

PDF 字体使用本地生成的静态分片，部分 fallback 分片移除了布局表。所有内置字体均不支持的字形显示为 `□` 并给出警告；Markdown、JSON 与 TXT 保留原始 Unicode。分发时请保留本文件和随附的实际许可材料。
