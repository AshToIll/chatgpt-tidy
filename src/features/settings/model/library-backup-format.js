// 本地资料备份与聊天 JSON 导出是两种文件，不互相猜测或兼容。
export const LIBRARY_BACKUP_FORMAT = "chatgpt-tidy.library-backup";
export const LIBRARY_BACKUP_VERSION = 1;
// 限制一次导入的内存和事务规模；单位为字节/条数，可在此统一调整。
export const LIBRARY_BACKUP_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, items: 20_000, groups: 500 });

export function backupError(code) {
  return Object.assign(new Error(code), { code, tidyCode: code });
}
