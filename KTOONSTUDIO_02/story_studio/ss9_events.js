// ===== Story Studio Events, Layout & Shortcuts (ss9_events.js) =====

// ---------- UI Preferences (localStorage) ----------
function saveUIPrefs() {
  try {
    const prefs = {
      tab: STORY.tab,
      rightTab: STORY.rightTab,
      rightWidth: STORY.rightWidth,
      railCollapsed: STORY.railCollapsed
    };
    localStorage.setItem("ktoon_story_ui", JSON.stringify(prefs));
  } catch (e) {
    // Safe fail if storage is restricted
  }
}

function loadUIPrefs() {
  try {
    const raw = localStorage.getItem("ktoon_story_ui");
    if (raw) {
      const p = JSON.parse(raw);
      if (p.tab && ["bible", "script", "shotlist", "prompts", "board"].includes(p.tab)) {
        STORY.tab = p.tab;
      }
      if (p.rightTab && ["inspector", "ai", "issues"].includes(p.rightTab)) {
        STORY.rightTab = p.rightTab;
      }
      if (typeof p.rightWidth === "number" && p.rightWidth >= 240 && p.rightWidth <= 1200) {
        STORY.rightWidth = p.rightWidth;
      }
      if (typeof p.railCollapsed === "boolean") {
        STORY.railCollapsed = p.railCollapsed;
      }
    }
  } catch (e) {
    // Safe fail
  }
}

