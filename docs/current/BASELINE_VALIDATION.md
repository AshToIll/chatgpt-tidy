# 0.4.0 → 0.5.0 架构迁移前基线验证

## 1. 目的与边界

本文件记录**迁移开始之前已有的行为和测试结果**，用于判断 0.5.0 架构整理是否引入回归。它不是对真实账号、生产网页或安装包的验收声明。

- 源版本：0.4.0。
- 源 Git HEAD：`c6248d51517503b2844d27ed9b9eddf03c7e5bc9`。
- 目标版本：0.5.0。
- 基线浏览器检查在目标的独立临时 checkout 中运行，不与正在迁移的源码共用工作区，也不使用共享 Git 对象或硬链接。
- 对源目录只读：迁移前及本文写入前再次执行 `git rev-parse HEAD`、`git status --short`、`git diff --stat`、`git diff --cached --stat`，HEAD 一致，后三项输出均为空。
- 本次没有针对发现的导航问题修复业务逻辑，也没有删除或弱化失败的验收测试。

## 2. 环境与步骤

| 项目 | 基线 |
| --- | --- |
| Node.js | v24.12.0 |
| npm | 11.6.2 |
| 开发依赖安装 | `npm ci --offline --ignore-scripts` 成功 |
| 唯一开发依赖 | `fake-indexeddb@6.2.5` |
| 浏览器 | Chrome、Edge，均使用全新的隔离测试配置 |
| 网络与账号 | 合成页面 / 本地测试；未访问真实账号配置；失败夹具的网络尝试为 0 |
| 浏览器运行时间 | 2026-09-29 02:27:32 至 02:30:05，UTC+08:00 |

执行顺序：

1. 在未迁移的 0.5.0 副本运行 `npm run verify`，记录初始 bundle 字节检查结果。
2. 独立执行完整 Node 测试，避免 bundle 字节差异遮蔽业务测试结果。
3. 只在目标运行原构建器 `npm run build`，再运行 `npm run verify`。
4. 从源 HEAD 创建独立 checkout，离线安装依赖，按原构建器重建 bundle，运行 `npm run verify:release`。
5. 保留所有原始日志、结构化回执以及失败断言，不以测试通过代替真实账号验收。

## 3. 结果汇总

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 未迁移完整 Node 测试 | **通过** | 143 个测试文件，2383 项通过，0 失败、0 跳过 |
| 初始 `verify` | 未通过 | bundle 字节检查发现换行差异，见下一节 |
| 原构建器重建后的 `verify` | **通过** | bundle 检查、第三方材料检查、2383 项测试均通过 |
| Chrome 隔离浏览器 | 12 / 13 通过 | 仅 `panel-current-protocol` 失败 |
| Edge 隔离浏览器 | 12 / 13 通过 | 同一 `panel-current-protocol` 断言失败 |
| 浏览器检查期间源码稳定性 | **通过** | 起止指纹完全一致 |
| 真实账号 / 真实 ChatGPT 页面验收 | **未运行** | 不能据合成夹具推定已通过 |
| 用户正式安装 / 候选安装包验收 | **未运行** | 不修改用户现有扩展或浏览器配置 |

浏览器总计 **26 项检查：24 通过，2 失败**。另有源测试和源码稳定性两项通过，因此发布报告总计为 28 项、26 通过、2 失败。不要把报告中的 26 通过误写为浏览器全部通过。

### 3.1 初始 bundle stale 是换行问题，不是业务源码不一致

原生成文件：`src/adapters/chatgpt/main-world.bundle.js`。

| 证据 | 原 checkout 文件 | 原构建器重建后 |
| --- | --- | --- |
| 字节数 | 326144 | 326062 |
| CRLF 数 | 6857 | 6775 |
| LF 总数 | 6857 | 6857 |
| SHA-256 | `de3474e6ee6c3322c7d4009acee4e40e79a95eacb09951c8943f9cfa5f5b1af5` | `0b09a286f2031ee96ed447498cfe82ec08c738000d0c2da2588f4fdcb74b11c4` |

将 CRLF 归一化为 LF 后，两个文件的内容**完全一致**；Git 语义 diff 为空。原构建器直接拼接 checkout 文本，而其生成的分隔行采用 LF，所以 Windows checkout 与重建结果出现 82 字节的差异。

