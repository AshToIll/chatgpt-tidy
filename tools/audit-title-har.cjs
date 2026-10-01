/* Local HAR evidence only. No network, browser or credentials are used.
 * Never print headers, cookies, titles, message bodies, conversation/account IDs
 * or arbitrary query parameters. Exact IDs/URLs are used only in memory to pair
 * observations and detect duplicate requests, then replaced by safe labels.
 * Usage: node tools/audit-title-har.cjs <absolute.har> [--from <ISO timestamp>]
 * --from must be the known F5 start; omission means "whole capture", NOT F5.
 */
const fs = require("node:fs");
const path = require("node:path");

function routeFor(raw) {
  let url;
  try { url = new URL(raw); } catch { return { kind: "other", endpoint: "(invalid URL)" }; }
  if (url.origin !== "https://chatgpt.com") return { kind: "other", endpoint: "(other origin)" };
  const p = url.pathname;
  if (p === "/api/auth/session") return { kind: "identity", endpoint: p };
  if (p === "/backend-api/conversations" || p === "/backend-api/pins" || p === "/backend-api/gizmos/snorlax/sidebar") {
    return { kind: "directory", endpoint: p };
  }
  if (/^\/backend-api\/gizmos\/[^/]+\/conversations$/.test(p)) {
    return { kind: "directory", endpoint: "/backend-api/gizmos/:project/conversations" };
  }
  if (/^\/backend-api\/conversations\/[^/]+$/.test(p)) return { kind: "detail", endpoint: "/backend-api/conversations/:conversation" };
  if (/^\/backend-api\/conversation\/[^/]+$/.test(p)) return { kind: "other", endpoint: "/backend-api/conversation/:conversation" };
  if (/^\/backend-api\/conversation\/id\/[^/]+\/rename$/.test(p)) return { kind: "write", endpoint: "/backend-api/conversation/id/:conversation/rename" };
  return { kind: "other", endpoint: "(other ChatGPT request)" };
}

function framesFor(entry) {
  const frames = [], seen = new Set();
  for (let stack = entry._initiator?.stack; stack && !seen.has(stack); stack = stack.parent) {
    seen.add(stack);
    frames.push(...stack.callFrames || []);
  }
  return frames;
}