// ---------- DOM Shell Builder ----------
function getStoryRoot() {
  let el = document.getElementById("story");
  if (!el) {
    el = document.createElement("div");
    el.id = "story";
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function renderStoryShell() {
  const root = getStoryRoot();
  const s = STORY.curSeries();
  const e = STORY.curEpisode();
  const eps = STORY.curSeriesEpisodes();
  const sName = (s && s.name) ? s.name : "Series";

  root.innerHTML = `
    <!-- Header -->
    <header id="story-header">
      <div class="story-hdr-left">
        <div class="story-brand">
          STORY STUDIO
          <span class="story-badge">v1.0</span>
        </div>
        <div class="story-crumbs">
          <span class="story-slash">/</span>
          <span id="story-series-name">${typeof esc === "function" ? esc(sName) : sName}</span>
          <span class="story-slash">/</span>
          <select id="story-ep-select" class="story-ep-select" data-s="ep:change">
            ${eps.length ? eps.map(ep => `
              <option value="${ep.id}" ${e && e.id === ep.id ? "selected" : ""}>
                ${typeof esc === "function" ? esc(ep.name) : ep.name}
              </option>
            `).join("") : `<option value="">${e && e.name ? (typeof esc === "function" ? esc(e.name) : e.name) : "Episode"}</option>`}
          </select>
        </div>
      </div>

      <!-- Navigation Tabs (5 Tabs) -->
      <nav class="story-nav-tabs" role="tablist">
        <button class="story-nav-tab ${STORY.tab === 'bible' ? 'story-tab-active' : ''}" data-s="tab:bible">Bible</button>
        <button class="story-nav-tab ${STORY.tab === 'script' ? 'story-tab-active' : ''}" data-s="tab:script">Script</button>
        <button class="story-nav-tab ${STORY.tab === 'shotlist' ? 'story-tab-active' : ''}" data-s="tab:shotlist">Shotlist</button>
        <button class="story-nav-tab ${STORY.tab === 'prompts' ? 'story-tab-active' : ''}" data-s="tab:prompts">Prompts</button>
        <button class="story-nav-tab ${STORY.tab === 'board' ? 'story-tab-active' : ''}" data-s="tab:board">Board</button>
      </nav>

      <!-- Header Right Actions -->
      <div class="story-hdr-right">
        <div class="story-pill story-cost-pill">
          Est. <b id="story-hdr-cost">$0.00</b>
        </div>
        <button id="story-btn-undo" class="story-btn-ghost" data-s="app:undo" ${STORY.canUndo() ? "" : "disabled"}>Undo</button>
        <button id="story-btn-redo" class="story-btn-ghost" data-s="app:redo" ${STORY.canRedo() ? "" : "disabled"}>Redo</button>
        <button class="story-btn-ghost" data-s="toggle:ai">AI</button>
        <button class="story-btn-ghost" data-s="export:menu">Export</button>
        <button class="story-btn-ghost" data-s="app:close">Close</button>
      </div>
    </header>

    <!-- Main Workspace Body -->
    <div id="story-body">
      <!-- Left Rail -->
      <aside id="story-rail" class="${STORY.railCollapsed ? 'story-rail-collapsed' : ''}">
        <div class="story-rail-sec story-rail-top">
          <div class="story-rail-header">
            <span>Episodes</span>
            <button class="story-btn-ghost" style="padding:1px 5px;font-size:10px;" data-s="toggle:rail">Hide</button>
          </div>
          <div id="story-rail-eps" class="story-rail-list">
            ${eps.length ? eps.map(ep => `
              <div class="story-rail-item ${e && e.id === ep.id ? 'story-rail-active' : ''}" data-s="ep:select:${ep.id}">
                <span>${typeof esc === "function" ? esc(ep.name) : ep.name}</span>
              </div>
            `).join("") : `<div class="story-rail-item story-rail-active"><span>${e && e.name ? (typeof esc === "function" ? esc(e.name) : e.name) : "Current Episode"}</span></div>`}
          </div>
        </div>

        <div class="story-rail-sec">
          <div class="story-rail-header">
            <span>Outline</span>
          </div>
          <div id="story-rail-outline" class="story-rail-list">
            <div style="font-size:11.5px;color:var(--muted,#93a39a);padding:6px 4px;line-height:1.4;">
              Beat sheet and scenes will appear here as outline blocks are created.
            </div>
          </div>
        </div>
      </aside>

      <!-- Center Main Workspace -->
      <main id="story-main">
        <!-- Tab 1: Bible -->
        <section id="story-view-bible" class="story-view" ${STORY.tab === 'bible' ? '' : 'hidden'}>
          <div class="story-empty-state">
            <div class="story-empty-title">Series Bible</div>
            <div class="story-empty-desc">
              Manage characters, locations, props, ref banks, and production rules across all episodes.
            </div>
            <button class="story-btn-gold" data-s="tab:bible">Open Bible Inspector</button>
          </div>
        </section>

        <!-- Tab 2: Script -->
        <section id="story-view-script" class="story-view" ${STORY.tab === 'script' ? '' : 'hidden'}>
          <div class="story-empty-state">
            <div class="story-empty-title">Script Writer</div>
            <div class="story-empty-desc">
              Screenplay block editor (Scene, Action, Character, Dialogue, Parenthetical, Transition) with real-time duration estimation.
            </div>
            <button class="story-btn-gold" data-s="tab:script">Open Script Editor</button>
          </div>
        </section>

        <!-- Tab 3: Shotlist -->
        <section id="story-view-shotlist" class="story-view" ${STORY.tab === 'shotlist' ? '' : 'hidden'}>
          <div class="story-empty-state">
            <div class="story-empty-title">Shotlist Editor</div>
            <div class="story-empty-desc">
              Shot breakdown from screenplay lines, 40/40/20 REF/I2V/MINI type ratio balance, duration controls, and Gate A rule verification.
            </div>
            <button class="story-btn-gold" data-s="tab:shotlist">Open Shotlist</button>
          </div>
        </section>

        <!-- Tab 4: Prompts -->
        <section id="story-view-prompts" class="story-view" ${STORY.tab === 'prompts' ? '' : 'hidden'}>
          <div class="story-empty-state">
            <div class="story-empty-title">Prompt Writer</div>
            <div class="story-empty-desc">
              Storyboard image keyframes and 6-block video prompts with variable interpolation, continuity locks, and safety linting.
            </div>
            <button class="story-btn-gold" data-s="tab:prompts">Open Prompt Writer</button>
          </div>
        </section>

        <!-- Tab 5: Board -->
        <section id="story-view-board" class="story-view" ${STORY.tab === 'board' ? '' : 'hidden'}>
          <div class="story-empty-state">
            <div class="story-empty-title">Production Board</div>
            <div class="story-empty-desc">
              Kanban view tracking shot progress from Draft, Ready, Storyboard, and Video Generation to Timeline Edit.
            </div>
            <button class="story-btn-gold" data-s="tab:board">Open Production Board</button>
          </div>
        </section>
      </main>

      <!-- Right Panel Resizer -->
      <div id="story-drag-right" title="Drag to resize panel"></div>

      <!-- Right Panel -->
      <aside id="story-right" style="width:${STORY.rightWidth}px; flex:0 0 ${STORY.rightWidth}px;">
        <div class="story-right-tabs">
          <button class="story-right-tab ${STORY.rightTab === 'inspector' ? 'story-right-tab-active' : ''}" data-s="rtab:inspector">Inspector</button>
          <button class="story-right-tab ${STORY.rightTab === 'ai' ? 'story-right-tab-active' : ''}" data-s="rtab:ai">AI Assistant</button>
          <button class="story-right-tab ${STORY.rightTab === 'issues' ? 'story-right-tab-active' : ''}" data-s="rtab:issues">
            Issues <span class="story-badge-count" id="story-issues-count">0</span>
          </button>
        </div>

        <div class="story-right-body">
          <!-- Inspector Panel -->
          <div id="story-panel-inspector" class="story-panel-view" ${STORY.rightTab === 'inspector' ? '' : 'hidden'}>
            <div class="story-empty-state" style="padding:24px 8px;">
              <div class="story-empty-title" style="font-size:13.5px;">Inspector</div>
              <div class="story-empty-desc">
                Select a shot, character, location, or script block to view and edit properties.
              </div>
            </div>
          </div>

          <!-- AI Assistant Panel -->
          <div id="story-panel-ai" class="story-panel-view" ${STORY.rightTab === 'ai' ? '' : 'hidden'} style="height:100%;">
            <div class="story-ai-chat">
              <div class="story-ai-prompts">
                <button class="story-ai-chip" data-s="ai:chip:Write outline for this episode">Write outline</button>
                <button class="story-ai-chip" data-s="ai:chip:Write script from outline">Script from outline</button>
                <button class="story-ai-chip" data-s="ai:chip:Generate shotlist from script">Shotlist from script</button>
                <button class="story-ai-chip" data-s="ai:chip:Fix Gate A issues">Fix Gate A</button>
                <button class="story-ai-chip" data-s="ai:chip:Generate prompts for missing shots">Prompts</button>
                <button class="story-ai-chip" data-s="ai:chip:Tighten script to target duration">Tighten to 90s</button>
              </div>

              <div id="story-ai-msgs" class="story-ai-msgs">
                <div class="story-ai-msg ai">
                  Story Studio Assistant ready. You can ask for outline creation, script generation, shot splitting, or continuity checks.
                </div>
              </div>

              <div class="story-ai-input-sec">
                <textarea id="story-ai-input" rows="3" placeholder="Instruction or request (Ctrl+Enter to send)..."></textarea>
                <div class="story-ai-toolbar">
                  <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted,#93a39a);cursor:pointer;">
                    <input type="checkbox" id="story-ai-auto-apply" checked> Auto-apply
                  </label>
                  <button class="story-btn-gold" data-s="ai:send">Send</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Issues Panel (Gate A) -->
          <div id="story-panel-issues" class="story-panel-view" ${STORY.rightTab === 'issues' ? '' : 'hidden'}>
            <div id="story-issues-list" style="display:flex;flex-direction:column;gap:8px;">
              <div class="story-empty-state" style="padding:24px 8px;">
                <div class="story-empty-title" style="font-size:13.5px;">Gate A Clear</div>
                <div class="story-empty-desc">
                  No issues found. Shot durations, REF banks, character dialogues, and type ratios satisfy production rules.
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- Status Bar -->
    <footer id="story-bar">
      <div class="story-bar-left" id="story-bar-stats">
        0 shots · 0.0 s / 90 s target · REF 0 · I2V 0 · MINI 0 · 0 batches · est. $0.00
      </div>
      <div class="story-bar-right">
        <span class="story-save-dot" id="story-save-dot"></span>
        <span id="story-save-status">Saved</span>
      </div>
    </footer>
  `;

  setupDragResizer();
  updateStatusBar();
}

function updateStatusBar(status) {
  const dot = document.getElementById("story-save-dot");
  const text = document.getElementById("story-save-status");
  const stats = document.getElementById("story-bar-stats");
  const hdrCost = document.getElementById("story-hdr-cost");

  if (dot && text) {
    if (status === "saving" || STORY.saving) {
      dot.className = "story-save-dot saving";
      text.textContent = "Saving...";
    } else if (status === "error" || STORY.saveError) {
      dot.className = "story-save-dot unsaved";
      text.textContent = "Unsaved error";
    } else {
      dot.className = "story-save-dot";
      text.textContent = "Saved";
    }
  }

  const ep = STORY.ep;
  const shots = (ep && Array.isArray(ep.shots)) ? ep.shots : [];
  const target = (ep && ep.target) ? ep.target : 90;
  const dur = shots.reduce((acc, s) => acc + (Number(s.dur) || 0), 0);
  const refCount = shots.filter(s => s.type === "REF").length;
  const i2vCount = shots.filter(s => s.type === "I2V").length;
  const miniCount = shots.filter(s => s.type === "MINI").length;
  const batches = (ep && Array.isArray(ep.batches)) ? ep.batches.length : 0;
  const estVal = (shots.length * 0.16 * 6).toFixed(2); // Seedance baseline estimate

  if (stats) {
    stats.textContent = `${shots.length} shots · ${dur.toFixed(1)} s / ${target} s target · REF ${refCount} · I2V ${i2vCount} · MINI ${miniCount} · ${batches} batches · est. $${estVal}`;
  }
  if (hdrCost) {
    hdrCost.textContent = `$${estVal}`;
  }
}

STORY.updateStatusBar = updateStatusBar;

STORY.renderAll = function() {
  if (!STORY.open) return;
  renderStoryShell();
  renderCurrentView();
};

// ---------- Module registry glue (Claude, 26/10) ----------
function renderCurrentView() {
  const ids = { bible: "story-view-bible", script: "story-view-script", shotlist: "story-view-shotlist", prompts: "story-view-prompts", board: "story-view-board" };
  const el = document.getElementById(ids[STORY.tab]);
  const V = STORY.views[STORY.tab];
  if (el && V && typeof V.render === "function") {
    try { V.render(el); } catch (err) { console.error(err); if (typeof toast === "function") toast("Story Studio: " + err.message, 1); }
  }
  renderInspector();
}
function renderInspector() {
  const el = document.getElementById("story-panel-inspector");
  const sel = STORY.selItem;
  const I = sel && STORY.inspector[sel.kind];
  if (el && I && typeof I.render === "function") {
    try { I.render(el, sel); } catch (err) { console.error(err); }
  }
}
STORY.renderView = renderCurrentView;
STORY.renderInspector = renderInspector;
STORY.select = function(kind, id) { STORY.selItem = kind ? { kind, id } : null; renderInspector(); };

// ---------- Tab Switchers ----------
function setMainTab(tab) {
  if (!["bible", "script", "shotlist", "prompts", "board"].includes(tab)) return;
  STORY.tab = tab;
  saveUIPrefs();

  // Update tabs
  document.querySelectorAll(".story-nav-tab").forEach(btn => {
    btn.classList.toggle("story-tab-active", btn.dataset.s === `tab:${tab}`);
  });

  // Update views
  const viewMap = {
    bible: "story-view-bible",
    script: "story-view-script",
    shotlist: "story-view-shotlist",
    prompts: "story-view-prompts",
    board: "story-view-board"
  };

  Object.entries(viewMap).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.hidden = (k !== tab);
  });
  renderCurrentView();
}

