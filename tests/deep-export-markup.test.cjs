const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPanelRuntime } = require("./helpers/panel-runtime.cjs");

const modulePath = "src/features/export/ui/export-markup.js";
const { renderExportMarkup } = createPanelRuntime().load(modulePath);
const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// Presentation fixtures intentionally contain markup-sensitive user strings.
// The renderer receives already-derived data, never a live document repository.
const t=(key, values={})=>key+Object.entries(values).map(([k,v])=>'['+k+'='+v+']').join('');
const port={
 resolveRoleNames:(roles={})=>({user:roles.user||'User',assistant:roles.assistant||'Assistant'}),
 exportErrorText:error=>error.code||'error',
 segmentsToPlainText:segments=>segments,
 serializeTextExcerpt:()=> 'preview <test> "quoted" & data',
};
const base={
 mode:'current',format:'markdown',content:{timestamps:true,messageNumbers:true,visibleProcess:false,toolProcess:false,webProcess:false,finalSources:true,mediaAttachments:true},
 roleNames:{user:'Name <me>',assistant:'Assistant & helper'},pdf:{pageSize:'A4',orientation:'portrait',fontSize:'standard',pageNumbers:true},preferences:{language:'en'},filename:'Title <test>',settingsView:null,
 accountKey:'account',scopeVerified:true,loading:false,documentStale:false,loadError:null,exportError:null,
 batchLoading:false,batchLoadError:null,batchRetryable:true,batchFailedTitles:[],batchPlanError:null,batchOrganizationOpen:null,
 conversationOrganization:'per-conversation',bookmarkOrganization:'all-bookmarks',batchFilename:'Archive',batchSingleFilename:'Single',showAllConversations:false,showAllBookmarkGroups:false,
 job:null,jobSubmission:null,jobUnknown:false,jobWarningsOpen:false,
 plan:{files:[{kind:'conversation',path:'Title.md',baseName:'Title',conversations:[{}],bookmarkEntries:[]}],assets:[],zipped:false,outputName:'Title.md'},
 currentTitle:'Title <test>',messageCount:5,currentReady:true,batchReady:true,responseInProgress:false,boundSnapshot:true,batchSourcesReady:true,batchStaleCount:0,
 conversationCount:1,bookmarkCount:1,
 conversationRecords:[{conversation:{id:'c1',title:'Title <test>',createdAt:'2026-09-28'},sources:['favorites','search'],messageTotal:5,highlighted:true}],
 bookmarkGroups:[{conversation:{id:'c1',title:'Title <test>'},bookmarks:[{bookmarkId:'b1',conversationId:'c1',messageId:'m1',groupId:'g1',excerpt:'Stored',text:'Text <&>',role:'assistant',timestamp:'2026-09-28',messageNumber:3,groupLabel:'Group <test>',highlighted:true}],overlap:true,highlighted:true,expanded:true}],
 bookmarkItems:[{groupId:'g1'}],
 pendingImages:0,missingImages:[],warningsOpen:false,selectionErrorOpen:false,currentPreviewText:'preview <test> "quoted" & data',currentPdfParts:[{type:'text',text:'PDF'}],selectionMissingLabels:[],
 jobHidden:false,jobBusy:false,jobCancellable:false,jobTerminal:false,
 exportApi:port,preview:{styles:'.preview{}',markup:parts=>parts.map(p=>'<p>'+escapeHtml(p.text)+'</p>').join('')},formatTimestamp:value=>value?'Time '+value:'',
};
function freeze(value) {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(freeze);}
 return value;
}

const scenarios=[
 {},
 {loading:true,currentReady:false},
 {documentStale:true,currentReady:false},
 {responseInProgress:true,currentReady:false},
 {loadError:{key:'loadFailure'},batchLoadError:{key:'batchFailure'},batchFailedTitles:['Failed <item>'],batchRetryable:true},
 {batchLoading:true,batchReady:false},
 {batchStaleCount:1,batchReady:false},
 {pendingImages:2},
 {missingImages:[{conversationId:'c1',resource:{id:'r1'}}],warningsOpen:true},
 {batchPlanError:{code:'EXPORT_SELECTION_INCOMPLETE',missingBookmarks:[{bookmarkId:'missing',reason:'content-excluded'}]},selectionMissingLabels:['Missing <bookmark>'],selectionErrorOpen:true,batchReady:false},
 {batchPlanError:{code:'SOME_FAILURE'},batchReady:false},
 {exportError:{key:'failure',values:{count:3},unitKey:'unit'}},
 {job:{state:'completed',outputName:'done.md',warnings:['A < B']},jobTerminal:true,jobWarningsOpen:true},
 {job:{state:'generating',progress:{phase:'files',done:2,total:5}},jobBusy:true,jobCancellable:true},
 {jobUnknown:true,jobBusy:true},
 {jobSubmission:true,jobBusy:true},
 {job:{state:'completed'},jobTerminal:true,jobHidden:true},
 {conversationCount:0,bookmarkCount:0,conversationRecords:[],bookmarkGroups:[],bookmarkItems:[],plan:null,currentReady:false,batchReady:false},
 {accountKey:null,currentReady:false,batchReady:false},
 {conversationOrganization:'invalid',bookmarkOrganization:'invalid',batchOrganizationOpen:'bookmarks'},
];

