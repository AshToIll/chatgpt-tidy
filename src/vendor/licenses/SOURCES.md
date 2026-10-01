# 本地库许可证来源与核验边界

本目录记录现有三个 PDF/ZIP 分发文件及 regenerator-runtime 的可核实许可证正文与原始声明，**没有更新或修改库文件**。最近一次上游核对：2026-09-19。
这是已核实正文及缺口清单，**不是全部第三方版权事项已经闭合的声明**。
机器可读的来源、包内路径、文件 SHA-256 和具体缺口见 [SOURCES.json](SOURCES.json)。

## 1. 直接分发文件：已逐字节核实版本

以下本地文件与官方 npm 注册表版本化发布包中的对应文件完全一致；同时校验了下载发布包的注册表 SHA-1。

| 本地文件 | 官方发布包与包内成员 | 本地许可证/声明 |
|---|---|---|
| `../pdf-lib-1.17.1.min.js` | [pdf-lib 1.17.1](https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz) → `package/dist/pdf-lib.min.js` | [完整 MIT 正文](pdf-lib-1.17.1-LICENSE.md) |
| `../fontkit-1.1.1.min.js` | [@pdf-lib/fontkit 1.1.1](https://registry.npmjs.org/@pdf-lib/fontkit/-/fontkit-1.1.1.tgz) → `package/dist/fontkit.umd.min.js` | [MIT 声明、元数据署名及同版本未压缩包的原始内嵌版权声明](pdf-lib-fontkit-1.1.1-NOTICES.txt)；顶层完整正文缺口未闭合 |
| `../jszip-3.10.1.min.js` | [JSZip 3.10.1](https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz) → `package/dist/jszip.min.js` | [完整官方双许可证文档](jszip-3.10.1-LICENSE.markdown)；本项目仍选择 MIT 使用，不因保留 GPL 备选正文而改变选择 |
| `../regenerator-runtime-0.14.1.js` | [regenerator-runtime 0.14.1](https://registry.npmjs.org/regenerator-runtime/-/regenerator-runtime-0.14.1.tgz) → `package/runtime.js` | [完整 MIT 原文](../REGENERATOR-RUNTIME-LICENSE.txt)，代码与许可均与发布包逐字节一致 |

直接文件 SHA-256：

```text
pdf-lib-1.17.1.min.js  0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f
fontkit-1.1.1.min.js  d8df561b9fba98e24f2e5130e40948809281bbbc55a20c412359f1a0a5eb35a6
jszip-3.10.1.min.js   acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e
```

## 2. pdf-lib 内嵌依赖：源码内容已核实

使用同一官方发布包 `package/dist/pdf-lib.min.js.map` 的 `sourcesContent`，与各版本官方 npm 包的对应源文件进行逐字符比较：

| 组件 | 匹配源文件数 | 本地正文 |
|---|---:|---|
| tslib 1.11.1 | 1 | [Apache-2.0 完整正文](tslib-1.11.1-LICENSE.txt)、[Microsoft 原始版权声明](tslib-1.11.1-CopyrightNotice.txt) |
| @pdf-lib/standard-fonts 1.0.0 | 3 | [MIT](pdf-lib-standard-fonts-1.0.0-LICENSE.md) |
| @pdf-lib/upng 1.0.1 | 1 | [MIT / Photopea](pdf-lib-upng-1.0.1-LICENSE) |
| pako 1.0.10（standard-fonts 与 upng 各有一份） | 32 | [MIT](pako-1.0.10-LICENSE)、[Zlib 源头声明](pako-zlib-NOTICES.txt) |
| pako 1.0.11（pdf-lib 直接依赖） | 16 | [MIT](pako-1.0.11-LICENSE)、[Zlib 源头声明](pako-zlib-NOTICES.txt) |

上述 53 个源文件全部匹配，无未匹配项。不要把 tslib 1.11.1 误记为新版 tslib 的许可证；这个实际内嵌版本使用 **Apache-2.0**。
版本化辅助来源：[pdf-lib v1.17.1 yarn.lock](https://github.com/Hopding/pdf-lib/blob/v1.17.1/yarn.lock)。

## 3. JSZip 浏览器包内嵌依赖

同版本 `package/dist/jszip.js` 的模块映射与官方 [v3.10.1 package-lock.json](https://github.com/Stuk/jszip/blob/v3.10.1/package-lock.json) 对应：

| 组件 | 浏览器包证据 | 本地正文 |
|---|---|---|
| pako 1.0.5 | 模块 38；13 个库源文件在去除注释/空白后与该官方版本匹配 | [MIT](pako-1.0.5-LICENSE)、[Zlib 源头声明](pako-zlib-NOTICES.txt) |
| lie 3.3.0 | 模块 37，版本来自发布标签锁文件 | [MIT](lie-3.3.0-license.md) |
| immediate 3.0.6 | 模块 36，版本来自发布标签锁文件 | [MIT](immediate-3.0.6-LICENSE.txt) |
| setimmediate 1.0.5 | 模块 54，版本来自发布标签锁文件 | [MIT](setimmediate-1.0.5-LICENSE.txt) |

该包共有 54 个模块。`readable-stream` 在此浏览器包映射到 JSZip 自有的浏览器替代模块 16，`stream` 映射到空模块 53；不能仅从 npm 依赖表推断它们及其全部 Node.js 依赖也在分发包内。

## 4. fontkit 已补入的内嵌声明与部分依赖正文

`@pdf-lib/fontkit` 的同版本未压缩构建可确认其内嵌了 Google Brotli 解码器的 Apache-2.0 声明以及 base64-arraybuffer 的 MIT 版权声明；原始版权注释完整保留在 [fontkit NOTICES](pdf-lib-fontkit-1.1.1-NOTICES.txt)。
其中 Google 的 Apache-2.0 许可全文由 [本地 Apache-2.0 正文](tslib-1.11.1-LICENSE.txt)提供，Google 的版权声明仍单独保留，不能被 fork 的顶层 MIT 元数据覆盖。

fontkit 1.1.1 发布包不含 sourcemap 或 `gitHead`，也没有可核对的同名发布标签。
以下版本参考官方 fork [固定提交的 yarn.lock](https://github.com/Hopding/fontkit/blob/72b8e42bd6a398d496a63a6d483eabeed43861fb/yarn.lock)，结合未压缩构建中可观察到的模块识别。
这属于**组件级声明与补充覆盖**，不等于逐字节重建或精确内部版本证明。

| 组件/版本 | 本地原文 |
|---|---|
| @pdf-lib/unicode-properties 0.0.1 | [MIT](pdf-lib-unicode-properties-0.0.1-LICENSE)；保留上游实际 `Copyright 2018` 行，不自行补写作者 |
| base64-arraybuffer 0.1.5 | [MIT](base64-arraybuffer-0.1.5-LICENSE-MIT) |
| buffer 5.6.0 | [MIT](buffer-5.6.0-LICENSE) |
| base64-js 1.3.0 / 1.3.1 | [1.3.0 MIT](base64-js-1.3.0-LICENSE)、[1.3.1 MIT](base64-js-1.3.1-LICENSE) |
| ieee754 1.1.13 | [BSD-3-Clause](ieee754-1.1.13-LICENSE) |
| clone 1.0.4 | [MIT](clone-1.0.4-LICENSE) |
| tiny-inflate 1.0.3 | [MIT](tiny-inflate-1.0.3-LICENSE)；不能据此反推 1.0.2 原始正文已找到 |
| pako 1.0.11 | [MIT](pako-1.0.11-LICENSE)、[Zlib 源头声明](pako-zlib-NOTICES.txt) |
| @pdf-lib/brotli 0.0.0、@pdf-lib/restructure 0.0.1 | [官方 MIT 元数据声明及缺口](fontkit-fork-DECLARATIONS.txt) |
| tiny-inflate 1.0.2、unicode-trie 0.3.1 | [官方 MIT 元数据声明及缺口](fontkit-runtime-DECLARATIONS.txt) |

## 5. 尚未闭合，发布记录不能省略

1. **fontkit 顶层原文缺失**：`@pdf-lib/fontkit 1.1.1` 发布包没有 LICENSE/COPYING 或正式顶层版权正文，只有 MIT 元数据与 README 链接。原项目也有仍未关闭的 [LICENSE 缺失 issue #255](https://github.com/foliojs/fontkit/issues/255)。不能臆造年份、版权所有者或把通用 MIT 模板称为恢复的上游原文。
2. **部分 fork/旧版依赖有同类缺口**：`@pdf-lib/brotli 0.0.0`、`@pdf-lib/restructure 0.0.1`、`tiny-inflate 1.0.2`、`unicode-trie 0.3.1` 的发布包没有完整顶层许可文件；其实际声明与可取得的内嵌条款已另存。
3. **fontkit 完整传递依赖审计仍待完成**：本轮补入下节已识别组件的原文，但没有重建全部内嵌模块或证明每一内部版本。不能把此目录标为完整 SBOM 或全部许可证已闭合。
4. **Node shim 顶层正文缺口**：固定 fork 锁文件中的 `rollup-plugin-node-builtins 2.1.2` 声明 ISC、`rollup-plugin-node-globals 1.4.0` 声明 MIT；二者发布包及本轮核对的 gitHead 常见 LICENSE 路径未取得完整顶层正文。包内 Node 派生代码另有原始 MIT 声明，不能只用插件元数据覆盖它。

2026-09-19 核对时，fontkit 原项目的 [issue #255](https://github.com/foliojs/fontkit/issues/255) 和补 LICENSE 的 [PR #300](https://github.com/foliojs/fontkit/pull/300) 均仍未关闭/合并。未合并 PR 的模板不作为已经发布的作者许可原文。

## 6. 本轮补入的 fontkit 组件声明

以下组件在 1.1.1 未压缩发布文件中可观察到对应代码；候选版本取自第 4 节固定 fork 锁文件。**原文文件本身逐字节核对通过，不等于精确还原了构建时的内部版本。** 每项的包内路径、SHA-256 与代码识别标记列在 [SOURCES.json](SOURCES.json)。

| 组件 | 本地材料 |
|---|---|
| iconv-lite 0.4.24、safer-buffer 2.1.2 | [MIT](iconv-lite-0.4.24-LICENSE.txt)、[MIT](safer-buffer-2.1.2-LICENSE.txt) |
| deep-equal 1.1.1、is-arguments 1.0.4 | [MIT](deep-equal-1.1.1-LICENSE.txt)、[MIT](is-arguments-1.0.4-LICENSE.txt) |
| is-date-object 1.0.2、is-regex 1.0.5 | [MIT](is-date-object-1.0.2-LICENSE.txt)、[MIT](is-regex-1.0.5-LICENSE.txt) |
| object-is 1.1.2、object-keys 1.1.1 | [MIT](object-is-1.1.2-LICENSE.txt)、[MIT](object-keys-1.1.1-LICENSE.txt) |
| define-properties 1.1.3、function-bind 1.1.1 | [MIT](define-properties-1.1.3-LICENSE.txt)、[MIT](function-bind-1.1.1-LICENSE.txt) |
| has-symbols 1.0.1、has 1.0.3 | [MIT](has-symbols-1.0.1-LICENSE.txt)、[MIT](has-1.0.3-LICENSE.txt) |
| es-abstract 1.17.5、regexp.prototype.flags 1.3.0 | [MIT](es-abstract-1.17.5-LICENSE.txt)、[MIT](regexp.prototype.flags-1.3.0-LICENSE.txt) |
| rollup-plugin-node-builtins 2.1.2、rollup-plugin-node-globals 1.4.0 | [ISC 元数据与缺口](rollup-plugin-node-builtins-2.1.2-DECLARATIONS.txt)、[MIT 元数据与缺口](rollup-plugin-node-globals-1.4.0-DECLARATIONS.txt) |
| string_decoder / Node 派生代码 | [发布包中原始 Joyent/Node MIT 注释](fontkit-node-NOTICES.txt) |

`*-LICENSE*` / `license.md` 文件均直接保留官方发布包原始字节；没有重新排版或替换版权行。
`*-NOTICES.txt` / `*-DECLARATIONS.txt` 则明确区分整理说明、原始声明和缺口。
字体材料独立列于 [字体来源索引](../../assets/fonts/SOURCES.md)。离线验证入口 `tools/check-third-party.cjs` 检查登记文件、原文指纹和完整收集；结果明确保留缺口，不会把可构建的本地候选包标成已完成公开许可验收。
