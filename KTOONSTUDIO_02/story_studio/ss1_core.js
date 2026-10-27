// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with authentication & episode header)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL resolver)
// - CUR : { ep: { id, name, ... }, series: { id, name, ... } } (Current context)
// - PJ : { groups: [...], series: [...], episodes: [...] } (Project tree)
// - window.ISTU : { open: boolean, ... } (Image Studio instance)
// - istuClose() : void (Closes Image Studio)
// - window.VEDIT : { open: boolean, ... } (Video Editor instance)
// - veClose() : void (Closes Video Editor)
//
// Server changes needed:
// - None for Task 001. Relies on existing /api/desk/all, /api/desk/put, /api/desk/batch.
//
// App changes needed:
// - None for Task 001. Top bar button "Story Studio" and Tools menu entry
//   are injected into ui.html by Claude during review.
//
// Known limitations:
// - Task 001 implements the core shell, document store, undo/redo system,
//   5-tab navigation frames with empty states, and keyboard shortcuts.
// - Full editing for Bible, Script, Shotlist, Prompts, Board, and AI features
//   will be developed in subsequent tasks.

// ---------- Core Helpers ----------
function uid(prefix = "") {
  const r = Math.random().toString(36).substring(2, 6);
  return prefix + Date.now().toString(36) + r;
}

function curSeries() {
  if (typeof CUR !== "undefined" && CUR && CUR.series) return CUR.series;
  if (typeof CUR !== "undefined" && CUR && CUR.ep && typeof PJ !== "undefined" && PJ && Array.isArray(PJ.series)) {
    return PJ.series.find(s => s.id === CUR.ep.series) || null;
  }
  return null;
}

function curEpisode() {
  if (typeof CUR !== "undefined" && CUR && CUR.ep) return CUR.ep;
  return null;
}

function curSeriesEpisodes() {
  const s = curSeries();
  if (!s || typeof PJ === "undefined" || !PJ || !Array.isArray(PJ.episodes)) return [];
  return PJ.episodes.filter(e => e.series === s.id);
}

// ---------- Document Models (Spec Section 4) ----------
function newBible(seriesId, name) {
  const s = curSeries();
  return {
    v: 1,
    series: seriesId || (s ? s.id : ""),
    name: name || (s ? s.name : "UNTITLED SERIES"),
    logline: "",
    genre: "",
    tone: "",
    audience: "US, 18+",
    format: {
      aspect: "9:16",
      epDur: 90,
      lang: "en",
      shotMin: 4,
      shotMax: 15,
      batchMax: 30,
      mix: { REF: 40, I2V: 40, MINI: 20 }
    },
    style: {
      look: "photoreal cinematic, AI actors",
      camera: "handheld subtle",
      grade: "teal-orange low contrast",
      negative: "text, watermark, extra fingers"
    },
    rules: [
      "Faces only from AI-generated images",
      "Sensual content non-explicit, adults only"
    ],
    chars: [],
    locs: [],
    props: [],
    banks: [],
    u: Date.now()
  };
}

function newEpisodeDoc(epId, seriesId, title) {
  const e = curEpisode();
  const s = curSeries();
  return {
    v: 1,
    ep: epId || (e ? e.id : ""),
    series: seriesId || (s ? s.id : ""),
    title: title || (e ? e.name : "Untitled Episode"),
    target: 90,
    outline: {
      premise: "",
      hook: "",
      beats: []
    },
    script: {
      blocks: [],
      rev: 1,
      revs: []
    },
    shots: [],
    batches: [],
    links: {
      vedit: "",
      istu: ""
    },
    ai: [],
    u: Date.now()
  };
}

// ---------- State Store ----------
const STORY = {
  open: false,
  tab: "script", // 'bible' | 'script' | 'shotlist' | 'prompts' | 'board'
  rightTab: "inspector", // 'inspector' | 'ai' | 'issues'
  rightWidth: 340,
  railCollapsed: false,
  selItem: null,
  bible: null,
  ep: null,
  tpls: {},
  dirty: {
    bible: false,
    ep: false,
    tpls: new Set()
  },
  saving: false,
  lastSaved: null,
  saveError: null,

  // Functions exposed on state
  uid,
  curSeries,
  curEpisode,
  curSeriesEpisodes,
  newBible,
  newEpisodeDoc,
  loadDesk,
  saveNow,
  scheduleSave,
  snapshot,
  undo,
  redo,
  canUndo: () => UNDO_STACK.length > 0,
  canRedo: () => REDO_STACK.length > 0,
  renderAll: null,
  updateStatusBar: null,
  // extension registry (Claude, 26/10): modules register here instead of editing ss1/ss9
  views: {},      // STORY.views.<tab> = { render(el) }  tabs: bible|script|shotlist|prompts|board
  cmds: {},       // STORY.cmds["<module>.<action>"] = (arg, el, event) => {}   used by data-s="<module>.<action>:arg"
  inspector: {},  // STORY.inspector.<kind> = { render(el, item) }  right panel for the selected item (STORY.selItem = {kind,id})
  hooks: { afterLoad: [], afterSave: [] }
};