function setRightTab(tab) {
  if (!["inspector", "ai", "issues"].includes(tab)) return;
  STORY.rightTab = tab;
  saveUIPrefs();

  document.querySelectorAll(".story-right-tab").forEach(btn => {
    btn.classList.toggle("story-right-tab-active", btn.dataset.s === `rtab:${tab}`);
  });

  const panelMap = {
    inspector: "story-panel-inspector",
    ai: "story-panel-ai",
    issues: "story-panel-issues"
  };

  Object.entries(panelMap).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.hidden = (k !== tab);
  });
}

function toggleAiPanel() {
  if (STORY.rightTab === "ai") {
    setRightTab("inspector");
  } else {
    setRightTab("ai");
    setTimeout(() => {
      const input = document.getElementById("story-ai-input");
      if (input) input.focus();
    }, 50);
  }
}

// ---------- Right Panel Resizer ----------
function setupDragResizer() {
  const handle = document.getElementById("story-drag-right");
  const panel = document.getElementById("story-right");
  if (!handle || !panel) return;

  handle.onmousedown = (e) => {
    e.preventDefault();
    handle.classList.add("story-dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const startX = e.clientX;
    const startW = panel.offsetWidth;

    const onMouseMove = (ev) => {
      const delta = startX - ev.clientX;
      const maxW = Math.max(300, window.innerWidth - 350);
      const newW = Math.max(240, Math.min(startW + delta, maxW));
      panel.style.width = newW + "px";
      panel.style.flex = `0 0 ${newW}px`;
      STORY.rightWidth = newW;
    };

    const onMouseUp = () => {
      handle.classList.remove("story-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      saveUIPrefs();
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
}

// ---------- Click Delegation (data-s="cmd:arg") ----------
function handleStoryClick(e) {
  const trigger = e.target.closest("[data-s]");
  if (!trigger) return;

  const raw = trigger.dataset.s;
  const parts = raw.split(":");
  const cmd = parts[0];
  const arg = parts.slice(1).join(":");

  switch (cmd) {
    case "tab":
      setMainTab(arg);
      break;

    case "rtab":
      setRightTab(arg);
      break;

    case "toggle":
      if (arg === "ai") {
        toggleAiPanel();
      } else if (arg === "rail") {
        STORY.railCollapsed = !STORY.railCollapsed;
        const rail = document.getElementById("story-rail");
        if (rail) rail.classList.toggle("story-rail-collapsed", STORY.railCollapsed);
        saveUIPrefs();
      }
      break;

    case "app":
      if (arg === "close") {
        storyClose();
      } else if (arg === "save") {
        STORY.saveNow();
      } else if (arg === "undo") {
        STORY.undo();
      } else if (arg === "redo") {
        STORY.redo();
      }
      break;

    case "ep":
      if (arg === "change") {
        const select = document.getElementById("story-ep-select");
        if (select && select.value) {
          selectEpisode(select.value);
        }
      } else if (arg.startsWith("select:")) {
        const epId = arg.replace("select:", "");
        selectEpisode(epId);
      }
      break;

    case "ai":
      if (arg.startsWith("chip:")) {
        const promptText = arg.replace("chip:", "");
        const input = document.getElementById("story-ai-input");
        if (input) {
          input.value = promptText;
          input.focus();
        }
      } else if (arg === "send") {
        handleAiSend();
      }
      break;

    case "export":
      if (typeof toast === "function") {
        toast("Export options will be available in the next task.");
      }
      break;

    default:
      if (STORY.cmds[cmd]) {
        try { STORY.cmds[cmd](arg, trigger, e); } catch (err) { console.error(err); if (typeof toast === "function") toast("Story Studio: " + err.message, 1); }
      }
      break;
  }
}

async function selectEpisode(epId) {
  if (!epId) return;
  await STORY.saveNow();
  if (typeof openEpisode === "function") {
    await openEpisode(epId);
  }
  await STORY.loadDesk();
  (STORY.hooks.afterLoad || []).forEach(f => { try { f(); } catch (err) { console.error(err); } });
  renderCurrentView();
}

function handleAiSend() {
  const input = document.getElementById("story-ai-input");
  const msgs = document.getElementById("story-ai-msgs");
  if (!input || !msgs) return;

  const text = (input.value || "").trim();
  if (!text) return;

  const userMsg = document.createElement("div");
  userMsg.className = "story-ai-msg user";
  userMsg.textContent = text;
  msgs.appendChild(userMsg);

  input.value = "";

  const replyMsg = document.createElement("div");
  replyMsg.className = "story-ai-msg ai";
  replyMsg.textContent = "AI Assistant will process this instruction when connected in Step 6 (ss8_ai.js).";
  msgs.appendChild(replyMsg);

  msgs.scrollTop = msgs.scrollHeight;
}

// ---------- Keyboard Shortcuts (Spec Section 6) ----------
function handleKeyDown(e) {
  if (!STORY.open) return;

  const target = e.target;
  const isTyping = target && (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );

  // When user is typing inside an input/textarea
  if (isTyping) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      STORY.saveNow();
      if (typeof toast === "function") toast("Saved");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      target.blur();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && target.id === "story-ai-input") {
      e.preventDefault();
      e.stopPropagation();
      handleAiSend();
      return;
    }
    return; // allow normal typing
  }

  // When NOT typing
  let handled = false;

  if (e.key === "Escape") {
    handled = true;
    // 1. Close any open menus or deselect items
    if (STORY.selItem) {
      STORY.selItem = null;
      if (typeof STORY.renderAll === "function") STORY.renderAll();
    } else {
      storyClose();
    }
  } else if (!e.ctrlKey && !e.altKey && !e.metaKey && ["1", "2", "3", "4", "5"].includes(e.key)) {
    handled = true;
    const tabMap = { "1": "bible", "2": "script", "3": "shotlist", "4": "prompts", "5": "board" };
    setMainTab(tabMap[e.key]);
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
    handled = true;
    STORY.saveNow();
    if (typeof toast === "function") toast("Saved");
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    handled = true;
    STORY.undo();
  } else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
             ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")) {
    handled = true;
    STORY.redo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
    handled = true;
    toggleAiPanel();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    handled = true;
    const search = document.querySelector("#story input[type='search']");
    if (search) search.focus();
  } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    handled = true;
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    handled = true;
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    handled = true;
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
    handled = true;
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (STORY.selItem) {
      handled = true;
    }
  }

  if (handled) {
    e.stopPropagation();
    e.preventDefault();
  }
}

