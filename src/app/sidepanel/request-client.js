/**
 * 侧栏唯一请求出口。传输只验证协议；业务准入由注入的 session.run 决定。
 * 不读取浏览器焦点，不签发账号身份，也不重放失败命令。
 */
export function createPanelRequestClient({ runtime, protocol, run }) {
  async function transmit(type, payload = null) {
    const envelope = protocol.request(type, payload);
    let result;
    try { result = await runtime.sendMessage(envelope); }
    catch (cause) {
      throw Object.assign(new Error("The extension request could not reach the background worker."), {
        code: protocol.ErrorCode.ADAPTER_UNAVAILABLE, requestId: envelope.requestId,
        details: { stage: "sidepanel.runtime-send-message", disconnect: protocol.runtimeDisconnectReason(cause) }, cause,
      });
    }
    if (!protocol.isResponse(result, envelope.requestId)) {
      throw Object.assign(new Error("Invalid extension response"), {
        code: protocol.ErrorCode.INVALID_ENVELOPE, requestId: envelope.requestId,
        details: { stage: "sidepanel.runtime-response" },
      });
    }
    if (!result.ok) {
      throw Object.assign(new Error(result.error?.message || "Extension request failed"), {
        code: result.error?.code || protocol.ErrorCode.INTERNAL_ERROR,
        requestId: envelope.requestId, details: result.error?.details || null,
      });
    }
    return result.payload;
  }
  return Object.freeze({ transmit, send: (type, payload = null) => run(type, () => transmit(type, payload)) });
}
