// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with authentication & episode header)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL resolver)
// - CUR : { ep: { id, name, ... }, series: { id, name, ... } } (Current context)
// - PJ : { groups: [...], series: [...], episodes: [...] } (Project tree)
// - C : { catalog: { video: [...], llm: [...], image: [...] } } (Model catalog)
// - STORY : state store exported on window
//
// Server changes needed:
// - None for Task 007. Uses existing /api/desk/batch for persistence and client-side blob downloads.
//
// App changes needed:
// - None. Integrates into STORY extension registry (STORY.views.board, STORY.cmds).
//
// Known limitations:
// - Kanban drag-and-drop uses HTML5 Drag and Drop API.
// - Episode budget cap defaults to $20.00 unless configured in series bible (STORY.bible.format.budgetCap).
// - Video generation costs are computed from C.catalog.video per-second pricing (baseline $0.16/s)
//   and STB generation baseline $0.04/image.

(function () {
  "use strict";

  // Kanban status columns definition (Spec Section 5.F)
  const BOARD_COLUMNS = [
    { id: "draft", label: "Draft", desc: "Written / Needs Prompts" },
    { id: "ready", label: "Ready", desc: "Prompts Linted & Locked" },
    { id: "stb", label: "STB", desc: "Keyframe Generated / Approved" },
    { id: "video", label: "Video", desc: "In Gen / Needs Review" },
    { id: "approved", label: "Approved", desc: "QC Passed / Ready for Edit" },
    { id: "in_edit", label: "In Edit", desc: "Placed in Video Editor" }
  ];

  // Local filter and display state
  let searchQuery = "";
  let batchFilter = "all"; // 'all' | 1 | 2 | 3
  let typeFilter = "all";  // 'all' | 'REF' | 'I2V' | 'MINI'
  let charFilter = "all";
  let locFilter = "all";
  let quickFilterRedo = false;
  let quickFilterStale = false;
  let quickFilterMissingStb = false;
  let quickFilterMissingVideo = false;

  let draggedShotId = null;

  // Safe escape utility
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

  function formatShotNumber(n) {
    return "S" + String(Number(n) || 1).padStart(2, "0");
  }

  function getBible() {
    return (typeof STORY !== "undefined" && STORY && STORY.bible) ? STORY.bible : null;
  }

  function getEp() {
    return (typeof STORY !== "undefined" && STORY && STORY.ep) ? STORY.ep : null;
  }

  function getShots() {
    const ep = getEp();
    if (!ep || !Array.isArray(ep.shots)) return [];
    return ep.shots;
  }

  // Cost computation for a shot (Spec 5.F.3 & 7.2)
  function computeShotCost(shot) {
    let cost = 0;
    // STB cost
    if (shot.stb && shot.stb.ref) {
      cost += 0.04;
    }
    // Video cost: read from C.catalog.video if available or baseline $0.16/s
    if (shot.video && (shot.video.ref || shot.video.status === "done" || shot.video.status === "approved" || shot.video.status === "in_edit")) {
      const dur = Number(shot.dur) || 6;
      let pricePerSec = 0.16;
      if (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) {
        const m = C.catalog.video.find(x => x.id === (shot.video.model || "seedance-2.5"));
        if (m && typeof m.price_s === "number") pricePerSec = m.price_s;
      }
      cost += dur * pricePerSec;
    }
    return cost;
  }

  // Board metrics summary (Spec 5.F.4)
  function computeBoardMetrics() {
    const shots = getShots();
    const bible = getBible() || {};
    const targetDur = (bible.format && bible.format.epDur) || 90;
    const budgetCap = (bible.format && bible.format.budgetCap) || 20.00;

    let totalDur = 0;
    let totalCost = 0;
    let doneCount = 0;
    let redoCount = 0;
    let staleCount = 0;
    let outOfSyncCount = 0;
    let missingStbCount = 0;
    let missingVideoCount = 0;

    shots.forEach(s => {
      totalDur += Number(s.dur) || 0;
      totalCost += computeShotCost(s);

      if (s.status === "approved" || s.status === "in_edit") {
        doneCount++;
      }
      if ((s.video && s.video.status === "redo") || s.status === "redo") {
        redoCount++;
      }
      if (s.isStale) staleCount++;
      if (s.isOutOfSync) outOfSyncCount++;
      if (!s.stb || !s.stb.ref) missingStbCount++;
      if (!s.video || !s.video.ref) missingVideoCount++;
    });

    const pctDone = shots.length > 0 ? Math.round((doneCount / shots.length) * 100) : 0;
    const budgetPct = Math.min(100, Math.round((totalCost / budgetCap) * 100));

    return {
      totalShots: shots.length,
      totalDur,
      targetDur,
      totalCost,
      budgetCap,
      budgetPct,
      pctDone,
      doneCount,
      redoCount,
      staleCount,
      outOfSyncCount,
      missingStbCount,
      missingVideoCount
    };
  }

  // Filter shots for Kanban display
  function filterShots(shots) {
    const q = searchQuery.trim().toLowerCase();
    return shots.filter(s => {
      // 1. Text search
      if (q) {
        const shotNo = formatShotNumber(s.n).toLowerCase();
        const act = (s.action || "").toLowerCase();
        const slug = (s.slug || "").toLowerCase();
        const title = (s.title || "").toLowerCase();
        if (!shotNo.includes(q) && !act.includes(q) && !slug.includes(q) && !title.includes(q)) {
          return false;
        }
      }

      // 2. Batch filter
      if (batchFilter !== "all") {
        if ((s.batch || 1) !== Number(batchFilter)) return false;
      }

      // 3. Type filter
      if (typeFilter !== "all") {
        if (s.type !== typeFilter) return false;
      }

      // 4. Character filter
      if (charFilter !== "all") {
        if (!Array.isArray(s.chars) || !s.chars.includes(charFilter)) return false;
      }

      // 5. Location filter
      if (locFilter !== "all") {
        if (s.loc !== locFilter) return false;
      }

      // 6. Quick filters
      if (quickFilterRedo) {
        if (s.video?.status !== "redo" && s.status !== "redo") return false;
      }
      if (quickFilterStale) {
        if (!s.isStale && !s.isOutOfSync) return false;
      }
      if (quickFilterMissingStb) {
        if (s.stb && s.stb.ref) return false;
      }
      if (quickFilterMissingVideo) {
        if (s.video && s.video.ref) return false;
      }

      return true;
    });
  }

  // ---------- Render Production Board (Main View) ----------
  function renderProductionBoard(container) {
    if (!container) return;

    // Run sync flags detection
    if (typeof STORY !== "undefined" && STORY.links && typeof STORY.links.checkSyncFlags === "function") {
      STORY.links.checkSyncFlags();
    }

    const metrics = computeBoardMetrics();
    const allShots = getShots();
    const filteredShots = filterShots(allShots);
    const bible = getBible() || {};
    const chars = bible.chars || [];
    const locs = bible.locs || [];

    // Distinct batches
    const batches = Array.from(new Set(allShots.map(s => s.batch || 1))).sort((a, b) => a - b);

    // Budget bar color class
    let budgetColorClass = "budget-ok";
    if (metrics.totalCost > metrics.budgetCap) {
      budgetColorClass = "budget-danger";
    } else if (metrics.budgetPct >= 70) {
      budgetColorClass = "budget-warn";
    }

    container.innerHTML = `
      <div id="story-board-container" class="story-board-view">
        <!-- Top Metrics & Controls Bar -->
        <div class="story-board-header">
          <div class="story-board-metrics">
            <!-- Progress Pill -->
            <div class="story-board-stat-card">
              <span class="stat-label">Progress</span>
              <div class="stat-val">
                <span class="stat-big">${metrics.pctDone}%</span>
                <span class="stat-sub">${metrics.doneCount}/${metrics.totalShots} approved</span>
              </div>
            </div>

            <!-- Duration Pill -->
            <div class="story-board-stat-card">
              <span class="stat-label">Duration</span>
              <div class="stat-val">
                <span class="stat-big">${metrics.totalDur.toFixed(1)}s</span>
                <span class="stat-sub">/ ${metrics.targetDur}s target</span>
              </div>
            </div>

            <!-- Budget & Cost Bar -->
            <div class="story-board-stat-card story-board-budget-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                <span class="stat-label">Episode Budget</span>
                <span class="stat-sub" style="font-weight:700;color:${metrics.totalCost > metrics.budgetCap ? '#ef4444' : '#e6f0ea'};">
                  $${metrics.totalCost.toFixed(2)} / $${metrics.budgetCap.toFixed(2)}
                </span>
              </div>
              <div class="story-board-budget-bar">
                <div class="story-board-budget-fill ${budgetColorClass}" style="width: ${metrics.budgetPct}%;"></div>
              </div>
            </div>

            <!-- Redo Pill -->
            ${metrics.redoCount > 0 ? `
              <div class="story-board-stat-card story-stat-redo">
                <span class="stat-label">Needs Redo</span>
                <div class="stat-val">
                  <span class="stat-big" style="color:#ef4444;">${metrics.redoCount}</span>
                  <span class="stat-sub">shots flagged</span>
                </div>
              </div>
            ` : ""}
          </div>

          <!-- Board Actions -->
          <div class="story-board-actions">
            <button class="story-btn-ghost" data-s="board.sync" title="Sync with Canvas nodes and background jobs">
              Sync Status
            </button>
            <div class="story-dropdown" style="display:inline-block;position:relative;">
              <button class="story-btn-ghost" data-s="board.nodes_menu">
                Create Nodes ▾
              </button>
              <div id="story-board-nodes-menu" class="story-dropdown-menu" hidden>
                <div class="story-dropdown-item" data-s="links.create_nodes:all">All Batches</div>
                ${batches.map(b => `
                  <div class="story-dropdown-item" data-s="links.create_nodes:${b}">Batch ${b} only</div>
                `).join("")}
              </div>
            </div>
            <div class="story-dropdown" style="display:inline-block;position:relative;">
              <button class="story-btn-ghost" data-s="board.prod_menu">
                Send Production ▾
              </button>
              <div id="story-board-prod-menu" class="story-dropdown-menu" hidden>
                <div class="story-dropdown-item" data-s="links.send_production:all">All Batches</div>
                ${batches.map(b => `
                  <div class="story-dropdown-item" data-s="links.send_production:${b}">Batch ${b} only</div>
                `).join("")}
              </div>
            </div>
            <button class="story-btn-gold" data-s="links.send_vedit" style="font-weight:700;">
              Send to Video Editor
            </button>
          </div>
        </div>

        <!-- Filter Bar -->
        <div class="story-board-filter-bar">
          <div class="story-filter-left">
            <!-- Search -->
            <div class="story-search-wrap">
              <input type="text" id="story-board-search" class="story-input" placeholder="Search shots, action, chars..." value="${_esc(searchQuery)}" />
            </div>

            <!-- Batch Filter -->
            <select id="story-board-filter-batch" class="story-select">
              <option value="all" ${batchFilter === "all" ? "selected" : ""}>All Batches</option>
              ${batches.map(b => `
                <option value="${b}" ${String(batchFilter) === String(b) ? "selected" : ""}>Batch ${b}</option>
              `).join("")}
            </select>

            <!-- Type Filter -->
            <select id="story-board-filter-type" class="story-select">
              <option value="all" ${typeFilter === "all" ? "selected" : ""}>All Types</option>
              <option value="REF" ${typeFilter === "REF" ? "selected" : ""}>REF</option>
              <option value="I2V" ${typeFilter === "I2V" ? "selected" : ""}>I2V</option>
              <option value="MINI" ${typeFilter === "MINI" ? "selected" : ""}>MINI</option>
            </select>

            <!-- Character Filter -->
            <select id="story-board-filter-char" class="story-select">
              <option value="all" ${charFilter === "all" ? "selected" : ""}>All Characters</option>
              ${chars.map(c => `
                <option value="${c.id}" ${charFilter === c.id ? "selected" : ""}>${_esc(c.name)}</option>
              `).join("")}
            </select>

            <!-- Location Filter -->
            <select id="story-board-filter-loc" class="story-select">
              <option value="all" ${locFilter === "all" ? "selected" : ""}>All Locations</option>
              ${locs.map(l => `
                <option value="${l.id}" ${locFilter === l.id ? "selected" : ""}>${_esc(l.name)}</option>
              `).join("")}
            </select>
          </div>

          <!-- Quick Toggle Chips -->
          <div class="story-filter-chips">
            <button class="story-chip ${quickFilterRedo ? 'active' : ''}" data-s="board.toggle_quick:redo">
              Redo ${metrics.redoCount > 0 ? `(${metrics.redoCount})` : ""}
            </button>
            <button class="story-chip ${quickFilterStale ? 'active' : ''}" data-s="board.toggle_quick:stale">
              Out of Sync ${metrics.outOfSyncCount + metrics.staleCount > 0 ? `(${metrics.outOfSyncCount + metrics.staleCount})` : ""}
            </button>
            <button class="story-chip ${quickFilterMissingStb ? 'active' : ''}" data-s="board.toggle_quick:missing_stb">
              Missing STB (${metrics.missingStbCount})
            </button>
            <button class="story-chip ${quickFilterMissingVideo ? 'active' : ''}" data-s="board.toggle_quick:missing_video">
              Missing Video (${metrics.missingVideoCount})
            </button>
            <button class="story-btn-ghost" data-s="board.export_csv" style="font-size:11px;padding:3px 8px;">
              Export CSV
            </button>
          </div>
        </div>

        <!-- Kanban Columns Area -->
        <div class="story-board-columns" id="story-board-columns">
          ${BOARD_COLUMNS.map(col => {
            const colShots = filteredShots.filter(s => (s.status || "draft") === col.id);
            return renderKanbanColumn(col, colShots);
          }).join("")}
        </div>
      </div>
    `;

    setupBoardEvents(container);
  }

  // Render a single Kanban Column
  function renderKanbanColumn(col, shots) {
    return `
      <div class="story-board-col" data-col-id="${col.id}">
        <div class="story-board-col-header">
          <div>
            <div class="story-col-title-wrap">
              <span class="story-col-title">${col.label}</span>
              <span class="story-col-count">${shots.length}</span>
            </div>
            <div class="story-col-desc">${col.desc}</div>
          </div>
          <div class="story-col-actions">
            ${col.id === "video" ? `
              <button class="story-btn-ghost" data-s="board.batch_approve:video" title="Approve all video shots in this column" style="font-size:10px;padding:1px 5px;">
                Approve All
              </button>
            ` : ""}
          </div>
        </div>

        <div class="story-board-cards-area" data-col-id="${col.id}">
          ${shots.length > 0 ? shots.map(s => renderKanbanCard(s)).join("") : `
            <div class="story-col-empty">
              No shots in ${col.label}
            </div>
          `}
        </div>
      </div>
    `;
  }

  // Render a single Kanban Card (Spec 5.F.3 & KTOONS_STANDARDS §4.4)
  function renderKanbanCard(shot) {
    const shotNo = formatShotNumber(shot.n);
    const cost = computeShotCost(shot);
    const bible = getBible() || {};
    const chars = bible.chars || [];

    // Thumbnail selection: prefer video ref, fallback to stb ref
    const videoRef = (shot.video && shot.video.ref) ? shot.video.ref : "";
    const stbRef = (shot.stb && shot.stb.ref) ? shot.stb.ref : "";
    const displayThumb = stbRef || videoRef;

    // Type badge color
    const typeClass = shot.type === "REF" ? "badge-ref" : (shot.type === "I2V" ? "badge-i2v" : "badge-mini");

    // Character names
    const charNames = [];
    if (Array.isArray(shot.chars)) {
      shot.chars.forEach(cId => {
        const c = chars.find(x => x.id === cId || x.name === cId);
        if (c) charNames.push(c.name);
      });
    }

    // QC Evaluation badge (KTOONS_STANDARDS §4.4)
    let qcBadgeHtml = "";
    if (shot.qc && typeof shot.qc === "object") {
      const verdict = shot.qc.verdict || "pass";
      const scores = shot.qc.scores || {};
      const scoreVals = Object.values(scores).map(Number).filter(n => !isNaN(n));
      const avgScore = scoreVals.length ? (scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length).toFixed(1) : "4.0";

      if (verdict === "pass") {
        qcBadgeHtml = `<span class="story-qc-pill qc-pass" data-s="board.show_qc:${shot.id}" title="QC Passed (${avgScore})">QC: PASS ${avgScore}</span>`;
      } else if (verdict === "regen") {
        qcBadgeHtml = `<span class="story-qc-pill qc-regen" data-s="board.show_qc:${shot.id}" title="QC Failed - Needs Regeneration">QC: REGEN ${avgScore}</span>`;
      } else if (verdict === "fix_frame") {
        qcBadgeHtml = `<span class="story-qc-pill qc-fix" data-s="board.show_qc:${shot.id}" title="QC Needs Frame Fix at ${shot.qc.fix_at_sec || 0}s">QC: FIX FRAME</span>`;
      }
    }

    // Stale & Out of sync flags
    let syncFlagHtml = "";
    if (shot.isOutOfSync) {
      syncFlagHtml += `<span class="story-sync-pill pill-oos" title="Duration or parameters modified after sending to Video Editor">OUT OF SYNC</span>`;
    }
    if (shot.isStale) {
      syncFlagHtml += `<span class="story-sync-pill pill-stale" title="Script blocks modified after prompt generation">SCRIPT CHANGED</span>`;
    }

    // Redo badge
    const isRedo = (shot.video && shot.video.status === "redo") || shot.status === "redo";
    const redoNote = (shot.video && shot.video.note) ? shot.video.note : "";

    return `
      <div class="story-board-card ${isRedo ? 'card-redo' : ''} ${shot.isOutOfSync ? 'card-oos' : ''} ${shot.isStale ? 'card-stale' : ''}"
           draggable="true"
           data-shot-id="${shot.id}">
        <!-- Card Header -->
        <div class="story-card-top">
          <div class="story-card-tags">
            <span class="story-card-no">${shotNo}</span>
            <span class="story-card-batch">B${shot.block || 1}</span>
            <span class="story-card-type ${typeClass}">${shot.type || "REF"}</span>
            <span class="story-card-dur">${Number(shot.dur) || 6}s</span>
          </div>
          <div class="story-card-cost" title="Estimated cost spent for this shot">
            $${cost.toFixed(2)}
          </div>
        </div>

        <!-- Thumbnail & Preview -->
        <div class="story-card-media-wrap" data-s="board.open_shot:${shot.id}">
          ${displayThumb ? `
            <img src="${typeof tsrc === 'function' ? tsrc(displayThumb) : (typeof src === 'function' ? src(displayThumb) : displayThumb)}"
                 class="story-card-img" alt="${shotNo}" />
            <div class="story-card-media-badge">
              ${videoRef ? "VIDEO" : "STB"}
            </div>
          ` : `
            <div class="story-card-placeholder" data-s="links.make_stb:${shot.id}">
              <span>+ Make STB</span>
            </div>
          `}
        </div>

        <!-- Action / Content text -->
        <div class="story-card-body">
          <div class="story-card-action">
            ${_esc(shot.action || shot.title || "(No action description)")}
          </div>

          <!-- Dialogue snippet -->
          ${Array.isArray(shot.dialogue) && shot.dialogue.length > 0 ? `
            <div class="story-card-dialogue">
              <span class="dlg-char">${_esc(shot.dialogue[0].char_name || shot.dialogue[0].char || "CHAR")}:</span>
              "${_esc(shot.dialogue[0].text || shot.dialogue[0].line || "")}"
            </div>
          ` : ""}

          <!-- Character and location badges -->
          <div class="story-card-meta">
            ${charNames.map(cn => `<span class="meta-char">${_esc(cn)}</span>`).join("")}
            ${shot.slug ? `<span class="meta-loc">${_esc(shot.slug)}</span>` : ""}
          </div>
        </div>

        <!-- Warnings & QC Badges -->
        <div class="story-card-flags">
          ${isRedo ? `<span class="story-redo-pill" title="${_esc(redoNote)}">REDO: ${_esc(redoNote || "Requested")}</span>` : ""}
          ${qcBadgeHtml}
          ${syncFlagHtml}
        </div>

        <!-- Card Footer Actions -->
        <div class="story-card-footer">
          <div style="display:flex;gap:4px;">
            <button class="story-card-btn" data-s="board.open_shot:${shot.id}">Open</button>
            <button class="story-card-btn" data-s="links.make_stb:${shot.id}">STB</button>
            <button class="story-card-btn" data-s="board.redo_dialog:${shot.id}">Redo</button>
          </div>
          <div>
            ${shot.status !== "approved" && shot.status !== "in_edit" ? `
              <button class="story-card-btn-approve" data-s="board.quick_approve:${shot.id}">Approve</button>
            ` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Drag and Drop Mechanics ----------
  function setupDragAndDrop(container) {
    const cards = container.querySelectorAll(".story-board-card");
    const dropZones = container.querySelectorAll(".story-board-cards-area");

    cards.forEach(card => {
      card.ondragstart = (e) => {
        draggedShotId = card.dataset.shotId;
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", draggedShotId);
        e.dataTransfer.effectAllowed = "move";
      };

      card.ondragend = () => {
        card.classList.remove("dragging");
        draggedShotId = null;
        dropZones.forEach(z => z.classList.remove("drag-over"));
      };
    });

    dropZones.forEach(zone => {
      zone.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        zone.classList.add("drag-over");
      };

      zone.ondragleave = () => {
        zone.classList.remove("drag-over");
      };

      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
        const shotId = e.dataTransfer.getData("text/plain") || draggedShotId;
        const targetCol = zone.dataset.colId;

        if (shotId && targetCol) {
          moveShotStatus(shotId, targetCol);
        }
      };
    });
  }

  // Move shot to a different status column
  function moveShotStatus(shotId, newStatus) {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot || shot.status === newStatus) return;

    const oldStatus = shot.status || "draft";
    shot.status = newStatus;
    shot.u = Date.now();

    // If moved to Approved, update video status if video exists
    if (newStatus === "approved" && shot.video) {
      shot.video.status = "approved";
    }

    if (typeof STORY !== "undefined") {
      if (typeof STORY.snapshot === "function") {
        STORY.snapshot(`Move ${formatShotNumber(shot.n)} from ${oldStatus} to ${newStatus}`);
      }
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }

    if (typeof toast === "function") toast(`Moved ${formatShotNumber(shot.n)} to ${newStatus.toUpperCase()}`);
  }

  // ---------- QC Inspector & Modal (KTOONS_STANDARDS §4.4) ----------
  function showQCModal(shotId) {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    const oldModal = document.getElementById("story-qc-modal");
    if (oldModal) oldModal.remove();

    const qc = shot.qc || {
      target: `B${shot.block || 1}_${formatShotNumber(shot.n)}`,
      scores: { identity: 4, raccord: 4, action: 4, lighting: 4, artifacts: 4 },
      issues: [],
      verdict: "pass",
      fix_at_sec: 0,
      fix_prompt: ""
    };

    const overlay = document.createElement("div");
    overlay.id = "story-qc-modal";
    overlay.className = "story-modal-overlay";
    overlay.innerHTML = `
      <div class="story-modal-box" style="max-width: 520px;">
        <div class="story-modal-header">
          <div>
            <h3 style="margin:0;font-size:15px;color:var(--text,#e6f0ea);font-weight:700;">QC Review · ${formatShotNumber(shot.n)}</h3>
            <div style="font-size:11.5px;color:var(--muted,#93a39a);margin-top:2px;">KTOONS Quality Gate B (§4.4)</div>
          </div>
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">✕</button>
        </div>

        <div class="story-modal-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;">
          <!-- 5 Scores Grid -->
          <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:8px;text-align:center;">
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:4px;">Identity</label>
              <input type="number" id="qc-score-identity" min="0" max="5" step="0.5" value="${qc.scores.identity ?? 4}" class="story-input" style="text-align:center;" />
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:4px;">Raccord</label>
              <input type="number" id="qc-score-raccord" min="0" max="5" step="0.5" value="${qc.scores.raccord ?? 4}" class="story-input" style="text-align:center;" />
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:4px;">Action</label>
              <input type="number" id="qc-score-action" min="0" max="5" step="0.5" value="${qc.scores.action ?? 4}" class="story-input" style="text-align:center;" />
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:4px;">Lighting</label>
              <input type="number" id="qc-score-lighting" min="0" max="5" step="0.5" value="${qc.scores.lighting ?? 4}" class="story-input" style="text-align:center;" />
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:4px;">Artifacts</label>
              <input type="number" id="qc-score-artifacts" min="0" max="5" step="0.5" value="${qc.scores.artifacts ?? 4}" class="story-input" style="text-align:center;" />
            </div>
          </div>

          <!-- Verdict Selector -->
          <div>
            <label style="font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;display:block;margin-bottom:4px;">Verdict</label>
            <select id="qc-verdict-select" class="story-select" style="width:100%;">
              <option value="pass" ${qc.verdict === "pass" ? "selected" : ""}>PASS (All scores ≥ 3 and average ≥ 3.8)</option>
              <option value="regen" ${qc.verdict === "regen" ? "selected" : ""}>REGEN (Full block/shot regeneration needed)</option>
              <option value="fix_frame" ${qc.verdict === "fix_frame" ? "selected" : ""}>FIX FRAME (Replace keyframe at timestamp)</option>
            </select>
          </div>

          <!-- Issues List -->
          <div>
            <label style="font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;display:block;margin-bottom:4px;">Identified Issues (one per line)</label>
            <textarea id="qc-issues-input" class="story-textarea" rows="2" placeholder="e.g. slight facial flicker at 2.4s...">${_esc((qc.issues || []).join("\n"))}</textarea>
          </div>

          <!-- Fix Timestamp & Fix Prompt -->
          <div id="qc-fix-fields" style="display:${qc.verdict === 'fix_frame' ? 'block' : 'none'};background:var(--card2,#0d1a15);padding:10px;border-radius:4px;border:1px solid var(--line,#1d3128);">
            <div style="display:flex;gap:10px;margin-bottom:8px;">
              <div style="flex:1;">
                <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:3px;">Fix at Seconds</label>
                <input type="number" id="qc-fix-sec" min="0" max="${shot.dur || 15}" step="0.1" value="${qc.fix_at_sec || 0}" class="story-input" />
              </div>
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:var(--muted,#93a39a);display:block;margin-bottom:3px;">Fix Frame Prompt</label>
              <textarea id="qc-fix-prompt" class="story-textarea" rows="2" placeholder="Describe correction for keyframe...">${_esc(qc.fix_prompt || "")}</textarea>
            </div>
          </div>
        </div>

        <div class="story-modal-footer" style="padding:10px 16px;border-top:1px solid var(--line,#1d3128);display:flex;justify-content:space-between;align-items:center;">
          <div>
            ${shot.qc ? `
              <button class="story-btn-ghost" id="qc-clear-btn" style="color:#ef4444;font-size:11px;">Clear QC</button>
            ` : ""}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">Cancel</button>
            <button class="story-btn-gold" id="qc-save-btn" style="font-size:11.5px;padding:6px 14px;">Save QC Result</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const verdictSelect = overlay.querySelector("#qc-verdict-select");
    const fixFields = overlay.querySelector("#qc-fix-fields");
    verdictSelect.onchange = () => {
      fixFields.style.display = (verdictSelect.value === "fix_frame") ? "block" : "none";
    };

    const clearBtn = overlay.querySelector("#qc-clear-btn");
    if (clearBtn) {
      clearBtn.onclick = () => {
        delete shot.qc;
        shot.u = Date.now();
        if (typeof STORY !== "undefined") {
          if (typeof STORY.snapshot === "function") STORY.snapshot(`Clear QC on ${formatShotNumber(shot.n)}`);
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          if (typeof STORY.renderView === "function") STORY.renderView();
        }
        overlay.remove();
      };
    }

    overlay.querySelector("#qc-save-btn").onclick = () => {
      const identity = parseFloat(overlay.querySelector("#qc-score-identity").value) || 0;
      const raccord = parseFloat(overlay.querySelector("#qc-score-raccord").value) || 0;
      const action = parseFloat(overlay.querySelector("#qc-score-action").value) || 0;
      const lighting = parseFloat(overlay.querySelector("#qc-score-lighting").value) || 0;
      const artifacts = parseFloat(overlay.querySelector("#qc-score-artifacts").value) || 0;
      const verdict = verdictSelect.value;
      const issues = overlay.querySelector("#qc-issues-input").value.split("\n").map(s => s.trim()).filter(Boolean);
      const fixSec = parseFloat(overlay.querySelector("#qc-fix-sec").value) || 0;
      const fixPrompt = overlay.querySelector("#qc-fix-prompt").value.trim();

      shot.qc = {
        target: `B${shot.block || 1}_${formatShotNumber(shot.n)}`,
        scores: { identity, raccord, action, lighting, artifacts },
        issues,
        verdict,
        fix_at_sec: fixSec,
        fix_prompt: fixPrompt,
        u: Date.now()
      };

      if (verdict === "pass") {
        shot.status = "approved";
        if (shot.video) shot.video.status = "approved";
      } else if (verdict === "regen") {
        if (!shot.video) shot.video = {};
        shot.video.status = "redo";
        shot.video.note = issues.length ? issues[0] : "QC Regen requested";
      }

      shot.u = Date.now();
      if (typeof STORY !== "undefined") {
        if (typeof STORY.snapshot === "function") STORY.snapshot(`Update QC on ${formatShotNumber(shot.n)}`);
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
      }
      if (typeof toast === "function") toast(`Saved QC result: ${verdict.toUpperCase()}`);
      overlay.remove();
    };
  }

  // ---------- Redo Request Dialog ----------
  function showRedoDialog(shotId) {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return;

    const oldModal = document.getElementById("story-redo-modal");
    if (oldModal) oldModal.remove();

    const overlay = document.createElement("div");
    overlay.id = "story-redo-modal";
    overlay.className = "story-modal-overlay";
    overlay.innerHTML = `
      <div class="story-modal-box" style="max-width: 480px;">
        <div class="story-modal-header">
          <div>
            <h3 style="margin:0;font-size:15px;color:var(--text,#e6f0ea);font-weight:700;">Request Redo · ${formatShotNumber(shot.n)}</h3>
            <div style="font-size:11.5px;color:var(--muted,#93a39a);margin-top:2px;">Specify the reason for re-generating this shot</div>
          </div>
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">✕</button>
        </div>

        <div class="story-modal-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;">
          <!-- Quick common reasons -->
          <div>
            <label style="font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;display:block;margin-bottom:6px;">Common Issues</label>
            <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text,#e6f0ea);">
              <label><input type="radio" name="redo-reason" value="Face identity broken / deformed" checked /> Facial identity broken or deformed</label>
              <label><input type="radio" name="redo-reason" value="Lighting mismatch / shadow glitch" /> Lighting mismatch / shadow glitch</label>
              <label><input type="radio" name="redo-reason" value="Raccord / character position flipped" /> Raccord / character position flipped</label>
              <label><input type="radio" name="redo-reason" value="Action / physics glitch" /> Action / unnatural physical motion</label>
              <label><input type="radio" name="redo-reason" value="Pacing too fast / dialogue clipped" /> Pacing / dialogue timing clipped</label>
              <label><input type="radio" name="redo-reason" value="custom" /> Other (specify below)</label>
            </div>
          </div>

          <!-- Note Textarea -->
          <div>
            <label style="font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;display:block;margin-bottom:4px;">Director's Notes</label>
            <textarea id="story-redo-notes" class="story-textarea" rows="2" placeholder="Additional details for the retry..."></textarea>
          </div>
        </div>

        <div class="story-modal-footer" style="padding:10px 16px;border-top:1px solid var(--line,#1d3128);display:flex;justify-content:flex-end;gap:8px;">
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">Cancel</button>
          <button class="story-btn-gold" id="story-redo-submit-btn" style="background:#ef4444;border-color:#ef4444;color:#fff;">Mark for Redo</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector("#story-redo-submit-btn").onclick = () => {
      const selectedRadio = overlay.querySelector('input[name="redo-reason"]:checked');
      let reason = selectedRadio ? selectedRadio.value : "Requested redo";
      const extraNotes = overlay.querySelector("#story-redo-notes").value.trim();
      if (reason === "custom" || extraNotes) {
        reason = extraNotes ? (reason === "custom" ? extraNotes : `${reason}: ${extraNotes}`) : reason;
      }

      if (typeof STORY !== "undefined" && STORY.links && typeof STORY.links.redoShot === "function") {
        STORY.links.redoShot(shot.id, reason);
      } else {
        shot.video = shot.video || {};
        shot.video.status = "redo";
        shot.video.note = reason;
        shot.status = "video";
        shot.u = Date.now();
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
      }

      overlay.remove();
    };
  }

  // ---------- CSV Export for Production Board ----------
  function exportBoardCSV() {
    const shots = getShots();
    if (!shots.length) {
      if (typeof toast === "function") toast("No shots to export.");
      return;
    }

    const headers = ["Shot", "Block", "Type", "Duration", "Status", "STB_Ref", "Video_Ref", "Cost", "QC_Verdict", "Action"];
    const rows = [headers];

    shots.forEach(s => {
      const shotNo = formatShotNumber(s.n);
      const cost = computeShotCost(s).toFixed(2);
      const qcVerdict = (s.qc && s.qc.verdict) ? s.qc.verdict.toUpperCase() : "N/A";
      rows.push([
        shotNo,
        s.block || 1,
        s.type || "REF",
        s.dur || 6,
        s.status || "draft",
        s.stb?.ref || "",
        s.video?.ref || "",
        `$${cost}`,
        qcVerdict,
        `"${(s.action || "").replace(/"/g, '""')}"`
      ]);
    });

    const csvContent = "\uFEFF" + rows.map(r => r.join(",")).join("\n");
    const ep = getEp() || {};
    const filename = `${ep.title || "Episode"}_production_board.csv`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (typeof toast === "function") toast(`Exported board to ${filename}`);
  }

  // ---------- Event Listeners Setup ----------
  function setupBoardEvents(container) {
    setupDragAndDrop(container);

    // Search input
    const searchInp = container.querySelector("#story-board-search");
    if (searchInp) {
      searchInp.oninput = (e) => {
        searchQuery = e.target.value;
        const colsArea = container.querySelector("#story-board-columns");
        if (colsArea) {
          const filtered = filterShots(getShots());
          colsArea.innerHTML = BOARD_COLUMNS.map(col => {
            const cShots = filtered.filter(s => (s.status || "draft") === col.id);
            return renderKanbanColumn(col, cShots);
          }).join("");
          setupDragAndDrop(container);
        }
      };
    }

    // Filter selectors
    const bFilter = container.querySelector("#story-board-filter-batch");
    if (bFilter) {
      bFilter.onchange = (e) => {
        batchFilter = e.target.value;
        renderProductionBoard(container);
      };
    }

    const tFilter = container.querySelector("#story-board-filter-type");
    if (tFilter) {
      tFilter.onchange = (e) => {
        typeFilter = e.target.value;
        renderProductionBoard(container);
      };
    }

    const cFilter = container.querySelector("#story-board-filter-char");
    if (cFilter) {
      cFilter.onchange = (e) => {
        charFilter = e.target.value;
        renderProductionBoard(container);
      };
    }

    const lFilter = container.querySelector("#story-board-filter-loc");
    if (lFilter) {
      lFilter.onchange = (e) => {
        locFilter = e.target.value;
        renderProductionBoard(container);
      };
    }
  }

  // ---------- Register Board Extension Commands ----------
  function registerCommands() {
    if (typeof STORY === "undefined" || !STORY.cmds) return;

    STORY.cmds["board.toggle_quick"] = (arg) => {
      if (arg === "redo") quickFilterRedo = !quickFilterRedo;
      if (arg === "stale") quickFilterStale = !quickFilterStale;
      if (arg === "missing_stb") quickFilterMissingStb = !quickFilterMissingStb;
      if (arg === "missing_video") quickFilterMissingVideo = !quickFilterMissingVideo;
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["board.open_shot"] = (arg) => {
      if (typeof STORY.select === "function") {
        STORY.select("shot", arg);
      }
    };

    STORY.cmds["board.redo_dialog"] = (arg) => {
      showRedoDialog(arg);
    };

    STORY.cmds["board.show_qc"] = (arg) => {
      showQCModal(arg);
    };

    STORY.cmds["board.quick_approve"] = (arg) => {
      moveShotStatus(arg, "approved");
    };

    STORY.cmds["board.batch_approve"] = (arg) => {
      const shots = getShots().filter(s => (s.status || "draft") === arg);
      if (!shots.length) {
        if (typeof toast === "function") toast("No shots to approve in this column.");
        return;
      }
      shots.forEach(s => {
        s.status = "approved";
        if (s.video) s.video.status = "approved";
        s.u = Date.now();
      });
      if (typeof STORY.snapshot === "function") STORY.snapshot(`Batch approve ${shots.length} shots`);
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
      if (typeof toast === "function") toast(`Approved ${shots.length} shots.`);
    };

    STORY.cmds["board.sync"] = () => {
      if (typeof STORY.links !== "undefined" && typeof STORY.links.syncStatus === "function") {
        STORY.links.syncStatus();
      }
    };

    STORY.cmds["board.nodes_menu"] = (arg, el) => {
      const m = document.getElementById("story-board-nodes-menu");
      if (m) m.hidden = !m.hidden;
    };

    STORY.cmds["board.prod_menu"] = (arg, el) => {
      const m = document.getElementById("story-board-prod-menu");
      if (m) m.hidden = !m.hidden;
    };

    STORY.cmds["board.export_csv"] = () => {
      exportBoardCSV();
    };
  }

  // ---------- Module Registry Registration ----------
  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Register view into STORY.views.board
    STORY.views.board = {
      render(el) {
        renderProductionBoard(el);
      }
    };

    registerCommands();
  }

  // Initialize
  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initModule);
    } else {
      initModule();
    }
  }

})();