// ---------- Lifecycle: Open, Close, Toggle ----------
async function storyOpen(targetTab) {
  // Mutual close with Image Studio and Video Editor
  if (window.ISTU && window.ISTU.open && typeof istuClose === "function") {
    try { istuClose(); } catch (e) {}
  }
  if (window.VEDIT && window.VEDIT.open && typeof veClose === "function") {
    try { veClose(); } catch (e) {}
  }

  loadUIPrefs();
  if (targetTab && ["bible", "script", "shotlist", "prompts", "board"].includes(targetTab)) {
    STORY.tab = targetTab;
  }

  const root = getStoryRoot();
  renderStoryShell();

  root.hidden = false;
  document.body.classList.add("story-open");
  STORY.open = true;

  // Load document data from Desk store
  await STORY.loadDesk();

  // Attach click listener on root
  root.removeEventListener("click", handleStoryClick);
  root.addEventListener("click", handleStoryClick);

  // Attach change listener for episode select dropdown
  const epSelect = document.getElementById("story-ep-select");
  if (epSelect) {
    epSelect.onchange = () => {
      selectEpisode(epSelect.value);
    };
  }
}

async function storyClose() {
  if (!STORY.open) return;

  await STORY.saveNow();

  const root = getStoryRoot();
  root.hidden = true;
  document.body.classList.remove("story-open");
  STORY.open = false;
}

function storyToggle(targetTab) {
  if (STORY.open) {
    storyClose();
  } else {
    storyOpen(targetTab);
  }
}

// Export to window
window.storyOpen = storyOpen;
window.storyClose = storyClose;
window.storyToggle = storyToggle;

// Register capture-phase keyboard shortcuts
window.removeEventListener("keydown", handleKeyDown, true);
window.addEventListener("keydown", handleKeyDown, true);

// Register beforeunload save
window.addEventListener("beforeunload", () => {
  if (STORY.open) {
    STORY.saveNow();
  }
});
