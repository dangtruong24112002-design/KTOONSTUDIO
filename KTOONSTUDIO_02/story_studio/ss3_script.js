// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with auth headers)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL and thumbnail resolvers)
// - CUR : { ep, series } (Current series and episode context)
// - PJ : { groups, series, episodes } (Project tree)
//
// Server changes needed:
// - None for Task 003. Relies on existing /api/desk/all, /api/desk/batch,
//   and /api/extract (which parses .docx, .pdf, .txt, .md).
//
// App changes needed:
// - None for Task 003. Injected via module registry STORY.views.script.
//
// Known limitations:
// - Script Writer AI generation actions (Write outline, Write script from outline,
//   Rewrite selection, Tighten to target, Dialogue translate) are wired to LLM roles
//   via STORY.ai in TASK 006 (ss8_ai.js). Synchronous block creation eliminates
//   focus stealing on rapid typing.

(function() {
  // ---------- Fallback Helpers ----------
  function _esc(s) {
    if (typeof esc === "function") return esc(s);
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function _uid(prefix = "") {
    if (typeof STORY !== "undefined" && typeof STORY.uid === "function") {
      return STORY.uid(prefix);
    }
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  // ---------- Schema Normalizers ----------
  function ensureScriptSchema(ep) {
    if (!ep) return;
    if (!ep.outline) {
      ep.outline = { premise: "", hook: "", beats: [] };
    }
    if (!Array.isArray(ep.outline.beats)) {
      ep.outline.beats = [];
    }
    if (!ep.script) {
      ep.script = { blocks: [], rev: 1, revs: [] };
    }
    if (!Array.isArray(ep.script.blocks)) {
      ep.script.blocks = [];
    }
    if (typeof ep.script.rev !== "number") {
      ep.script.rev = 1;
    }
    if (!Array.isArray(ep.script.revs)) {
      ep.script.revs = [];
    }
    if (!ep.target) {
      ep.target = 90;
    }
  }

  function ensureBibleSeason(bible) {
    if (!bible) return;
    if (!Array.isArray(bible.season)) {
      bible.season = [];
    }
    if (!Array.isArray(bible.season_new_entities)) {
      bible.season_new_entities = [];
    }
  }

  // ---------- Module Internal State ----------
  const SCRIPT_STATE = {
    subview: "script", // 'outline' | 'script' | 'split' | 'season'
    durFactor: 1.0,    // 0.85 = brisk, 1.0 = normal, 1.15 = relaxed
    activeBlockId: null,
    ac: {
      open: false,
      blockId: null,
      query: "",
      index: 0,
      items: [],
      x: 0,
      y: 0
    },
    modal: null, // null | 'versions' | 'import' | 'seasonImport'
    selectedRev: null,
    importPreview: null,
    seasonImportText: ""
  };

  // Block type sequence for cycling: Tab
  const BLOCK_TYPES = ["scene", "action", "character", "paren", "dialogue", "trans"];

  // ---------- Duration Estimation Meter ----------
  // Dialogue: 2.5 words / sec
  // Action: ~2 sec per sentence
  function calcBlockDuration(block, factor = 1.0) {
    if (!block || !block.text) return 0;
    const text = block.text.trim();
    if (!text) return 0;

    const f = Math.max(0.5, factor);

    if (block.k === "dialogue") {
      const words = text.split(/\s+/).filter(Boolean).length;
      return Math.max(0.4, words / (2.5 * f));
    }

    if (block.k === "action") {
      const sentences = text.split(/[.!?]+(?:\s+|$)/).filter(s => s.trim().length > 0).length;
      const count = Math.max(1, sentences);
      return Math.max(1.0, (count * 2.0) / f);
    }

    if (block.k === "scene") {
      return 1.0 / f; // Establishing glance
    }

    return 0;
  }

  function calcScriptTotals(blocks, target = 90, factor = 1.0) {
    let diaSec = 0;
    let actSec = 0;
    let sceneSec = 0;

    (blocks || []).forEach(b => {
      const d = calcBlockDuration(b, factor);
      if (b.k === "dialogue") diaSec += d;
      else if (b.k === "action") actSec += d;
      else if (b.k === "scene") sceneSec += d;
    });

    const totalSec = diaSec + actSec + sceneSec;
    const tgt = target || 90;
    const pct = Math.round((totalSec / tgt) * 100);

    let status = "good";
    if (totalSec > tgt * 1.25) {
      status = "danger"; // >25% over target: red
    } else if (totalSec > tgt * 1.10) {
      status = "warn"; // >10% over target: yellow
    }

    return {
      totalSec,
      diaSec,
      actSec,
      sceneSec,
      target: tgt,
      pct,
      status
    };
  }

  // ---------- Heuristic Hook Check ----------
  function evaluateHookHeuristic(blocks) {
    if (!blocks || !blocks.length) {
      return { score: 0, text: "No script blocks found." };
    }

    const firstBlocks = blocks.slice(0, 3);
    const combined = firstBlocks.map(b => (b.text || "").toLowerCase()).join(" ");

    // Check for dramatic hooks: conflict verbs, questions, urgency, mystery
    const hookWords = [
      "?", "gun", "blood", "knife", "screams", "shouts", "dead", "body", "secret",
      "trap", "stop", "freeze", "run", "fire", "slap", "tears", "steals", "reveals",
      "caught", "betrayal", "lies", "confronts", "threatens", "escapes", "urgent"
    ];

    let hits = 0;
    hookWords.forEach(w => {
      if (combined.includes(w)) hits++;
    });

    let score = Math.min(10, 4 + hits * 2);
    if (combined.length < 15) score = 2;

    let text = "Hook: Strong active opening beat detected.";
    if (score < 5) text = "Hook: Slow opening. Add conflict or question in the first 3s.";
    else if (score < 8) text = "Hook: Moderate tension in opening beats.";

    return { score, text };
  }

  // ---------- Main View Render ----------
  function renderScriptView(container) {
    const ep = STORY.ep;
    const bible = STORY.bible;

    if (!ep) {
      container.innerHTML = `
        <div class="story-empty-state">
          <div class="story-empty-title">No Episode Selected</div>
          <div class="story-empty-desc">Please select an episode from the left rail or top dropdown to view its script.</div>
        </div>
      `;
      return;
    }

    ensureScriptSchema(ep);
    ensureBibleSeason(bible);

    const totals = calcScriptTotals(ep.script.blocks, ep.target, SCRIPT_STATE.durFactor);
    const hookCheck = evaluateHookHeuristic(ep.script.blocks);

    container.innerHTML = `
      <div id="story-view-script">
        <!-- Top Toolbar -->
        <div class="script-topbar">
          <div class="script-subnav">
            <button class="script-subnav-btn ${SCRIPT_STATE.subview === 'script' ? 'active' : ''}" data-s="script.subview:script">Script</button>
            <button class="script-subnav-btn ${SCRIPT_STATE.subview === 'outline' ? 'active' : ''}" data-s="script.subview:outline">Outline</button>
            <button class="script-subnav-btn ${SCRIPT_STATE.subview === 'split' ? 'active' : ''}" data-s="script.subview:split">Split</button>
            <button class="script-subnav-btn ${SCRIPT_STATE.subview === 'season' ? 'active' : ''}" data-s="script.subview:season">Season (${(bible && bible.season) ? bible.season.length : 0})</button>
          </div>

          <!-- Duration Meter -->
          <div class="script-dur-widget script-dur-${totals.status}" title="Dialogue: ${totals.diaSec.toFixed(1)}s, Action: ${totals.actSec.toFixed(1)}s">
            <div class="script-dur-text">
              <span>${totals.totalSec.toFixed(1)}s / ${totals.target}s</span>
              <span style="font-size:10px;opacity:0.8;">(${totals.pct}%)</span>
            </div>
            <div class="script-dur-meter-wrap">
              <div class="script-dur-meter-fill" style="width: ${Math.min(100, totals.pct)}%;"></div>
            </div>
            <div class="script-dur-breakdown">
              Dia ${totals.diaSec.toFixed(0)}s · Act ${totals.actSec.toFixed(0)}s
            </div>
          </div>

          <!-- Pace Factor & Hook Check -->
          <div class="script-actions">
            <select class="story-btn-ghost" data-s="script.changePace" style="font-size:11px;padding:3px 6px;" title="Adjust speech pacing calculation">
              <option value="0.85" ${SCRIPT_STATE.durFactor === 0.85 ? "selected" : ""}>Pace: Brisk (0.85x)</option>
              <option value="1.0" ${SCRIPT_STATE.durFactor === 1.0 ? "selected" : ""}>Pace: Normal (1.0x)</option>
              <option value="1.15" ${SCRIPT_STATE.durFactor === 1.15 ? "selected" : ""}>Pace: Slow (1.15x)</option>
            </select>

            <button class="story-btn-ghost" data-s="script.hookCheck" title="${_esc(hookCheck.text)} (AI evaluation in Task 006)">
              Hook ${hookCheck.score}/10
            </button>

            <button class="story-btn-ghost" data-s="script.openVersions" title="Revision history and diff">
              Versions (Rev ${ep.script.rev || 1})
            </button>

            <button class="story-btn-ghost" data-s="script.openImport" title="Import from .docx, .pdf, .txt, .md">
              Import
            </button>
            <button class="story-btn-gold" data-s="source.open" title="Analyze a script, shotlist, story document, or video and build an episode map">
              Source → Story workflow
            </button>

            <div style="position:relative;display:inline-block;">
              <button class="story-btn-ghost" data-s="script.openExportMenu" title="Export script">
                Export ▾
              </button>
              <div id="script-export-dropdown" class="bible-card-dropdown" hidden style="right:0;top:100%;min-width:140px;z-index:90;">
                <div class="bible-dropdown-item" data-s="script.export:fountain">Fountain (.fountain)</div>
                <div class="bible-dropdown-item" data-s="script.export:txt">Screenplay Text (.txt)</div>
                <div class="bible-dropdown-item" data-s="script.export:md">Markdown (.md)</div>
              </div>
            </div>
          </div>
        </div>

        <!-- AI Assistant Action Bar (Spec 5.B.5 — Wired in TASK 006) -->
        <div class="script-ai-bar">
          <span class="label">AI Actions:</span>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiWriteOutline" title="Write episode outline and beats from Bible and logline">
            Write outline <span class="script-cost-pill">$0.02</span>
          </button>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiWriteScript" title="Generate screenplay blocks from outline beats">
            Write script from outline <span class="script-cost-pill">$0.04</span>
          </button>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiRewrite" title="Rewrite selected blocks with custom instructions">
            Rewrite selection <span class="script-cost-pill">$0.02</span>
          </button>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiTighten" title="Tighten screenplay to fit target duration">
            Tighten to target <span class="script-cost-pill">$0.02</span>
          </button>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiTranslate:vi_to_en" title="Translate dialogue from Vietnamese to English">
            Translate VI→EN <span class="script-cost-pill">$0.02</span>
          </button>
          <button class="story-btn-ghost script-btn-cost" data-s="script.aiTranslate:en_to_vi" title="Translate dialogue from English to Vietnamese">
            Translate EN→VI <span class="script-cost-pill">$0.02</span>
          </button>
        </div>

        <!-- Main Content Area -->
        <div class="script-content-area" id="script-content-area">
          ${renderSubviewContent(ep, bible)}
        </div>

        <!-- Autocomplete Floating Menu -->
        <div id="script-autocomplete-popup" class="script-autocomplete" ${SCRIPT_STATE.ac.open ? "" : "hidden"}>
          ${renderAutocompleteItems()}
        </div>

        <!-- Modal Overlays -->
        ${renderModalOverlay(ep, bible)}
      </div>
    `;

    attachScriptListeners(container);
    updateLeftRailOutline(ep);
  }

  function renderSubviewContent(ep, bible) {
    switch (SCRIPT_STATE.subview) {
      case "outline":
        return renderOutlineView(ep);
      case "split":
        return `
          <div class="script-split-wrap">
            <div class="script-split-outline">
              ${renderOutlineView(ep)}
            </div>
            <div class="script-split-script">
              ${renderScriptEditor(ep)}
            </div>
          </div>
        `;
      case "season":
        return renderSeasonView(bible, ep);
      case "script":
      default:
        return `
          <div class="script-editor-scroll">
            ${renderScriptEditor(ep)}
          </div>
        `;
    }
  }

  // ---------- Screenplay Block Editor View ----------
  function renderScriptEditor(ep) {
    const blocks = ep.script.blocks || [];
    const title = ep.title || "UNTITLED EPISODE";
    const series = STORY.curSeries();
    const seriesName = (series && series.name) ? series.name : "SERIES";

    return `
      <div class="script-page" id="script-page-container">
        <div class="script-page-header">
          <div>
            <div class="script-page-title">${_esc(title)}</div>
            <div class="script-page-meta">${_esc(seriesName)} · Target: ${ep.target || 90}s</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="script.addBlock:scene">+ Scene</button>
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="script.addBlock:action">+ Action</button>
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="script.addBlock:dialogue">+ Dialogue</button>
          </div>
        </div>

        <div class="script-blocks" id="script-blocks-list">
          ${blocks.length ? blocks.map((b, idx) => renderBlockItem(b, idx)).join("") : `
            <div class="story-empty-desc" style="padding:40px 20px;text-align:center;">
              Script is empty. Press <b>+ Scene</b> or <b>+ Action</b> above, or type in the outline tab.
            </div>
          `}
        </div>

        <!-- Quick Add Controls at Bottom -->
        <div class="script-quick-add">
          <span>Add block:</span>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:scene">Scene</button>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:action">Action</button>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:character">Character</button>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:paren">Paren</button>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:dialogue">Dialogue</button>
          <button class="story-btn-ghost" style="padding:3px 8px;font-size:11px;" data-s="script.addBlock:trans">Transition</button>
        </div>
      </div>
    `;
  }

  function renderBlockItem(block, idx) {
    const k = block.k || "action";
    const id = block.id || `sb_${idx}`;
    const text = block.text || "";
    const isFocused = SCRIPT_STATE.activeBlockId === id;

    let placeholder = "Type action description...";
    if (k === "scene") placeholder = "INT./EXT. LOCATION - TIME";
    else if (k === "character") placeholder = "CHARACTER NAME";
    else if (k === "paren") placeholder = "(direction)";
    else if (k === "dialogue") placeholder = "Dialogue line...";
    else if (k === "trans") placeholder = "CUT TO:";

    return `
      <div class="script-block script-block-${k} ${isFocused ? 'focused' : ''}" data-block-id="${id}" data-block-kind="${k}">
        <div class="script-block-gutter">
          <span class="script-block-type-badge" data-s="script.cycleType:${id}" title="Click or press Tab inside block to cycle type">${k}</span>
          <button class="script-block-btn" data-s="script.moveBlock:${id}:up" title="Move Up (Alt+Up)">▲</button>
          <button class="script-block-btn" data-s="script.moveBlock:${id}:down" title="Move Down (Alt+Down)">▼</button>
          <button class="script-block-btn btn-del" data-s="script.deleteBlock:${id}" title="Delete Block">✕</button>
        </div>
        <textarea class="script-block-input"
                  data-input-block="${id}"
                  placeholder="${placeholder}"
                  rows="1">${_esc(text)}</textarea>
      </div>
    `;
  }

  // ---------- Character Autocomplete Popup ----------
  function renderAutocompleteItems() {
    const items = SCRIPT_STATE.ac.items || [];
    if (!items.length) {
      return `<div style="padding:8px 12px;font-size:11px;color:var(--muted);">No matching characters in Bible.</div>`;
    }

    return items.map((char, i) => `
      <div class="script-ac-item ${i === SCRIPT_STATE.ac.index ? 'active' : ''}" data-s="script.selectAc:${char.id}">
        <div class="script-ac-avatar">${_esc((char.name || 'C').substring(0, 2).toUpperCase())}</div>
        <div class="script-ac-name">${_esc(char.name)}</div>
        <div class="script-ac-role">${_esc(char.role || 'lead')}</div>
      </div>
    `).join("");
  }

  // ---------- Outline (Beat Sheet) View ----------
  function renderOutlineView(ep) {
    const beats = (ep.outline && ep.outline.beats) ? ep.outline.beats : [];
    const premise = (ep.outline && ep.outline.premise) || "";
    const hook = (ep.outline && ep.outline.hook) || "";

    const totalSec = beats.reduce((sum, b) => sum + (Number(b.sec) || 0), 0);

    return `
      <div class="script-outline-wrap">
        <!-- Episode Premise Card -->
        <div class="outline-card">
          <div class="outline-card-head">
            <span class="outline-card-title">Episode Premise & Logline</span>
            <span style="font-size:11px;color:var(--muted);">Core Dramatic Engine</span>
          </div>
          <textarea class="story-input-text" data-s-outline="premise" rows="2" placeholder="Episode summary (1-3 sentences): who wants what, what obstacle strikes, and the main turning point...">${_esc(premise)}</textarea>
        </div>

        <!-- Hook Card -->
        <div class="outline-card">
          <div class="outline-card-head">
            <span class="outline-card-title">First 3 Seconds Hook</span>
            <span style="font-size:11px;color:var(--gold);">Immediate Conflict / Curiosity</span>
          </div>
          <textarea class="story-input-text" data-s-outline="hook" rows="2" placeholder="First 3-second opening hook image: high tension action, startling visual, or urgent question...">${_esc(hook)}</textarea>
        </div>

        <!-- Beat Sheet -->
        <div class="outline-card">
          <div class="outline-card-head">
            <span class="outline-card-title">Beat Sheet (${beats.length} Beats · ${totalSec}s / ${ep.target || 90}s)</span>
            <div style="display:flex;gap:6px;">
              <button class="story-btn-ghost" data-s="script.addBeat">+ Add Beat</button>
              <button class="story-btn-gold" data-s="script.generateFromOutline" title="Create screenplay Scene and Action blocks from beats">Convert to Script</button>
            </div>
          </div>

          <div class="outline-beats-list">
            ${beats.length ? beats.map((b, idx) => renderBeatItem(b, idx)).join("") : `
              <div class="story-empty-desc" style="padding:20px;text-align:center;">
                No beats yet. Click <b>+ Add Beat</b> or apply from the Season planner.
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  function renderBeatItem(beat, idx) {
    const id = beat.id || `bt_${idx}`;
    const t = beat.t || "Beat";
    const sec = beat.sec || 15;
    const text = beat.text || "";

    return `
      <div class="outline-beat-item" data-beat-id="${id}">
        <div class="outline-beat-head">
          <div class="outline-beat-left">
            <span class="outline-beat-tag">${_esc(t)}</span>
            <div class="outline-beat-sec">
              <input type="number" min="1" max="120" value="${sec}" data-beat-sec="${id}">
              <span>sec</span>
            </div>
          </div>
          <div style="display:flex;gap:4px;">
            <button class="script-block-btn" data-s="script.moveBeat:${id}:up">▲</button>
            <button class="script-block-btn" data-s="script.moveBeat:${id}:down">▼</button>
            <button class="script-block-btn btn-del" data-s="script.deleteBeat:${id}">✕</button>
          </div>
        </div>
        <textarea class="outline-beat-text" data-beat-text="${id}" placeholder="Describe beat action...">${_esc(text)}</textarea>
      </div>
    `;
  }

  // ---------- Season Section View (Workflow §1 step 1-2) ----------
  function renderSeasonView(bible, ep) {
    const season = (bible && bible.season) ? bible.season : [];
    const curEpId = ep ? ep.ep : "";

    return `
      <div class="script-season-wrap">
        <div class="season-header-card">
          <div>
            <div class="season-title">Season Story & Episodes Planner</div>
            <div class="season-desc">
              Manage multi-episode story arc and skeletons (1-3 sentences per episode) matching <code>plot_analyst</code> schema.
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="story-btn-ghost" data-s="script.openSeasonImport">Import Story File</button>
            <button class="story-btn-gold" data-s="script.addSeasonEp">+ Add Episode Skeleton</button>
          </div>
        </div>

        <div class="season-ep-list">
          ${season.length ? season.map((sep, idx) => renderSeasonEpCard(sep, idx, curEpId)).join("") : `
            <div class="story-empty-desc" style="padding:40px;text-align:center;">
              No season episodes found. Click <b>Import Story File</b> or <b>+ Add Episode Skeleton</b> to plan the season.
            </div>
          `}
        </div>
      </div>
    `;
  }

  function renderSeasonEpCard(sep, idx, curEpId) {
    const n = sep.n || (idx + 1);
    const title = sep.title || `Episode ${n}`;
    const skeleton = sep.skeleton || "";
    const hook = sep.hook || "";
    const ending = sep.ending || "";
    const locs = Array.isArray(sep.locations) ? sep.locations : [];
    const chars = Array.isArray(sep.characters) ? sep.characters : [];

    return `
      <div class="season-ep-card" data-season-idx="${idx}">
        <div class="season-ep-head">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="season-ep-number">EP ${n}</span>
            <span class="season-ep-title">${_esc(title)}</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="story-btn-gold" style="padding:3px 8px;font-size:11px;" data-s="script.applySeasonToOutline:${idx}" title="Transfer skeleton and beats into the current episode outline">
              Apply to Current Ep
            </button>
            <button class="script-block-btn btn-del" data-s="script.deleteSeasonEp:${idx}" title="Remove episode">✕</button>
          </div>
        </div>

        <div class="season-ep-body">
          <b>Skeleton:</b> ${_esc(skeleton || 'No skeleton provided.')}
        </div>

        ${hook ? `<div class="season-ep-body" style="color:var(--gold);font-size:11.5px;"><b>Hook:</b> ${_esc(hook)}</div>` : ''}
        ${ending ? `<div class="season-ep-body" style="color:#64b5f6;font-size:11.5px;"><b>Ending:</b> ${_esc(ending)}</div>` : ''}

        <div class="season-ep-meta">
          ${chars.length ? `<span class="season-pill">Characters: ${_esc(chars.join(", "))}</span>` : ''}
          ${locs.length ? `<span class="season-pill">Locations: ${_esc(locs.join(", "))}</span>` : ''}
        </div>
      </div>
    `;
  }

  // ---------- Modals (Versions, Import, Export) ----------
  function renderModalOverlay(ep, bible) {
    if (!SCRIPT_STATE.modal) return "";

    switch (SCRIPT_STATE.modal) {
      case "versions":
        return renderVersionsModal(ep);
      case "import":
        return renderImportModal();
      case "seasonImport":
        return renderSeasonImportModal();
      default:
        return "";
    }
  }

  function renderVersionsModal(ep) {
    const revs = ep.script.revs || [];
    const curRev = ep.script.rev || 1;
    const curBlocks = ep.script.blocks || [];

    const selectedRevObj = SCRIPT_STATE.selectedRev ? revs.find(r => r.rev === SCRIPT_STATE.selectedRev) : null;

    return `
      <div class="script-modal-overlay">
        <div class="script-modal-box">
          <div class="script-modal-head">
            <span class="script-modal-title">Script Version History (Current Rev ${curRev})</span>
            <button class="script-block-btn" data-s="script.closeModal">✕</button>
          </div>

          <div class="script-modal-body">
            <!-- Save New Version Form -->
            <div style="display:flex;gap:8px;">
              <input type="text" id="script-version-note" class="story-input-text" placeholder="Optional version note (e.g. Before dialogue cuts)..." style="flex:1;">
              <button class="story-btn-gold" data-s="script.saveVersionNow">Save Current Version</button>
            </div>

            <!-- Version List -->
            <div class="script-version-list">
              ${revs.length ? revs.slice().reverse().map(r => `
                <div class="script-version-item">
                  <div>
                    <b>Rev ${r.rev}</b>
                    <span style="color:var(--muted);font-size:11px;margin-left:8px;">${new Date(r.at).toLocaleString()}</span>
                    ${r.note ? `<div style="font-size:11.5px;color:var(--text);margin-top:2px;">${_esc(r.note)}</div>` : ''}
                    <div style="font-size:10.5px;color:var(--muted);margin-top:2px;">${(r.blocks || []).length} blocks</div>
                  </div>
                  <div style="display:flex;gap:6px;">
                    <button class="story-btn-ghost" data-s="script.selectDiffRev:${r.rev}">Diff</button>
                    <button class="story-btn-gold" data-s="script.restoreRev:${r.rev}">Restore</button>
                  </div>
                </div>
              `).join("") : `<div class="story-empty-desc">No previous versions saved. Click Save Current Version above.</div>`}
            </div>

            <!-- Diff Viewer -->
            ${selectedRevObj ? `
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--gold);margin-bottom:6px;">
                  Diff: Rev ${selectedRevObj.rev} vs Current Script
                </div>
                <div class="script-diff-box">
                  ${renderBlockDiff(selectedRevObj.blocks, curBlocks)}
                </div>
              </div>
            ` : ''}
          </div>

          <div class="script-modal-foot">
            <button class="story-btn-ghost" data-s="script.closeModal">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderBlockDiff(oldBlocks = [], newBlocks = []) {
    const oldLines = oldBlocks.map(b => `[${(b.k || '').toUpperCase()}] ${b.text || ''}`);
    const newLines = newBlocks.map(b => `[${(b.k || '').toUpperCase()}] ${b.text || ''}`);

    const html = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i];
      const n = newLines[i];

      if (o === n) {
        html.push(`<div class="diff-same">${_esc(n)}</div>`);
      } else {
        if (o != null) html.push(`<div class="diff-del">- ${_esc(o)}</div>`);
        if (n != null) html.push(`<div class="diff-add">+ ${_esc(n)}</div>`);
      }
    }

    return html.join("") || `<div class="diff-same">No differences found.</div>`;
  }

  function renderImportModal() {
    return `
      <div class="script-modal-overlay">
        <div class="script-modal-box">
          <div class="script-modal-head">
            <span class="script-modal-title">Import Screenplay (.docx, .pdf, .txt, .md)</span>
            <button class="script-block-btn" data-s="script.closeModal">✕</button>
          </div>

          <div class="script-modal-body">
            <div class="script-dropzone" data-s="script.triggerFileSelect">
              <div style="font-size:14px;font-weight:600;color:var(--gold);margin-bottom:6px;">Click to select file or drag & drop</div>
              <div style="font-size:11px;color:var(--muted);">Supported formats: .docx, .pdf, .txt, .md</div>
              <input type="file" id="script-hidden-file-input" accept=".docx,.pdf,.txt,.md" style="display:none;">
            </div>

            ${SCRIPT_STATE.importPreview ? `
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--gold);margin-bottom:6px;">
                  Parsed Preview: ${SCRIPT_STATE.importPreview.blocks.length} blocks found
                </div>
                <div class="script-diff-box" style="max-height:200px;">
                  ${SCRIPT_STATE.importPreview.blocks.slice(0, 15).map(b => `
                    <div><b>[${_esc(b.k.toUpperCase())}]</b> ${_esc(b.text)}</div>
                  `).join("")}
                  ${SCRIPT_STATE.importPreview.blocks.length > 15 ? `<div>... and ${SCRIPT_STATE.importPreview.blocks.length - 15} more blocks</div>` : ''}
                </div>
              </div>
            ` : ''}
          </div>

          <div class="script-modal-foot">
            <button class="story-btn-ghost" data-s="script.closeModal">Cancel</button>
            ${SCRIPT_STATE.importPreview ? `
              <button class="story-btn-ghost" data-s="script.confirmImport:append">Append to Script</button>
              <button class="story-btn-gold" data-s="script.confirmImport:replace">Replace Script</button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function renderSeasonImportModal() {
    return `
      <div class="script-modal-overlay">
        <div class="script-modal-box">
          <div class="script-modal-head">
            <span class="script-modal-title">Import Season Story File</span>
            <button class="script-block-btn" data-s="script.closeModal">✕</button>
          </div>

          <div class="script-modal-body">
            <div class="script-dropzone" data-s="script.triggerSeasonFileSelect">
              <div style="font-size:14px;font-weight:600;color:var(--gold);margin-bottom:6px;">Upload full season plot file (.docx, .pdf, .txt, .md)</div>
              <div style="font-size:11px;color:var(--muted);">Or paste the story text below</div>
              <input type="file" id="season-hidden-file-input" accept=".docx,.pdf,.txt,.md" style="display:none;">
            </div>

            <textarea id="season-import-textarea" class="story-input-text" rows="8" placeholder="Paste full season story or chapter text here...">${_esc(SCRIPT_STATE.seasonImportText)}</textarea>
          </div>

          <div class="script-modal-foot">
            <button class="story-btn-ghost" data-s="script.closeModal">Cancel</button>
            <button class="story-btn-gold" data-s="script.confirmSeasonImport">Parse into Episodes</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Left Rail Outline Integration ----------
  function updateLeftRailOutline(ep) {
    const el = document.getElementById("story-rail-outline");
    if (!el) return;

    if (!ep) {
      el.innerHTML = `<div style="font-size:11.5px;color:var(--muted);padding:6px 4px;">No episode loaded.</div>`;
      return;
    }

    const blocks = (ep.script && ep.script.blocks) ? ep.script.blocks : [];
    const scenes = blocks.filter(b => b.k === "scene");
    const beats = (ep.outline && ep.outline.beats) ? ep.outline.beats : [];

    if (!scenes.length && !beats.length) {
      el.innerHTML = `
        <div style="font-size:11.5px;color:var(--muted);padding:6px 4px;line-height:1.4;">
          Beat sheet and scenes will appear here as outline blocks are created.
        </div>
      `;
      return;
    }

    let html = "";
    if (scenes.length) {
      html += `<div style="font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;padding:4px 6px;">Scenes (${scenes.length})</div>`;
      scenes.forEach((sc, i) => {
        html += `
          <div class="story-rail-item" data-s="script.jumpToScene:${sc.id}" title="${_esc(sc.text)}" style="font-size:11px;padding:4px 6px;">
            <span>${i + 1}. ${_esc(sc.text || 'UNTITLED SCENE')}</span>
          </div>
        `;
      });
    }

    if (beats.length) {
      html += `<div style="font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;padding:8px 6px 4px 6px;">Beats (${beats.length})</div>`;
      beats.forEach((bt, i) => {
        html += `
          <div class="story-rail-item" data-s="script.jumpToBeat:${bt.id}" title="${_esc(bt.text)}" style="font-size:11px;padding:4px 6px;">
            <span>${_esc(bt.t || 'Beat')} (${bt.sec || 15}s)</span>
          </div>
        `;
      });
    }

    el.innerHTML = html;
  }

  // ---------- Script Parser (Heuristic for .docx, .pdf, .txt, .md) ----------
  function parseScreenplayText(rawText) {
    if (!rawText) return [];

    const lines = rawText.split(/\r?\n/);
    const blocks = [];

    const sceneRegex = /^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)/i;
    const transRegex = /^(?:FADE IN:|CUT TO:|DISSOLVE TO:|SMASH CUT:|TRANSITION:|FADE OUT\.)/i;
    const parenRegex = /^\s*\([^)]+\)\s*$/;

    let prevBlock = null;
    let currentSpeaker = "";
    let blankAfterDialogue = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        if (prevBlock && prevBlock.k === "dialogue") blankAfterDialogue = true;
        continue;
      }

      if (sceneRegex.test(line)) {
        prevBlock = { id: _uid("sb_"), k: "scene", text: line.toUpperCase() };
        blocks.push(prevBlock);
        continue;
      }

      if (transRegex.test(line) || line.endsWith("TO:")) {
        prevBlock = { id: _uid("sb_"), k: "trans", text: line.toUpperCase() };
        blocks.push(prevBlock);
        continue;
      }

      if (parenRegex.test(line)) {
        prevBlock = { id: _uid("sb_"), k: "paren", text: line, char: currentSpeaker };
        blocks.push(prevBlock);
        continue;
      }

      // Check if line is ALL CAPS and short (< 35 chars) -> Character Name
      const isAllCaps = (line === line.toUpperCase()) && /[A-Z]/.test(line);
      const isShort = line.length <= 32;
      const noPunctuation = !/[.?!,]$/.test(line);

      if (isAllCaps && isShort && noPunctuation && !sceneRegex.test(line)) {
        currentSpeaker = line;
        prevBlock = { id: _uid("sb_"), k: "character", text: line, char: line };
        blocks.push(prevBlock);
        blankAfterDialogue = false;
        continue;
      }

      // Keep wrapped dialogue with its speaker, and retain source language verbatim.
      if (currentSpeaker && prevBlock && (prevBlock.k === "character" || prevBlock.k === "paren" || (prevBlock.k === "dialogue" && !blankAfterDialogue))) {
        if (prevBlock.k === "dialogue") prevBlock.text += "\n" + line;
        else {
          prevBlock = { id: _uid("sb_"), k: "dialogue", text: line, char: currentSpeaker };
          blocks.push(prevBlock);
        }
        blankAfterDialogue = false;
        continue;
      }

      // Otherwise: Action description
      if (prevBlock && prevBlock.k === "dialogue") currentSpeaker = "";
      prevBlock = { id: _uid("sb_"), k: "action", text: line };
      blocks.push(prevBlock);
      blankAfterDialogue = false;
    }

    return blocks;
  }

  // ---------- Export Generators ----------
  function exportFountain(ep) {
    const blocks = (ep.script && ep.script.blocks) ? ep.script.blocks : [];
    const lines = [];

    lines.push(`Title: ${ep.title || 'Untitled Episode'}`);
    lines.push(`Credit: Written with KTOONSTUDIO Story Studio`);
    lines.push(`Draft date: ${new Date().toLocaleDateString()}`);
    lines.push("");

    blocks.forEach(b => {
      const text = b.text || "";
      if (b.k === "scene") {
        lines.push("");
        lines.push(text.toUpperCase());
        lines.push("");
      } else if (b.k === "character") {
        lines.push("");
        lines.push(text.toUpperCase());
      } else if (b.k === "paren") {
        lines.push(text);
      } else if (b.k === "dialogue") {
        lines.push(text);
      } else if (b.k === "trans") {
        lines.push("");
        lines.push(`> ${text.toUpperCase()}`);
        lines.push("");
      } else {
        lines.push("");
        lines.push(text);
      }
    });

    return lines.join("\n");
  }

  function exportScreenplayText(ep) {
    const blocks = (ep.script && ep.script.blocks) ? ep.script.blocks : [];
    const lines = [];

    lines.push(ep.title ? ep.title.toUpperCase() : "UNTITLED EPISODE");
    lines.push("=".repeat(40));
    lines.push("");

    blocks.forEach(b => {
      const text = b.text || "";
      if (b.k === "scene") {
        lines.push("");
        lines.push(text.toUpperCase());
        lines.push("");
      } else if (b.k === "character") {
        lines.push("");
        lines.push(" ".repeat(22) + text.toUpperCase());
      } else if (b.k === "paren") {
        lines.push(" ".repeat(16) + text);
      } else if (b.k === "dialogue") {
        lines.push(" ".repeat(10) + text);
      } else if (b.k === "trans") {
        lines.push("");
        lines.push(" ".repeat(45) + text.toUpperCase());
        lines.push("");
      } else {
        lines.push("");
        lines.push(text);
      }
    });

    return lines.join("\n");
  }

  function exportMarkdown(ep) {
    const blocks = (ep.script && ep.script.blocks) ? ep.script.blocks : [];
    const lines = [];

    lines.push(`# ${ep.title || 'Untitled Episode'}`);
    lines.push(`*Target duration: ${ep.target || 90}s*`);
    lines.push("");

    blocks.forEach(b => {
      const text = b.text || "";
      if (b.k === "scene") {
        lines.push(`\n### ${text.toUpperCase()}\n`);
      } else if (b.k === "character") {
        lines.push(`\n**${text.toUpperCase()}**`);
      } else if (b.k === "paren") {
        lines.push(`*${text}*`);
      } else if (b.k === "dialogue") {
        lines.push(`${text}\n`);
      } else if (b.k === "trans") {
        lines.push(`\n_${text.toUpperCase()}_\n`);
      } else {
        lines.push(`\n${text}\n`);
      }
    });

    return lines.join("\n");
  }

  function downloadFile(content, filename, mimeType = "text/plain") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Autocomplete Trigger & Selection ----------
  function checkCharacterAutocomplete(textarea, blockId) {
    const ep = STORY.ep;
    const bible = STORY.bible;
    if (!ep || !bible) return;

    const block = (ep.script.blocks || []).find(b => b.id === blockId);
    if (!block || block.k !== "character") {
      closeAutocomplete();
      return;
    }

    const val = textarea.value.trim().toLowerCase();
    const chars = bible.chars || [];

    const matches = chars.filter(c => {
      if (!val) return true;
      const name = (c.name || "").toLowerCase();
      const aliases = (c.aliases || []).map(a => a.toLowerCase());
      return name.includes(val) || aliases.some(a => a.includes(val));
    });

    if (matches.length > 0) {
      const rect = textarea.getBoundingClientRect();
      const rootRect = document.getElementById("story").getBoundingClientRect();

      SCRIPT_STATE.ac.open = true;
      SCRIPT_STATE.ac.blockId = blockId;
      SCRIPT_STATE.ac.items = matches;
      SCRIPT_STATE.ac.index = 0;
      SCRIPT_STATE.ac.x = rect.left - rootRect.left;
      SCRIPT_STATE.ac.y = rect.bottom - rootRect.top + 4;

      const popup = document.getElementById("script-autocomplete-popup");
      if (popup) {
        popup.innerHTML = renderAutocompleteItems();
        popup.style.left = `${SCRIPT_STATE.ac.x}px`;
        popup.style.top = `${SCRIPT_STATE.ac.y}px`;
        popup.hidden = false;
      }
    } else {
      closeAutocomplete();
    }
  }

  function closeAutocomplete() {
    SCRIPT_STATE.ac.open = false;
    SCRIPT_STATE.ac.blockId = null;
    SCRIPT_STATE.ac.items = [];
    const popup = document.getElementById("script-autocomplete-popup");
    if (popup) popup.hidden = true;
  }

  function selectAutocompleteItem(charId) {
    const ep = STORY.ep;
    const bible = STORY.bible;
    if (!ep || !bible) return;

    const char = (bible.chars || []).find(c => c.id === charId);
    const block = (ep.script.blocks || []).find(b => b.id === SCRIPT_STATE.ac.blockId);

    if (char && block) {
      block.text = char.name.toUpperCase();
      block.char = char.id;

      const textarea = document.querySelector(`[data-input-block="${block.id}"]`);
      if (textarea) {
        textarea.value = block.text;
        textarea.focus();
      }

      STORY.dirty.ep = true;
      STORY.scheduleSave();
      closeAutocomplete();
    }
  }

  // ---------- DOM Event Listeners & Keyboard Engine ----------
  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  function attachScriptListeners(container) {
    // 1. Textarea auto-sizing and live updates
    const textareas = container.querySelectorAll(".script-block-input");
    textareas.forEach(ta => {
      autoResizeTextarea(ta);

      ta.addEventListener("input", () => {
        autoResizeTextarea(ta);
        const blockId = ta.dataset.inputBlock;
        const block = (STORY.ep.script.blocks || []).find(b => b.id === blockId);
        if (block) {
          block.text = ta.value;
          STORY.dirty.ep = true;
          STORY.scheduleSave();

          // Autocomplete check if in character block
          if (block.k === "character") {
            checkCharacterAutocomplete(ta, blockId);
          }
        }
      });

      ta.addEventListener("focus", () => {
        const blockId = ta.dataset.inputBlock;
        SCRIPT_STATE.activeBlockId = blockId;
        container.querySelectorAll(".script-block").forEach(b => {
          b.classList.toggle("focused", b.dataset.blockId === blockId);
        });

        const block = (STORY.ep.script.blocks || []).find(b => b.id === blockId);
        if (block && block.k === "character") {
          checkCharacterAutocomplete(ta, blockId);
        }
      });

      ta.addEventListener("blur", () => {
        // Delayed close to allow autocomplete clicks
        setTimeout(() => {
          closeAutocomplete();
        }, 150);
      });

      // Screenplay Navigation Shortcuts
      ta.addEventListener("keydown", (e) => {
        handleBlockKeydown(e, ta);
      });
    });

    // 2. Outline beat textareas
    container.querySelectorAll(".outline-beat-text").forEach(ta => {
      ta.addEventListener("input", () => {
        const beatId = ta.dataset.beatText;
        const beat = (STORY.ep.outline.beats || []).find(b => b.id === beatId);
        if (beat) {
          beat.text = ta.value;
          STORY.dirty.ep = true;
          STORY.scheduleSave();
        }
      });
    });

    // 3. Outline beat second inputs
    container.querySelectorAll("[data-beat-sec]").forEach(input => {
      input.addEventListener("change", () => {
        const beatId = input.dataset.beatSec;
        const beat = (STORY.ep.outline.beats || []).find(b => b.id === beatId);
        if (beat) {
          beat.sec = Math.max(1, Number(input.value) || 15);
          STORY.dirty.ep = true;
          STORY.scheduleSave();
          STORY.renderView();
        }
      });
    });

    // 4. Outline Premise and Hook
    const premiseInput = container.querySelector("[data-s-outline='premise']");
    if (premiseInput) {
      premiseInput.addEventListener("input", () => {
        if (!STORY.ep.outline) STORY.ep.outline = {};
        STORY.ep.outline.premise = premiseInput.value;
        STORY.dirty.ep = true;
        STORY.scheduleSave();
      });
    }

    const hookInput = container.querySelector("[data-s-outline='hook']");
    if (hookInput) {
      hookInput.addEventListener("input", () => {
        if (!STORY.ep.outline) STORY.ep.outline = {};
        STORY.ep.outline.hook = hookInput.value;
        STORY.dirty.ep = true;
        STORY.scheduleSave();
      });
    }

    // 5. Pace Selector
    const paceSelect = container.querySelector("[data-s='script.changePace']");
    if (paceSelect) {
      paceSelect.addEventListener("change", (e) => {
        SCRIPT_STATE.durFactor = Number(e.target.value) || 1.0;
        STORY.renderView();
      });
    }
  }

  function handleBlockKeydown(e, ta) {
    const blockId = ta.dataset.inputBlock;
    const blocks = STORY.ep.script.blocks || [];
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;

    const block = blocks[idx];

    // Autocomplete Navigation (if open)
    if (SCRIPT_STATE.ac.open && SCRIPT_STATE.ac.items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        SCRIPT_STATE.ac.index = (SCRIPT_STATE.ac.index + 1) % SCRIPT_STATE.ac.items.length;
        const popup = document.getElementById("script-autocomplete-popup");
        if (popup) popup.innerHTML = renderAutocompleteItems();
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        SCRIPT_STATE.ac.index = (SCRIPT_STATE.ac.index - 1 + SCRIPT_STATE.ac.items.length) % SCRIPT_STATE.ac.items.length;
        const popup = document.getElementById("script-autocomplete-popup");
        if (popup) popup.innerHTML = renderAutocompleteItems();
        return;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const sel = SCRIPT_STATE.ac.items[SCRIPT_STATE.ac.index];
        if (sel) {
          selectAutocompleteItem(sel.id);
          return;
        }
      } else if (e.key === "Escape") {
        closeAutocomplete();
        return;
      }
    }

    // Tab Cycles Block Type (Synchronous DOM update avoids focus stealing on rapid double-tab)
    if (e.key === "Tab") {
      e.preventDefault();
      const curTypeIdx = BLOCK_TYPES.indexOf(block.k);
      const nextTypeIdx = e.shiftKey
        ? (curTypeIdx - 1 + BLOCK_TYPES.length) % BLOCK_TYPES.length
        : (curTypeIdx + 1) % BLOCK_TYPES.length;

      const oldK = block.k;
      block.k = BLOCK_TYPES[nextTypeIdx];
      STORY.dirty.ep = true;
      STORY.scheduleSave();

      const blockEl = ta.closest(".script-block");
      if (blockEl) {
        blockEl.classList.remove(`script-block-${oldK}`);
        blockEl.classList.add(`script-block-${block.k}`);
        blockEl.dataset.blockKind = block.k;
        const badge = blockEl.querySelector(".script-block-type-badge");
        if (badge) badge.textContent = block.k;
        let placeholder = "Type action description...";
        if (block.k === "scene") placeholder = "INT./EXT. LOCATION - TIME";
        else if (block.k === "character") placeholder = "CHARACTER NAME";
        else if (block.k === "paren") placeholder = "(direction)";
        else if (block.k === "dialogue") placeholder = "Dialogue line...";
        else if (block.k === "trans") placeholder = "CUT TO:";
        ta.placeholder = placeholder;
      }
      ta.focus();
      return;
    }

    // Enter creates the next logical block
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      let nextKind = "action";

      if (block.k === "scene") {
        nextKind = "action";
      } else if (block.k === "action") {
        nextKind = "action";
      } else if (block.k === "character") {
        nextKind = "dialogue";
      } else if (block.k === "paren") {
        nextKind = "dialogue";
      } else if (block.k === "dialogue") {
        if (!block.text || !block.text.trim()) {
          // If empty dialogue, convert this block to action
          block.k = "action";
          STORY.dirty.ep = true;
          STORY.scheduleSave();
          STORY.renderView();
          return;
        }
        nextKind = "character"; // Ready for next speaker
      } else if (block.k === "trans") {
        nextKind = "scene";
      }

      insertBlockAfter(idx, nextKind);
      return;
    }

    // Backspace on empty block removes it and focuses previous
    if (e.key === "Backspace" && (!ta.value || ta.value === "")) {
      if (blocks.length > 1) {
        e.preventDefault();
        STORY.snapshot("Delete empty block");
        blocks.splice(idx, 1);
        STORY.dirty.ep = true;
        STORY.scheduleSave();
        STORY.renderView();

        const prevIdx = Math.max(0, idx - 1);
        setTimeout(() => {
          const prevTa = document.querySelector(`[data-input-block="${blocks[prevIdx].id}"]`);
          if (prevTa) {
            prevTa.focus();
            prevTa.setSelectionRange(prevTa.value.length, prevTa.value.length);
          }
        }, 20);
        return;
      }
    }

    // Arrow Up/Down navigation between blocks
    if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0 && idx > 0) {
      e.preventDefault();
      const prevTa = document.querySelector(`[data-input-block="${blocks[idx - 1].id}"]`);
      if (prevTa) {
        prevTa.focus();
        prevTa.setSelectionRange(prevTa.value.length, prevTa.value.length);
      }
      return;
    }

    if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length && idx < blocks.length - 1) {
      e.preventDefault();
      const nextTa = document.querySelector(`[data-input-block="${blocks[idx + 1].id}"]`);
      if (nextTa) {
        nextTa.focus();
        nextTa.setSelectionRange(0, 0);
      }
      return;
    }

    // Alt+Up / Alt+Down moves block
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      moveBlockById(block.id, dir);
    }
  }

  function insertBlockAfter(idx, kind = "action") {
    const ep = STORY.ep;
    if (!ep) return;

    STORY.snapshot("Add block");
    const newBlock = {
      id: _uid("sb_"),
      k: kind,
      text: ""
    };

    if (kind === "dialogue" && idx >= 0 && ep.script.blocks[idx] && ep.script.blocks[idx].k === "character") {
      newBlock.char = ep.script.blocks[idx].char || "";
    }

    ep.script.blocks.splice(idx + 1, 0, newBlock);
    STORY.dirty.ep = true;
    STORY.scheduleSave();
    SCRIPT_STATE.activeBlockId = newBlock.id;
    STORY.renderView();

    // Synchronous focus prevents keystrokes typed within 0-50ms from being dropped
    const nextTa = document.querySelector(`[data-input-block="${newBlock.id}"]`);
    if (nextTa) nextTa.focus();
  }

  function moveBlockById(blockId, direction) {
    const ep = STORY.ep;
    if (!ep) return;

    const blocks = ep.script.blocks || [];
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx === -1) return;

    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= blocks.length) return;

    STORY.snapshot("Move block");
    const item = blocks.splice(idx, 1)[0];
    blocks.splice(targetIdx, 0, item);

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    STORY.renderView();

    setTimeout(() => {
      const ta = document.querySelector(`[data-input-block="${blockId}"]`);
      if (ta) ta.focus();
    }, 20);
  }

  // ---------- Register into STORY.cmds ----------
  STORY.cmds["script.subview"] = (arg) => {
    if (["script", "outline", "split", "season"].includes(arg)) {
      SCRIPT_STATE.subview = arg;
      STORY.renderView();
    }
  };

  STORY.cmds["script.addBlock"] = (arg) => {
    const kind = arg || "action";
    const ep = STORY.ep;
    if (!ep) return;

    insertBlockAfter(ep.script.blocks.length - 1, kind);
  };

  STORY.cmds["script.deleteBlock"] = (arg) => {
    const ep = STORY.ep;
    if (!ep) return;

    const idx = (ep.script.blocks || []).findIndex(b => b.id === arg);
    if (idx !== -1) {
      STORY.snapshot("Delete block");
      ep.script.blocks.splice(idx, 1);
      STORY.dirty.ep = true;
      STORY.scheduleSave();
      STORY.renderView();
    }
  };

  STORY.cmds["script.cycleType"] = (arg) => {
    const ep = STORY.ep;
    if (!ep) return;

    const block = (ep.script.blocks || []).find(b => b.id === arg);
    if (block) {
      const curIdx = BLOCK_TYPES.indexOf(block.k);
      block.k = BLOCK_TYPES[(curIdx + 1) % BLOCK_TYPES.length];
      STORY.dirty.ep = true;
      STORY.scheduleSave();
      STORY.renderView();
    }
  };

  STORY.cmds["script.moveBlock"] = (arg) => {
    const [blockId, dirStr] = arg.split(":");
    const dir = dirStr === "up" ? -1 : 1;
    moveBlockById(blockId, dir);
  };

  STORY.cmds["script.selectAc"] = (arg) => {
    selectAutocompleteItem(arg);
  };

  STORY.cmds["script.hookCheck"] = () => {
    if (STORY.ai && typeof STORY.ai.checkHookAI === "function") {
      STORY.ai.checkHookAI();
      return;
    }
    const ep = STORY.ep;
    if (!ep) return;
    const res = evaluateHookHeuristic(ep.script.blocks);
    if (typeof toast === "function") {
      toast(`${res.text} (Score: ${res.score}/10)`);
    }
  };

  // AI Script Actions (Wired to STORY.ai)
  STORY.cmds["script.aiWriteOutline"] = () => {
    if (STORY.ai && typeof STORY.ai.generateOutline === "function") {
      STORY.ai.generateOutline();
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  STORY.cmds["script.aiWriteScript"] = () => {
    if (STORY.ai && typeof STORY.ai.generateScriptFromOutline === "function") {
      STORY.ai.generateScriptFromOutline();
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  STORY.cmds["script.aiRewrite"] = () => {
    if (STORY.ai && typeof STORY.ai.rewriteScript === "function") {
      STORY.ai.rewriteScript();
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  STORY.cmds["script.aiTighten"] = () => {
    if (STORY.ai && typeof STORY.ai.tightenScriptToTarget === "function") {
      STORY.ai.tightenScriptToTarget();
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  STORY.cmds["script.aiTranslate"] = (arg) => {
    if (STORY.ai && typeof STORY.ai.translateDialogue === "function") {
      STORY.ai.translateDialogue(arg);
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  // Outline Beats Commands
  STORY.cmds["script.addBeat"] = () => {
    const ep = STORY.ep;
    if (!ep) return;
    ensureScriptSchema(ep);

    STORY.snapshot("Add beat");
    ep.outline.beats.push({
      id: _uid("bt_"),
      t: "Beat",
      sec: 15,
      text: ""
    });

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    STORY.renderView();
  };

  STORY.cmds["script.deleteBeat"] = (arg) => {
    const ep = STORY.ep;
    if (!ep) return;

    const idx = (ep.outline.beats || []).findIndex(b => b.id === arg);
    if (idx !== -1) {
      STORY.snapshot("Delete beat");
      ep.outline.beats.splice(idx, 1);
      STORY.dirty.ep = true;
      STORY.scheduleSave();
      STORY.renderView();
    }
  };

  STORY.cmds["script.moveBeat"] = (arg) => {
    const [beatId, dirStr] = arg.split(":");
    const dir = dirStr === "up" ? -1 : 1;
    const ep = STORY.ep;
    if (!ep) return;

    const beats = ep.outline.beats || [];
    const idx = beats.findIndex(b => b.id === beatId);
    if (idx === -1) return;

    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= beats.length) return;

    STORY.snapshot("Move beat");
    const item = beats.splice(idx, 1)[0];
    beats.splice(targetIdx, 0, item);

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    STORY.renderView();
  };

  STORY.cmds["script.generateFromOutline"] = async () => {
    const ep = STORY.ep;
    if (!ep) return;

    const beats = ep.outline.beats || [];
    if (!beats.length) {
      if (typeof toast === "function") toast("No beats in outline to convert.", true);
      return;
    }

    if (ep.script.blocks.length > 0) {
      const ok = typeof ask === "function" ? await ask(
        "Convert Outline to Script",
        "This will append new scene and action blocks from your outline beats to the current script. Continue?",
        "Append Blocks"
      ) : true;
      if (!ok) return;
    }

    STORY.snapshot("Convert outline to script");

    beats.forEach(b => {
      ep.script.blocks.push({
        id: _uid("sb_"),
        k: "scene",
        text: `INT. SCENE - ${b.t ? b.t.toUpperCase() : 'BEAT'}`
      });
      if (b.text) {
        ep.script.blocks.push({
          id: _uid("sb_"),
          k: "action",
          text: b.text
        });
      }
    });

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    SCRIPT_STATE.subview = "script";
    STORY.renderView();
    if (typeof toast === "function") toast("Converted outline beats into screenplay blocks.");
  };

  // Rail Jump Commands
  STORY.cmds["script.jumpToScene"] = (arg) => {
    SCRIPT_STATE.subview = "script";
    STORY.renderView();
    setTimeout(() => {
      const el = document.querySelector(`[data-block-id="${arg}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const ta = el.querySelector("textarea");
        if (ta) ta.focus();
      }
    }, 50);
  };

  STORY.cmds["script.jumpToBeat"] = (arg) => {
    SCRIPT_STATE.subview = "outline";
    STORY.renderView();
    setTimeout(() => {
      const el = document.querySelector(`[data-beat-id="${arg}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const ta = el.querySelector("textarea");
        if (ta) ta.focus();
      }
    }, 50);
  };

  // Season Commands
  STORY.cmds["script.addSeasonEp"] = () => {
    const bible = STORY.bible;
    if (!bible) return;
    ensureBibleSeason(bible);

    STORY.snapshot("Add season episode");
    const nextN = bible.season.length + 1;
    bible.season.push({
      n: nextN,
      title: `EP0${nextN} – Untitled`,
      skeleton: "1-3 sentences describing concrete character actions and dramatic turning point.",
      hook: "Startling opening visual or urgent question in the first 3 seconds.",
      ending: "Dramatic cliffhanger leading into next episode.",
      locations: [],
      characters: []
    });

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderView();
  };

  STORY.cmds["script.deleteSeasonEp"] = (arg) => {
    const bible = STORY.bible;
    if (!bible) return;

    const idx = Number(arg);
    if (bible.season && bible.season[idx]) {
      STORY.snapshot("Delete season episode");
      bible.season.splice(idx, 1);
      STORY.dirty.bible = true;
      STORY.scheduleSave();
      STORY.renderView();
    }
  };

  STORY.cmds["script.applySeasonToOutline"] = (arg) => {
    const bible = STORY.bible;
    const ep = STORY.ep;
    if (!bible || !ep) return;

    const idx = Number(arg);
    const sep = (bible.season || [])[idx];
    if (!sep) return;

    STORY.snapshot("Apply season skeleton to outline");
    ensureScriptSchema(ep);

    ep.outline.premise = sep.skeleton || "";
    ep.outline.hook = sep.hook || "";

    // Build 4 starter beats from skeleton, hook, and ending
    ep.outline.beats = [
      { id: _uid("bt_"), t: "Hook", sec: 5, text: sep.hook || "Opening hook beat" },
      { id: _uid("bt_"), t: "Setup", sec: 35, text: sep.skeleton || "Setup of conflict" },
      { id: _uid("bt_"), t: "Turn", sec: 30, text: "Dramatic escalation and main turn" },
      { id: _uid("bt_"), t: "Cliffhanger", sec: 20, text: sep.ending || "Ending beat" }
    ];

    if (sep.title) {
      ep.title = sep.title;
    }

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    SCRIPT_STATE.subview = "outline";
    STORY.renderView();

    if (typeof toast === "function") toast(`Applied EP ${sep.n || (idx + 1)} skeleton to outline.`);
  };

  STORY.cmds["script.openSeasonImport"] = () => {
    SCRIPT_STATE.modal = "seasonImport";
    SCRIPT_STATE.seasonImportText = "";
    STORY.renderView();
  };

  STORY.cmds["script.triggerSeasonFileSelect"] = () => {
    const input = document.getElementById("season-hidden-file-input");
    if (!input) return;

    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        if (typeof toast === "function") toast(`Extracting ${file.name}...`);
        const buffer = await file.arrayBuffer();
        const res = await api("/api/extract", buffer, file.name);
        if (res && res.text) {
          SCRIPT_STATE.seasonImportText = res.text;
          const ta = document.getElementById("season-import-textarea");
          if (ta) ta.value = res.text;
          if (typeof toast === "function") toast("Extracted text successfully.");
        } else {
          throw new Error("No text extracted from file.");
        }
      } catch (err) {
        console.error("Season extract error:", err);
        if (typeof toast === "function") toast("Extract failed: " + err.message, true);
      }
    };

    input.click();
  };

  STORY.cmds["script.confirmSeasonImport"] = () => {
    const ta = document.getElementById("season-import-textarea");
    const raw = ta ? ta.value : SCRIPT_STATE.seasonImportText;
    if (!raw || !raw.trim()) {
      if (typeof toast === "function") toast("Please paste or upload story text.", true);
      return;
    }

    const bible = STORY.bible;
    if (!bible) return;
    ensureBibleSeason(bible);

    // Heuristic splitting into episodes: looks for "EPISODE", "EP ", "TẬP ", or double newlines
    const chunks = raw.split(/(?:EPISODE\s*\d+|EP\s*\d+|TẬP\s*\d+|CHAPTER\s*\d+)/i).filter(c => c.trim().length > 20);

    STORY.snapshot("Import season episodes");

    if (chunks.length > 1) {
      chunks.forEach((chunk, i) => {
        const lines = chunk.trim().split(/\r?\n/).filter(Boolean);
        const title = lines[0] ? lines[0].substring(0, 40) : `Episode ${i + 1}`;
        const body = lines.slice(1).join(" ") || lines[0] || "";

        bible.season.push({
          n: bible.season.length + 1,
          title: `EP0${bible.season.length + 1} – ${title}`,
          skeleton: body.substring(0, 300),
          hook: body.substring(0, 100),
          ending: body.length > 200 ? body.substring(body.length - 120) : "Cliffhanger ending beat.",
          locations: [],
          characters: []
        });
      });
    } else {
      // Single chunk: create 1 episode
      bible.season.push({
        n: bible.season.length + 1,
        title: `EP0${bible.season.length + 1} – Story Arc`,
        skeleton: raw.substring(0, 300),
        hook: raw.substring(0, 100),
        ending: raw.length > 200 ? raw.substring(raw.length - 120) : "Cliffhanger ending beat.",
        locations: [],
        characters: []
      });
    }

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    SCRIPT_STATE.modal = null;
    STORY.renderView();
    if (typeof toast === "function") toast(`Parsed and created ${chunks.length || 1} season episode(s).`);
  };

  // Versions Commands
  STORY.cmds["script.openVersions"] = () => {
    SCRIPT_STATE.modal = "versions";
    SCRIPT_STATE.selectedRev = null;
    STORY.renderView();
  };

  STORY.cmds["script.closeModal"] = () => {
    SCRIPT_STATE.modal = null;
    SCRIPT_STATE.importPreview = null;
    STORY.renderView();
  };

  STORY.cmds["script.saveVersionNow"] = () => {
    const ep = STORY.ep;
    if (!ep) return;
    ensureScriptSchema(ep);

    const noteInput = document.getElementById("script-version-note");
    const note = noteInput ? noteInput.value.trim() : "";

    const revNum = ep.script.rev || 1;
    const snap = {
      rev: revNum,
      at: Date.now(),
      note: note,
      blocks: JSON.parse(JSON.stringify(ep.script.blocks || []))
    };

    ep.script.revs.push(snap);
    // Keep max 10 revisions
    if (ep.script.revs.length > 10) {
      ep.script.revs.shift();
    }

    ep.script.rev = revNum + 1;
    STORY.dirty.ep = true;
    STORY.scheduleSave();
    STORY.renderView();

    if (typeof toast === "function") toast(`Saved Version Rev ${revNum}.`);
  };

  STORY.cmds["script.selectDiffRev"] = (arg) => {
    SCRIPT_STATE.selectedRev = Number(arg);
    STORY.renderView();
  };

  STORY.cmds["script.restoreRev"] = async (arg) => {
    const revNum = Number(arg);
    const ep = STORY.ep;
    if (!ep) return;

    const revObj = (ep.script.revs || []).find(r => r.rev === revNum);
    if (!revObj) return;

    const ok = typeof ask === "function" ? await ask(
      "Restore Version",
      `Are you sure you want to restore Revision ${revNum}? Current unsaved edits will be replaced.`,
      "Restore Version"
    ) : true;
    if (!ok) return;

    STORY.snapshot(`Before restore rev ${revNum}`);
    ep.script.blocks = JSON.parse(JSON.stringify(revObj.blocks || []));
    STORY.dirty.ep = true;
    STORY.scheduleSave();
    SCRIPT_STATE.modal = null;
    STORY.renderView();

    if (typeof toast === "function") toast(`Restored script to Revision ${revNum}.`);
  };

  // Import Commands
  STORY.cmds["script.openImport"] = () => {
    SCRIPT_STATE.modal = "import";
    SCRIPT_STATE.importPreview = null;
    STORY.renderView();
  };

  STORY.cmds["script.triggerFileSelect"] = () => {
    const input = document.getElementById("script-hidden-file-input");
    if (!input) return;

    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        if (typeof toast === "function") toast(`Extracting ${file.name}...`);
        const buffer = await file.arrayBuffer();
        const res = await api("/api/extract", buffer, file.name);

        if (res && res.text) {
          const parsed = parseScreenplayText(res.text);
          SCRIPT_STATE.importPreview = {
            filename: file.name,
            blocks: parsed
          };
          STORY.renderView();
          if (typeof toast === "function") toast(`Extracted ${parsed.length} blocks.`);
        } else {
          throw new Error("No text returned from extractor.");
        }
      } catch (err) {
        console.error("Extract error:", err);
        if (typeof toast === "function") toast("Extract failed: " + err.message, true);
      }
    };

    input.click();
  };

  STORY.cmds["script.confirmImport"] = (arg) => {
    if (!SCRIPT_STATE.importPreview || !SCRIPT_STATE.importPreview.blocks) return;
    const ep = STORY.ep;
    if (!ep) return;

    STORY.snapshot("Import screenplay");
    ensureScriptSchema(ep);

    if (arg === "append") {
      ep.script.blocks = ep.script.blocks.concat(SCRIPT_STATE.importPreview.blocks);
    } else {
      ep.script.blocks = SCRIPT_STATE.importPreview.blocks;
    }

    STORY.dirty.ep = true;
    STORY.scheduleSave();
    SCRIPT_STATE.modal = null;
    SCRIPT_STATE.importPreview = null;
    STORY.renderView();

    if (typeof toast === "function") toast("Script imported successfully.");
  };

  // Export Commands
  STORY.cmds["script.openExportMenu"] = () => {
    const dd = document.getElementById("script-export-dropdown");
    if (dd) dd.hidden = !dd.hidden;
  };

  STORY.cmds["script.export"] = (arg) => {
    const ep = STORY.ep;
    if (!ep) return;

    const dd = document.getElementById("script-export-dropdown");
    if (dd) dd.hidden = true;

      const filename = ext => window.KTOON_FILENAME && typeof window.KTOON_FILENAME.next === "function"
        ? window.KTOON_FILENAME.next("SCRIPT", ext, ep)
        : `PROJECT_EP${String(ep.no || 1).padStart(2, "0")}_SCRIPT_v1.${ext}`;

    if (arg === "fountain") {
      const content = exportFountain(ep);
      downloadFile(content, filename("fountain"), "text/plain");
      if (typeof toast === "function") toast("Exported .fountain file.");
    } else if (arg === "txt") {
      const content = exportScreenplayText(ep);
      downloadFile(content, filename("txt"), "text/plain");
      if (typeof toast === "function") toast("Exported screenplay .txt file.");
    } else if (arg === "md") {
      const content = exportMarkdown(ep);
      downloadFile(content, filename("md"), "text/markdown");
      if (typeof toast === "function") toast("Exported .md file.");
    }
  };

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    const dd = document.getElementById("script-export-dropdown");
    if (dd && !dd.hidden && !e.target.closest("[data-s='script.openExportMenu']")) {
      dd.hidden = true;
    }
  });

  // ---------- Register into Module Registry ----------
  STORY.views.script = {
    render: renderScriptView
  };
  STORY.script = STORY.script || {};
  STORY.script.parseScreenplayText = parseScreenplayText;

  if (!Array.isArray(STORY.hooks.afterLoad)) {
    STORY.hooks.afterLoad = [];
  }

  STORY.hooks.afterLoad.push(() => {
    if (STORY.tab === "script" && typeof STORY.renderView === "function") {
      STORY.renderView();
    }
  });

})();