window.STORY = STORY;

// ---------- Undo / Redo Engine (200 Steps, JSON Snapshots) ----------
const UNDO_STACK = [];
const REDO_STACK = [];
const MAX_UNDO = 200;
let lastSnapshotKey = null;

function makeSnapshotKey() {
  const epStr = STORY.ep ? JSON.stringify(STORY.ep) : "";
  const bibleStr = STORY.bible ? JSON.stringify(STORY.bible) : "";
  return epStr + "|||" + bibleStr;
}

function snapshot(tag = "") {
  const currentKey = makeSnapshotKey();
  if (lastSnapshotKey === null) {
    lastSnapshotKey = currentKey;
    return;
  }
  if (currentKey !== lastSnapshotKey) {
    UNDO_STACK.push({
      ep: STORY.ep ? JSON.parse(JSON.stringify(STORY.ep)) : null,
      bible: STORY.bible ? JSON.parse(JSON.stringify(STORY.bible)) : null,
      tag: tag || "Action",
      time: Date.now()
    });
    if (UNDO_STACK.length > MAX_UNDO) {
      UNDO_STACK.shift();
    }
    REDO_STACK.length = 0;
    lastSnapshotKey = currentKey;
    updateUndoButtons();
  }
}

function undo() {
  if (!UNDO_STACK.length) {
    if (typeof toast === "function") toast("Nothing to undo.");
    return false;
  }
  REDO_STACK.push({
    ep: STORY.ep ? JSON.parse(JSON.stringify(STORY.ep)) : null,
    bible: STORY.bible ? JSON.parse(JSON.stringify(STORY.bible)) : null,
    tag: "Redo",
    time: Date.now()
  });
  const prev = UNDO_STACK.pop();
  if (prev.ep) STORY.ep = JSON.parse(JSON.stringify(prev.ep));
  if (prev.bible) STORY.bible = JSON.parse(JSON.stringify(prev.bible));
  lastSnapshotKey = makeSnapshotKey();
  STORY.dirty.ep = true;
  STORY.dirty.bible = true;
  scheduleSave();
  updateUndoButtons();
  if (typeof STORY.renderAll === "function") STORY.renderAll();
  if (typeof toast === "function") toast("Undone" + (prev.tag ? ": " + prev.tag : ""));
  return true;
}

function redo() {
  if (!REDO_STACK.length) {
    if (typeof toast === "function") toast("Nothing to redo.");
    return false;
  }
  UNDO_STACK.push({
    ep: STORY.ep ? JSON.parse(JSON.stringify(STORY.ep)) : null,
    bible: STORY.bible ? JSON.parse(JSON.stringify(STORY.bible)) : null,
    tag: "Undo",
    time: Date.now()
  });
  const next = REDO_STACK.pop();
  if (next.ep) STORY.ep = JSON.parse(JSON.stringify(next.ep));
  if (next.bible) STORY.bible = JSON.parse(JSON.stringify(next.bible));
  lastSnapshotKey = makeSnapshotKey();
  STORY.dirty.ep = true;
  STORY.dirty.bible = true;
  scheduleSave();
  updateUndoButtons();
  if (typeof STORY.renderAll === "function") STORY.renderAll();
  if (typeof toast === "function") toast("Redone");
  return true;
}

function updateUndoButtons() {
  const bUndo = document.getElementById("story-btn-undo");
  const bRedo = document.getElementById("story-btn-redo");
  if (bUndo) bUndo.disabled = UNDO_STACK.length === 0;
  if (bRedo) bRedo.disabled = REDO_STACK.length === 0;
}

// ---------- Desk Store Load & Save Engine ----------
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  if (typeof STORY.updateStatusBar === "function") {
    STORY.updateStatusBar("saving");
  }
  saveTimer = setTimeout(() => {
    saveNow();
  }, 800);
}