const isTidyFrame = frame => typeof frame.url === "string"
  && /(?:^|\/)app\/page\/main-world(?:\.bundle)?\.js(?:[?#]|$)/.test(frame.url);

function initiatorFor(entry) {
  const frames = framesFor(entry), urls = frames.map(frame => frame.url).filter(url => typeof url === "string");
  if (entry._initiator?.url) urls.push(entry._initiator.url);
  // A missing stack or generic fetch call is not proof of TIDY ownership.
  if (frames.some(isTidyFrame)) return "tidy-stack";
  if (urls.some(url => url.startsWith("chrome-extension://"))) return "other-or-unidentified-extension";
  if (urls.some(url => /^https:\/\/chatgpt\.com\//.test(url))) return "chatgpt-stack";
  return "unknown";
}

function requestFamily(entry) {
  const frames = framesFor(entry), tidy = frames.filter(isTidyFrame);
  if (tidy.some(frame => frame.functionName === "ensureCurrentConversationMeta")) return "tidy-current-metadata";
  if (tidy.some(frame => frame.functionName === "freshAuth")) return "tidy-title-auth";
  if (tidy.some(frame => frame.functionName === "loadSession")) return "tidy-catalog-auth";
  if (tidy.length) return "tidy-other";
  // A fetch wrapper alone is not ownership. This named caller chain is stronger
  // evidence of an independent extension's scan. Its installed name must still
  // be verified separately, without including extension IDs in this report.
  const extension = frames.filter(frame => typeof frame.url === "string" && frame.url.startsWith("chrome-extension://"));
  if (extension.some(frame => frame.functionName === "fetchPage")
    && extension.some(frame => frame.functionName === "loadConversationsByArchivedState")) return "other-extension-directory-scan";
  return "unattributed";
}

function paginationFor(entry) {
  let url;
  try { url = new URL(entry.request?.url); } catch { return null; }
  if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/conversations") return null;
  const values = {};
  for (const key of ["offset", "limit"]) {
    const value = url.searchParams.get(key);
    if (value !== null && /^\d{1,8}$/.test(value)) values[key] = Number(value);
  }
  for (const key of ["is_archived", "is_starred", "hide_snorlax"]) {
    const value = url.searchParams.get(key);
    if (["true", "false"].includes(value)) values[key] = value === "true";
  }
  return values;
}

function responseInstant(entry, start) {
  const timing = entry.timings;
  // HAR connect includes SSL. Do not count ssl a second time. This estimates
  // headers-arrival (when status is known), not request order or body completion.
  if (timing && ["blocked", "dns", "connect", "send", "wait"].every(key => Number.isFinite(timing[key]))) {
    return { at: start + ["blocked", "dns", "connect", "send", "wait"].reduce((n, key) => n + Math.max(0, timing[key]), 0), basis: "HAR headers timing" };
  }
  if (Number.isFinite(entry.time) && entry.time >= 0) return { at: start + entry.time, basis: "HAR completion time (headers timing unavailable)" };
  return { at: start, basis: "request start only (response timing unavailable)" };
}

function bodyFor(entry) {
  const content = entry.response?.content;
  if (typeof content?.text !== "string") return null;
  try { return JSON.parse(content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text); }
  catch { return null; }
}
function milliseconds(value) {
  const time = typeof value === "number" && Number.isFinite(value) ? value * 1000
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : null;
}

function timestampEvidence(entries) {
  const directory = [], detail = [];
  for (const entry of entries) {
    if (entry.request?.method !== "GET" || entry.response?.status !== 200) continue;
    const route = routeFor(entry.request.url), body = bodyFor(entry), at = Date.parse(entry.startedDateTime);
    if (!body || !Number.isFinite(at)) continue;
    const add = (row, destination, id) => {
      if (typeof id !== "string" || !id || typeof row?.title !== "string") return;
      destination.push({ id, title: row.title, at, endpoint: route.endpoint,
        created: milliseconds(row.create_time), updated: milliseconds(row.update_time),
        createdType: typeof row.create_time, updatedType: typeof row.update_time,
        // JS Date TimeClip is sub-millisecond truncation, not 1-2 second rounding.
        clippedUpdated: milliseconds(row.update_time) == null ? null : new Date(milliseconds(row.update_time)).getTime() });
    };
    if (route.kind === "directory") {
      if (Array.isArray(body)) {
        for (const pin of body) if (pin.item_type === "conversation") add(pin.item, directory, pin.item?.id);
      } else if (Array.isArray(body.items)) {
        for (const item of body.items) {
          if (Array.isArray(item.conversations?.items)) {
            for (const row of item.conversations.items) add(row, directory, row.id);
          } else add(item, directory, item.id);
        }
      }
    } else if (route.kind === "detail") {
      const requested = decodeURIComponent(new URL(entry.request.url).pathname.split("/").at(-1));
      if (body.conversation_id === requested) add(body, detail, requested);
    }
  }
  const sampleIds = new Map();
  const label = id => { if (!sampleIds.has(id)) sampleIds.set(id, `sample-${sampleIds.size + 1}`); return sampleIds.get(id); };
  const pairs = [];
  for (const item of detail) {
    // The nearest SAME-ID/SAME-TITLE directory observation may precede OR follow
    // this detail. Report that ordering instead of pretending it was a preview.
    const candidates = directory.filter(row => row.id === item.id && row.title === item.title);
    candidates.sort((a, b) => Math.abs(a.at - item.at) - Math.abs(b.at - item.at));
    const listing = candidates[0];
    if (!listing || listing.updated === null || item.updated === null) continue;
    pairs.push({ sample: label(item.id), sameTitle: true,
      directoryEndpoint: listing.endpoint, detailEndpoint: item.endpoint,
      detailRequestMinusDirectoryRequestMs: item.at - listing.at,
      directoryUpdatedType: listing.updatedType, detailUpdatedType: item.updatedType,
      rawUpdatedDeltaMs: item.updated - listing.updated,
      normalizedUpdatedDeltaMs: item.clippedUpdated - listing.clippedUpdated,
      createdDeltaMs: item.created == null || listing.created == null ? null : item.created - listing.created });
  }
  const repeatedDetail = [];
  for (const [id] of new Map(detail.map(row => [row.id, true]))) {
    const rows = detail.filter(row => row.id === id).sort((a, b) => a.at - b.at);
    for (let i = 1; i < rows.length; i++) if (rows[i].title === rows[i - 1].title && rows[i].updated != null && rows[i - 1].updated != null) {
      repeatedDetail.push({ sample: label(id), requestGapMs: rows[i].at - rows[i - 1].at,
        updatedDeltaMs: rows[i].updated - rows[i - 1].updated, sameTitle: true });
    }
  }
  return { directoryObservations: directory.length, detailObservations: detail.length, pairs, repeatedDetail,
    limitation: "Matching observations only. No claim that the user previewed this row, no account-version proof, and no causal proof that a GET changed update_time." };
}

function currentMetadataFailures(entries) {
  const failures = entries.filter(entry => entry.response?.status >= 400
    && requestFamily(entry) === "tidy-current-metadata"
    && routeFor(entry.request?.url).endpoint === "/backend-api/conversation/:conversation");
  let inaccessible = 0, noRetry = 0, matchedIdentity = 0;
  const targets = new Set();
  for (const entry of failures) {
    const id = decodeURIComponent(new URL(entry.request.url).pathname.split("/").at(-1));
    const detail = bodyFor(entry)?.detail;
    targets.add(id);
    if (detail?.code === "conversation_inaccessible") inaccessible++;
    if (detail?.can_retry === false) noRetry++;
    if (detail?.conversation_id === id) matchedIdentity++;
  }
  // Count only the known error semantics. Never forward server messages, IDs
  // or arbitrary error codes; sanitized HAR files may omit these bodies.
  return { requests: failures.length, uniqueTargets: targets.size, inaccessible, explicitNoRetry: noRetry,
    matchedResponseIdentity: matchedIdentity, firstAt: failures[0]?.startedDateTime ?? null,
    lastAt: failures.at(-1)?.startedDateTime ?? null };
}

function analyzeHar(har, { from = null } = {}) {
  if (!Array.isArray(har?.log?.entries)) throw new Error("Invalid HAR entries");
  const fromMs = from === null ? -Infinity : Date.parse(from);
  if (Number.isNaN(fromMs)) throw new Error("--from must be an ISO time");
  const selected = har.log.entries.map((entry, i) => ({ entry, captureIndex: i, start: Date.parse(entry.startedDateTime) }))
    .filter(value => Number.isFinite(value.start) && value.start >= fromMs)
    .sort((a, b) => a.start - b.start || a.captureIndex - b.captureIndex);
  const errors = selected.filter(value => value.entry.response?.status === 429)
    .map(value => ({ ...value, response: responseInstant(value.entry, value.start) }))
    .sort((a, b) => a.response.at - b.response.at || a.captureIndex - b.captureIndex);
  const first = errors[0], cutoff = first?.response.at ?? Infinity;
  const window = selected.filter(value => value.start <= cutoff);
  const counts = { identity: 0, directory: 0, detail: 0, write: 0, other: 0 };
  const byInitiator = {}, byFamily = {}, byEndpoint = {}, statusCounts = {}, duplicates = [], seen = new Map();
  const requests = window.map(({ entry, start }, i) => {
    const route = routeFor(entry.request?.url), initiator = initiatorFor(entry), response = responseInstant(entry, start);
    const family = requestFamily(entry), pagination = paginationFor(entry), status = entry.response?.status ?? null;
    counts[route.kind]++; byInitiator[initiator] = (byInitiator[initiator] || 0) + 1;
    byFamily[family] = (byFamily[family] || 0) + 1;
    byEndpoint[route.endpoint] = (byEndpoint[route.endpoint] || 0) + 1;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const key = `${entry.request?.method} ${entry.request?.url}`;
    if (seen.has(key)) duplicates.push({ firstSequence: seen.get(key), repeatedSequence: i + 1, endpoint: route.endpoint, kind: route.kind });
    else seen.set(key, i + 1);
    return { sequence: i + 1, startedAt: new Date(start).toISOString(), method: entry.request?.method || "UNKNOWN",
      ...route, status, statusKnownByCutoff: status > 0 && response.at <= cutoff, initiator, family,
      ...(pagination ? { pagination } : {}) };
  });
  return { evidence: "LOCAL HAR OBSERVATION; raw identity, credential and body fields are omitted",
    window: { basis: from ? "caller-supplied F5 start" : "capture start; NOT asserted to be F5", requestedFrom: from,
      firstRequestAt: requests[0]?.startedAt ?? null, end: first ? new Date(cutoff).toISOString() : requests.at(-1)?.startedAt ?? null,
      endBasis: first ? first.response.basis : "last captured request start; no 429 in selected capture" },
    first429: first ? { ...routeFor(first.entry.request.url), startedAt: new Date(first.start).toISOString(),
      observedAt: new Date(cutoff).toISOString(), initiator: initiatorFor(first.entry), timingBasis: first.response.basis } : null,
    counts, byInitiator, byFamily, byEndpoint, statusCounts, duplicates, requests,
    currentMetadataFailures: currentMetadataFailures(window.map(value => value.entry)),
    timestamps: timestampEvidence(selected.map(value => value.entry)),
    limitation: "HAR counts include the site and extensions; stack presence alone is not caller ownership, and detail GETs are not automatically TIDY supplements. Missing initiators stay unknown. In-flight requests started before the first 429 response are included. Only allowlisted numeric/boolean pagination fields are exposed." };
}

if (require.main === module) {
  const args = process.argv.slice(2), file = args[0];
  if (!file || !path.isAbsolute(file) || (args.length !== 1 && !(args.length === 3 && args[1] === "--from"))) {
    throw new Error("Usage: node tools/audit-title-har.cjs <absolute.har> [--from <ISO timestamp>]");
  }
  console.log(JSON.stringify(analyzeHar(JSON.parse(fs.readFileSync(file, "utf8")), { from: args[2] || null }), null, 2));
}
module.exports = { analyzeHar, routeFor, timestampEvidence };
