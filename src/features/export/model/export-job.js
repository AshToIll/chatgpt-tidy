// 导出任务合同：设置属于下一次导出，任务保存点击时的快照。全扩展只运行一个任务，不隐式排队。
(function (root) {
  'use strict';
  const ACTIVE = ['starting', 'generating', 'saving', 'cancelling'];
  const PHASES = ['preparing', 'resources', 'files', 'packaging', 'saving'];
  // 产品可调等待上限：单个资源最多 60 秒；整次生成最多 15 分钟。
  // 超时不是成功，也不自动重试；用户可检查提示后重新发起。
  const RESOURCE_TIMEOUT_MS = 60_000, GENERATION_TIMEOUT_MS = 15 * 60_000;
  const active = job => ACTIVE.includes(job?.state);
  const terminal = job => ['completed', 'failed', 'cancelled'].includes(job?.state);
  // 结果提示的可见时间：成功/取消 6 秒，有内容提醒 12 秒；失败由用户关闭。
  // 查看详情、悬停或键盘操作时暂停，离开导出页不消耗阅读时间。
  const NOTICE_MS = 6_000, WARNING_NOTICE_MS = 12_000;
  // PDF 需要图片字节，JSON 保留已解析资源；MD/TXT 只写说明和已有链接，不请求图片地址。
  const needsImageResolution = format => format === 'pdf' || format === 'json';
  // 需要解析的图片必须准备完成，后台也执行相同边界，不能绕过按钮提交半成品。
  function pendingImages(plan) {
    if (!needsImageResolution(plan.format)) return false;
    try {
      return (plan.files || []).some(file => {
        const selections = file.kind === 'conversation' ? file.conversations.map(conversation => ({ conversation, messages: conversation.messages }))
          : file.bookmarkEntries.map(entry => ({ conversation: entry.conversation, messages: [entry.message] }));
        return selections.some(({ conversation, messages }) => {
          const ids = new Set((messages || []).flatMap(message => (message.segments || []).flatMap(segment =>
            (segment.blocks || []).filter(block => block.type === 'image').map(block => block.resourceId))));
          return (conversation.resources || []).some(resource => resource.pending && ids.has(resource.id));
        });
      });
    } catch { return true; } // 不完整的数据结构也不能按“图片已准备好”放行。
  }
  function validSpec(spec) {
    const p = spec?.plan;
    return Boolean(p && ['markdown', 'json', 'txt', 'pdf'].includes(p.format)
      && typeof p.outputName === 'string' && p.outputName.length > 0 && p.outputName.length < 200
      && !/[\\/\u0000-\u001f]/.test(p.outputName) && !/^\.+$/.test(p.outputName)
      && Array.isArray(p.files) && p.files.length && p.files.every(f => f && typeof f.path === 'string'
        && !f.path.split(/[\\/]/).some(part => !part || part === '..') && !/^[\\/]|:|[\u0000-\u001f]/.test(f.path)
        && (f.kind === 'conversation' ? Array.isArray(f.conversations) && f.conversations.length > 0
          : f.kind === 'bookmark-excerpt' && Array.isArray(f.bookmarkEntries) && f.bookmarkEntries.length > 0))
      && p.messages && typeof p.messages === 'object' && spec.context && typeof spec.context === 'object'
      && Array.isArray(spec.warnings) && spec.warnings.every(w => typeof w === 'string') && !pendingImages(p));
  }
  function receipt(record, owner) {
    if (!record) return null;
    if (record.owner.tabId !== owner.tabId || record.owner.accountKey !== owner.accountKey) return active(record) ? { state: 'busy' } : null;
    // 不把 blob URL、签名地址、正文或账号标识广播到其他页面。
    return { id: record.id, revision: record.revision, state: record.state, outputName: record.outputName,
      progress: record.progress, warnings: record.warnings || [], errorCode: record.errorCode || '',
      startedAt: record.startedAt, updatedAt: record.updatedAt, dismissedAt: record.dismissedAt || null };
  }
  root.TidyExportJobs = Object.freeze({ active, terminal, validSpec, receipt, needsImageResolution, PHASES, RESOURCE_TIMEOUT_MS, GENERATION_TIMEOUT_MS, NOTICE_MS, WARNING_NOTICE_MS });
})(globalThis);