function guardEpDocSize(epDoc, extraOps) {
  if (!epDoc) return;
  const LIMIT = 900 * 1024; // 900 KB guard
  let json = JSON.stringify(epDoc);
  if (json.length <= LIMIT) return;

  // 1. Prune oldest script revisions if exceeding size
  if (epDoc.script && Array.isArray(epDoc.script.revs)) {
    while (epDoc.script.revs.length > 0 && JSON.stringify(epDoc).length > LIMIT) {
      epDoc.script.revs.shift();
    }

    // 2. If still exceeds, split revs into <ep>__revs doc
    if (JSON.stringify(epDoc).length > LIMIT && epDoc.script.revs.length > 0) {
      extraOps.push({
        coll: "story_ep",
        id: epDoc.ep + "__revs",
        doc: {
          v: 1,
          ep: epDoc.ep,
          revs: epDoc.script.revs,
          u: Date.now()
        }
      });
      epDoc.script.revs = [];
    }
  }

  // 3. Trim AI message history if needed
  if (JSON.stringify(epDoc).length > LIMIT && Array.isArray(epDoc.ai) && epDoc.ai.length > 10) {
    epDoc.ai = epDoc.ai.slice(-10);
  }
}

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const ops = [];
  const s = curSeries();
  const e = curEpisode();

  if (STORY.dirty.bible && STORY.bible) {
    const sId = (s && s.id) || STORY.bible.series;
    if (sId) {
      STORY.bible.series = sId;
      STORY.bible.u = Date.now();
      ops.push({
        coll: "story_bible",
        id: sId,
        doc: STORY.bible
      });
    }
  }

  if (STORY.dirty.ep && STORY.ep) {
    const eId = (e && e.id) || STORY.ep.ep;
    const sId = (s && s.id) || STORY.ep.series;
    if (eId) {
      STORY.ep.ep = eId;
      STORY.ep.series = sId;
      STORY.ep.u = Date.now();
      guardEpDocSize(STORY.ep, ops);
      ops.push({
        coll: "story_ep",
        id: eId,
        doc: STORY.ep
      });
    }
  }

  if (STORY.dirty.tpls && STORY.dirty.tpls.size > 0) {
    for (const tId of STORY.dirty.tpls) {
      ops.push({
        coll: "story_tpl",
        id: tId,
        doc: STORY.tpls[tId] || null
      });
    }
  }

  if (ops.length === 0) {
    if (typeof STORY.updateStatusBar === "function") STORY.updateStatusBar("saved");
    return true;
  }

  STORY.saving = true;
  if (typeof STORY.updateStatusBar === "function") STORY.updateStatusBar("saving");

  try {
    if (typeof api !== "function") {
      throw new Error("api() function is not available.");
    }
    const res = await api("/api/desk/batch", { ops });
    if (res && res.error) {
      throw new Error(res.error);
    }
    STORY.dirty.bible = false;
    STORY.dirty.ep = false;
    STORY.dirty.tpls.clear();
    STORY.saving = false;
    STORY.lastSaved = Date.now();
    STORY.saveError = null;
    if (typeof STORY.updateStatusBar === "function") STORY.updateStatusBar("saved");
    return true;
  } catch (err) {
    STORY.saving = false;
    STORY.saveError = err ? (err.message || String(err)) : "Save error";
    if (typeof STORY.updateStatusBar === "function") STORY.updateStatusBar("error");
    if (typeof toast === "function") {
      toast("Story Studio save failed: " + STORY.saveError, true);
    }
    // Schedule a retry in 5 seconds
    setTimeout(() => {
      if (STORY.saveError && (STORY.dirty.bible || STORY.dirty.ep || STORY.dirty.tpls.size > 0)) {
        scheduleSave();
      }
    }, 5000);
    return false;
  }
}

async function loadDesk() {
  const s = curSeries();
  const e = curEpisode();
  const sId = s ? s.id : null;
  const eId = e ? e.id : null;

  try {
    if (typeof api !== "function") {
      throw new Error("api() function is not available.");
    }
    const res = await api("/api/desk/all");
    const colls = (res && res.colls) || {};
    const bColl = colls.story_bible || {};
    const epColl = colls.story_ep || {};
    const tplColl = colls.story_tpl || {};

    // Load or create Bible for current series
    if (sId && bColl[sId]) {
      STORY.bible = bColl[sId];
    } else {
      STORY.bible = newBible(sId, s ? s.name : "UNTITLED SERIES");
      if (sId) STORY.dirty.bible = true;
    }

    // Load or create Episode doc
    if (eId && epColl[eId]) {
      STORY.ep = epColl[eId];
    } else {
      STORY.ep = newEpisodeDoc(eId, sId, e ? e.name : "Untitled Episode");
      if (eId) STORY.dirty.ep = true;
    }

    // Load templates
    STORY.tpls = Object.assign({}, tplColl);

    // Initialize undo stack
    UNDO_STACK.length = 0;
    REDO_STACK.length = 0;
    lastSnapshotKey = null;
    snapshot("Initial Load");

    // If newly created defaults need saving
    if (STORY.dirty.bible || STORY.dirty.ep) {
      scheduleSave();
    }

    if (typeof STORY.renderAll === "function") {
      STORY.renderAll();
    }
    return true;
  } catch (err) {
    console.warn("Story Studio loadDesk error:", err);
    if (!STORY.bible) STORY.bible = newBible(sId, s ? s.name : "UNTITLED SERIES");
    if (!STORY.ep) STORY.ep = newEpisodeDoc(eId, sId, e ? e.name : "Untitled Episode");
    if (typeof STORY.renderAll === "function") STORY.renderAll();
    return false;
  }
}
