# 字体来源与许可

本索引覆盖随扩展交付的 24 个字体家族、355 个 TTF 文件。每份本地字体的 SHA-256、内嵌名称/版本/版权记录及许可来源见 [SOURCES.json](SOURCES.json)。本轮没有改动任何字体字节。

## 原始许可与署名

许可逐家族取自 Google Fonts 的固定提交 [f2bd09badbc763d8757951d52deec29da27e85fb](https://github.com/google/fonts/tree/f2bd09badbc763d8757951d52deec29da27e85fb/ofl)，保留完整原始字节，不用一段统一的 Google 版权说明代替不同作者。

本地字体的内嵌版权行同时按原文保留在 JSON 的 `local_name_records["0"]` 中。希伯来文、孟加拉文、Emoji 等文件的内嵌年份与目前上游 OFL 文件不同；这里同时列出两者，不自行改写年份或署名。

| 字体 | 本地内嵌版本（不是生成工具版本） | 原始许可 |
|---|---|---|
| noto-sans | Version 2.015 | [OFL 原文](licenses/OFL-noto-sans.txt) |
| noto-sans-jp | Version 2.004-H2;hotconv 1.0.118;makeotfexe 2.5.65603 | [OFL 原文](licenses/OFL-noto-sans-jp.txt) |
| noto-sans-kr | Version 2.004-H2;hotconv 1.0.118;makeotfexe 2.5.65603 | [OFL 原文](licenses/OFL-noto-sans-kr.txt) |
| noto-sans-arabic | Version 2.012 | [OFL 原文](licenses/OFL-noto-sans-arabic.txt) |
| noto-sans-hebrew | Version 3.001 | [OFL 原文](licenses/OFL-noto-sans-hebrew.txt) |
| noto-sans-armenian | Version 2.008 | [OFL 原文](licenses/OFL-noto-sans-armenian.txt) |
| noto-sans-georgian | Version 2.005 | [OFL 原文](licenses/OFL-noto-sans-georgian.txt) |
| noto-sans-devanagari | Version 2.006 | [OFL 原文](licenses/OFL-noto-sans-devanagari.txt) |
| noto-sans-bengali | Version 3.011 | [OFL 原文](licenses/OFL-noto-sans-bengali.txt) |
| noto-sans-tamil | Version 2.004 | [OFL 原文](licenses/OFL-noto-sans-tamil.txt) |
| noto-sans-telugu | Version 2.005 | [OFL 原文](licenses/OFL-noto-sans-telugu.txt) |
| noto-sans-gujarati | Version 2.106 | [OFL 原文](licenses/OFL-noto-sans-gujarati.txt) |
| noto-sans-kannada | Version 2.006 | [OFL 原文](licenses/OFL-noto-sans-kannada.txt) |
| noto-sans-malayalam | Version 2.104 | [OFL 原文](licenses/OFL-noto-sans-malayalam.txt) |
| noto-sans-gurmukhi | Version 2.004 | [OFL 原文](licenses/OFL-noto-sans-gurmukhi.txt) |
| noto-sans-sinhala | Version 2.006 | [OFL 原文](licenses/OFL-noto-sans-sinhala.txt) |
| noto-sans-thai | Version 2.002 | [OFL 原文](licenses/OFL-noto-sans-thai.txt) |
| noto-sans-khmer | Version 2.004 | [OFL 原文](licenses/OFL-noto-sans-khmer.txt) |
| noto-sans-lao | Version 2.003 | [OFL 原文](licenses/OFL-noto-sans-lao.txt) |
| noto-sans-myanmar | Version 2.107 | [OFL 原文](licenses/OFL-noto-sans-myanmar.txt) |
| noto-sans-ethiopic | Version 2.102 | [OFL 原文](licenses/OFL-noto-sans-ethiopic.txt) |
| noto-sans-symbols2 | Version 2.008; ttfautohint (v1.8.4.7-5d5b) | [OFL 原文](licenses/OFL-noto-sans-symbols2.txt) |
| noto-sans-sc | Version 2.004-H2;hotconv 1.0.118;makeotfexe 2.5.65603 | [OFL 原文](OFL-NotoSansSC.txt) |
| noto-emoji | Version 2.001 | [OFL 原文](OFL-NotoEmoji.txt) |

## 本地修改与核验边界

- Sans 字体为现有 Regular 400 / Medium 500 静态分片；fallback 生成时移除了布局/塑形表。Emoji 是现有静态轮廓字体。具体渲染限制见上层 [第三方说明](../../THIRD_PARTY_LICENSES.md)。
- 本地文件指纹证明本轮保留了哪些字节；字体内部版本和版权记录不是上游可变字体文件的 SHA-256。历史输入文件指纹、完整生成工具版本及可复现分片脚本未保留，不能把本索引称为已重建生成链。
- 原始 OFL 与字体文件一同进入源码包和安装包；Git 不转换许可原文的换行和空白。统一检查会阻止漏文件、未登记的新字体或指纹不一致的候选包生成。