因此不能把这个现象描述成“0.4.0 漏打包了业务修改”。可复现构建中的换行规范是架构 / 工具层问题，应与业务行为变更分开说明。

## 4. 已知的原版本导航回执问题

### 4.1 精确失败

Chrome、Edge 均失败于：

```text
Error: Exact terminal receipt reaches the real panel: true !== false
```

原测试来源：

- `tests/browser/plugin-navigation.mjs:296–299`。
- 测试先发送错误标签页、错误导航编号、错误消息编号的回执，确认它们不能完成当前操作。
- 随后发送完全匹配的终态回执，预期真实侧栏展示完成反馈。
- 实际反馈仍隐藏，断言失败。两次检查均无页面错误、无外部网络尝试。

### 4.2 原代码中的因果链

原 HEAD 的代码位置：

1. `src/sidepanel/panel.js:1524–1529`，函数 `completeNavigation(payload)`。
2. `src/sidepanel/bookmark-navigation.js:17–24`，内部函数 `complete(result)`。

`completeNavigation(payload)` 先检查标签页 ID、导航意图 ID 和 `located` 类型，然后**先写入** `state.completedNavigationResultId`，再调用 `bookmarkNavigation.complete(payload)`。

书签内部的 `complete(result)` 才继续精确检查会话 ID 和消息 ID。因此以下顺序会发生：

```text
同一导航意图的错误消息回执先到达
→ 外层提前记为“已经完成”
→ 书签内部发现消息 ID 不匹配，正确拒绝这个回执
→ 正确消息回执随后到达
→ 外层以“已经完成”为由丢弃
→ 书签完成状态和反馈没有收到正确回执
```

这不是凭文案推测的缓存问题；它由原 HEAD 中的条件执行顺序与原浏览器夹具的失败共同支持。

### 4.3 迁移后对应位置

迁移后查找：

- `src/app/sidepanel/panel.js` → `completeNavigation(payload)`。
- `src/features/bookmarks/ui/bookmark-navigation.js` → `createBookmarkNavigation()` 内的 `complete(result)`。
- `tests/browser/plugin-navigation.mjs` → 断言文字 `Exact terminal receipt reaches the real panel`。

迁移会改变行号，应使用函数名和断言文字定位；原 HEAD 路径及行号仅作为冻结证据。

### 4.4 本次处理原则

- **这是原 0.4.0 已存在的问题，不是 0.5.0 架构迁移引入。**
- 本次仅整理架构，不借迁移之名修改导航完成条件、提示触发行为或业务语义。
- 不删除、不跳过、不弱化这个验收测试；最终报告应如实区分“基线已有失败”和“新增回归”。
- 此问题以后若修复，应作为独立行为变更处理，补齐回归证据；不能仅修改测试预期使其变绿。

## 5. 历史证据与公开范围

本记录保留迁移前的结果、源码指纹和失败原因；原始日志、临时 checkout、浏览器配置与会话材料不随公开源码分发，也不是构建依赖。历史提交标识用于说明版本来源，不要求公开仓库包含原开发历史。

发布检查起止源码指纹均为：

`3e6fdf8f498abf8b225fc072f3bc5bdbc383326192611304295fea803119f820`

## 6. 后续迁移验收如何对照

1. 检查源码迁移映射、模块装配、资源引用、构建输出和测试入口是否全部指向新目录，不保留旧路径兼容。
2. 原有 2383 项 Node 测试应全部继续通过；新增架构检查另计。
3. 浏览器检查逐项与本基线对照，任何新失败都是需要调查的回归；现有两个失败不能静默消失或被记作“全部通过”。
4. 真实安装和真实账号验收仍应独立标记，不能因为 Node 或隔离浏览器测试通过就宣称已验收生产场景。

## 7. 历史记录与当前验证

以上结果属于迁移前基线，不重写为当前版本验收。当前修复与验证结果见 [VALIDATION](VALIDATION.md)；开发与检查步骤见 [DEVELOPMENT](DEVELOPMENT.md)。公开源码保留可重新运行的测试，不要求恢复历史临时目录或原始会话材料。
