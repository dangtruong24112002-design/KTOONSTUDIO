// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with authentication & episode header)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL resolver)
// - parseShotlist(raw) : { shots: [...], header: string, tail: string } (Existing GPT shotlist parser)
// - CUR : { ep: { id, name, ... }, series: { id, name, ... } } (Current context)
// - PJ : { groups: [...], series: [...], episodes: [...] } (Project tree)
// - C : { catalog: { video: [...], llm: [...], image: [...] } } (Model catalog)
// - STORY : state store exported on window
//
// Server changes needed:
// - None for Task 004. Utilizes /api/desk/batch for persistence and client-side blob downloads.
//
// App changes needed:
// - None. Integrates into STORY module registry (STORY.views.shotlist, STORY.inspector.shot).
//
// Known limitations:
// - Drag-and-drop reordering uses HTML5 Drag and Drop API.
// - AI shotlist generation from script will be hooked up in TASK 006.

(function () {
  "use strict";

  // Default Column Definitions
  const ALL_COLUMNS = [
    { id: "chk", label: "Sel", fixed: true, defaultShow: true },
    { id: "no", label: "#", fixed: true, defaultShow: true },
    { id: "block", label: "Block", defaultShow: true },
    { id: "type", label: "Type", defaultShow: true },
    { id: "dur", label: "Dur", defaultShow: true },
    { id: "size", label: "Size", defaultShow: true },
    { id: "angle", label: "Angle", defaultShow: true },
    { id: "move", label: "Move", defaultShow: true },
    { id: "chars", label: "Chars", defaultShow: true },
    { id: "loc", label: "Loc", defaultShow: true },
    { id: "action", label: "Action", defaultShow: true },
    { id: "dialogue", label: "Dialogue", defaultShow: true },
    { id: "stb", label: "STB", defaultShow: true },
    { id: "video", label: "Video", defaultShow: true },
    { id: "status", label: "Status", defaultShow: true },
    { id: "lens", label: "Lens", defaultShow: false },
    { id: "cam_rel", label: "Cam Rel", defaultShow: false },
    { id: "placement", label: "Placement", defaultShow: false },
    { id: "purpose", label: "Purpose", defaultShow: false },
    { id: "perf", label: "Perf", defaultShow: false },
    { id: "act", label: "Actions", fixed: true, defaultShow: true }
  ];

  // Local preferences
  let viewMode = "table"; // 'table' | 'cards'
  let visibleCols = new Set(ALL_COLUMNS.filter(c => c.defaultShow).map(c => c.id));
  let selectedShotIds = new Set();
  let colMenuOpen = false;
  let draggedShotId = null;
  let searchQuery = "";

  // Load preferences from localStorage
  try {
    const rawMode = localStorage.getItem("ktoon_shot_view_mode");
    if (rawMode === "table" || rawMode === "cards") viewMode = rawMode;
    const rawCols = localStorage.getItem("ktoon_shot_cols");
    if (rawCols) {
      const arr = JSON.parse(rawCols);
      if (Array.isArray(arr) && arr.length) visibleCols = new Set(arr);
    }
  } catch (e) {
    // safe fail
  }

  function savePrefs() {
    try {
      localStorage.setItem("ktoon_shot_view_mode", viewMode);
      localStorage.setItem("ktoon_shot_cols", JSON.stringify([...visibleCols]));
    } catch (e) {
      // safe fail
    }
  }

  // Safe escape helper
  function _esc(s) {
    if (typeof esc === "function") return esc(s);
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function _uid(prefix = "sh_") {
    if (STORY && typeof STORY.uid === "function") return STORY.uid(prefix);
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  // ---------- Full Schema Factory (Spec 4.2 & Workflow §4) ----------
  function createDefaultShot(overrides = {}) {
    const defaultBlock = overrides.block || 1;
    // Default slug from current script scene heading if available
    let defaultSlug = "";
    if (typeof STORY !== "undefined" && STORY && STORY.ep && STORY.ep.script && Array.isArray(STORY.ep.script.blocks)) {
      const sceneBlocks = STORY.ep.script.blocks.filter(b => b.k === "scene" || b.type === "scene");
      if (sceneBlocks.length > 0) {
        defaultSlug = sceneBlocks[sceneBlocks.length - 1].text || "";
      }
    }
    // Default type: I2V unless characters assigned per KTOONS_STANDARDS mix 40/40/20
    const hasChars = overrides.chars && overrides.chars.length > 0;
    const defaultType = overrides.type || (hasChars ? "REF" : "I2V");

    return Object.assign({
      id: _uid("sh_"),
      n: 1,
      block: defaultBlock,
      batch: overrides.batch || defaultBlock,
      type: defaultType, // REF | I2V | MINI
      dur: 6, // 4..15
      source: "", // SOURCE (EPxx SHOT yy)
      slug: defaultSlug, // INT./EXT. LOCATION - TIME
      scene: "", // scene block ID
      lines: [], // script blocks
      title: "",
      content: "",
      size: "MCU",
      angle: "eye level",
      move: "static",
      lens: "50mm",
      cam_rel: "", // camera relative to subject
      placement: "", // subject placement in frame
      purpose: "", // storyboard purpose
      perf: "", // performance / acting notes
      is_intercut: false,
      intercut_to: "",
      chars: [],
      loc: "",
      props: [],
      wardrobe: {},
      action: "",
      dialogue: [], // [{ char, char_name, modifier, text, sec }]
      sfx: "",
      music: "",
      cont: { start: "", end: "" },
      excl: "",
      bank: [], // <= 8 items for REF
      stb: { prompt: "", ref: "", status: "none", istu: "" },
      vprompt: { text: "", ver: 1, lint: [], locked: false },
      video: { node: "", job: "", ref: "", status: "none", note: "" },
      edit: { clip: "", pid: "" },
      notes: "",
      status: "draft", // draft | ready | stb | video | approved | in_edit
      u: Date.now()
    }, overrides);
  }

  // Helper to get shot list
  function getShots() {
    if (!STORY || !STORY.ep) return [];
    if (!Array.isArray(STORY.ep.shots)) STORY.ep.shots = [];
    return STORY.ep.shots;
  }

  // Helper to get series bible
  function getBible() {
    return (STORY && STORY.bible) ? STORY.bible : null;
  }

  // Format shot number e.g. S01, S12
  function formatShotNo(n) {
    const num = Number(n) || 1;
    return "S" + (num < 10 ? "0" + num : num);
  }

  // ---------- Automatic Batching Engine (≤ batchMax, default 30s) ----------
  function computeBatches() {
    const shots = getShots();
    const bible = getBible();
    const batchMax = (bible && bible.format && bible.format.batchMax) || 30;

    if (!shots.length) {
      if (STORY.ep) STORY.ep.batches = [];
      return;
    }

    const batches = [];
    let curBatchShots = [];
    let curBatchSec = 0;
    let batchIndex = 1;

    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const dur = Number(s.dur) || 6;

      // If adding this shot exceeds batchMax and current batch has shots, wrap current batch
      if (curBatchShots.length > 0 && (curBatchSec + dur > batchMax)) {
        batches.push({
          id: _uid("bt_"),
          n: batchIndex,
          shots: curBatchShots.map(x => x.id),
          sec: Number(curBatchSec.toFixed(1)),
          block: Math.min(3, Math.max(1, batchIndex))
        });
        batchIndex++;
        curBatchShots = [];
        curBatchSec = 0;
      }

      curBatchShots.push(s);
      curBatchSec += dur;
      s.batch = batchIndex;
      // In KTOONS workflow, 3 blocks x 30s = 90s total (block = generation batch)
      s.block = Math.min(3, Math.max(1, batchIndex));
    }

    if (curBatchShots.length > 0) {
      batches.push({
        id: _uid("bt_"),
        n: batchIndex,
        shots: curBatchShots.map(x => x.id),
        sec: Number(curBatchSec.toFixed(1)),
        block: Math.min(3, Math.max(1, batchIndex))
      });
    }

    if (STORY.ep) {
      STORY.ep.batches = batches;
    }
  }

  // Renumber shots sequentially 1..N
  function renumberShots() {
    const shots = getShots();
    shots.forEach((s, idx) => {
      s.n = idx + 1;
    });
  }

  // ---------- Metrics & Totals Calculation ----------
  function computeTotals() {
    const shots = getShots();
    const ep = STORY.ep || {};
    const target = Number(ep.target) || 90;
    const dur = shots.reduce((acc, s) => acc + (Number(s.dur) || 0), 0);
    const count = shots.length;

    const refCount = shots.filter(s => s.type === "REF").length;
    const i2vCount = shots.filter(s => s.type === "I2V").length;
    const miniCount = shots.filter(s => s.type === "MINI").length;

    const refPct = count ? Math.round((refCount / count) * 100) : 0;
    const i2vPct = count ? Math.round((i2vCount / count) * 100) : 0;
    const miniPct = count ? Math.round((miniCount / count) * 100) : 0;

    const batches = (ep.batches && Array.isArray(ep.batches)) ? ep.batches.length : 0;

    // Estimate cost: get price per sec from catalog or default Seedance $0.16/sec
    let pricePerSec = 0.16;
    if (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) {
      const vmod = C.catalog.video.find(m => m.id && m.id.includes("seedance"));
      if (vmod && typeof vmod.price === "number") pricePerSec = vmod.price;
    }
    const cost = (dur * pricePerSec).toFixed(2);

    return {
      count,
      duration: Number(dur.toFixed(1)),
      target,
      refCount,
      i2vCount,
      miniCount,
      refPct,
      i2vPct,
      miniPct,
      batches,
      cost
    };
  }

  // ---------- Gate A Rule Verification (Realtime) ----------
  function checkGateA() {
    const shots = getShots();
    const bible = getBible() || {};
    const format = bible.format || {};
    const shotMin = format.shotMin || 4;
    const shotMax = format.shotMax || 15;
    const target = (STORY.ep && STORY.ep.target) || 90;
    const totals = computeTotals();

    const issues = [];

    // 1. Total duration vs target (> 5% deviation)
    if (shots.length > 0 && target > 0) {
      const diff = Math.abs(totals.duration - target);
      const diffPct = Math.round((diff / target) * 100);
      if (diffPct > 5) {
        issues.push({
          id: "iss_tot_dur",
          severity: diffPct > 20 ? "err" : "warn",
          code: "DUR_TARGET_DRIFT",
          shotId: null,
          title: "Total Duration Mismatch",
          desc: `Total shotlist duration (${totals.duration} s) deviates from ${target} s target by ${diffPct}% (> 5%).`,
          canFix: false
        });
      }
    }

    // 2. Type ratio deviation (> 15% from 40/40/20 target)
    if (shots.length >= 5) {
      const diffRef = Math.abs(totals.refPct - 40);
      const diffI2v = Math.abs(totals.i2vPct - 40);
      const diffMini = Math.abs(totals.miniPct - 20);
      if (diffRef > 15 || diffI2v > 15 || diffMini > 15) {
        issues.push({
          id: "iss_mix_ratio",
          severity: "warn",
          code: "TYPE_MIX_UNBALANCED",
          shotId: null,
          title: "Type Ratio Imbalance",
          desc: `Current ratio REF ${totals.refPct}% / I2V ${totals.i2vPct}% / MINI ${totals.miniPct}% deviates >15% from target 40 / 40 / 20.`,
          canFix: false
        });
      }
    }

    // Bible entities for lookup
    const bibleCharIds = new Set((bible.chars || []).map(c => c.id));
    const bibleCharNames = new Set((bible.chars || []).map(c => (c.name || "").toUpperCase()));
    const bibleLocIds = new Set((bible.locs || []).map(l => l.id));

    // Check duplicate or skipped shot numbers
    const seenNos = new Set();
    let hasSkippedOrDup = false;
    shots.forEach((s, idx) => {
      if (s.n !== idx + 1 || seenNos.has(s.n)) {
        hasSkippedOrDup = true;
      }
      seenNos.add(s.n);
    });

    if (hasSkippedOrDup) {
      issues.push({
        id: "iss_renumber",
        severity: "err",
        code: "SHOT_NUMBERING",
        shotId: null,
        title: "Shot Numbering Out of Order",
        desc: "Shot numbers have gaps or duplicate sequence numbers.",
        canFix: true,
        fixCmd: "shot.renumber"
      });
    }

    // Per-shot checks
    shots.forEach((s, idx) => {
      const sNo = formatShotNo(s.n);

      // Duration limits [shotMin, shotMax]
      const dur = Number(s.dur) || 0;
      if (dur < shotMin || dur > shotMax) {
        issues.push({
          id: `iss_dur_${s.id}`,
          severity: "err",
          code: "DUR_OUT_OF_BOUNDS",
          shotId: s.id,
          title: `${sNo} Duration Limit`,
          desc: `${sNo} duration (${dur} s) is outside the allowed [${shotMin} s, ${shotMax} s] range.`,
          canFix: true,
          fixCmd: `shot.fix_dur:${s.id}`
        });
      }

      // REF shot checks
      if (s.type === "REF") {
        if (!s.bank || s.bank.length === 0) {
          issues.push({
            id: `iss_ref_bank_${s.id}`,
            severity: "warn",
            code: "REF_NO_BANK",
            shotId: s.id,
            title: `${sNo} REF Missing Bank`,
            desc: `${sNo} is TYPE: REF but has no reference bank items assigned.`,
            canFix: false
          });
        } else if (s.bank.length > 8) {
          issues.push({
            id: `iss_ref_max_${s.id}`,
            severity: "err",
            code: "REF_BANK_OVERFLOW",
            shotId: s.id,
            title: `${sNo} Reference Bank Overflow`,
            desc: `${sNo} specifies ${s.bank.length} bank images. Seedance REF allows a maximum of 8 images.`,
            canFix: true,
            fixCmd: `shot.fix_trim_bank:${s.id}`
          });
        }
      }

      // Non-REF shot mentioning bank
      if ((s.type === "I2V" || s.type === "MINI") && s.bank && s.bank.length > 0) {
        issues.push({
          id: `iss_nonref_bank_${s.id}`,
          severity: "warn",
          code: "NON_REF_HAS_BANK",
          shotId: s.id,
          title: `${sNo} Bank In I2V/MINI`,
          desc: `${sNo} is TYPE: ${s.type} but specifies bank references (banks are strictly for REF).`,
          canFix: true,
          fixCmd: `shot.fix_clear_bank:${s.id}`
        });
      }

      // Missing STB when reaching video phase
      if ((s.type === "I2V" || s.type === "MINI") && (s.status === "video" || (s.video && s.video.status !== "none")) && (!s.stb || !s.stb.ref)) {
        issues.push({
          id: `iss_stb_${s.id}`,
          severity: "err",
          code: "MISSING_STB_FOR_VIDEO",
          shotId: s.id,
          title: `${sNo} Missing STB Keyframe`,
          desc: `${sNo} is in video production stage but does not have an approved STB image.`,
          canFix: false
        });
      }

      // Character in dialogue not in shot's chars
      if (Array.isArray(s.dialogue)) {
        s.dialogue.forEach(d => {
          if (d.char && (!Array.isArray(s.chars) || !s.chars.includes(d.char))) {
            const charName = d.char_name || d.char;
            issues.push({
              id: `iss_dlg_char_${s.id}_${d.char}`,
              severity: "warn",
              code: "DIALOGUE_CHAR_NOT_TAGGED",
              shotId: s.id,
              title: `${sNo} Dialogue Character Tag`,
              desc: `Character '${charName}' speaks in dialogue but is not tagged in shot characters list.`,
              canFix: true,
              fixCmd: `shot.fix_add_char:${s.id}:${d.char}`
            });
          }
        });

        // Dialogue length vs shot duration check (2.5 words/sec)
        const totalWords = s.dialogue.reduce((wAcc, line) => {
          const words = (line.text || "").trim().split(/\s+/).filter(Boolean).length;
          return wAcc + words;
        }, 0);
        const maxWords = Math.floor(dur * 2.5);
        if (totalWords > maxWords && dur > 0) {
          issues.push({
            id: `iss_dlg_len_${s.id}`,
            severity: "warn",
            code: "DIALOGUE_OVERFLOW",
            shotId: s.id,
            title: `${sNo} Dialogue Exceeds Duration`,
            desc: `Dialogue in ${sNo} (${totalWords} words) exceeds duration capacity (${dur} s × 2.5 w/s = ${maxWords} words).`,
            canFix: false
          });
        }
      }

      // Continuity conflict check between S(n) end and S(n+1) start
      if (idx < shots.length - 1) {
        const nextShot = shots[idx + 1];
        if (s.cont && s.cont.end && nextShot.cont && nextShot.cont.start) {
          const endNote = s.cont.end.toLowerCase();
          const startNote = nextShot.cont.start.toLowerCase();
          if (
            (endNote.includes("left") && startNote.includes("right")) ||
            (endNote.includes("standing") && startNote.includes("sitting")) ||
            (endNote.includes("day") && startNote.includes("night"))
          ) {
            issues.push({
              id: `iss_cont_${s.id}`,
              severity: "warn",
              code: "CONTINUITY_CONFLICT",
              shotId: s.id,
              title: `${sNo} Continuity Conflict`,
              desc: `Potential continuity mismatch between ${sNo} end ('${s.cont.end}') and ${formatShotNo(nextShot.n)} start ('${nextShot.cont.start}').`,
              canFix: false
            });
          }
        }
      }
    });

    return issues;
  }

  function updateGateAUI() {
    const issues = checkGateA();
    const countEl = document.getElementById("story-issues-count");
    if (countEl) {
      countEl.textContent = issues.length;
      countEl.className = "story-badge-count" + (issues.some(i => i.severity === "err") ? " err" : issues.length ? " warn" : "");
    }

    const listEl = document.getElementById("story-issues-list");
    if (!listEl) return;

    if (!issues.length) {
      listEl.innerHTML = `
        <div class="story-empty-state" style="padding:24px 8px;">
          <div class="story-empty-title" style="font-size:13.5px;color:var(--ok,#56d9b0);">Gate A Clear</div>
          <div class="story-empty-desc">
            No issues found. Shot durations, REF banks, character dialogues, and type ratios satisfy production rules.
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = issues.map(iss => `
      <div class="story-issue-item ${iss.severity}">
        <div class="story-issue-header">
          <span class="story-issue-tag ${iss.severity}">${_esc(iss.code)}</span>
          <span style="font-size:11px;font-weight:600;color:var(--text);">${_esc(iss.title)}</span>
        </div>
        <div class="story-issue-msg">${_esc(iss.desc)}</div>
        <div class="story-issue-actions">
          ${iss.shotId ? `<button class="story-btn-ghost" style="padding:2px 7px;font-size:10.5px;" data-s="shot.goto:${iss.shotId}">Go to</button>` : ""}
          ${iss.canFix && iss.fixCmd ? `<button class="story-btn-gold" style="padding:2px 7px;font-size:10.5px;" data-s="${iss.fixCmd}">Fix</button>` : ""}
        </div>
      </div>
    `).join("");
  }

  // ---------- Table & Cards UI Renderers ----------
  function renderShotlist(root) {
    if (!root) return;
    const shots = getShots();
    const totals = computeTotals();
    const ep = STORY.ep || {};
    const bible = getBible() || {};

    // Sync header status bar & cost pill
    if (typeof STORY.updateStatusBar === "function") {
      STORY.updateStatusBar();
    }
    const hdrCost = document.getElementById("story-hdr-cost");
    if (hdrCost) hdrCost.textContent = `$${totals.cost}`;

    // Update Gate A issues in right panel
    updateGateAUI();

    const targetSec = Number(ep.target) || 90;
    const durDelta = Math.abs(totals.duration - targetSec);
    const durPillClass = durDelta <= targetSec * 0.05 ? "ok" : durDelta <= targetSec * 0.15 ? "warn" : "err";

    root.innerHTML = `
      <div class="story-shotlist-wrap">
        <!-- Top Toolbar -->
        <div class="story-shot-toolbar">
          <div class="story-shot-toolbar-left">
            <div class="story-view-toggle">
              <button class="${viewMode === 'table' ? 'active' : ''}" data-s="shot.view_mode:table">Table</button>
              <button class="${viewMode === 'cards' ? 'active' : ''}" data-s="shot.view_mode:cards">Cards</button>
            </div>
            <button class="story-btn-gold" data-s="shot.add">+ Add Shot</button>
            <button class="story-btn-ghost" data-s="shot.add_intercut">+ Intercut</button>
            <button class="story-btn-ghost" data-s="shot.renumber">Renumber</button>
            <button class="story-btn-ghost" data-s="shot.rebatch">Rebatch</button>
            <select class="story-cell-select" id="story-bulk-type-select" style="width:105px;" onchange="STORY.cmds['shot.bulk_type'](this.value)">
              <option value="">Bulk Type...</option>
              <option value="REF">Set to REF</option>
              <option value="I2V">Set to I2V</option>
              <option value="MINI">Set to MINI</option>
            </select>
          </div>

          <div class="story-shot-toolbar-right">
            <input type="search" class="story-shot-search" placeholder="Filter shots..." value="${_esc(searchQuery)}" id="story-shot-filter-input">
            <button class="story-btn-ghost" data-s="shot.toggle_cols">Columns ▾</button>
            <button class="story-btn-ghost" data-s="shot.import_menu">Import ▾</button>
            <button class="story-btn-ghost" data-s="shot.export_menu">Export ▾</button>
          </div>
        </div>

        <!-- Metrics & Ratio Bar -->
        <div class="story-shot-metrics">
          <div class="story-shot-metrics-left">
            <div class="story-dur-meter">
              <span>Duration:</span>
              <span class="story-dur-pill ${durPillClass}">${totals.duration} s / ${targetSec} s</span>
            </div>

            <div class="story-ratio-bar-wrap">
              <span>Mix (40/40/20):</span>
              <div class="story-ratio-bar" title="REF ${totals.refPct}% / I2V ${totals.i2vPct}% / MINI ${totals.miniPct}%">
                <div class="story-ratio-seg-ref" style="width:${totals.refPct}%;"></div>
                <div class="story-ratio-seg-i2v" style="width:${totals.i2vPct}%;"></div>
                <div class="story-ratio-seg-mini" style="width:${totals.miniPct}%;"></div>
              </div>
              <div class="story-ratio-legend">
                <span><span class="story-legend-dot story-legend-ref"></span>REF ${totals.refCount} (${totals.refPct}%)</span>
                <span><span class="story-legend-dot story-legend-i2v"></span>I2V ${totals.i2vCount} (${totals.i2vPct}%)</span>
                <span><span class="story-legend-dot story-legend-mini"></span>MINI ${totals.miniCount} (${totals.miniPct}%)</span>
              </div>
            </div>
          </div>

          <div>
            <span>${totals.batches} batches · Est. Video <b>$${totals.cost}</b></span>
          </div>
        </div>

        <!-- Main Content Area -->
        <div class="story-shot-content" id="story-shot-scroll-area">
          ${viewMode === "table" ? renderTableView(shots) : renderCardsView(shots)}
        </div>
      </div>
    `;

    // Hook search input
    const filterInp = document.getElementById("story-shot-filter-input");
    if (filterInp) {
      filterInp.oninput = (e) => {
        searchQuery = (e.target.value || "").trim().toLowerCase();
        renderShotlist(root);
      };
    }
  }

  // Filter shots based on search text
  function getFilteredShots(shots) {
    if (!searchQuery) return shots;
    return shots.filter(s => {
      const text = [
        formatShotNo(s.n),
        s.type,
        s.slug,
        s.title,
        s.action,
        s.content,
        (s.dialogue || []).map(d => `${d.char_name}: ${d.text}`).join(" "),
        s.size,
        s.angle,
        s.move,
        s.status
      ].join(" ").toLowerCase();
      return text.includes(searchQuery);
    });
  }

  // Render Table View
  function renderTableView(allShots) {
    const shots = getFilteredShots(allShots);
    if (!shots.length) {
      return `
        <div class="story-empty-state" style="padding:60px 16px;">
          <div class="story-empty-title">No shots in this episode</div>
          <div class="story-empty-desc">Click '+ Add Shot' to create your first shot, or import a shotlist from GPT / CSV format.</div>
          <button class="story-btn-gold" data-s="shot.add">+ Add First Shot</button>
        </div>
      `;
    }

    const bible = getBible() || {};
    const charMap = new Map((bible.chars || []).map(c => [c.id, c.name]));
    const locMap = new Map((bible.locs || []).map(l => [l.id, l.name]));

    // Group rows by batch
    let currentBatch = null;
    const rowsHtml = [];

    shots.forEach(s => {
      // Check if batch changed (divider row)
      if (s.batch && s.batch !== currentBatch) {
        currentBatch = s.batch;
        const bObj = (STORY.ep && STORY.ep.batches) ? STORY.ep.batches.find(b => b.n === currentBatch) : null;
        const bSec = bObj ? bObj.sec : 0;
        const bBlock = s.block || Math.min(3, currentBatch);
        rowsHtml.push(`
          <tr class="story-batch-divider-row" data-batch="${currentBatch}">
            <td colspan="${visibleCols.size}">
              <div class="story-batch-divider-content">
                <div class="story-batch-divider-left">
                  <span class="story-batch-tag">BATCH ${currentBatch}</span>
                  <span>Block ${bBlock} · Total: <b>${bSec} s</b> / 30 s max</span>
                </div>
                <div style="font-size:11px;color:var(--muted);font-weight:normal;">
                  Generation batch unit (Seedance 2.5)
                </div>
              </div>
            </td>
          </tr>
        `);
      }

      // Check if this shot is an INTERCUT TO row
      if (s.is_intercut) {
        rowsHtml.push(`
          <tr class="story-intercut-row story-shot-row ${STORY.selItem && STORY.selItem.id === s.id ? 'selected' : ''}" data-s="shot.select:${s.id}">
            <td colspan="${visibleCols.size}">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <span>INTERCUT TO: <b>${_esc(s.intercut_to || s.slug || "LOCATION")}</b></span>
                <button class="story-btn-ghost" style="padding:1px 6px;font-size:10px;" data-s="shot.del:${s.id}">Remove</button>
              </div>
            </td>
          </tr>
        `);
        return;
      }

      const isSel = STORY.selItem && STORY.selItem.id === s.id;
      const isChecked = selectedShotIds.has(s.id);
      const sNo = formatShotNo(s.n);

      rowsHtml.push(`
        <tr class="story-shot-row ${isSel ? 'selected' : ''}" data-s="shot.select:${s.id}" data-shot-id="${s.id}" draggable="true">
          ${visibleCols.has("chk") ? `
            <td style="width:34px;text-align:center;" onclick="event.stopPropagation()">
              <input type="checkbox" ${isChecked ? 'checked' : ''} data-s="shot.toggle_check:${s.id}">
            </td>
          ` : ""}

          ${visibleCols.has("no") ? `
            <td style="width:50px;font-weight:700;color:var(--text);">${sNo}</td>
          ` : ""}

          ${visibleCols.has("block") ? `
            <td style="width:50px;text-align:center;">B${s.block || 1}</td>
          ` : ""}

          ${visibleCols.has("type") ? `
            <td style="width:68px;">
              <span class="story-type-badge ${String(s.type || '').toLowerCase()}">${s.type || 'REF'}</span>
            </td>
          ` : ""}

          ${visibleCols.has("dur") ? `
            <td style="width:58px;" onclick="event.stopPropagation()">
              <input type="number" min="4" max="15" class="story-cell-dur-input" value="${s.dur || 6}" data-shot-field="dur:${s.id}">
            </td>
          ` : ""}

          ${visibleCols.has("size") ? `
            <td style="width:68px;" onclick="event.stopPropagation()">
              <select class="story-cell-select" data-shot-field="size:${s.id}">
                ${["ECU", "CU", "MCU", "MS", "MLS", "WS", "VWS", "POV", "INSERT"].map(sz => `
                  <option value="${sz}" ${s.size === sz ? "selected" : ""}>${sz}</option>
                `).join("")}
              </select>
            </td>
          ` : ""}

          ${visibleCols.has("angle") ? `
            <td style="width:85px;" onclick="event.stopPropagation()">
              <select class="story-cell-select" data-shot-field="angle:${s.id}">
                ${["eye level", "low angle", "high angle", "dutch", "top-down", "bird's eye"].map(ag => `
                  <option value="${ag}" ${s.angle === ag ? "selected" : ""}>${ag}</option>
                `).join("")}
              </select>
            </td>
          ` : ""}

          ${visibleCols.has("move") ? `
            <td style="width:95px;" onclick="event.stopPropagation()">
              <select class="story-cell-select" data-shot-field="move:${s.id}">
                ${["static", "slow push-in", "pull-back", "pan left", "pan right", "tilt up", "tilt down", "tracking", "handheld subtle"].map(mv => `
                  <option value="${mv}" ${s.move === mv ? "selected" : ""}>${mv}</option>
                `).join("")}
              </select>
            </td>
          ` : ""}

          ${visibleCols.has("chars") ? `
            <td style="min-width:110px;">
              ${(s.chars || []).map(cId => `<span class="story-char-pill">${_esc(charMap.get(cId) || cId)}</span>`).join("") || '<span style="color:var(--muted);font-size:11px;">none</span>'}
            </td>
          ` : ""}

          ${visibleCols.has("loc") ? `
            <td style="min-width:110px;">
              <span style="font-size:11.5px;color:#cbd5ce;">${_esc(locMap.get(s.loc) || s.slug || "unassigned")}</span>
            </td>
          ` : ""}

          ${visibleCols.has("action") ? `
            <td style="min-width:180px;" onclick="event.stopPropagation()">
              <div class="story-cell-editable" contenteditable="true" data-shot-field="action:${s.id}">${_esc(s.action || "")}</div>
            </td>
          ` : ""}

          ${visibleCols.has("dialogue") ? `
            <td style="min-width:140px;">
              <div style="font-style:italic;font-size:11.5px;color:#d6e6dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">
                ${(s.dialogue || []).map(d => `${d.char_name || d.char}: "${d.text}"`).join("; ") || '<span style="color:var(--muted);font-style:normal;">no dialogue</span>'}
              </div>
            </td>
          ` : ""}

          ${visibleCols.has("stb") ? `
            <td style="width:65px;text-align:center;">
              ${s.stb && s.stb.ref ? `
                <img src="${typeof tsrc === 'function' ? _esc(tsrc(s.stb.ref)) : _esc(s.stb.ref)}" style="width:34px;height:24px;object-fit:cover;border-radius:3px;border:1px solid var(--line);" title="STB: Done">
              ` : `
                <span class="story-status-badge ${s.stb ? s.stb.status : 'none'}">${s.stb ? s.stb.status : 'none'}</span>
              `}
            </td>
          ` : ""}

          ${visibleCols.has("video") ? `
            <td style="width:65px;text-align:center;">
              <span class="story-status-badge ${s.video ? s.video.status : 'none'}">${s.video ? s.video.status : 'none'}</span>
            </td>
          ` : ""}

          ${visibleCols.has("status") ? `
            <td style="width:80px;" onclick="event.stopPropagation()">
              <select class="story-cell-select" data-shot-field="status:${s.id}">
                ${["draft", "ready", "stb", "video", "approved", "in_edit"].map(st => `
                  <option value="${st}" ${s.status === st ? "selected" : ""}>${st}</option>
                `).join("")}
              </select>
            </td>
          ` : ""}

          ${visibleCols.has("lens") ? `
            <td style="width:65px;">${_esc(s.lens || "50mm")}</td>
          ` : ""}

          ${visibleCols.has("cam_rel") ? `
            <td style="min-width:90px;">${_esc(s.cam_rel || "")}</td>
          ` : ""}

          ${visibleCols.has("placement") ? `
            <td style="min-width:90px;">${_esc(s.placement || "")}</td>
          ` : ""}

          ${visibleCols.has("purpose") ? `
            <td style="min-width:100px;">${_esc(s.purpose || "")}</td>
          ` : ""}

          ${visibleCols.has("perf") ? `
            <td style="min-width:100px;">${_esc(s.perf || "")}</td>
          ` : ""}

          ${visibleCols.has("act") ? `
            <td style="width:95px;white-space:nowrap;text-align:right;" onclick="event.stopPropagation()">
              <button class="story-btn-ghost" style="padding:1px 5px;font-size:10.5px;" title="Duplicate" data-s="shot.dup:${s.id}">Dup</button>
              <button class="story-btn-ghost" style="padding:1px 5px;font-size:10.5px;" title="Split shot" data-s="shot.split:${s.id}">Split</button>
              <button class="story-btn-ghost" style="padding:1px 5px;font-size:10.5px;color:var(--err,#ff6b6b);" title="Delete" data-s="shot.del:${s.id}">✕</button>
            </td>
          ` : ""}
        </tr>
      `);
    });

    return `
      <table class="story-shot-table" id="story-table-main">
        <thead>
          <tr>
            ${visibleCols.has("chk") ? `
              <th style="width:34px;text-align:center;">
                <input type="checkbox" id="story-chk-all" data-s="shot.toggle_all">
              </th>
            ` : ""}
            ${visibleCols.has("no") ? `<th style="width:50px;">#</th>` : ""}
            ${visibleCols.has("block") ? `<th style="width:50px;">Block</th>` : ""}
            ${visibleCols.has("type") ? `<th style="width:68px;">Type</th>` : ""}
            ${visibleCols.has("dur") ? `<th style="width:58px;">Dur</th>` : ""}
            ${visibleCols.has("size") ? `<th style="width:68px;">Size</th>` : ""}
            ${visibleCols.has("angle") ? `<th style="width:85px;">Angle</th>` : ""}
            ${visibleCols.has("move") ? `<th style="width:95px;">Move</th>` : ""}
            ${visibleCols.has("chars") ? `<th style="min-width:110px;">Chars</th>` : ""}
            ${visibleCols.has("loc") ? `<th style="min-width:110px;">Location</th>` : ""}
            ${visibleCols.has("action") ? `<th style="min-width:180px;">Action</th>` : ""}
            ${visibleCols.has("dialogue") ? `<th style="min-width:140px;">Dialogue</th>` : ""}
            ${visibleCols.has("stb") ? `<th style="width:65px;text-align:center;">STB</th>` : ""}
            ${visibleCols.has("video") ? `<th style="width:65px;text-align:center;">Video</th>` : ""}
            ${visibleCols.has("status") ? `<th style="width:80px;">Status</th>` : ""}
            ${visibleCols.has("lens") ? `<th style="width:65px;">Lens</th>` : ""}
            ${visibleCols.has("cam_rel") ? `<th style="min-width:90px;">Cam Rel</th>` : ""}
            ${visibleCols.has("placement") ? `<th style="min-width:90px;">Placement</th>` : ""}
            ${visibleCols.has("purpose") ? `<th style="min-width:100px;">Purpose</th>` : ""}
            ${visibleCols.has("perf") ? `<th style="min-width:100px;">Perf</th>` : ""}
            ${visibleCols.has("act") ? `<th style="width:95px;text-align:right;">Actions</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml.join("")}
        </tbody>
      </table>
    `;
  }

  // Render Cards View
  function renderCardsView(allShots) {
    const shots = getFilteredShots(allShots);
    if (!shots.length) {
      return `
        <div class="story-empty-state" style="padding:60px 16px;">
          <div class="story-empty-title">No shots matching filter</div>
          <button class="story-btn-gold" data-s="shot.add">+ Add Shot</button>
        </div>
      `;
    }

    const bible = getBible() || {};
    const charMap = new Map((bible.chars || []).map(c => [c.id, c.name]));
    const locMap = new Map((bible.locs || []).map(l => [l.id, l.name]));

    const cardsHtml = shots.map(s => {
      const isSel = STORY.selItem && STORY.selItem.id === s.id;
      const isChecked = selectedShotIds.has(s.id);
      const sNo = formatShotNo(s.n);

      const thumbHtml = (s.stb && s.stb.ref)
        ? `<img class="story-card-thumb" src="${typeof tsrc === 'function' ? _esc(tsrc(s.stb.ref)) : _esc(s.stb.ref)}" alt="${sNo}">`
        : `<div class="story-card-thumb-empty">No storyboard keyframe</div>`;

      return `
        <div class="story-shot-card ${isSel ? 'selected' : ''}" data-s="shot.select:${s.id}" data-shot-id="${s.id}" draggable="true">
          <div class="story-card-header">
            <div class="story-card-header-left">
              <input type="checkbox" ${isChecked ? 'checked' : ''} data-s="shot.toggle_check:${s.id}" onclick="event.stopPropagation()">
              <span style="font-weight:700;">${sNo}</span>
              <span class="story-type-badge ${String(s.type || '').toLowerCase()}">${s.type || 'REF'}</span>
            </div>
            <div>
              <span style="font-size:11px;font-weight:600;margin-right:4px;">${s.dur || 6} s</span>
              <span class="story-status-badge ${s.status}">${s.status}</span>
            </div>
          </div>

          <div class="story-card-thumb-wrap">
            ${thumbHtml}
          </div>

          <div class="story-card-body">
            <div class="story-card-title">${_esc(s.slug || locMap.get(s.loc) || "Scene Location")}</div>
            <div class="story-card-action">${_esc(s.action || "No action description.")}</div>

            ${s.dialogue && s.dialogue.length ? `
              <div class="story-card-dialogue">
                ${_esc(s.dialogue[0].char_name || s.dialogue[0].char)}: "${_esc(s.dialogue[0].text)}"
              </div>
            ` : ""}

            <div class="story-card-tags">
              <span class="story-char-pill">${s.size || 'MCU'}</span>
              <span class="story-char-pill">${s.move || 'static'}</span>
              ${(s.chars || []).map(cId => `<span class="story-char-pill">${_esc(charMap.get(cId) || cId)}</span>`).join("")}
            </div>
          </div>

          <div class="story-card-footer" onclick="event.stopPropagation()">
            <span style="font-size:10.5px;color:var(--muted);">Block ${s.block || 1} · Batch ${s.batch || 1}</span>
            <div style="display:flex;gap:4px;">
              <button class="story-btn-ghost" style="padding:1px 6px;font-size:10.5px;" data-s="shot.dup:${s.id}">Dup</button>
              <button class="story-btn-ghost" style="padding:1px 6px;font-size:10.5px;" data-s="shot.split:${s.id}">Split</button>
              <button class="story-btn-ghost" style="padding:1px 6px;font-size:10.5px;color:var(--err,#ff6b6b);" data-s="shot.del:${s.id}">✕</button>
            </div>
          </div>
        </div>
      `;
    });

    return `<div class="story-shot-cards-grid">${cardsHtml.join("")}</div>`;
  }

  // ---------- Inspector Shot Panel Renderer ----------
  function renderShotInspector(el, sel) {
    if (!el || !sel || sel.kind !== "shot") return;
    const shots = getShots();
    const shot = shots.find(s => s.id === sel.id);

    if (!shot) {
      el.innerHTML = `
        <div class="story-empty-state" style="padding:30px 10px;">
          <div class="story-empty-title">Shot not found</div>
          <div class="story-empty-desc">The selected shot was deleted or renumbered.</div>
        </div>
      `;
      return;
    }

    const bible = getBible() || {};
    const chars = bible.chars || [];
    const locs = bible.locs || [];
    const sNo = formatShotNo(shot.n);

    // Prev / Next shot IDs
    const curIdx = shots.findIndex(s => s.id === shot.id);
    const prevShot = curIdx > 0 ? shots[curIdx - 1] : null;
    const nextShot = curIdx < shots.length - 1 ? shots[curIdx + 1] : null;

    el.innerHTML = `
      <div class="story-insp-shot">
        <!-- Header Section -->
        <div class="story-insp-sec">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:16px;font-weight:700;color:var(--text);">${sNo}</span>
              <span class="story-type-badge ${String(shot.type || '').toLowerCase()}">${shot.type}</span>
            </div>
            <div style="display:flex;gap:4px;">
              <button class="story-btn-ghost" style="padding:2px 7px;" ${prevShot ? '' : 'disabled'} data-s="shot.select:${prevShot ? prevShot.id : ''}">‹ Prev</button>
              <button class="story-btn-ghost" style="padding:2px 7px;" ${nextShot ? '' : 'disabled'} data-s="shot.select:${nextShot ? nextShot.id : ''}">Next ›</button>
            </div>
          </div>
        </div>

        <!-- Timing & Production Type -->
        <div class="story-insp-sec">
          <div class="story-insp-title">Timing & Type</div>
          <div class="story-insp-grid2">
            <div class="story-insp-field">
              <label>Duration (sec)</label>
              <input type="number" min="4" max="15" value="${shot.dur || 6}" data-insp-field="dur">
            </div>
            <div class="story-insp-field">
              <label>Production Type</label>
              <select data-insp-field="type">
                <option value="REF" ${shot.type === "REF" ? "selected" : ""}>REF (Face/Identity)</option>
                <option value="I2V" ${shot.type === "I2V" ? "selected" : ""}>I2V (Image to Video)</option>
                <option value="MINI" ${shot.type === "MINI" ? "selected" : ""}>MINI (Fast/Cheaper)</option>
              </select>
            </div>
            <div class="story-insp-field">
              <label>Block (1–3)</label>
              <select data-insp-field="block">
                <option value="1" ${shot.block === 1 ? "selected" : ""}>Block 1 (0–30s)</option>
                <option value="2" ${shot.block === 2 ? "selected" : ""}>Block 2 (30–60s)</option>
                <option value="3" ${shot.block === 3 ? "selected" : ""}>Block 3 (60–90s)</option>
              </select>
            </div>
            <div class="story-insp-field">
              <label>Status</label>
              <select data-insp-field="status">
                ${["draft", "ready", "stb", "video", "approved", "in_edit"].map(st => `
                  <option value="${st}" ${shot.status === st ? "selected" : ""}>${st}</option>
                `).join("")}
              </select>
            </div>
          </div>
        </div>

        <!-- Camera & Framing -->
        <div class="story-insp-sec">
          <div class="story-insp-title">Camera & Staging</div>
          <div class="story-insp-grid2">
            <div class="story-insp-field">
              <label>Shot Size</label>
              <select data-insp-field="size">
                ${["ECU", "CU", "MCU", "MS", "MLS", "WS", "VWS", "POV", "INSERT"].map(sz => `
                  <option value="${sz}" ${shot.size === sz ? "selected" : ""}>${sz}</option>
                `).join("")}
              </select>
            </div>
            <div class="story-insp-field">
              <label>Angle</label>
              <select data-insp-field="angle">
                ${["eye level", "low angle", "high angle", "dutch", "top-down", "bird's eye"].map(ag => `
                  <option value="${ag}" ${shot.angle === ag ? "selected" : ""}>${ag}</option>
                `).join("")}
              </select>
            </div>
            <div class="story-insp-field">
              <label>Movement</label>
              <select data-insp-field="move">
                ${["static", "slow push-in", "pull-back", "pan left", "pan right", "tilt up", "tilt down", "tracking", "handheld subtle"].map(mv => `
                  <option value="${mv}" ${shot.move === mv ? "selected" : ""}>${mv}</option>
                `).join("")}
              </select>
            </div>
            <div class="story-insp-field">
              <label>Lens</label>
              <select data-insp-field="lens">
                ${["24mm", "35mm", "50mm", "85mm", "100mm"].map(l => `
                  <option value="${l}" ${shot.lens === l ? "selected" : ""}>${l}</option>
                `).join("")}
              </select>
            </div>
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Camera Relative to Subject</label>
            <input type="text" placeholder="e.g. 45° front-left, profile right..." value="${_esc(shot.cam_rel || "")}" data-insp-field="cam_rel">
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Placement in Frame</label>
            <input type="text" placeholder="e.g. screen-left, screen-right, center..." value="${_esc(shot.placement || "")}" data-insp-field="placement">
          </div>
        </div>

        <!-- Story Action & Narrative -->
        <div class="story-insp-sec">
          <div class="story-insp-title">Action & Performance</div>
          <div class="story-insp-field">
            <label>Scene Slug / Heading</label>
            <input type="text" placeholder="INT. LOCATION - DAY" value="${_esc(shot.slug || "")}" data-insp-field="slug">
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Shot Action (Clear visual movement)</label>
            <textarea rows="3" data-insp-field="action">${_esc(shot.action || "")}</textarea>
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Performance / Acting Notes</label>
            <input type="text" placeholder="e.g. subtle smirk, tense breathing..." value="${_esc(shot.perf || "")}" data-insp-field="perf">
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Storyboard Purpose</label>
            <input type="text" placeholder="e.g. Reveal weapon, emotional turn..." value="${_esc(shot.purpose || "")}" data-insp-field="purpose">
          </div>
        </div>

        <!-- Characters & Dialogue -->
        <div class="story-insp-sec">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div class="story-insp-title">Characters & Dialogue</div>
            <button class="story-btn-ghost" style="padding:1px 6px;font-size:10px;" id="story-add-dlg-line-btn">+ Add Line</button>
          </div>

          <!-- Characters Multi-select -->
          <div class="story-insp-field" style="margin-top:6px;">
            <label>Characters Present</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;">
              ${chars.length ? chars.map(c => {
                const active = Array.isArray(shot.chars) && shot.chars.includes(c.id);
                return `
                  <label class="story-col-item" style="font-size:11px;">
                    <input type="checkbox" ${active ? "checked" : ""} data-insp-char="${c.id}">
                    <span>${_esc(c.name)}</span>
                  </label>
                `;
              }).join("") : `<div style="font-size:11px;color:var(--muted);">No characters in Bible yet.</div>`}
            </div>
          </div>

          <!-- Dialogue Lines -->
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px;" id="story-dlg-lines-wrap">
            ${(shot.dialogue || []).map((d, dIdx) => `
              <div style="display:flex;flex-direction:column;gap:4px;padding:6px;background:var(--card2,#1b241f);border:1px solid var(--line);border-radius:6px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <select style="flex:1;" data-dlg-field="char:${dIdx}">
                    <option value="">(Speaker)</option>
                    ${chars.map(c => `
                      <option value="${c.id}" ${d.char === c.id ? "selected" : ""}>${_esc(c.name)}</option>
                    `).join("")}
                  </select>
                  <select style="width:90px;" data-dlg-field="mod:${dIdx}">
                    <option value="" ${!d.modifier ? "selected" : ""}>Standard</option>
                    <option value="(CONT'D)" ${d.modifier === "(CONT'D)" ? "selected" : ""}>(CONT'D)</option>
                    <option value="(O.S.)" ${d.modifier === "(O.S.)" ? "selected" : ""}>(O.S.)</option>
                    <option value="(quietly)" ${d.modifier === "(quietly)" ? "selected" : ""}>(quietly)</option>
                  </select>
                  <button class="story-btn-ghost" style="padding:1px 5px;color:var(--err);" data-dlg-del="${dIdx}">✕</button>
                </div>
                <input type="text" placeholder="Dialogue text..." value="${_esc(d.text || "")}" data-dlg-field="text:${dIdx}">
              </div>
            `).join("")}
          </div>
        </div>

        <!-- Room Geography & Continuity -->
        <div class="story-insp-sec">
          <div class="story-insp-title">Geography & Continuity</div>
          <div class="story-insp-field">
            <label>Location</label>
            <select data-insp-field="loc">
              <option value="">(Select Location)</option>
              ${locs.map(l => `
                <option value="${l.id}" ${shot.loc === l.id ? "selected" : ""}>${_esc(l.name)}</option>
              `).join("")}
            </select>
          </div>

          <div class="story-insp-grid2" style="margin-top:6px;">
            <div class="story-insp-field">
              <label>Continuity In (Start)</label>
              <input type="text" placeholder="e.g. Steve standing screen-left" value="${_esc(shot.cont ? shot.cont.start : "")}" data-insp-field="cont_start">
            </div>
            <div class="story-insp-field">
              <label>Continuity Out (End)</label>
              <input type="text" placeholder="e.g. Steve turns to door" value="${_esc(shot.cont ? shot.cont.end : "")}" data-insp-field="cont_end">
            </div>
          </div>

          <div class="story-insp-field" style="margin-top:6px;">
            <label>Hard Exclusions / Negatives</label>
            <input type="text" placeholder="e.g. extra hands, blurry eyes..." value="${_esc(shot.excl || "")}" data-insp-field="excl">
          </div>
        </div>

        <!-- Reference Bank (If REF) -->
        ${shot.type === "REF" ? `
          <div class="story-insp-sec">
            <div class="story-insp-title">Reference Bank (≤ 8 items)</div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">
              Bank ID: <b>${_esc(shot.bank && shot.bank[0] ? shot.bank[0].bank : "REFBANK_01")}</b>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${(shot.bank || []).map((b, bIdx) => `
                <div style="font-size:10.5px;padding:3px 6px;border:1px solid var(--accent);border-radius:4px;color:var(--accent);background:rgba(200,169,106,0.1);">
                  image${b.n || bIdx + 1} (${_esc(b.role || 'ref')})
                </div>
              `).join("") || '<div style="font-size:11px;color:var(--muted);">No bank assigned.</div>'}
            </div>
          </div>
        ` : ""}

        <!-- Asset Links Preview -->
        <div class="story-insp-sec">
          <div class="story-insp-title">Assets Preview</div>
          <div style="display:flex;gap:8px;">
            <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
              <span style="font-size:11px;color:var(--muted);">STB Keyframe</span>
              ${shot.stb && shot.stb.ref ? `
                <img src="${typeof src === 'function' ? _esc(src(shot.stb.ref)) : _esc(shot.stb.ref)}" style="width:100%;height:70px;object-fit:cover;border-radius:4px;border:1px solid var(--line);">
              ` : `
                <div style="height:70px;background:#09100c;border:1px solid var(--line);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);">
                  None
                </div>
              `}
            </div>

            <div style="flex:1;display:flex;flex-direction:column;gap:4px;">
              <span style="font-size:11px;color:var(--muted);">Video Result</span>
              ${shot.video && shot.video.ref ? `
                <video src="${typeof src === 'function' ? _esc(src(shot.video.ref)) : _esc(shot.video.ref)}" style="width:100%;height:70px;object-fit:cover;border-radius:4px;border:1px solid var(--line);" controls></video>
              ` : `
                <div style="height:70px;background:#09100c;border:1px solid var(--line);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);">
                  None
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    `;

    // Bind inputs on the inspector
    el.querySelectorAll("[data-insp-field]").forEach(input => {
      input.onchange = () => {
        const field = input.dataset.inspField;
        let val = input.value;
        if (field === "dur") val = Math.max(4, Math.min(15, Number(val) || 6));
        if (field === "block") val = Number(val) || 1;

        if (field === "cont_start" || field === "cont_end") {
          if (!shot.cont) shot.cont = { start: "", end: "" };
          if (field === "cont_start") shot.cont.start = val;
          if (field === "cont_end") shot.cont.end = val;
        } else {
          shot[field] = val;
        }

        shot.u = Date.now();
        computeBatches();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Edit Shot " + sNo);
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
      };
    });

    // Character checkboxes
    el.querySelectorAll("[data-insp-char]").forEach(chk => {
      chk.onchange = () => {
        const cId = chk.dataset.inspChar;
        if (!Array.isArray(shot.chars)) shot.chars = [];
        if (chk.checked) {
          if (!shot.chars.includes(cId)) shot.chars.push(cId);
        } else {
          shot.chars = shot.chars.filter(id => id !== cId);
        }
        shot.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Update characters on " + sNo);
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
      };
    });

    // Add dialogue line button
    const addLineBtn = el.querySelector("#story-add-dlg-line-btn");
    if (addLineBtn) {
      addLineBtn.onclick = () => {
        if (!Array.isArray(shot.dialogue)) shot.dialogue = [];
        shot.dialogue.push({
          char: chars.length ? chars[0].id : "",
          char_name: chars.length ? chars[0].name : "",
          modifier: "",
          text: "",
          sec: 1.5
        });
        shot.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Add dialogue to " + sNo);
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        renderShotInspector(el, sel);
        if (typeof STORY.renderView === "function") STORY.renderView();
      };
    }

    // Dialogue line updates
    el.querySelectorAll("[data-dlg-field]").forEach(input => {
      input.onchange = () => {
        const [kind, idxStr] = input.dataset.dlgField.split(":");
        const idx = parseInt(idxStr, 10);
        if (!shot.dialogue || !shot.dialogue[idx]) return;

        if (kind === "char") {
          shot.dialogue[idx].char = input.value;
          const found = chars.find(c => c.id === input.value);
          shot.dialogue[idx].char_name = found ? found.name : "";
        } else if (kind === "mod") {
          shot.dialogue[idx].modifier = input.value;
        } else if (kind === "text") {
          shot.dialogue[idx].text = input.value;
        }

        shot.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Update dialogue on " + sNo);
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
      };
    });

    // Delete dialogue line
    el.querySelectorAll("[data-dlg-del]").forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.dlgDel, 10);
        if (shot.dialogue) {
          shot.dialogue.splice(idx, 1);
          shot.u = Date.now();
          if (typeof STORY.snapshot === "function") STORY.snapshot("Remove dialogue on " + sNo);
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          renderShotInspector(el, sel);
          if (typeof STORY.renderView === "function") STORY.renderView();
        }
      };
    });
  }

  // ---------- Shot Mutations (Add / Duplicate / Split / Merge / Delete) ----------
  function addShot(afterId) {
    const shots = getShots();
    const idx = afterId ? shots.findIndex(s => s.id === afterId) : shots.length - 1;
    const prevShot = idx >= 0 ? shots[idx] : null;

    const newShot = createDefaultShot({
      block: prevShot ? prevShot.block : 1,
      batch: prevShot ? prevShot.batch : 1,
      slug: prevShot ? prevShot.slug : "INT. LOCATION - DAY",
      loc: prevShot ? prevShot.loc : "",
      type: prevShot ? prevShot.type : "REF"
    });

    if (idx >= 0 && idx < shots.length - 1) {
      shots.splice(idx + 1, 0, newShot);
    } else {
      shots.push(newShot);
    }

    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot("Add shot");
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.select === "function") STORY.select("shot", newShot.id);
    if (typeof STORY.renderView === "function") STORY.renderView();
  }

  function addIntercut() {
    const shots = getShots();
    const selId = STORY.selItem && STORY.selItem.kind === "shot" ? STORY.selItem.id : null;
    const idx = selId ? shots.findIndex(s => s.id === selId) : shots.length - 1;

    const intercutShot = createDefaultShot({
      is_intercut: true,
      intercut_to: "EXT. COURTYARD - DAY",
      dur: 0
    });

    if (idx >= 0 && idx < shots.length - 1) {
      shots.splice(idx + 1, 0, intercutShot);
    } else {
      shots.push(intercutShot);
    }

    if (typeof STORY.snapshot === "function") STORY.snapshot("Add intercut");
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();
  }

  function duplicateShot(id) {
    const shots = getShots();
    const idx = shots.findIndex(s => s.id === id);
    if (idx < 0) return;

    const orig = shots[idx];
    const clone = JSON.parse(JSON.stringify(orig));
    clone.id = _uid("sh_");
    clone.stb = { prompt: clone.stb ? clone.stb.prompt : "", ref: "", status: "none", istu: "" };
    clone.video = { node: "", job: "", ref: "", status: "none", note: "" };
    clone.edit = { clip: "", pid: "" };
    clone.u = Date.now();

    shots.splice(idx + 1, 0, clone);
    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot("Duplicate shot " + formatShotNo(orig.n));
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.select === "function") STORY.select("shot", clone.id);
    if (typeof STORY.renderView === "function") STORY.renderView();
  }

  function splitShot(id) {
    const shots = getShots();
    const idx = shots.findIndex(s => s.id === id);
    if (idx < 0) return;

    const s1 = shots[idx];
    const origDur = Number(s1.dur) || 6;
    const dur1 = Math.max(2, Math.floor(origDur / 2));
    const dur2 = Math.max(2, origDur - dur1);

    s1.dur = dur1;
    s1.u = Date.now();

    const s2 = JSON.parse(JSON.stringify(s1));
    s2.id = _uid("sh_");
    s2.dur = dur2;
    s2.stb = { prompt: "", ref: "", status: "none", istu: "" };
    s2.video = { node: "", job: "", ref: "", status: "none", note: "" };
    s2.edit = { clip: "", pid: "" };
    s2.u = Date.now();

    shots.splice(idx + 1, 0, s2);
    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot("Split shot " + formatShotNo(s1.n));
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.select === "function") STORY.select("shot", s2.id);
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast(`Split shot into ${dur1}s and ${dur2}s.`);
  }

  function mergeShots(id1, id2) {
    const shots = getShots();
    const idx1 = shots.findIndex(s => s.id === id1);
    const idx2 = shots.findIndex(s => s.id === id2);
    if (idx1 < 0 || idx2 < 0) return;

    const s1 = shots[idx1];
    const s2 = shots[idx2];

    s1.dur = Math.min(15, (Number(s1.dur) || 0) + (Number(s2.dur) || 0));
    s1.action = ((s1.action || "") + " " + (s2.action || "")).trim();
    if (Array.isArray(s2.dialogue) && s2.dialogue.length) {
      s1.dialogue = (s1.dialogue || []).concat(s2.dialogue);
    }
    const combinedChars = new Set([...(s1.chars || []), ...(s2.chars || [])]);
    s1.chars = [...combinedChars];

    shots.splice(idx2, 1);
    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot("Merge shots");
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.select === "function") STORY.select("shot", s1.id);
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast("Shots merged.");
  }

  function deleteShot(id) {
    const shots = getShots();
    const idx = shots.findIndex(s => s.id === id);
    if (idx < 0) return;

    const delNo = formatShotNo(shots[idx].n);
    shots.splice(idx, 1);
    selectedShotIds.delete(id);

    renumberShots();
    computeBatches();

    if (STORY.selItem && STORY.selItem.id === id) {
      const nextSel = shots[Math.min(idx, shots.length - 1)];
      if (typeof STORY.select === "function") {
        STORY.select(nextSel ? "shot" : null, nextSel ? nextSel.id : null);
      }
    }

    if (typeof STORY.snapshot === "function") STORY.snapshot("Delete shot " + delNo);
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast(`Deleted ${delNo}.`);
  }

  function bulkChangeType(newType) {
    if (!newType) return;
    const shots = getShots();
    let count = 0;

    shots.forEach(s => {
      if (selectedShotIds.size === 0 || selectedShotIds.has(s.id)) {
        s.type = newType;
        s.u = Date.now();
        count++;
      }
    });

    if (typeof STORY.snapshot === "function") STORY.snapshot(`Bulk change ${count} shots to ${newType}`);
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast(`Updated ${count} shots to ${newType}.`);
  }

  // ---------- Import / Export Functions (Spec 9.2 & 9.3) ----------

  // Build GPT export text matching Section 9.2 exactly
  function buildGptExportText(shotOverride) {
    const shots = Array.isArray(shotOverride) ? shotOverride : getShots();
    const bible = getBible() || {};
    const lines = [];

    shots.forEach(s => {
      const sNo = formatShotNo(s.n);
      const bNo = s.batch < 10 ? "0" + s.batch : s.batch;
      const blkNo = s.block < 10 ? "0" + s.block : s.block;
      const type = s.type || "REF";

      lines.push(`========== CONTENT BLOCK ${blkNo} | BATCH ${bNo} — SHOT ${s.n < 10 ? "0" + s.n : s.n} | TYPE: ${type} ==========`);
      lines.push(`Target duration: ${s.dur || 6} seconds.`);

      if (type === "REF") {
        const bankTag = (s.bank && s.bank[0] && s.bank[0].bank) ? s.bank[0].bank : `REFBANK_01_${(bible.name || "SERIES").replace(/\s+/g, "_").toUpperCase()}`;
        lines.push(`Reference bank: ${bankTag}`);
        if (Array.isArray(s.bank) && s.bank.length) {
          s.bank.forEach(item => {
            lines.push(`${bankTag}/image${item.n || 1}.jpg — ${item.role || 'character'}`);
          });
        }
      }

      lines.push(`STORYBOARD:`);
      if (type === "REF") {
        lines.push(`image1 is the storyboard keyframe: follow its composition and framing.`);
      } else {
        lines.push(`The storyboard (image1) is the opening frame of this shot.`);
      }

      lines.push(`SHOT ACTION:`);
      lines.push(s.action || `${sNo}: ${s.title || "Cinematic character action."}`);

      if (s.dialogue && s.dialogue.length) {
        const dlgStr = s.dialogue.map(d => `${d.char_name || d.char} ${d.modifier || ''}: "${d.text}"`).join("\n");
        lines.push(`DIALOGUE:\n${dlgStr}`);
      }

      lines.push(`CONTINUITY:`);
      lines.push(`Start: ${(s.cont && s.cont.start) || "Matches previous shot setup."}`);
      lines.push(`End: ${(s.cont && s.cont.end) || "Holds final pose for cut."}`);

      lines.push(`EXCLUSIONS:`);
      lines.push(s.excl || "text, watermark, extra fingers, cartoonish look");
      lines.push("");
    });

    const totals = computeTotals();
    lines.push(`TOTAL: ${totals.count} shots · ${totals.duration} s · REF ${totals.refCount} · I2V ${totals.i2vCount} · MINI ${totals.miniCount}`);

    return lines.join("\n");
  }

  // Parse GPT shotlist using app's parseShotlist or fallback
  function importGptText(raw) {
    if (!raw || !raw.trim()) return false;
    let parsedShots = [];

    // 1. Try global parseShotlist if available
    if (typeof parseShotlist === "function") {
      try {
        const res = parseShotlist(raw);
        if (res && Array.isArray(res.shots) && res.shots.length > 0) {
          parsedShots = res.shots.map((ps, idx) => {
            const matchType = (ps.raw || "").match(/TYPE:\s*(REF|I2V|MINI)/i);
            const shotType = matchType ? matchType[1].toUpperCase() : "REF";
            return createDefaultShot({
              n: idx + 1,
              dur: ps.sec || 6,
              title: ps.title || "",
              action: ps.character || ps.inFrame || ps.title || "",
              type: shotType
            });
          });
        }
      } catch (err) {
        console.warn("parseShotlist error:", err);
      }
    }

    // 2. Custom Section 9.2 Block Parser if parseShotlist didn't yield shots
    if (!parsedShots.length) {
      const blocks = raw.split(/={10,}\s*CONTENT BLOCK/i);
      blocks.forEach((blk, idx) => {
        if (!blk.trim()) return;
        const fullBlock = "CONTENT BLOCK " + blk;

        const mHeader = fullBlock.match(/CONTENT BLOCK\s+(\d+)\s*\|\s*BATCH\s+(\d+)\s*—\s*SHOT\s+(\d+)\s*\|\s*TYPE:\s*(REF|I2V|MINI)/i);
        const mDur = fullBlock.match(/Target duration:\s*(\d+)/i) || fullBlock.match(/Duration:\s*(\d+)/i);
        const mAction = fullBlock.match(/SHOT ACTION:\s*([\s\S]*?)(?=CONTINUITY:|EXCLUSIONS:|TOTAL:|$)/i);
        const mExcl = fullBlock.match(/EXCLUSIONS:\s*([\s\S]*?)(?=TOTAL:|$)/i);

        const shot = createDefaultShot({
          n: mHeader ? parseInt(mHeader[3], 10) : idx + 1,
          block: mHeader ? parseInt(mHeader[1], 10) : 1,
          batch: mHeader ? parseInt(mHeader[2], 10) : 1,
          type: mHeader ? mHeader[4].toUpperCase() : "REF",
          dur: mDur ? parseInt(mDur[1], 10) : 6,
          action: mAction ? mAction[1].trim() : "",
          excl: mExcl ? mExcl[1].trim() : ""
        });
        parsedShots.push(shot);
      });
    }

    if (!parsedShots.length) {
      if (typeof toast === "function") toast("Could not parse any shots from input.", true);
      return false;
    }

    if (!STORY.ep) STORY.ep = {};
    STORY.ep.shots = parsedShots;
    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot(`Imported ${parsedShots.length} shots (GPT)`);
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast(`Imported ${parsedShots.length} shots successfully.`);
    return true;
  }

  // Build CSV export text matching Section 9.3 exactly (with UTF-8 BOM)
  function buildCsvExportText() {
    const shots = getShots();
    const headers = [
      "n", "block", "batch", "type", "dur", "size", "angle", "move", "lens",
      "chars", "loc", "props", "action", "dialogue", "cont_start", "cont_end",
      "excl", "bank", "stb_prompt", "video_prompt", "status"
    ];

    function csvVal(v) {
      if (v == null) return "";
      const str = String(v);
      if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes(";")) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    const rows = [headers.join(",")];

    shots.forEach(s => {
      const charsStr = (s.chars || []).join(";");
      const propsStr = (s.props || []).join(";");
      const dlgStr = (s.dialogue || []).map(d => `${d.char}:${d.text}`).join(";");
      const bankStr = (s.bank || []).map(b => `${b.bank}:${b.n}:${b.role}`).join(";");

      const row = [
        s.n,
        s.block || 1,
        s.batch || 1,
        s.type || "REF",
        s.dur || 6,
        s.size || "MCU",
        s.angle || "eye level",
        s.move || "static",
        s.lens || "50mm",
        charsStr,
        s.loc || s.slug || "",
        propsStr,
        s.action || "",
        dlgStr,
        s.cont ? s.cont.start : "",
        s.cont ? s.cont.end : "",
        s.excl || "",
        bankStr,
        s.stb ? s.stb.prompt : "",
        s.vprompt ? s.vprompt.text : "",
        s.status || "draft"
      ].map(csvVal);

      rows.push(row.join(","));
    });

    // UTF-8 BOM
    return "\uFEFF" + rows.join("\r\n");
  }

  // Parse CSV text matching Section 9.3 header
  function importCsvText(raw) {
    if (!raw || !raw.trim()) return false;
    const cleanRaw = raw.replace(/^\uFEFF/, "");
    const lines = [];
    let curLine = [];
    let curField = "";
    let inQuotes = false;

    // Simple robust CSV tokenizer handling quoted multi-line cells
    for (let i = 0; i < cleanRaw.length; i++) {
      const c = cleanRaw[i];
      if (inQuotes) {
        if (c === '"') {
          if (cleanRaw[i + 1] === '"') {
            curField += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          curField += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          curLine.push(curField);
          curField = "";
        } else if (c === '\n' || c === '\r') {
          if (c === '\r' && cleanRaw[i + 1] === '\n') i++;
          curLine.push(curField);
          lines.push(curLine);
          curLine = [];
          curField = "";
        } else {
          curField += c;
        }
      }
    }
    if (curField || curLine.length) {
      curLine.push(curField);
      lines.push(curLine);
    }

    if (lines.length < 2) {
      if (typeof toast === "function") toast("CSV file has no data rows.", true);
      return false;
    }

    const header = lines[0].map(h => h.trim().toLowerCase());
    const parsedShots = [];

    for (let r = 1; r < lines.length; r++) {
      const row = lines[r];
      if (!row || row.length < 3 || !row.some(Boolean)) continue;
      const getVal = (col) => {
        const idx = header.indexOf(col);
        return (idx >= 0 && row[idx]) ? row[idx].trim() : "";
      };

      const shot = createDefaultShot({
        n: parseInt(getVal("n"), 10) || r,
        block: parseInt(getVal("block"), 10) || 1,
        batch: parseInt(getVal("batch"), 10) || 1,
        type: getVal("type").toUpperCase() || "REF",
        dur: parseInt(getVal("dur"), 10) || 6,
        size: getVal("size") || "MCU",
        angle: getVal("angle") || "eye level",
        move: getVal("move") || "static",
        lens: getVal("lens") || "50mm",
        chars: getVal("chars") ? getVal("chars").split(";").filter(Boolean) : [],
        slug: getVal("loc") || "",
        action: getVal("action") || "",
        excl: getVal("excl") || "",
        cont: { start: getVal("cont_start"), end: getVal("cont_end") },
        status: getVal("status") || "draft"
      });

      // Parse dialogue field if present
      const dlgRaw = getVal("dialogue");
      if (dlgRaw) {
        shot.dialogue = dlgRaw.split(";").filter(Boolean).map(part => {
          const m = part.match(/^([^:]+):(.*)$/);
          return m ? { char: m[1].trim(), char_name: m[1].trim(), text: m[2].trim(), sec: 1.5 } : { text: part.trim(), sec: 1.5 };
        });
      }

      parsedShots.push(shot);
    }

    if (!parsedShots.length) {
      if (typeof toast === "function") toast("Could not parse shots from CSV.", true);
      return false;
    }

    if (!STORY.ep) STORY.ep = {};
    STORY.ep.shots = parsedShots;
    renumberShots();
    computeBatches();

    if (typeof STORY.snapshot === "function") STORY.snapshot(`Imported ${parsedShots.length} shots (CSV)`);
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();
    if (typeof toast === "function") toast(`Imported ${parsedShots.length} shots from CSV.`);
    return true;
  }

  // Trigger file download helper
  function downloadBlob(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // Show Import Modal (GPT or CSV)
  function showImportModal() {
    const existing = document.getElementById("story-import-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "story-import-modal";
    overlay.className = "story-modal-overlay";
    overlay.innerHTML = `
      <div class="story-modal-box">
        <div class="story-modal-hdr">
          <span>Import Shotlist</span>
          <button class="story-btn-ghost" style="padding:1px 6px;" id="story-import-close">✕</button>
        </div>
        <div class="story-modal-body">
          <p style="font-size:11.5px;color:var(--muted);margin:0;">
            Paste GPT-format shotlist text or CSV lines below, or choose a .txt / .md / .csv file.
          </p>
          <input type="file" id="story-import-file-input" accept=".txt,.md,.csv">
          <textarea id="story-import-textarea" rows="10" placeholder="Paste GPT shotlist or CSV content here..."></textarea>
        </div>
        <div class="story-modal-ftr">
          <button class="story-btn-ghost" id="story-import-cancel">Cancel</button>
          <button class="story-btn-gold" id="story-import-submit">Import</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#story-import-close").onclick = close;
    overlay.querySelector("#story-import-cancel").onclick = close;

    const fileInp = overlay.querySelector("#story-import-file-input");
    const txtArea = overlay.querySelector("#story-import-textarea");

    fileInp.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        txtArea.value = ev.target.result;
      };
      reader.readAsText(file);
    };

    overlay.querySelector("#story-import-submit").onclick = () => {
      const raw = txtArea.value;
      if (!raw.trim()) {
        if (typeof toast === "function") toast("Please enter or upload shotlist text.", true);
        return;
      }
      // Detect CSV vs GPT format
      if (raw.includes("n,block,batch") || raw.split("\n")[0].split(",").length > 5) {
        if (importCsvText(raw)) close();
      } else {
        if (importGptText(raw)) close();
      }
    };
  }

  // Show Columns Chooser Popover
  function showColumnsPopover(btnEl) {
    const existing = document.getElementById("story-col-popover");
    if (existing) {
      existing.remove();
      return;
    }

    const pop = document.createElement("div");
    pop.id = "story-col-popover";
    pop.className = "story-col-popover";

    pop.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:4px;">Toggle Columns</div>
      ${ALL_COLUMNS.filter(c => !c.fixed).map(c => `
        <label class="story-col-item">
          <input type="checkbox" ${visibleCols.has(c.id) ? "checked" : ""} data-col-id="${c.id}">
          <span>${c.label}</span>
        </label>
      `).join("")}
      <div style="display:flex;justify-content:flex-end;margin-top:6px;">
        <button class="story-btn-ghost" style="padding:2px 8px;font-size:10.5px;" id="story-col-close">Done</button>
      </div>
    `;

    const wrap = document.querySelector(".story-shotlist-wrap");
    if (wrap) wrap.appendChild(pop);

    pop.querySelectorAll("[data-col-id]").forEach(chk => {
      chk.onchange = () => {
        const id = chk.dataset.colId;
        if (chk.checked) visibleCols.add(id);
        else visibleCols.delete(id);
        savePrefs();
        if (typeof STORY.renderView === "function") STORY.renderView();
      };
    });

    pop.querySelector("#story-col-close").onclick = () => pop.remove();
  }

  // ---------- Drag and Drop HTML5 Reordering ----------
  function setupDragAndDrop() {
    const table = document.getElementById("story-table-main");
    if (table) {
      table.querySelectorAll("tbody tr.story-shot-row").forEach(row => {
        row.ondragstart = (e) => {
          draggedShotId = row.dataset.shotId;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", draggedShotId);
          row.style.opacity = "0.5";
        };
        row.ondragend = () => {
          row.style.opacity = "1";
          draggedShotId = null;
        };
        row.ondragover = (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        };
        row.ondrop = (e) => {
          e.preventDefault();
          const targetShotId = row.dataset.shotId;
          if (draggedShotId && targetShotId && draggedShotId !== targetShotId) {
            const shots = getShots();
            const fromIdx = shots.findIndex(s => s.id === draggedShotId);
            const toIdx = shots.findIndex(s => s.id === targetShotId);
            if (fromIdx >= 0 && toIdx >= 0) {
              const [moved] = shots.splice(fromIdx, 1);
              shots.splice(toIdx, 0, moved);
              renumberShots();
              computeBatches();
              if (typeof STORY.snapshot === "function") STORY.snapshot("Reorder shot");
              if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
              if (typeof STORY.renderView === "function") STORY.renderView();
            }
          }
        };
      });
    }

    const cardsGrid = document.querySelector(".story-shot-cards-grid");
    if (cardsGrid) {
      cardsGrid.querySelectorAll(".story-shot-card").forEach(card => {
        card.ondragstart = (e) => {
          draggedShotId = card.dataset.shotId;
          e.dataTransfer.effectAllowed = "move";
          card.style.opacity = "0.5";
        };
        card.ondragend = () => {
          card.style.opacity = "1";
          draggedShotId = null;
        };
        card.ondragover = (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        };
        card.ondrop = (e) => {
          e.preventDefault();
          const targetShotId = card.dataset.shotId;
          if (draggedShotId && targetShotId && draggedShotId !== targetShotId) {
            const shots = getShots();
            const fromIdx = shots.findIndex(s => s.id === draggedShotId);
            const toIdx = shots.findIndex(s => s.id === targetShotId);
            if (fromIdx >= 0 && toIdx >= 0) {
              const [moved] = shots.splice(fromIdx, 1);
              shots.splice(toIdx, 0, moved);
              renumberShots();
              computeBatches();
              if (typeof STORY.snapshot === "function") STORY.snapshot("Reorder shot");
              if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
              if (typeof STORY.renderView === "function") STORY.renderView();
            }
          }
        };
      });
    }
  }

  // ---------- Inline Cell Edit Delegation ----------
  function setupInlineEditing() {
    // Inputs & Selects on rows
    document.querySelectorAll("[data-shot-field]").forEach(el => {
      const parts = el.dataset.shotField.split(":");
      const field = parts[0];
      const sId = parts[1];

      if (el.tagName === "SELECT" || el.tagName === "INPUT") {
        el.onchange = () => {
          const shots = getShots();
          const s = shots.find(x => x.id === sId);
          if (!s) return;

          let val = el.value;
          if (field === "dur") {
            val = Math.max(4, Math.min(15, parseInt(val, 10) || 6));
            el.value = val;
          }
          s[field] = val;
          s.u = Date.now();

          computeBatches();
          if (typeof STORY.snapshot === "function") STORY.snapshot(`Change ${field} on ${formatShotNo(s.n)}`);
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          if (typeof STORY.renderView === "function") STORY.renderView();
        };
      } else if (el.isContentEditable) {
        el.onblur = () => {
          const shots = getShots();
          const s = shots.find(x => x.id === sId);
          if (!s) return;
          const val = el.textContent.trim();
          if (s[field] !== val) {
            s[field] = val;
            s.u = Date.now();
            if (typeof STORY.snapshot === "function") STORY.snapshot(`Edit ${field} on ${formatShotNo(s.n)}`);
            if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
            updateGateAUI();
          }
        };

        el.onkeydown = (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            el.blur();
          }
        };
      }
    });
  }

  // ---------- Command Handlers Registration (STORY.cmds) ----------
  function registerCommands() {
    if (!STORY || !STORY.cmds) return;

    STORY.cmds["shot.select"] = (arg) => {
      if (typeof STORY.select === "function") {
        STORY.select("shot", arg);
      }
      if (typeof STORY.renderView === "function") {
        STORY.renderView();
      }
    };

    STORY.cmds["shot.toggle_check"] = (arg, trigger, ev) => {
      if (selectedShotIds.has(arg)) {
        selectedShotIds.delete(arg);
      } else {
        selectedShotIds.add(arg);
      }
      const chk = document.querySelector(`input[data-s="shot.toggle_check:${arg}"]`);
      if (chk) chk.checked = selectedShotIds.has(arg);
    };

    STORY.cmds["shot.toggle_all"] = (arg, trigger) => {
      const shots = getShots();
      if (selectedShotIds.size === shots.length) {
        selectedShotIds.clear();
      } else {
        selectedShotIds = new Set(shots.map(s => s.id));
      }
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["shot.add"] = () => {
      const curId = STORY.selItem && STORY.selItem.kind === "shot" ? STORY.selItem.id : null;
      addShot(curId);
    };

    STORY.cmds["shot.add_intercut"] = () => {
      addIntercut();
    };

    STORY.cmds["shot.dup"] = (arg) => {
      duplicateShot(arg);
    };

    STORY.cmds["shot.split"] = (arg) => {
      splitShot(arg);
    };

    STORY.cmds["shot.del"] = (arg) => {
      deleteShot(arg);
    };

    STORY.cmds["shot.renumber"] = () => {
      renumberShots();
      computeBatches();
      if (typeof STORY.snapshot === "function") STORY.snapshot("Renumber shots");
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
      if (typeof toast === "function") toast("Renumbered all shots sequentially.");
    };

    STORY.cmds["shot.rebatch"] = () => {
      computeBatches();
      if (typeof STORY.snapshot === "function") STORY.snapshot("Recompute batches");
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
      if (typeof toast === "function") toast("Recalculated 30s batches.");
    };

    STORY.cmds["shot.bulk_type"] = (arg) => {
      bulkChangeType(arg);
    };

    STORY.cmds["shot.view_mode"] = (arg) => {
      viewMode = arg === "cards" ? "cards" : "table";
      savePrefs();
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["shot.toggle_cols"] = (arg, trigger) => {
      showColumnsPopover(trigger);
    };

    STORY.cmds["shot.import_menu"] = () => {
      showImportModal();
    };

    STORY.cmds["shot.export_menu"] = () => {
      const text = buildGptExportText();
      const filename = window.KTOON_FILENAME && typeof window.KTOON_FILENAME.next === "function"
        ? window.KTOON_FILENAME.next("SHOTLIST", "md", STORY.ep)
        : `PROJECT_EP${String(STORY.ep && STORY.ep.no || 1).padStart(2, "0")}_SHOTLIST_v1.md`;
      downloadBlob(filename, text, "text/markdown;charset=utf-8");
      if (typeof toast === "function") toast("Exported GPT shotlist .md");
    };

    STORY.cmds["shot.export_gpt"] = () => {
      STORY.cmds["shot.export_menu"]();
    };

    STORY.cmds["shot.export_csv"] = () => {
      const text = buildCsvExportText();
      const filename = window.KTOON_FILENAME && typeof window.KTOON_FILENAME.next === "function"
        ? window.KTOON_FILENAME.next("SHOTLIST", "csv", STORY.ep)
        : `PROJECT_EP${String(STORY.ep && STORY.ep.no || 1).padStart(2, "0")}_SHOTLIST_v1.csv`;
      downloadBlob(filename, text, "text/csv;charset=utf-8");
      if (typeof toast === "function") toast("Exported CSV shotlist");
    };

    STORY.cmds["shot.goto"] = (arg) => {
      if (!arg) return;
      if (typeof STORY.select === "function") {
        STORY.select("shot", arg);
      }
      // Ensure shotlist tab active
      if (STORY.tab !== "shotlist" && typeof STORY.cmds["tab"] === "function") {
        STORY.cmds["tab"]("shotlist");
      }
      // Scroll into view
      setTimeout(() => {
        const row = document.querySelector(`[data-shot-id="${arg}"]`);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.classList.add("selected");
        }
      }, 50);
    };

    // Auto-fix commands for Gate A issues
    STORY.cmds["shot.fix_dur"] = (arg) => {
      const shots = getShots();
      const s = shots.find(x => x.id === arg);
      if (s) {
        const bible = getBible() || {};
        const shotMin = (bible.format && bible.format.shotMin) || 4;
        const shotMax = (bible.format && bible.format.shotMax) || 15;
        s.dur = Math.max(shotMin, Math.min(shotMax, Number(s.dur) || 6));
        s.u = Date.now();
        computeBatches();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Clamp duration on " + formatShotNo(s.n));
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Clamped duration of ${formatShotNo(s.n)} to ${s.dur}s.`);
      }
    };

    STORY.cmds["shot.fix_trim_bank"] = (arg) => {
      const shots = getShots();
      const s = shots.find(x => x.id === arg);
      if (s && s.bank && s.bank.length > 8) {
        s.bank = s.bank.slice(0, 8);
        s.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Trim bank on " + formatShotNo(s.n));
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Trimmed bank of ${formatShotNo(s.n)} to 8 images.`);
      }
    };

    STORY.cmds["shot.fix_clear_bank"] = (arg) => {
      const shots = getShots();
      const s = shots.find(x => x.id === arg);
      if (s) {
        s.bank = [];
        s.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Clear bank on " + formatShotNo(s.n));
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Cleared bank references on ${formatShotNo(s.n)}.`);
      }
    };

    STORY.cmds["shot.fix_add_char"] = (arg) => {
      const [sId, cId] = arg.split(":");
      const shots = getShots();
      const s = shots.find(x => x.id === sId);
      if (s && cId) {
        if (!Array.isArray(s.chars)) s.chars = [];
        if (!s.chars.includes(cId)) s.chars.push(cId);
        s.u = Date.now();
        if (typeof STORY.snapshot === "function") STORY.snapshot("Tag character on " + formatShotNo(s.n));
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Tagged character in ${formatShotNo(s.n)}.`);
      }
    };
  }

  // ---------- Module Registry Registration ----------
  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Register view
    STORY.views.shotlist = {
      render(el) {
        renderShotlist(el);
        setupDragAndDrop();
        setupInlineEditing();
      }
    };

    // Register inspector
    STORY.inspector.shot = {
      render(el, sel) {
        renderShotInspector(el, sel);
      }
    };

    // Register commands
    registerCommands();

    // Cross-module APIs (Spec Section 5.C & TASK_004)
    STORY.shots = {
      list() {
        return getShots();
      },
      byBlock(blockNum) {
        const shots = getShots();
        const b = Number(blockNum) || 1;
        return shots.filter(s => (s.block || 1) === b);
      },
      totals() {
        return computeTotals();
      },
      exportText(kind, shotOverride) {
        if (kind === "gpt") return buildGptExportText(shotOverride);
        if (kind === "csv") return buildCsvExportText();
        if (kind === "json") return JSON.stringify(getShots(), null, 2);
        return "";
      },
      computeBatches,
      renumberShots,
      checkGateA,
      importJSON(obj) {
        if (!obj) return false;
        let data = obj;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (e) { return false; }
        }
        if (!data || typeof data !== "object") return false;

        const ep = STORY.ep || {};
        if (data.title && typeof data.title === "string") ep.title = data.title;
        if (Array.isArray(data.locations)) ep.locations = data.locations;
        if (Array.isArray(data.blocks)) ep.blocks = data.blocks;

        const rawShots = Array.isArray(data.shots) ? data.shots : [];
        if (rawShots.length > 0) {
          const imported = rawShots.map((rs, idx) => {
            const dialogueList = Array.isArray(rs.dialogue) ? rs.dialogue.map(d => ({
              char: d.char || "",
              char_name: d.char || "",
              text: d.line || d.text || "",
              modifier: d.mode || ""
            })) : [];

            const actionStr = rs.content || (Array.isArray(rs.action_order) ? rs.action_order.join(". ") : rs.action) || "";

            return createDefaultShot({
              n: rs.n || (idx + 1),
              block: rs.block || 1,
              slug: rs.slug || "",
              location: rs.location || rs.loc || "",
              loc: rs.location || rs.loc || "",
              size: rs.size || "MCU",
              angle: rs.angle || "eye level",
              move: rs.movement || rs.move || "static",
              cam_rel: rs.camera_relative || rs.cam_rel || "",
              placement: rs.placement || "",
              purpose: rs.purpose || "",
              perf: rs.performance || rs.perf || "",
              dur: Number(rs.duration || rs.dur) || 6,
              type: rs.type || "I2V",
              action: actionStr,
              content: rs.content || actionStr,
              dialogue: dialogueList,
              sfx: rs.sfx || "",
              cont: {
                start: rs.cont_start || (rs.cont && rs.cont.start) || "",
                end: rs.cont_end || (rs.cont && rs.cont.end) || ""
              }
            });
          });

          ep.shots = imported;
          computeBatches();
          if (typeof STORY.snapshot === "function") STORY.snapshot("Import shotlist JSON");
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          if (typeof STORY.renderView === "function") STORY.renderView();
          return { success: true, count: imported.length };
        }
        return { success: true, count: 0 };
      }
    };

    // Extension Hook: After Desk load, ensure batches computed & Gate A checked
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) {
      STORY.hooks.afterLoad.push(() => {
        computeBatches();
        updateGateAUI();
      });
    }

    // Initial batch computation if shots exist
    if (STORY.ep && Array.isArray(STORY.ep.shots) && STORY.ep.shots.length > 0) {
      computeBatches();
      updateGateAUI();
    }
  }

  // Run initialization
  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initModule);
    } else {
      initModule();
    }
  }

})();
