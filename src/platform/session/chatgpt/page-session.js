// MAIN 跟随同一文档的 ISOLATED 停机信号，不能靠旧的 ready DOM 标记恢复。
globalThis.TidyPageSession = globalThis.TidyPageSessionContract.create();
