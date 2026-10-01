# ChatGPT Tidy 文档入口

这里说明 **0.5.0 架构候选**的当前源码与契约；产品 manifest/package 已同步为 0.5.0。本地构建不等于已对外发布，验收范围以 [本次验证记录](current/VALIDATION.md) 为准。

## 产品经理先看

1. [文件职责树](current/FILE_GUIDE.md)：完整业务树、每个文件做什么，以及七栏的入口。
2. [七栏功能契约](current/FEATURE_CONTRACTS.md)：每栏输入输出、状态所有者、共享底座、取消和跨栏协作。
3. [提示与文案索引](current/MESSAGE_INDEX.md)：从屏幕文字找到稳定键、显示代码、出现原因、下一步和消失条件。
4. [文案维护入口](../src/messages/README.md)：哪些是唯一手写源，哪些文件必须生成。

## 开发与核对

- [架构与运行边界](current/ARCHITECTURE.md)：组合根、控制器、呈现、消息方向与运行环境。
- [存储与备份](current/STORAGE.md)：数据库、账号隔离、备份、导出回执与会话诊断的不同边界。
- [开发与检查](current/DEVELOPMENT.md)：修改入口、生成顺序、诊断取证、测试和打包。
- [发布清单](current/RELEASE_CHECKLIST.md)：发布前逐项确认，不以自动检查代替真实账号验收。

## 执行记录与机器可读资料

- [深度整理方案](current/REFACTOR_PLAN.md)：本轮范围、状态所有权与交互治理准则。
- [本次验证记录](current/VALIDATION.md)：已执行检查、修复证据、产物与尚未验收的范围。
- [迁移前基线](current/BASELINE_VALIDATION.md)：原版本检查结果；历史失败不代表当前允许继续失败。
- [第一阶段路径映射](current/MIGRATION_MAP.json)：原文件的归位证据，不是现行兼容层或完整当前树。
- [行为基线](current/BEHAVIOR_BASELINE.json)：迁移前约束；明确批准的变更单独核对，不能整体重录掩盖差异。
- [完整提示索引数据](current/MESSAGE_INDEX.json)：四语言文字、引用、动态调用与扫描局限。
- [开发依赖清单](current/DEVELOPMENT_DEPENDENCIES.json)：开发依赖版本与许可。

## 维护约定

- 七栏各有功能目录；共享身份、连接、导航、资料和目录只有一套，不复制七份。
- 入口装配窄接口；业务控制器写状态，呈现层读取投影，不靠绘制顺序改变业务。
- 产品文案唯一手写源在 `src/messages/catalogs/`。提示的触发、原因、下一步、替换和清除条件由所属业务及公共生命周期控制，登记在提示索引。
- 短暂反馈可以到期消失；写入结果未知、阻塞恢复和进行中任务不能靠 toast 超时伪装成已经结束。
- 源码改变时更新这些现行文档及生成索引，不新增平行规格，不保留旧路径别名或兼容壳。
- 临时日志、截图和取证放 `.tmp/`；个人设计草稿在 `docs/design-preview/`，均非生产依赖。
- 不把职责拆分称为“彻底无 bug”；代码回归、合成浏览器、真实账号与发布产物的证据分别报告。