test("export markup renders frozen presentation DTOs without writes or owner access", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", modulePath), "utf8");
  assert.doesNotMatch(source, /\b(?:document|window|globalThis|root)\s*\./);
  assert.doesNotMatch(source, /\b(?:getState|setState|requestDocument|requestDocuments|jobRequest)\s*\(/);
  let count = 0;
  for (const mode of ["current", "batch"]) {
    for (const format of ["markdown", "json", "txt", "pdf"]) {
      for (const settingsView of [null, "shared", "pdf", "manage"]) {
        for (const scenario of scenarios) {
          const model = freeze({ ...base, ...scenario, mode, format, settingsView });
          const html = renderExportMarkup(model, t);
          assert.match(html, /class="export-panel /);
          assert.equal(renderExportMarkup(model, t), html, "identical DTOs render identically");
          count++;
        }
      }
    }
  }
  assert.equal(count, 640);
});

test("export markup keeps account, loading, and image readiness states", () => {
  const account = renderExportMarkup(freeze({ ...base, scopeVerified: false }), t);
  assert.match(account, /data-list-key="account-required"/);
  assert.match(account, /data-retry-library/);
  assert.doesNotMatch(account, /data-export-action/);

  const pending = renderExportMarkup(freeze({ ...base, pendingImages: 2 }), t);
  assert.match(pending, /exportImagesPreparing\[count=2\]/);
  assert.match(pending, /data-export-full-preview disabled/);
  assert.match(pending, /data-export-action disabled/);

  const reading = renderExportMarkup(freeze({ ...base, responseInProgress: true, currentReady: false }), t);
  assert.match(reading, /exportWaitingForResponse/);
  assert.match(reading, /data-export-refresh disabled/);
});

test("export markup preserves batch row identity, metadata, disclosure, and escaping", () => {
  const html = renderExportMarkup(freeze({ ...base, mode: "batch", settingsView: "manage" }), t);
  assert.match(html, /data-list-key="conversation:c1" class="export-basket-conversation is-new"/);
  assert.match(html, /data-export-remove-conversation="c1"/);
  assert.match(html, /Title &lt;test&gt;/);
  assert.match(html, /messagesCount\[count=5\]/);
  assert.match(html, /exportFromSource\[source=favoritesexportSummarySeparatorglobalSearch\]/);
  assert.match(html, /data-list-key="bookmark:b1" class="export-basket-bookmark is-new"/);
  assert.match(html, /Text &lt;&amp;&gt;/);
  assert.match(html, /#3 · Time 2026-09-28 · assistant/);
  assert.match(html, /bookmarkFromGroup\[group=Group &lt;test&gt;\]/);
  assert.match(html, /exportBookmarkAlsoInConversation/);
  assert.match(html, /data-export-expand-bookmark-group="c1" aria-expanded="true"/);
  assert.match(html, /data-export-bookmark-rows="c1">/);
  assert.doesNotMatch(html, /<test>/);
});

test("export markup keeps warning and selection-error disclosure state", () => {
  const html = renderExportMarkup(freeze({
    ...base, mode: "batch", missingImages: [{ resource: { id: "image" } }], warningsOpen: true,
    batchPlanError: { code: "EXPORT_SELECTION_INCOMPLETE",
      missingBookmarks: [{ bookmarkId: "missing", reason: "content-excluded" }] },
    selectionMissingLabels: ["Missing <bookmark>"], selectionErrorOpen: true,
  }), t);
  assert.match(html, /data-export-warnings open/);
  assert.match(html, /exportImageUnavailable/);
  assert.match(html, /data-export-selection-error open/);
  assert.match(html, /exportSelectionFiltered\[count=1\]/);
  assert.match(html, /Missing &lt;bookmark&gt;/);
});

test("export markup renders job controls from presentation status only", () => {
  const active = renderExportMarkup(freeze({ ...base,
    job: { state: "generating", progress: { phase: "files", done: 2, total: 5 } },
    jobBusy: true, jobCancellable: true,
  }), t);
  assert.match(active, /data-export-job-cancel/);
  assert.match(active, /exportJobFiles\[done=2\]\[total=5\]/);
  assert.match(active, /exportJobShowProgress/);
  assert.doesNotMatch(active, /data-export-job-dismiss/);

  const terminal = renderExportMarkup(freeze({ ...base,
    job: { state: "completed", outputName: "A < B", warnings: ["Some <warning>"] },
    jobTerminal: true, jobWarningsOpen: true,
  }), t);
  assert.match(terminal, /data-export-job-dismiss/);
  assert.match(terminal, /data-export-job-warnings open/);
  assert.match(terminal, /A &lt; B/);
  assert.match(terminal, /Some &lt;warning&gt;/);
  assert.doesNotMatch(renderExportMarkup(freeze({ ...base,
    job: { state: "completed" }, jobTerminal: true, jobHidden: true,
  }), t), /data-list-key="job"/);

  const unknown = renderExportMarkup(freeze({ ...base, jobUnknown: true, jobBusy: true }), t);
  assert.match(unknown, /data-export-job-check/);
  assert.match(unknown, /data-export-downloads/);
});

test("export markup renders mixed document archive tree and filename controls", () => {
  const html = renderExportMarkup(freeze({
    ...base, mode: "batch",
    plan: {
      zipped: true, outputName: "Archive.zip",
      files: [
        { kind: "conversation", path: "Conversation.md", conversations: [{}] },
        { kind: "bookmark-excerpt", path: "Bookmarks.md", bookmarkEntries: [{}, {}] },
      ],
    },
  }), t);
  assert.match(html, /data-export-filename="batch"/);
  assert.match(html, /<i>\.zip<\/i>/);
  assert.match(html, /export-preview-tree/);
  assert.match(html, /Conversation\.md/);
  assert.match(html, /Bookmarks\.md/);
  assert.doesNotMatch(html, /export-preview-tree--assets/);
});
