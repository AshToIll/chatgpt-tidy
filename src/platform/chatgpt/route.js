(function initTidyChatgptRoute(global) {
  "use strict";

  if (global.TidyChatgptRoute) return;
  const snapshotContract = global.TidySnapshot;
  if (!snapshotContract) return;

  const DRAFT_PREFIX = "WEB:";

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function isDraftId(value) {
    return typeof value === "string" && value.startsWith(DRAFT_PREFIX);
  }

  function parse(input = global.location.href) {
    let url;
    try {
      url = new URL(input, global.location.origin);
    } catch {
      return {
        supported: false,
        href: String(input || ""),
        pathname: "",
        kind: "unsupported",
        conversationId: null,
        projectId: null,
        identityStatus: "unavailable",
      };
    }

    const supported = url.hostname === "chatgpt.com";
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
    const projectIndex = segments.findIndex((segment) => /^g-p-[A-Za-z0-9_-]+$/.test(segment));
    const conversationIndex = segments.lastIndexOf("c");
    const groupIndex = segments.indexOf("gg");
    let conversationId = null;
    let kind = "home";

    if (groupIndex >= 0 && segments[groupIndex + 1]) {
      conversationId = segments[groupIndex + 1];
      kind = "group";
    } else if (conversationIndex >= 0 && segments[conversationIndex + 1]) {
      conversationId = segments[conversationIndex + 1];
      kind = projectIndex >= 0 ? "project-conversation" : "conversation";
    } else if (projectIndex >= 0) {
      kind = "project";
    }

    return {
      supported,
      href: url.href,
      pathname: url.pathname,
      kind,
      conversationId,
      projectId: projectIndex >= 0 ? snapshotContract.projectIdFromSegment(segments[projectIndex]) : null,
      identityStatus: conversationId
        ? isDraftId(conversationId)
          ? "draft"
          : "stable"
        : kind === "home" || kind === "project"
          ? "empty"
          : "unavailable",
    };
  }

  global.TidyChatgptRoute = Object.freeze({ DRAFT_PREFIX, isDraftId, parse });
})(globalThis);
