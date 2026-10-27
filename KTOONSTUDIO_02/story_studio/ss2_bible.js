// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with auth headers)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL and thumbnail resolvers)
// - CUR : { ep, series } (Current series and episode context)
// - PJ : { groups, series, episodes } (Project tree)
// - window.ISTU : { open, prefillPrompt, I } (Image Studio instance)
// - istuClose() : void (Closes Image Studio)
// - istuOpen() : void (Opens Image Studio)
// - libPut(id, doc), libNewId(), libUnique() : Library helpers for coll 'ktoonlib'
//
// Server changes needed:
// - None for Task 002. Utilizes existing endpoints:
//   - GET /api/desk/all
//   - POST /api/desk/put
//   - POST /api/desk/batch
//   - POST /api/upload
//
// App changes needed:
// - When "Make in Image Studio" is triggered, `window.ISTU.prefillPrompt` is populated with
//   the 21:9 concept sheet prompt. If Image Studio does not yet check `window.ISTU.prefillPrompt`
//   on initialization, Claude can add a 1-line check in Image Studio:
//   `if (window.ISTU && window.ISTU.prefillPrompt) { setPromptInput(window.ISTU.prefillPrompt); window.ISTU.prefillPrompt = null; }`
//
// Known limitations:
// - Connected to LLM roles via STORY.ai in TASK 006 (ss8_ai.js). "Extract bible from script"
//   opens an interactive checklist modal allowing users to inspect and selectively import
//   characters, locations, and props.

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

  function _src(ref) {
    if (typeof src === "function") return src(ref);
    return ref || "";
  }

  function _tsrc(ref) {
    if (typeof tsrc === "function") return tsrc(ref);
    if (typeof src === "function") return src(ref);
    return ref || "";
  }

  function _uid(prefix = "") {
    if (STORY && typeof STORY.uid === "function") return STORY.uid(prefix);
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  function escapeRegExp(string) {
    return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---------- Schema Normalizer ----------
  function ensureBibleSchema(b) {
    if (!b) return;
    if (!b.format) b.format = {};
    b.format.aspect = b.format.aspect || "9:16";
    b.format.epDur = b.format.epDur || 90;
    b.format.lang = b.format.lang || "en";
    b.format.shotMin = b.format.shotMin || 4;
    b.format.shotMax = b.format.shotMax || 15;
    b.format.batchMax = b.format.batchMax || 30;
    if (!b.format.mix) b.format.mix = { REF: 40, I2V: 40, MINI: 20 };

    if (!b.style) b.style = {};
    b.style.look = b.style.look || "photoreal cinematic, AI actors";
    b.style.camera = b.style.camera || "handheld subtle";
    b.style.grade = b.style.grade || "teal-orange low contrast";
    b.style.negative = b.style.negative || "text, watermark, extra fingers";
    if (!Array.isArray(b.style.videoRefs)) b.style.videoRefs = [];
    if (!Array.isArray(b.style.refs)) b.style.refs = [];

    if (!Array.isArray(b.rules)) {
      b.rules = [
        "Faces only from AI-generated images",
        "Sensual content non-explicit, adults only"
      ];
    }
    if (!Array.isArray(b.chars)) b.chars = [];
    if (!Array.isArray(b.locs)) b.locs = [];
    if (!Array.isArray(b.props)) b.props = [];
    if (!Array.isArray(b.banks)) b.banks = [];
  }

  // ---------- Internal Bible View State ----------
  const BIBLE_STATE = {
    subview: "entities", // 'entities' | 'style' | 'rules' | 'banks'
    searchChar: "",
    searchLoc: "",
    searchProp: "",
    picker: {
      open: false,
      tab: "library", // 'library' | 'istu' | 'upload'
      targetKind: null, // 'char' | 'loc' | 'prop' | 'style' | 'bank'
      targetId: null,
      targetSlot: null,
      libraryItems: [],
      istuItems: [],
      loading: false
    }
  };

  // Switch right panel to Inspector tab
  function activateInspectorTab() {
    if (STORY.rightTab !== "inspector") {
      STORY.rightTab = "inspector";
      document.querySelectorAll(".story-right-tab").forEach(btn => {
        btn.classList.toggle("story-right-tab-active", btn.dataset.s === "rtab:inspector");
      });
      const inspEl = document.getElementById("story-panel-inspector");
      const aiEl = document.getElementById("story-panel-ai");
      const issuesEl = document.getElementById("story-panel-issues");
      if (inspEl) inspEl.hidden = false;
      if (aiEl) aiEl.hidden = true;
      if (issuesEl) issuesEl.hidden = true;
    }
  }

  // ---------- Render Main Bible View ----------
  function renderBibleView(container) {
    if (!container) return;
    const bible = STORY.bible;
    if (!bible) {
      container.innerHTML = `
        <div class="story-empty-state">
          <div class="story-empty-title">No Series Bible Loaded</div>
          <div class="story-empty-desc">Create or load a series bible to configure characters, locations, art styles, and reference banks.</div>
        </div>
      `;
      return;
    }

    ensureBibleSchema(bible);

    container.innerHTML = `
      <div class="bible-wrap">
        <!-- Top Toolbar with Subnav & Actions -->
        <div class="bible-topbar">
          <div class="bible-subnav">
            <button class="bible-subnav-btn ${BIBLE_STATE.subview === 'entities' ? 'active' : ''}" data-s="bible.subview:entities">Entities</button>
            <button class="bible-subnav-btn ${BIBLE_STATE.subview === 'style' ? 'active' : ''}" data-s="bible.subview:style">Art Style & Video</button>
            <button class="bible-subnav-btn ${BIBLE_STATE.subview === 'rules' ? 'active' : ''}" data-s="bible.subview:rules">Format & Rules</button>
            <button class="bible-subnav-btn ${BIBLE_STATE.subview === 'banks' ? 'active' : ''}" data-s="bible.subview:banks">Ref Banks</button>
          </div>
          <div class="bible-topbar-actions">
            <button class="story-btn-ghost" data-s="bible.extractFromScript" title="Extract characters, locations, and props from script with AI">Extract bible from script · ~$0.03</button>
            <button class="story-btn-ghost" data-s="bible.autoBanks" title="Auto-build Reference Banks from character images">Auto-build Banks</button>
            <button class="story-btn-gold" data-s="bible.addEntityPrompt">+ Add Entity</button>
          </div>
        </div>

        <!-- Dynamic Subview Container -->
        <div class="bible-content" id="bible-subview-container">
          ${renderSubviewContent(bible)}
        </div>
      </div>

      <!-- Ref Image Picker Overlay Modal -->
      <div id="bible-picker-modal" class="bible-picker-overlay" ${BIBLE_STATE.picker.open ? '' : 'hidden'}>
        ${renderPickerModalContent()}
      </div>
    `;

    attachBibleInputListeners(container);
  }

  function renderSubviewContent(bible) {
    switch (BIBLE_STATE.subview) {
      case "style":
        return renderArtStyleView(bible);
      case "rules":
        return renderFormatRulesView(bible);
      case "banks":
        return renderRefBanksView(bible);
      case "entities":
      default:
        return renderEntitiesView(bible);
    }
  }

  // ---------- Subview 1: Entities (3 Columns) ----------
  function renderEntitiesView(bible) {
    const chars = bible.chars || [];
    const locs = bible.locs || [];
    const props = bible.props || [];

    const charQuery = (BIBLE_STATE.searchChar || "").toLowerCase();
    const locQuery = (BIBLE_STATE.searchLoc || "").toLowerCase();
    const propQuery = (BIBLE_STATE.searchProp || "").toLowerCase();

    const filteredChars = chars.filter(c => !charQuery || (c.name && c.name.toLowerCase().includes(charQuery)) || (c.look && c.look.toLowerCase().includes(charQuery)));
    const filteredLocs = locs.filter(l => !locQuery || (l.name && l.name.toLowerCase().includes(locQuery)) || (l.desc && l.desc.toLowerCase().includes(locQuery)));
    const filteredProps = props.filter(p => !propQuery || (p.name && p.name.toLowerCase().includes(propQuery)) || (p.desc && p.desc.toLowerCase().includes(propQuery)));

    const sel = STORY.selItem;

    return `
      <div class="bible-cols-view">
        <!-- Col 1: Characters -->
        <div class="bible-col">
          <div class="bible-col-header">
            <div class="bible-col-title">
              Characters <span class="bible-count-pill">${chars.length}</span>
            </div>
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="bible.addChar">+ Add</button>
          </div>
          <div class="bible-col-search">
            <input type="text" placeholder="Filter characters..." value="${_esc(BIBLE_STATE.searchChar)}" data-b-search="char">
          </div>
          <div class="bible-card-list">
            ${filteredChars.length ? filteredChars.map(c => {
              const isSelected = sel && sel.kind === "char" && sel.id === c.id;
              const firstRef = c.refs && c.refs.length > 0 ? c.refs[0].ref : null;
              return `
                <div class="bible-card ${isSelected ? 'selected' : ''}" data-s="bible.selectChar:${c.id}">
                  ${firstRef ? `<img class="bible-card-thumb" src="${_tsrc(firstRef)}" alt="${_esc(c.name)}">`
                             : `<div class="bible-card-thumb-placeholder">${_esc((c.name || 'C').substring(0, 2))}</div>`}
                  <div class="bible-card-body">
                    <div class="bible-card-head">
                      <span class="bible-card-name">${_esc(c.name || 'Unnamed')}</span>
                      <span class="bible-tag-role">${_esc(c.role || 'lead')}</span>
                    </div>
                    <div class="bible-card-desc">${_esc(c.look || 'No appearance description.')}</div>
                    <div class="bible-card-meta">
                      <span class="bible-card-meta-pill">${(c.refs || []).length} refs</span>
                      <span class="bible-card-meta-pill">${(c.wardrobe || []).length} wardrobe</span>
                      ${c.voice ? `<span class="bible-card-meta-pill">${_esc(c.voice)}</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join("") : `<div class="story-empty-desc" style="padding:20px;text-align:center;">No characters yet. Click + Add to create one.</div>`}
          </div>
        </div>

        <!-- Col 2: Locations -->
        <div class="bible-col">
          <div class="bible-col-header">
            <div class="bible-col-title">
              Locations <span class="bible-count-pill">${locs.length}</span>
            </div>
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="bible.addLoc">+ Add</button>
          </div>
          <div class="bible-col-search">
            <input type="text" placeholder="Filter locations..." value="${_esc(BIBLE_STATE.searchLoc)}" data-b-search="loc">
          </div>
          <div class="bible-card-list">
            ${filteredLocs.length ? filteredLocs.map(l => {
              const isSelected = sel && sel.kind === "loc" && sel.id === l.id;
              const firstRef = l.refs && l.refs.length > 0 ? l.refs[0].ref : null;
              return `
                <div class="bible-card ${isSelected ? 'selected' : ''}" data-s="bible.selectLoc:${l.id}">
                  ${firstRef ? `<img class="bible-card-thumb" src="${_tsrc(firstRef)}" alt="${_esc(l.name)}">`
                             : `<div class="bible-card-thumb-placeholder">${_esc((l.name || 'L').substring(0, 2))}</div>`}
                  <div class="bible-card-body">
                    <div class="bible-card-head">
                      <span class="bible-card-name">${_esc(l.name || 'Unnamed')}</span>
                      <span class="bible-tag-role" style="color:#e6b86a;border-color:#5c4723;background:#261d0f;">${_esc(l.time || 'all')}</span>
                    </div>
                    <div class="bible-card-desc">${_esc(l.desc || 'No description.')}</div>
                    <div class="bible-card-meta">
                      <span class="bible-card-meta-pill">${(l.refs || []).length} refs</span>
                      ${l.geography ? `<span class="bible-card-meta-pill">Raccord set</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join("") : `<div class="story-empty-desc" style="padding:20px;text-align:center;">No locations yet. Click + Add to create one.</div>`}
          </div>
        </div>

        <!-- Col 3: Props -->
        <div class="bible-col">
          <div class="bible-col-header">
            <div class="bible-col-title">
              Props <span class="bible-count-pill">${props.length}</span>
            </div>
            <button class="story-btn-ghost" style="padding:2px 8px;font-size:11px;" data-s="bible.addProp">+ Add</button>
          </div>
          <div class="bible-col-search">
            <input type="text" placeholder="Filter props..." value="${_esc(BIBLE_STATE.searchProp)}" data-b-search="prop">
          </div>
          <div class="bible-card-list">
            ${filteredProps.length ? filteredProps.map(p => {
              const isSelected = sel && sel.kind === "prop" && sel.id === p.id;
              const firstRef = p.refs && p.refs.length > 0 ? p.refs[0].ref : null;
              return `
                <div class="bible-card ${isSelected ? 'selected' : ''}" data-s="bible.selectProp:${p.id}">
                  ${firstRef ? `<img class="bible-card-thumb" src="${_tsrc(firstRef)}" alt="${_esc(p.name)}">`
                             : `<div class="bible-card-thumb-placeholder">${_esc((p.name || 'P').substring(0, 2))}</div>`}
                  <div class="bible-card-body">
                    <div class="bible-card-head">
                      <span class="bible-card-name">${_esc(p.name || 'Unnamed')}</span>
                    </div>
                    <div class="bible-card-desc">${_esc(p.desc || 'No description.')}</div>
                    <div class="bible-card-meta">
                      <span class="bible-card-meta-pill">${(p.refs || []).length} refs</span>
                    </div>
                  </div>
                </div>
              `;
            }).join("") : `<div class="story-empty-desc" style="padding:20px;text-align:center;">No props yet. Click + Add to create one.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Subview 2: Art Style & Video References ----------
  function renderArtStyleView(bible) {
    const s = bible.style || {};
    const vrefs = s.videoRefs || [];
    const srefs = s.refs || [];

    return `
      <div class="bible-scroll-view">
        <div class="bible-sec">
          <div class="bible-sec-title">
            <span>Series Art Style Block</span>
            <span class="bible-note">Role: style only (never copy character identity)</span>
          </div>
          <div class="bible-sec-desc">
            Defines the visual world, lighting physics, camera personality, and color science applied across storyboard and video generations.
            <b>Critical relighting rule:</b> Characters must always be relit by the scene's ambient and directional lighting.
          </div>

          <div class="bible-form-grid">
            <div class="bible-form-row full">
              <label class="bible-label">Visual Look / Master Prompt Modifier</label>
              <textarea rows="3" data-b-path="style.look" placeholder="e.g. photoreal cinematic, 35mm film grain, AI actors, dramatic rim lighting...">${_esc(s.look || '')}</textarea>
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Camera Style</label>
              <input type="text" data-b-path="style.camera" placeholder="e.g. handheld subtle, prime lenses, 50mm portraiture" value="${_esc(s.camera || '')}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Color Grading</label>
              <input type="text" data-b-path="style.grade" placeholder="e.g. teal-orange low contrast, cinematic shadow rolloff" value="${_esc(s.grade || '')}">
            </div>

            <div class="bible-form-row full">
              <label class="bible-label">Global Style Negative Prompt</label>
              <textarea rows="2" data-b-path="style.negative" placeholder="e.g. text, watermark, extra limbs, cartoon, 3D render...">${_esc(s.negative || '')}</textarea>
            </div>
          </div>

          <div style="margin-top:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <label class="bible-label">Style Reference Images (${srefs.length})</label>
              <button class="story-btn-ghost" data-s="bible.openPicker:style:master">+ Add Style Image</button>
            </div>
            <div class="bible-ref-grid" style="grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));">
              ${srefs.map((r, idx) => `
                <div class="bible-ref-item">
                  <img class="bible-ref-thumb" src="${_tsrc(r.ref)}" alt="Style Ref">
                  <div class="bible-ref-item-info">${_esc(r.label || 'Style Ref')}</div>
                  <div class="bible-ref-item-actions">
                    <button class="story-btn-ghost" data-s="bible.saveToLib:${r.ref}:Style Ref">Save Lib</button>
                    <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteRefImage:style:master:${idx}">Remove</button>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        </div>

        <div class="bible-sec">
          <div class="bible-sec-title">
            <span>Video References (@video1… motion only)</span>
            <button class="story-btn-ghost" data-s="bible.addVideoRef">+ Add Video Ref</button>
          </div>
          <div class="bible-sec-desc">
            Directly referenced in video prompts as motion, camera pacing, or animation style references. <b>Rules:</b> @video1 is animation/style only; characters in video refs are never reproduced.
          </div>

          <table class="bible-vref-table">
            <thead>
              <tr>
                <th style="width:90px;">Tag</th>
                <th style="width:180px;">Title</th>
                <th>Role Description</th>
                <th>Reference Ref / Path</th>
                <th style="width:60px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${vrefs.length ? vrefs.map((vr, idx) => `
                <tr>
                  <td><input type="text" value="${_esc(vr.tag || '@video1')}" data-b-vref="${idx}" data-b-field="tag"></td>
                  <td><input type="text" value="${_esc(vr.title || '')}" placeholder="Title" data-b-vref="${idx}" data-b-field="title"></td>
                  <td><input type="text" value="${_esc(vr.role || 'ANIMATION STYLE / MOTION ONLY')}" data-b-vref="${idx}" data-b-field="role"></td>
                  <td><input type="text" value="${_esc(vr.ref || '')}" placeholder="media/video.mp4" data-b-vref="${idx}" data-b-field="ref"></td>
                  <td><button class="story-btn-ghost" style="color:var(--err,#ff6b6b);padding:2px 6px;" data-s="bible.deleteVideoRef:${idx}">Delete</button></td>
                </tr>
              `).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--muted,#93a39a);padding:14px;">No video references configured. Click + Add Video Ref.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------- Subview 3: Format & Rules Editor ----------
  function renderFormatRulesView(bible) {
    const f = bible.format || {};
    const mix = f.mix || { REF: 40, I2V: 40, MINI: 20 };
    const mixSum = (Number(mix.REF) || 0) + (Number(mix.I2V) || 0) + (Number(mix.MINI) || 0);
    const rules = bible.rules || [];

    return `
      <div class="bible-scroll-view">
        <div class="bible-sec">
          <div class="bible-sec-title">Production Format & Parameters</div>
          <div class="bible-form-grid">
            <div class="bible-form-row">
              <label class="bible-label">Series Name</label>
              <input type="text" data-b-path="name" value="${_esc(bible.name || '')}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Aspect Ratio</label>
              <select data-b-path="format.aspect">
                <option value="9:16" ${f.aspect === '9:16' ? 'selected' : ''}>9:16 (Vertical / Mobile)</option>
                <option value="16:9" ${f.aspect === '16:9' ? 'selected' : ''}>16:9 (Horizontal / Cinema)</option>
              </select>
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Episode Target Duration (Seconds)</label>
              <input type="number" min="30" max="600" step="1" data-b-path="format.epDur" value="${f.epDur || 90}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Batch Max Duration (Seconds)</label>
              <input type="number" min="10" max="60" step="1" data-b-path="format.batchMax" value="${f.batchMax || 30}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Shot Min Duration (Seconds)</label>
              <input type="number" min="1" max="10" step="1" data-b-path="format.shotMin" value="${f.shotMin || 4}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Shot Max Duration (Seconds)</label>
              <input type="number" min="5" max="30" step="1" data-b-path="format.shotMax" value="${f.shotMax || 15}">
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Dialogue Language</label>
              <select data-b-path="format.lang">
                <option value="en" ${f.lang === 'en' ? 'selected' : ''}>English (US)</option>
                <option value="vi" ${f.lang === 'vi' ? 'selected' : ''}>Vietnamese</option>
              </select>
            </div>

            <div class="bible-form-row">
              <label class="bible-label">Target Audience</label>
              <input type="text" data-b-path="audience" value="${_esc(bible.audience || 'US, 18+')}">
            </div>

            <div class="bible-form-row full">
              <label class="bible-label">Logline / Premise</label>
              <textarea rows="2" data-b-path="logline" placeholder="One-sentence logline of the series...">${_esc(bible.logline || '')}</textarea>
            </div>
          </div>
        </div>

        <div class="bible-sec">
          <div class="bible-sec-title">
            <span>Shot Type Balance Mix (REF / I2V / MINI)</span>
            <span class="bible-note" style="${mixSum !== 100 ? 'color:var(--err,#ff6b6b);' : ''}">Total: ${mixSum}% (Recommended: 100%)</span>
          </div>
          <div class="bible-sec-desc">
            Target ratio for production budget and identity lock balance. REF for character consistency; I2V for dynamic keyframe-driven action; MINI for fast transitions and atmosphere.
          </div>

          <div class="bible-form-grid" style="grid-template-columns: repeat(3, 1fr);">
            <div class="bible-form-row">
              <label class="bible-label">REF Type %</label>
              <input type="number" min="0" max="100" data-b-path="format.mix.REF" value="${mix.REF || 40}">
            </div>
            <div class="bible-form-row">
              <label class="bible-label">I2V Type %</label>
              <input type="number" min="0" max="100" data-b-path="format.mix.I2V" value="${mix.I2V || 40}">
            </div>
            <div class="bible-form-row">
              <label class="bible-label">MINI Type %</label>
              <input type="number" min="0" max="100" data-b-path="format.mix.MINI" value="${mix.MINI || 20}">
            </div>
          </div>

          <div class="bible-mix-bar">
            <div class="bible-mix-seg ref" style="width:${mix.REF || 40}%;"></div>
            <div class="bible-mix-seg i2v" style="width:${mix.I2V || 40}%;"></div>
            <div class="bible-mix-seg mini" style="width:${mix.MINI || 20}%;"></div>
          </div>

          <div class="bible-mix-legend">
            <div class="bible-mix-legend-item"><span class="bible-mix-dot" style="background:#3fa37c;"></span> REF ${mix.REF || 40}% (Reference Bank Locked)</div>
            <div class="bible-mix-legend-item"><span class="bible-mix-dot" style="background:#c8a96a;"></span> I2V ${mix.I2V || 40}% (Image-to-Video Keyframe)</div>
            <div class="bible-mix-legend-item"><span class="bible-mix-dot" style="background:#7b8de6;"></span> MINI ${mix.MINI || 20}% (Fast Cut / Cutaway)</div>
          </div>
        </div>

        <div class="bible-sec">
          <div class="bible-sec-title">
            <span>Production Rules</span>
            <button class="story-btn-ghost" data-s="bible.addRule">+ Add Rule</button>
          </div>
          <div class="bible-sec-desc">
            Rules automatically enforced during Gate A shot validation and LLM script generation.
          </div>

          <div style="display:flex;flex-direction:column;gap:6px;">
            ${rules.map((r, idx) => `
              <div style="display:flex;align-items:center;gap:8px;">
                <input type="text" value="${_esc(r)}" data-b-rule="${idx}" style="flex:1;">
                <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);padding:4px 8px;" data-s="bible.deleteRule:${idx}">Delete</button>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Subview 4: Ref Banks Management ----------
  function renderRefBanksView(bible) {
    const banks = bible.banks || [];

    return `
      <div class="bible-scroll-view">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text,#e6ece8);">Reference Banks</div>
            <div class="bible-note">Max 8 images per REF bank (image1..image8). Filenames should follow image{n}_{NAME}.</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="story-btn-ghost" data-s="bible.autoBanks">Rebuild Banks from Characters</button>
            <button class="story-btn-gold" data-s="bible.addBank">+ Create Bank</button>
          </div>
        </div>

        ${banks.length ? banks.map((bank, bIdx) => {
          const items = bank.items || [];
          const char = (bible.chars || []).find(c => c.id === bank.charId);
          const safeName = (char ? char.name : (bank.name || 'CHAR')).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

          return `
            <div class="bible-bank-card">
              <div class="bible-bank-hdr">
                <div style="display:flex;align-items:center;gap:10px;">
                  <span class="bible-bank-name">${_esc(bank.name || bank.id)}</span>
                  <span class="bible-count-pill">${items.length} / 8 images</span>
                  ${char ? `<span class="bible-tag-role">${_esc(char.name)}</span>` : ''}
                </div>
                <div style="display:flex;gap:6px;">
                  <button class="story-btn-ghost" data-s="bible.openPicker:bank:${bank.id}">+ Add Image</button>
                  <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteBank:${bIdx}">Delete Bank</button>
                </div>
              </div>

              <!-- Bank Images Grid -->
              <div class="bible-bank-grid">
                ${items.map((item, iIdx) => {
                  const expectedRegex = new RegExp(`^image${item.n}_${safeName}`, 'i');
                  const filename = item.filename || (item.ref ? item.ref.split('/').pop() : '');
                  const hasWarning = filename && !expectedRegex.test(filename);

                  return `
                    <div class="bible-bank-item">
                      <img class="bible-bank-item-thumb" src="${_tsrc(item.ref)}" alt="image${item.n}">
                      <div class="bible-bank-item-label">
                        <span>image${item.n}</span>
                        ${hasWarning ? `<span style="color:#ffc97a;font-size:10px;" title="Filename '${_esc(filename)}' deviates from pattern image${item.n}_${safeName}">⚠️</span>` : ''}
                      </div>
                      <input type="text" class="bible-bank-item-role" value="${_esc(item.role || 'character = design/identity only')}" data-b-bank="${bIdx}" data-b-bitem="${iIdx}" data-b-field="role" title="Reference role">
                      <div class="bible-bank-item-actions">
                        <div>
                          <button class="story-btn-ghost" style="padding:1px 4px;font-size:9px;" data-s="bible.moveBankItem:${bIdx}:${iIdx}:up" ${iIdx === 0 ? 'disabled' : ''}>▲</button>
                          <button class="story-btn-ghost" style="padding:1px 4px;font-size:9px;" data-s="bible.moveBankItem:${bIdx}:${iIdx}:down" ${iIdx === items.length - 1 ? 'disabled' : ''}>▼</button>
                        </div>
                        <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);padding:1px 4px;font-size:9px;" data-s="bible.deleteBankItem:${bIdx}:${iIdx}">X</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }).join("") : `<div class="story-empty-desc" style="padding:40px;text-align:center;">No reference banks created. Click "Rebuild Banks from Characters" to automatically create banks.</div>`}
      </div>
    `;
  }

  // ---------- Inspector Panels (Registered in STORY.inspector) ----------
  function renderCharInspector(container, sel) {
    if (!container || !sel || !STORY.bible) return;
    const char = (STORY.bible.chars || []).find(c => c.id === sel.id);
    if (!char) {
      container.innerHTML = `<div class="story-empty-desc" style="padding:20px;">Character not found.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="bible-insp-sec">
        <div class="bible-insp-hdr">
          <span class="bible-insp-title">Character Inspector</span>
          <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteEntity:char:${char.id}">Delete</button>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Character Name</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="bible-insp-char-name" value="${_esc(char.name || '')}" data-b-entity="char" data-b-id="${char.id}" data-b-field="name">
            <button class="story-btn-ghost" data-s="bible.renameCharPrompt:${char.id}" title="Rename character across all episodes">Rename</button>
          </div>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Role</label>
          <select data-b-entity="char" data-b-id="${char.id}" data-b-field="role">
            <option value="lead" ${char.role === 'lead' ? 'selected' : ''}>Lead / Protagonist</option>
            <option value="supporting" ${char.role === 'supporting' ? 'selected' : ''}>Supporting</option>
            <option value="minor" ${char.role === 'minor' ? 'selected' : ''}>Minor</option>
            <option value="extra" ${char.role === 'extra' ? 'selected' : ''}>Extra / Background</option>
          </select>
        </div>

        <div class="bible-form-grid">
          <div class="bible-form-row">
            <label class="bible-label">Age</label>
            <input type="text" value="${_esc(char.age || '')}" placeholder="e.g. 35" data-b-entity="char" data-b-id="${char.id}" data-b-field="age">
          </div>
          <div class="bible-form-row">
            <label class="bible-label">Gender</label>
            <input type="text" value="${_esc(char.gender || '')}" placeholder="e.g. Male" data-b-entity="char" data-b-id="${char.id}" data-b-field="gender">
          </div>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Aliases (Comma-separated)</label>
          <input type="text" value="${_esc((char.aliases || []).join(', '))}" placeholder="Steve, Mr. Hale, The Boss" data-b-entity="char" data-b-id="${char.id}" data-b-field="aliases">
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Visual Appearance & Look</label>
          <textarea rows="3" placeholder="Facial features, hair, eye color, scars, build..." data-b-entity="char" data-b-id="${char.id}" data-b-field="look">${_esc(char.look || '')}</textarea>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Voice & Tone</label>
          <input type="text" value="${_esc(char.voice || '')}" placeholder="Deep, calm, slight raspy baritone" data-b-entity="char" data-b-id="${char.id}" data-b-field="voice">
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Voice Ref Asset</label>
          <input type="text" value="${_esc(char.voiceRef || '')}" placeholder="media/audio/voice_steve.wav" data-b-entity="char" data-b-id="${char.id}" data-b-field="voiceRef">
        </div>
      </div>

      <!-- Wardrobe Section -->
      <div class="bible-insp-sec">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="bible-insp-title" style="font-size:12px;">Wardrobe Outfits (${(char.wardrobe || []).length})</span>
          <button class="story-btn-ghost" data-s="bible.addWardrobe:${char.id}">+ Add</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${(char.wardrobe || []).map((w, wIdx) => `
            <div class="bible-wardrobe-item">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <input type="text" value="${_esc(w.name || '')}" placeholder="Outfit Name" data-b-wardrobe="${char.id}:${wIdx}:name">
                <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);padding:1px 5px;" data-s="bible.deleteWardrobe:${char.id}:${wIdx}">X</button>
              </div>
              <textarea rows="1" placeholder="Outfit description, fabrics, colors..." data-b-wardrobe="${char.id}:${wIdx}:desc">${_esc(w.desc || '')}</textarea>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Ref Images Section -->
      <div class="bible-insp-sec" style="border-bottom:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <span class="bible-insp-title" style="font-size:12px;">Ref Images (${(char.refs || []).length})</span>
            <div class="bible-note">Role: design/identity only (NOT lighting)</div>
          </div>
          <button class="story-btn-ghost" data-s="bible.openPicker:char:${char.id}">+ Add Ref</button>
        </div>

        <div style="margin-top:6px;">
          <button class="story-btn-gold" style="width:100%;margin-bottom:8px;" data-s="bible.makeIstu:${char.id}">Make in Image Studio</button>
        </div>

        <div class="bible-ref-grid">
          ${(char.refs || []).map((r, rIdx) => `
            <div class="bible-ref-item">
              <img class="bible-ref-thumb" src="${_tsrc(r.ref)}" alt="Ref">
              <div class="bible-ref-item-info">${_esc(r.label || 'Ref ' + (rIdx + 1))}</div>
              <div class="bible-ref-item-actions">
                <button class="story-btn-ghost" data-s="bible.saveToLib:${r.ref}:${char.name}">Save</button>
                <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteRefImage:char:${char.id}:${rIdx}">X</button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    attachBibleInputListeners(container);
  }

  function renderLocInspector(container, sel) {
    if (!container || !sel || !STORY.bible) return;
    const loc = (STORY.bible.locs || []).find(l => l.id === sel.id);
    if (!loc) {
      container.innerHTML = `<div class="story-empty-desc" style="padding:20px;">Location not found.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="bible-insp-sec">
        <div class="bible-insp-hdr">
          <span class="bible-insp-title">Location Inspector</span>
          <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteEntity:loc:${loc.id}">Delete</button>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Location Name</label>
          <input type="text" value="${_esc(loc.name || '')}" data-b-entity="loc" data-b-id="${loc.id}" data-b-field="name">
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Time of Day / Atmosphere</label>
          <select data-b-entity="loc" data-b-id="${loc.id}" data-b-field="time">
            <option value="night" ${loc.time === 'night' ? 'selected' : ''}>Night</option>
            <option value="day" ${loc.time === 'day' ? 'selected' : ''}>Day</option>
            <option value="interior moody" ${loc.time === 'interior moody' ? 'selected' : ''}>Interior Moody</option>
            <option value="dusk" ${loc.time === 'dusk' ? 'selected' : ''}>Dusk / Sunset</option>
            <option value="dawn" ${loc.time === 'dawn' ? 'selected' : ''}>Dawn / Morning</option>
          </select>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Description / Architecture</label>
          <textarea rows="3" placeholder="Architectural details, materials, lighting atmosphere..." data-b-entity="loc" data-b-id="${loc.id}" data-b-field="desc">${_esc(loc.desc || '')}</textarea>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Room Geography & Raccord Rules</label>
          <textarea rows="3" placeholder="Entrance side, door positions, desk placement, camera 180-degree axis..." data-b-entity="loc" data-b-id="${loc.id}" data-b-field="geography">${_esc(loc.geography || '')}</textarea>
          <div class="bible-note">Role: mood/architecture only. Never copy camera angle from ref images.</div>
        </div>
      </div>

      <div class="bible-insp-sec" style="border-bottom:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="bible-insp-title" style="font-size:12px;">Ref Images (${(loc.refs || []).length})</span>
          <button class="story-btn-ghost" data-s="bible.openPicker:loc:${loc.id}">+ Add Ref</button>
        </div>

        <div class="bible-ref-grid" style="margin-top:8px;">
          ${(loc.refs || []).map((r, rIdx) => `
            <div class="bible-ref-item">
              <img class="bible-ref-thumb" src="${_tsrc(r.ref)}" alt="Ref">
              <div class="bible-ref-item-info">${_esc(r.label || 'Ref ' + (rIdx + 1))}</div>
              <div class="bible-ref-item-actions">
                <button class="story-btn-ghost" data-s="bible.saveToLib:${r.ref}:${loc.name}">Save</button>
                <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteRefImage:loc:${loc.id}:${rIdx}">X</button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    attachBibleInputListeners(container);
  }

  function renderPropInspector(container, sel) {
    if (!container || !sel || !STORY.bible) return;
    const prop = (STORY.bible.props || []).find(p => p.id === sel.id);
    if (!prop) {
      container.innerHTML = `<div class="story-empty-desc" style="padding:20px;">Prop not found.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="bible-insp-sec">
        <div class="bible-insp-hdr">
          <span class="bible-insp-title">Prop Inspector</span>
          <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteEntity:prop:${prop.id}">Delete</button>
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Prop Name</label>
          <input type="text" value="${_esc(prop.name || '')}" data-b-entity="prop" data-b-id="${prop.id}" data-b-field="name">
        </div>

        <div class="bible-form-row">
          <label class="bible-label">Description / Materials</label>
          <textarea rows="3" placeholder="Materials, condition, engraving, dimensions..." data-b-entity="prop" data-b-id="${prop.id}" data-b-field="desc">${_esc(prop.desc || '')}</textarea>
          <div class="bible-note">Role: design/identity only</div>
        </div>
      </div>

      <div class="bible-insp-sec" style="border-bottom:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="bible-insp-title" style="font-size:12px;">Ref Images (${(prop.refs || []).length})</span>
          <button class="story-btn-ghost" data-s="bible.openPicker:prop:${prop.id}">+ Add Ref</button>
        </div>

        <div class="bible-ref-grid" style="margin-top:8px;">
          ${(prop.refs || []).map((r, rIdx) => `
            <div class="bible-ref-item">
              <img class="bible-ref-thumb" src="${_tsrc(r.ref)}" alt="Ref">
              <div class="bible-ref-item-info">${_esc(r.label || 'Ref ' + (rIdx + 1))}</div>
              <div class="bible-ref-item-actions">
                <button class="story-btn-ghost" data-s="bible.saveToLib:${r.ref}:${prop.name}">Save</button>
                <button class="story-btn-ghost" style="color:var(--err,#ff6b6b);" data-s="bible.deleteRefImage:prop:${prop.id}:${rIdx}">X</button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    attachBibleInputListeners(container);
  }

  // ---------- Ref Image Picker Modal ----------
  function renderPickerModalContent() {
    const p = BIBLE_STATE.picker;
    const tab = p.tab || "library";

    return `
      <div class="bible-picker-modal">
        <div class="bible-picker-head">
          <div class="bible-picker-tabs">
            <span style="font-weight:700;font-size:13px;color:var(--text,#e6ece8);margin-right:12px;">Select Reference Image</span>
            <button class="bible-subnav-btn ${tab === 'library' ? 'active' : ''}" data-s="bible.pickTab:library">Library (ktoonlib)</button>
            <button class="bible-subnav-btn ${tab === 'istu' ? 'active' : ''}" data-s="bible.pickTab:istu">Image Studio</button>
            <button class="bible-subnav-btn ${tab === 'upload' ? 'active' : ''}" data-s="bible.pickTab:upload">Upload File</button>
          </div>
          <button class="story-btn-ghost" data-s="bible.closePicker">Close</button>
        </div>

        <div class="bible-picker-body">
          ${p.loading ? `<div class="story-empty-desc" style="text-align:center;padding:40px;">Loading images...</div>` : ''}

          ${!p.loading && tab === 'library' ? `
            <div class="bible-picker-grid">
              ${p.libraryItems.length ? p.libraryItems.map(item => `
                <div class="bible-picker-item" data-s="bible.selectPickerImage:${item.ref}:${_esc(item.title || '')}">
                  <img src="${_tsrc(item.ref)}" alt="${_esc(item.title || '')}">
                  <div class="bible-picker-item-label">${_esc(item.title || 'Asset')}</div>
                </div>
              `).join("") : `<div class="story-empty-desc" style="grid-column:1/-1;text-align:center;padding:40px;">No images in Library (coll 'ktoonlib'). Use Upload or save images from Bible.</div>`}
            </div>
          ` : ''}

          ${!p.loading && tab === 'istu' ? `
            <div class="bible-picker-grid">
              ${p.istuItems.length ? p.istuItems.map(item => `
                <div class="bible-picker-item" data-s="bible.selectPickerImage:${item.ref}:${_esc(item.title || '')}">
                  <img src="${_tsrc(item.ref)}" alt="${_esc(item.title || '')}">
                  <div class="bible-picker-item-label">${_esc(item.title || 'Image')}</div>
                </div>
              `).join("") : `<div class="story-empty-desc" style="grid-column:1/-1;text-align:center;padding:40px;">No Image Studio generations found. Open Image Studio to generate images.</div>`}
            </div>
          ` : ''}

          ${!p.loading && tab === 'upload' ? `
            <div class="bible-picker-upload-drop" data-s="bible.triggerUpload">
              <div style="font-size:14px;font-weight:600;color:var(--text,#e6ece8);">Click to browse and upload an image</div>
              <div class="bible-note">PNG, JPG, WebP supported. File is uploaded to server and linked directly.</div>
              <input type="file" id="bible-hidden-file-input" accept="image/*" style="display:none;">
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ---------- Event Listeners for Live Editing ----------
  function attachBibleInputListeners(root) {
    if (!root) return;

    // Filter search inputs
    root.querySelectorAll("[data-b-search]").forEach(inp => {
      inp.oninput = (e) => {
        const kind = e.target.dataset.bSearch;
        if (kind === "char") BIBLE_STATE.searchChar = e.target.value;
        if (kind === "loc") BIBLE_STATE.searchLoc = e.target.value;
        if (kind === "prop") BIBLE_STATE.searchProp = e.target.value;
        const subCont = document.getElementById("bible-subview-container");
        if (subCont && BIBLE_STATE.subview === "entities") {
          subCont.innerHTML = renderEntitiesView(STORY.bible);
          attachBibleInputListeners(subCont);
        }
      };
    });

    // Bible root / format / style fields
    root.querySelectorAll("[data-b-path]").forEach(inp => {
      inp.oninput = (e) => {
        const path = e.target.dataset.bPath;
        const val = e.target.type === "number" ? Number(e.target.value) : e.target.value;
        setDeepPath(STORY.bible, path, val);
        STORY.dirty.bible = true;
        STORY.scheduleSave();
      };
    });

    // Entity fields (character, location, prop)
    root.querySelectorAll("[data-b-entity]").forEach(inp => {
      inp.oninput = (e) => {
        const kind = e.target.dataset.bEntity;
        const id = e.target.dataset.bId;
        const field = e.target.dataset.bField;
        const val = e.target.value;

        const list = kind === "char" ? STORY.bible.chars : (kind === "loc" ? STORY.bible.locs : STORY.bible.props);
        const item = list.find(x => x.id === id);
        if (item) {
          if (field === "aliases") {
            item.aliases = val.split(",").map(s => s.trim()).filter(Boolean);
          } else {
            item[field] = val;
          }
          STORY.dirty.bible = true;
          STORY.scheduleSave();
        }
      };
    });

    // Wardrobe fields
    root.querySelectorAll("[data-b-wardrobe]").forEach(inp => {
      inp.oninput = (e) => {
        const parts = e.target.dataset.bWardrobe.split(":");
        const charId = parts[0];
        const wIdx = parseInt(parts[1], 10);
        const field = parts[2];
        const char = (STORY.bible.chars || []).find(c => c.id === charId);
        if (char && char.wardrobe && char.wardrobe[wIdx]) {
          char.wardrobe[wIdx][field] = e.target.value;
          STORY.dirty.bible = true;
          STORY.scheduleSave();
        }
      };
    });

    // Video ref fields
    root.querySelectorAll("[data-b-vref]").forEach(inp => {
      inp.oninput = (e) => {
        const idx = parseInt(e.target.dataset.bVref, 10);
        const field = e.target.dataset.bField;
        if (STORY.bible.style && STORY.bible.style.videoRefs && STORY.bible.style.videoRefs[idx]) {
          STORY.bible.style.videoRefs[idx][field] = e.target.value;
          STORY.dirty.bible = true;
          STORY.scheduleSave();
        }
      };
    });

    // Production rules fields
    root.querySelectorAll("[data-b-rule]").forEach(inp => {
      inp.oninput = (e) => {
        const idx = parseInt(e.target.dataset.bRule, 10);
        if (Array.isArray(STORY.bible.rules) && STORY.bible.rules[idx] !== undefined) {
          STORY.bible.rules[idx] = e.target.value;
          STORY.dirty.bible = true;
          STORY.scheduleSave();
        }
      };
    });

    // Bank item role fields
    root.querySelectorAll("[data-b-bank]").forEach(inp => {
      inp.oninput = (e) => {
        const bIdx = parseInt(e.target.dataset.bBank, 10);
        const iIdx = parseInt(e.target.dataset.bBitem, 10);
        const field = e.target.dataset.bField;
        if (STORY.bible.banks && STORY.bible.banks[bIdx] && STORY.bible.banks[bIdx].items[iIdx]) {
          STORY.bible.banks[bIdx].items[iIdx][field] = e.target.value;
          STORY.dirty.bible = true;
          STORY.scheduleSave();
        }
      };
    });
  }

  function setDeepPath(obj, path, value) {
    if (!obj || !path) return;
    const parts = path.split(".");
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!curr[parts[i]]) curr[parts[i]] = {};
      curr = curr[parts[i]];
    }
    curr[parts[parts.length - 1]] = value;
  }

  // ---------- Library and Ref Image Loaders ----------
  async function loadPickerImages(tab) {
    BIBLE_STATE.picker.loading = true;
    const modalEl = document.getElementById("bible-picker-modal");
    if (modalEl) modalEl.innerHTML = renderPickerModalContent();

    try {
      if (tab === "library") {
        const res = await api("/api/desk/all");
        const colls = (res && res.colls) || {};
        const lib = colls.ktoonlib || {};
        BIBLE_STATE.picker.libraryItems = Object.values(lib).map(doc => ({
          ref: doc.ref || doc.media || doc.src || "",
          title: doc.title || doc.name || "Library Asset"
        })).filter(x => Boolean(x.ref));
      } else if (tab === "istu") {
        const res = await api("/api/desk/all");
        const colls = (res && res.colls) || {};
        const istu = colls.istu || {};
        BIBLE_STATE.picker.istuItems = Object.values(istu).map(doc => ({
          ref: doc.ref || doc.img || doc.src || "",
          title: doc.prompt ? doc.prompt.substring(0, 30) : "Image Studio"
        })).filter(x => Boolean(x.ref));
      }
    } catch (err) {
      console.warn("Picker load error:", err);
    }

    BIBLE_STATE.picker.loading = false;
    if (modalEl) modalEl.innerHTML = renderPickerModalContent();
  }

  // ---------- Cross-Episode Character Rename Helper ----------
  async function renameCharacterCrossEpisodes(charId) {
    if (!STORY.bible) return;
    const char = (STORY.bible.chars || []).find(c => c.id === charId);
    if (!char) return;

    const oldName = char.name || "CHARACTER";
    const nameInput = document.getElementById("bible-insp-char-name");
    const newName = (nameInput ? nameInput.value : prompt("Enter new character name:", oldName))?.trim();

    if (!newName || newName === oldName) return;

    const confirmMsg = `Do you want to update all occurrences of "${oldName}" to "${newName}" across script blocks, dialogues, and shot prompts for ALL episodes in this series?`;
    let confirmAll = false;
    if (typeof ask === "function") {
      confirmAll = await ask("Rename Character", `<p style="font-size:13px;line-height:1.5;">${confirmMsg}</p>`, "Rename Everywhere");
    } else {
      confirmAll = window.confirm(confirmMsg);
    }

    if (!confirmAll) {
      // Local rename only
      STORY.snapshot(`Rename character ${oldName} to ${newName} (local)`);
      char.name = newName;
      STORY.dirty.bible = true;
      STORY.scheduleSave();
      STORY.renderAll();
      return;
    }

    // Cross-episode propagation
    STORY.snapshot(`Rename character ${oldName} to ${newName} (all episodes)`);
    char.name = newName;
    STORY.dirty.bible = true;

    // Update bank name if attached
    if (Array.isArray(STORY.bible.banks)) {
      const bank = STORY.bible.banks.find(b => b.charId === charId);
      if (bank) {
        const safe = newName.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
        bank.name = `REFBANK_01_${safe}`;
        bank.id = bank.name;
      }
    }

    try {
      const res = await api("/api/desk/all");
      const colls = (res && res.colls) || {};
      const epColl = colls.story_ep || {};
      const s = STORY.curSeries();
      const sId = s ? s.id : (STORY.bible ? STORY.bible.series : null);

      const ops = [];
      const nameRegex = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "gi");

      Object.values(epColl).forEach(epDoc => {
        if (!epDoc || (sId && epDoc.series !== sId)) return;
        let modified = false;

        // 1. Script blocks
        if (epDoc.script && Array.isArray(epDoc.script.blocks)) {
          epDoc.script.blocks.forEach(blk => {
            if (blk.char === charId || blk.char === oldName) {
              blk.char = charId;
              modified = true;
            }
            if (blk.text && nameRegex.test(blk.text)) {
              blk.text = blk.text.replace(nameRegex, newName);
              modified = true;
            }
          });
        }

        // 2. Shots
        if (Array.isArray(epDoc.shots)) {
          epDoc.shots.forEach(shot => {
            if (shot.title && nameRegex.test(shot.title)) {
              shot.title = shot.title.replace(nameRegex, newName);
              modified = true;
            }
            if (shot.action && nameRegex.test(shot.action)) {
              shot.action = shot.action.replace(nameRegex, newName);
              modified = true;
            }
            if (Array.isArray(shot.dialogue)) {
              shot.dialogue.forEach(d => {
                if (d.char === charId || d.char === oldName) {
                  d.char = newName;
                  modified = true;
                }
                if (d.text && nameRegex.test(d.text)) {
                  d.text = d.text.replace(nameRegex, newName);
                  modified = true;
                }
              });
            }
            if (shot.vprompt && shot.vprompt.text && nameRegex.test(shot.vprompt.text)) {
              shot.vprompt.text = shot.vprompt.text.replace(nameRegex, newName);
              modified = true;
            }
            if (shot.stb && shot.stb.prompt && nameRegex.test(shot.stb.prompt)) {
              shot.stb.prompt = shot.stb.prompt.replace(nameRegex, newName);
              modified = true;
            }
          });
        }

        if (modified) {
          epDoc.u = Date.now();
          ops.push({
            coll: "story_ep",
            id: epDoc.ep,
            doc: epDoc
          });
          if (STORY.ep && STORY.ep.ep === epDoc.ep) {
            STORY.ep = epDoc;
            STORY.dirty.ep = true;
          }
        }
      });

      if (ops.length > 0) {
        await api("/api/desk/batch", { ops });
      }

      STORY.scheduleSave();
      if (typeof toast === "function") {
        toast(`Renamed "${oldName}" to "${newName}" across ${ops.length} episode document(s).`);
      }
    } catch (err) {
      console.error("Rename propagation error:", err);
      if (typeof toast === "function") toast("Rename propagation failed: " + err.message, true);
    }

    STORY.renderAll();
  }

  // ---------- Auto-Generate Ref Banks ----------
  function autoGenerateRefBanks() {
    if (!STORY.bible) return;
    STORY.snapshot("Auto-generate Reference Banks");

    const chars = STORY.bible.chars || [];
    if (!Array.isArray(STORY.bible.banks)) STORY.bible.banks = [];

    let count = 0;
    chars.forEach((c, idx) => {
      const safe = (c.name || `CHAR_${idx + 1}`).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
      const bankId = `REFBANK_${String(idx + 1).padStart(2, "0")}_${safe}`;

      let bank = STORY.bible.banks.find(b => b.charId === c.id);
      if (!bank) {
        bank = {
          id: bankId,
          name: bankId,
          charId: c.id,
          items: []
        };
        STORY.bible.banks.push(bank);
      } else {
        bank.name = bankId;
        bank.id = bankId;
      }

      // Populate items from character refs up to 8 images
      const refs = c.refs || [];
      bank.items = refs.slice(0, 8).map((r, rIdx) => {
        const n = rIdx + 1;
        const filename = r.ref ? r.ref.split("/").pop() : `image${n}_${safe}.jpg`;
        return {
          n: n,
          ref: r.ref,
          entity: c.id,
          role: "character = design/identity only (NOT lighting)",
          filename: filename
        };
      });
      count++;
    });

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    if (typeof toast === "function") toast(`Generated ${count} reference bank(s).`);
    STORY.renderAll();
  }

  // ---------- Make in Image Studio ----------
  function makeInImageStudio(charId) {
    if (!STORY.bible) return;
    const char = (STORY.bible.chars || []).find(c => c.id === charId);
    if (!char) return;

    const style = STORY.bible.style || {};
    const look = char.look || "athletic build, distinct facial features";
    const styleLook = style.look || "photoreal cinematic, AI actor";

    // 21:9 concept sheet prompt matching spec section 5.A.3
    const prompt = `Character portrait of ${char.name}, ${look}. Style: ${styleLook}. Pure white background single image, then sheet 21:9 (70% right 4 body angles front/back/3-quarter, 30% left 4 face expressions). Neutral studio lighting, master quality.`;

    if (window.ISTU) {
      window.ISTU.prefillPrompt = prompt;
    }

    if (typeof toast === "function") {
      toast(`Opening Image Studio with concept sheet prompt for ${char.name}...`);
    }

    if (typeof storyClose === "function") {
      storyClose();
    }

    if (typeof istuOpen === "function") {
      istuOpen();
    } else {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(prompt);
        if (typeof toast === "function") toast("Copied concept sheet prompt to clipboard!");
      }
    }
  }

  // ---------- Register Commands in STORY.cmds ----------
  STORY.cmds["bible.subview"] = (arg) => {
    if (["entities", "style", "rules", "banks"].includes(arg)) {
      BIBLE_STATE.subview = arg;
      const viewEl = document.getElementById("story-view-bible");
      if (viewEl) renderBibleView(viewEl);
    }
  };

  STORY.cmds["bible.selectChar"] = (id) => {
    STORY.select("char", id);
    activateInspectorTab();
    const viewEl = document.getElementById("story-view-bible");
    if (viewEl) renderBibleView(viewEl);
  };

  STORY.cmds["bible.selectLoc"] = (id) => {
    STORY.select("loc", id);
    activateInspectorTab();
    const viewEl = document.getElementById("story-view-bible");
    if (viewEl) renderBibleView(viewEl);
  };

  STORY.cmds["bible.selectProp"] = (id) => {
    STORY.select("prop", id);
    activateInspectorTab();
    const viewEl = document.getElementById("story-view-bible");
    if (viewEl) renderBibleView(viewEl);
  };

  STORY.cmds["bible.addChar"] = () => {
    if (!STORY.bible) return;
    STORY.snapshot("Add Character");
    const newId = _uid("ch_");
    const count = (STORY.bible.chars || []).length + 1;
    const newChar = {
      id: newId,
      name: `CHARACTER ${count}`,
      aliases: [],
      role: count === 1 ? "lead" : "supporting",
      age: "",
      gender: "",
      look: "",
      wardrobe: [],
      voice: "",
      voiceRef: "",
      refs: []
    };
    STORY.bible.chars.push(newChar);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.select("char", newId);
    activateInspectorTab();
    STORY.renderAll();
  };

  STORY.cmds["bible.extractFromScript"] = () => {
    if (STORY.ai && typeof STORY.ai.extractBibleFromScript === "function") {
      STORY.ai.extractBibleFromScript();
    } else {
      if (typeof toast === "function") toast("AI subsystem not loaded.", true);
    }
  };

  STORY.cmds["bible.addLoc"] = () => {
    if (!STORY.bible) return;
    STORY.snapshot("Add Location");
    const newId = _uid("lc_");
    const count = (STORY.bible.locs || []).length + 1;
    const newLoc = {
      id: newId,
      name: `LOCATION ${count}`,
      desc: "Distinct architecture and moody environment.",
      time: "night",
      geography: "Main entrance screen-left, focal action area center frame.",
      refs: []
    };
    STORY.bible.locs.push(newLoc);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.select("loc", newId);
    activateInspectorTab();
    STORY.renderAll();
  };

  STORY.cmds["bible.addProp"] = () => {
    if (!STORY.bible) return;
    STORY.snapshot("Add Prop");
    const newId = _uid("pp_");
    const count = (STORY.bible.props || []).length + 1;
    const newProp = {
      id: newId,
      name: `PROP ${count}`,
      desc: "Hero key story item.",
      refs: []
    };
    STORY.bible.props.push(newProp);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.select("prop", newId);
    activateInspectorTab();
    STORY.renderAll();
  };

  STORY.cmds["bible.addEntityPrompt"] = () => {
    if (typeof ask === "function") {
      ask("Add Entity", `<p>What type of entity would you like to create?</p>`, "Character").then(ok => {
        if (ok) STORY.cmds["bible.addChar"]();
      });
    } else {
      STORY.cmds["bible.addChar"]();
    }
  };

  STORY.cmds["bible.deleteEntity"] = async (arg) => {
    const parts = arg.split(":");
    const kind = parts[0];
    const id = parts[1];
    if (!STORY.bible || !kind || !id) return;

    let confirmed = false;
    if (typeof ask === "function") {
      confirmed = await ask("Delete Entity", `<p>Are you sure you want to delete this ${kind}?</p>`, "Delete");
    } else {
      confirmed = window.confirm(`Delete this ${kind}?`);
    }

    if (!confirmed) return;

    STORY.snapshot(`Delete ${kind}`);
    if (kind === "char") STORY.bible.chars = (STORY.bible.chars || []).filter(c => c.id !== id);
    if (kind === "loc") STORY.bible.locs = (STORY.bible.locs || []).filter(l => l.id !== id);
    if (kind === "prop") STORY.bible.props = (STORY.bible.props || []).filter(p => p.id !== id);

    if (STORY.selItem && STORY.selItem.id === id) {
      STORY.select(null);
    }

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.renameCharPrompt"] = (charId) => {
    renameCharacterCrossEpisodes(charId);
  };

  STORY.cmds["bible.makeIstu"] = (charId) => {
    makeInImageStudio(charId);
  };

  STORY.cmds["bible.autoBanks"] = () => {
    autoGenerateRefBanks();
  };

  STORY.cmds["bible.addBank"] = () => {
    if (!STORY.bible) return;
    STORY.snapshot("Add Ref Bank");
    const count = (STORY.bible.banks || []).length + 1;
    const bankId = `REFBANK_${String(count).padStart(2, "0")}_CUSTOM`;
    STORY.bible.banks.push({
      id: bankId,
      name: bankId,
      charId: "",
      items: []
    });
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.deleteBank"] = (bIdxStr) => {
    const idx = parseInt(bIdxStr, 10);
    if (!STORY.bible || !Array.isArray(STORY.bible.banks)) return;
    STORY.snapshot("Delete Ref Bank");
    STORY.bible.banks.splice(idx, 1);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.moveBankItem"] = (arg) => {
    const parts = arg.split(":");
    const bIdx = parseInt(parts[0], 10);
    const iIdx = parseInt(parts[1], 10);
    const dir = parts[2];
    const bank = STORY.bible && STORY.bible.banks && STORY.bible.banks[bIdx];
    if (!bank || !Array.isArray(bank.items)) return;

    const targetIdx = dir === "up" ? iIdx - 1 : iIdx + 1;
    if (targetIdx < 0 || targetIdx >= bank.items.length) return;

    STORY.snapshot("Reorder Bank Item");
    const item = bank.items.splice(iIdx, 1)[0];
    bank.items.splice(targetIdx, 0, item);
    bank.items.forEach((it, n) => { it.n = n + 1; });

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.deleteBankItem"] = (arg) => {
    const parts = arg.split(":");
    const bIdx = parseInt(parts[0], 10);
    const iIdx = parseInt(parts[1], 10);
    const bank = STORY.bible && STORY.bible.banks && STORY.bible.banks[bIdx];
    if (!bank || !Array.isArray(bank.items)) return;

    STORY.snapshot("Remove Bank Item");
    bank.items.splice(iIdx, 1);
    bank.items.forEach((it, n) => { it.n = n + 1; });

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.addWardrobe"] = (charId) => {
    const char = STORY.bible && (STORY.bible.chars || []).find(c => c.id === charId);
    if (!char) return;
    STORY.snapshot("Add Wardrobe");
    if (!Array.isArray(char.wardrobe)) char.wardrobe = [];
    char.wardrobe.push({
      id: _uid("wd_"),
      name: `Outfit ${char.wardrobe.length + 1}`,
      desc: ""
    });
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    if (typeof STORY.renderInspector === "function") STORY.renderInspector();
  };

  STORY.cmds["bible.deleteWardrobe"] = (arg) => {
    const parts = arg.split(":");
    const charId = parts[0];
    const wIdx = parseInt(parts[1], 10);
    const char = STORY.bible && (STORY.bible.chars || []).find(c => c.id === charId);
    if (!char || !Array.isArray(char.wardrobe)) return;

    STORY.snapshot("Delete Wardrobe");
    char.wardrobe.splice(wIdx, 1);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    if (typeof STORY.renderInspector === "function") STORY.renderInspector();
  };

  STORY.cmds["bible.addRule"] = () => {
    if (!STORY.bible) return;
    STORY.snapshot("Add Production Rule");
    if (!Array.isArray(STORY.bible.rules)) STORY.bible.rules = [];
    STORY.bible.rules.push("New production guideline");
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.deleteRule"] = (idxStr) => {
    const idx = parseInt(idxStr, 10);
    if (!STORY.bible || !Array.isArray(STORY.bible.rules)) return;
    STORY.snapshot("Delete Production Rule");
    STORY.bible.rules.splice(idx, 1);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.addVideoRef"] = () => {
    if (!STORY.bible || !STORY.bible.style) return;
    STORY.snapshot("Add Video Ref");
    if (!Array.isArray(STORY.bible.style.videoRefs)) STORY.bible.style.videoRefs = [];
    const count = STORY.bible.style.videoRefs.length + 1;
    STORY.bible.style.videoRefs.push({
      id: _uid("vr_"),
      tag: `@video${count}`,
      title: "Motion Reference",
      role: "ANIMATION STYLE / MOTION ONLY",
      ref: "",
      note: ""
    });
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.deleteVideoRef"] = (idxStr) => {
    const idx = parseInt(idxStr, 10);
    if (!STORY.bible || !STORY.bible.style || !Array.isArray(STORY.bible.style.videoRefs)) return;
    STORY.snapshot("Delete Video Ref");
    STORY.bible.style.videoRefs.splice(idx, 1);
    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.deleteRefImage"] = (arg) => {
    const parts = arg.split(":");
    const kind = parts[0];
    const id = parts[1];
    const idx = parseInt(parts[2], 10);

    STORY.snapshot("Delete Ref Image");
    if (kind === "char") {
      const c = (STORY.bible.chars || []).find(x => x.id === id);
      if (c && c.refs) c.refs.splice(idx, 1);
    } else if (kind === "loc") {
      const l = (STORY.bible.locs || []).find(x => x.id === id);
      if (l && l.refs) l.refs.splice(idx, 1);
    } else if (kind === "prop") {
      const p = (STORY.bible.props || []).find(x => x.id === id);
      if (p && p.refs) p.refs.splice(idx, 1);
    } else if (kind === "style") {
      if (STORY.bible.style && STORY.bible.style.refs) STORY.bible.style.refs.splice(idx, 1);
    }

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    STORY.renderAll();
  };

  STORY.cmds["bible.saveToLib"] = async (arg) => {
    const parts = arg.split(":");
    const ref = parts[0];
    const title = parts.slice(1).join(":") || "Bible Asset";
    if (!ref) return;

    try {
      const libId = (typeof libNewId === "function") ? libNewId() : ("lib_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
      const doc = {
        id: libId,
        ref: ref,
        title: title,
        tags: ["bible", "character"],
        u: Date.now()
      };
      if (typeof libPut === "function") {
        await libPut(libId, doc);
      } else if (typeof api === "function") {
        await api("/api/desk/put", { coll: "ktoonlib", id: libId, doc });
      }
      if (typeof toast === "function") toast(`Saved "${title}" to Library`);
    } catch (err) {
      if (typeof toast === "function") toast("Failed to save to Library: " + err.message, true);
    }
  };

  // Picker controls
  STORY.cmds["bible.openPicker"] = (arg) => {
    const parts = arg.split(":");
    BIBLE_STATE.picker.targetKind = parts[0];
    BIBLE_STATE.picker.targetId = parts[1];
    BIBLE_STATE.picker.open = true;

    const modalEl = document.getElementById("bible-picker-modal");
    if (modalEl) {
      modalEl.hidden = false;
      modalEl.innerHTML = renderPickerModalContent();
    }
    loadPickerImages(BIBLE_STATE.picker.tab);
  };

  STORY.cmds["bible.closePicker"] = () => {
    BIBLE_STATE.picker.open = false;
    const modalEl = document.getElementById("bible-picker-modal");
    if (modalEl) modalEl.hidden = true;
  };

  STORY.cmds["bible.pickTab"] = (tab) => {
    BIBLE_STATE.picker.tab = tab;
    loadPickerImages(tab);
  };

  STORY.cmds["bible.selectPickerImage"] = (arg) => {
    const parts = arg.split(":");
    const ref = parts[0];
    const title = parts.slice(1).join(":");
    if (!ref) return;

    const p = BIBLE_STATE.picker;
    STORY.snapshot("Attach Reference Image");

    if (p.targetKind === "char") {
      const char = (STORY.bible.chars || []).find(c => c.id === p.targetId);
      if (char) {
        if (!Array.isArray(char.refs)) char.refs = [];
        char.refs.push({
          ref: ref,
          label: title || `Ref ${char.refs.length + 1}`,
          role: "design/identity only",
          bank: `image${char.refs.length + 1}`
        });
      }
    } else if (p.targetKind === "loc") {
      const loc = (STORY.bible.locs || []).find(l => l.id === p.targetId);
      if (loc) {
        if (!Array.isArray(loc.refs)) loc.refs = [];
        loc.refs.push({
          ref: ref,
          label: title || `Ref ${loc.refs.length + 1}`,
          role: "mood/architecture only"
        });
      }
    } else if (p.targetKind === "prop") {
      const prop = (STORY.bible.props || []).find(x => x.id === p.targetId);
      if (prop) {
        if (!Array.isArray(prop.refs)) prop.refs = [];
        prop.refs.push({
          ref: ref,
          label: title || `Ref ${prop.refs.length + 1}`,
          role: "design/identity only"
        });
      }
    } else if (p.targetKind === "style") {
      if (!STORY.bible.style) STORY.bible.style = {};
      if (!Array.isArray(STORY.bible.style.refs)) STORY.bible.style.refs = [];
      STORY.bible.style.refs.push({
        ref: ref,
        label: title || `Style Ref ${STORY.bible.style.refs.length + 1}`,
        role: "style only"
      });
    } else if (p.targetKind === "bank") {
      const bank = (STORY.bible.banks || []).find(b => b.id === p.targetId);
      if (bank) {
        if (!Array.isArray(bank.items)) bank.items = [];
        if (bank.items.length < 8) {
          const n = bank.items.length + 1;
          bank.items.push({
            n: n,
            ref: ref,
            entity: bank.charId || "",
            role: "character = design/identity only",
            filename: ref.split("/").pop()
          });
        } else {
          if (typeof toast === "function") toast("Bank already has maximum 8 images.", true);
        }
      }
    }

    STORY.dirty.bible = true;
    STORY.scheduleSave();
    BIBLE_STATE.picker.open = false;
    STORY.renderAll();
  };

  STORY.cmds["bible.triggerUpload"] = () => {
    const input = document.getElementById("bible-hidden-file-input");
    if (!input) return;

    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        if (typeof toast === "function") toast(`Uploading ${file.name}...`);
        const buffer = await file.arrayBuffer();
        const res = await api("/api/upload", buffer, file.name);
        if (res && res.ref) {
          if (typeof toast === "function") toast("Uploaded successfully.");
          STORY.cmds["bible.selectPickerImage"](`${res.ref}:${file.name}`);
        } else {
          throw new Error("Upload did not return a valid reference.");
        }
      } catch (err) {
        console.error("Upload error:", err);
        if (typeof toast === "function") toast("Upload failed: " + err.message, true);
      }
    };

    input.click();
  };

  // ---------- Register into Module Registry ----------
  STORY.views.bible = {
    render: renderBibleView
  };

  STORY.inspector.char = {
    render: renderCharInspector
  };

  STORY.inspector.loc = {
    render: renderLocInspector
  };

  STORY.inspector.prop = {
    render: renderPropInspector
  };

  if (!Array.isArray(STORY.hooks.afterLoad)) {
    STORY.hooks.afterLoad = [];
  }

  STORY.hooks.afterLoad.push(() => {
    if (STORY.tab === "bible" && typeof STORY.renderView === "function") {
      STORY.renderView();
    }
  });

})();
