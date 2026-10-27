// Assumed app functions:
// - api(path, body, raw) : Promise<any> (Server API call with authentication & episode header)
// - toast(msg, isError) : void (Transient notification)
// - ask(title, html, okLabel) : Promise<boolean> (Modal confirmation dialog)
// - esc(str) : string (HTML escape utility)
// - usd(num) : string (Currency formatting)
// - src(ref), tsrc(ref) : string (Media URL resolver)
// - parseShotlist(raw) : { shots: [...], header: string, tail: string } (Existing GPT shotlist parser)
// - prodInit() : object (Production pipeline context)
// - prSetShotlist(P, raw, note) : void (Populate production pipeline)
// - prMakeBatches(P) : void (Batch calculation in production pipeline)
// - prWritePrompt(i) : void (Write prompt in production pipeline)
// - prRunShotlist() : void (Run generation in production pipeline)
// - W : { nodes: { [id]: { id, type, x, y, data } } } (Canvas workspace)
// - newNode(type, x, y, data) : object (Create canvas node)
// - renderNode(node) : void (Render canvas node)
// - save() : void (Save canvas workspace)
// - toWorld(x, y) : void (Center canvas on coordinate)
// - CUR : { ep: { id, name, ... }, series: { id, name, ... } } (Current context)
// - PJ : { groups: [...], series: [...], episodes: [...] } (Project tree)
// - C : { catalog: { video: [...], llm: [...], image: [...] } } (Model catalog)
// - window.ISTU : { open: boolean, P: object, I: object, ... } (Image Studio instance)
// - istuOpen() : void (Opens Image Studio)
// - istuClose() : void (Closes Image Studio)
// - window.VEDIT : { open: boolean, ... } (Video Editor instance)
// - veOpen() : void (Opens Video Editor)
// - veClose() : void (Closes Video Editor)
// - window.VEDIT_API : { buildFromShots(opts), buildFromEDL(opts), open(pid), ... } (Video Editor API)
// - libPut(doc), libNewId(), libUnique(name) : functions (Library asset persistence)
// - STORY : state store exported on window
//
// Server changes needed:
// - None for Task 007. Uses existing endpoints:
//   - GET /api/desk/all, POST /api/desk/put, POST /api/desk/batch
//   - POST /api/run, GET /api/job?id=, POST /api/job_stop
//   - POST /api/upload
//
// App changes needed:
// - None. Integrates into STORY extension registry (STORY.links, STORY.cmds).
//
// Known limitations:
// - Image Studio integration passes prefilled prompt/aspect/refs and creates/reuses `<EP> · STB` project.
//   STB generation can also run directly through /api/run or be attached manually via the asset picker.
// - Canvas node creation generates standard 'video' nodes and saves canvas state.
// - Video Editor integration calls window.VEDIT_API.buildFromShots if present, falling back to buildFromEDL.

(function () {
  "use strict";

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

  // Safe uid generator
  function _uid(prefix = "lnk_") {
    if (typeof STORY !== "undefined" && STORY && typeof STORY.uid === "function") {
      return STORY.uid(prefix);
    }
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  // Helper to retrieve series bible
  function getBible() {
    return (typeof STORY !== "undefined" && STORY && STORY.bible) ? STORY.bible : null;
  }

  // Helper to retrieve current episode doc
  function getEp() {
    return (typeof STORY !== "undefined" && STORY && STORY.ep) ? STORY.ep : null;
  }

  // Helper to retrieve shot list
  function getShots() {
    const ep = getEp();
    if (!ep || !Array.isArray(ep.shots)) return [];
    return ep.shots;
  }

  function normalizeMediaRef(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return normalizeMediaRef(value[0]);
    if (value && typeof value === "object") return value.ref || value.file || value.url || "";
    return "";
  }

  function setVersionedRef(record, field, ref) {
    if (!record || !ref || record[field] === ref) return false;
    const version = Number(record.version) || (record[field] ? 1 : 0);
    record.version = Math.max(1, version + (version > 0 ? 1 : 0));
    record[field] = ref;
    return true;
  }

  // ---------- KTOONS_STANDARDS §2: Naming Conventions ----------
  function getProjCode() {
    const bible = getBible();
    if (bible && bible.proj && typeof bible.proj === "string") {
      return bible.proj.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    }
    if (bible && bible.name && typeof bible.name === "string") {
      const sanitized = bible.name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
      if (sanitized) return sanitized;
    }
    return "PROJECT";
  }

  function getEpNumber() {
    const ep = getEp();
    if (!ep) return "01";
    if (ep.n) return String(ep.n).padStart(2, "0");
    const m = (ep.title || "").match(/EP\s*(\d+)/i) || (ep.ep || "").match(/(\d+)/);
    if (m && m[1]) return String(m[1]).padStart(2, "0");
    return "01";
  }

  function formatShotNumber(n) {
    return "S" + String(Number(n) || 1).padStart(2, "0");
  }

  function formatBlockNumber(b) {
    return "B" + String(Number(b) || 1);
  }

  // Storyboard filename: <PROJ>_EP<nn>_STB_S<nn>_v<N>.png (KTOONS_STANDARDS §2)
  function getSTBFilename(shot, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const shotNo = formatShotNumber(shot ? shot.n : 1);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_STB_${shotNo}${v}.png`;
  }

  // Video shot filename: <PROJ>_EP<nn>_B<n>_S<nn>_v<N>.mp4 (KTOONS_STANDARDS §2)
  function getVideoFilename(shot, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const blockNo = formatBlockNumber(shot ? shot.block : 1);
    const shotNo = formatShotNumber(shot ? shot.n : 1);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_${blockNo}_${shotNo}${v}.mp4`;
  }

  // Video block filename: <PROJ>_EP<nn>_B<n>_v<N>.mp4 (KTOONS_STANDARDS §2)
  function getVideoBlockFilename(blockNum, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const blockNo = formatBlockNumber(blockNum);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_${blockNo}${v}.mp4`;
  }

  // Final edit sequence filename: <PROJ>_EP<nn>_EDIT_v<N>.mp4 (KTOONS_STANDARDS §2)
  function getEditFilename(ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_EDIT${v}.mp4`;
  }

  // ---------- 7.1: Shot -> Image Studio & STB Management ----------
  async function makeSTB(shotOrShots, opts = {}) {
    const shots = Array.isArray(shotOrShots) ? shotOrShots : [shotOrShots];
    if (!shots.length) {
      if (typeof toast === "function") toast("No shots selected for STB generation.");
      return;
    }

    const bible = getBible() || {};
    const ep = getEp() || {};
    const aspect = (bible.format && bible.format.aspect) || "9:16";
    const projCode = getProjCode();
    const epNum = getEpNumber();
    const istuProjectName = `${projCode} · EP${epNum} · STB`;

    // Ensure links object exists
    if (!ep.links) ep.links = {};
    if (!ep.links.istu) {
      ep.links.istu = _uid("istu_proj_");
    }

    // Process each target shot
    for (const shot of shots) {
      // Resolve prompt variables if STORY.prompts is available
      let promptText = (shot.stb && shot.stb.prompt) ? shot.stb.prompt : "";
      if (!promptText && shot.action) {
        promptText = `${shot.size || "MCU"}, ${shot.angle || "eye-level"}. ${shot.action}. Cinematic lighting, photoreal, 8k.`;
      }
      if (typeof STORY !== "undefined" && STORY.prompts && typeof STORY.prompts.resolveVariables === "function") {
        promptText = STORY.prompts.resolveVariables(promptText, shot);
      }

      // Collect reference images
      const refs = [];
      if (shot.type === "REF" && Array.isArray(shot.bank) && shot.bank.length) {
        shot.bank.forEach(b => {
          if (b.ref) refs.push(b.ref);
        });
      } else if (Array.isArray(shot.chars) && bible.chars) {
        shot.chars.forEach(cId => {
          const ch = bible.chars.find(c => c.id === cId || c.name === cId);
          if (ch && Array.isArray(ch.refs) && ch.refs.length) {
            refs.push(ch.refs[0].ref || ch.refs[0]);
          }
        });
      }

      // If opening in Image Studio
      if (opts.openImageStudio) {
        if (typeof window !== "undefined" && window.ISTU) {
          window.ISTU.prefill = {
            project: ep.links.istu,
            projectName: istuProjectName,
            prompt: promptText,
            aspect: aspect,
            refs: refs,
            shotId: shot.id,
            filename: getSTBFilename(shot)
          };
          if (typeof window.storyClose === "function") window.storyClose();
          if (typeof window.istuOpen === "function") {
            window.istuOpen();
          } else if (typeof window.ISTU.open === "function") {
            window.ISTU.open();
          }
          if (typeof toast === "function") toast(`Opened Image Studio for ${formatShotNumber(shot.n)}`);
          return;
        } else {
          if (typeof toast === "function") toast("Image Studio is not accessible in this session.", true);
        }
      }

      // If running deterministic or direct API gen
      if (opts.directGen) {
        shot.stb.status = "queued";
        if (typeof STORY !== "undefined" && typeof STORY.scheduleSave === "function") {
          STORY.scheduleSave();
        }
      }
    }

    // Default: Open the STB Action & Attachment Modal
    showSTBModal(shots[0]);
  }

  // Attach a completed STB image to a shot
  function attachSTBImage(shotId, ref, istuId = "") {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return false;

    if (!shot.stb) shot.stb = { prompt: "", ref: "", status: "none", istu: "" };
    setVersionedRef(shot.stb, "ref", normalizeMediaRef(ref));
    if (istuId) shot.stb.istu = istuId;
    shot.stb.status = "done";
    if (shot.status === "draft") shot.status = "ready";
    shot.u = Date.now();

    if (typeof STORY !== "undefined") {
      if (typeof STORY.snapshot === "function") {
        STORY.snapshot(`Attach STB to ${formatShotNumber(shot.n)}`);
      }
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }
    if (typeof toast === "function") toast(`Attached STB image to ${formatShotNumber(shot.n)}`);
    return true;
  }

  // Approve STB for a shot
  function approveSTB(shotId) {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return false;

    if (!shot.stb) shot.stb = { prompt: "", ref: "", status: "none", istu: "" };
    shot.stb.status = "approved";
    shot.status = "stb";
    shot.u = Date.now();

    if (typeof STORY !== "undefined") {
      if (typeof STORY.snapshot === "function") {
        STORY.snapshot(`Approve STB on ${formatShotNumber(shot.n)}`);
      }
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }
    if (typeof toast === "function") toast(`Approved STB on ${formatShotNumber(shot.n)}`);
    return true;
  }

  // Modal to pick or attach an STB image
  function showSTBModal(shot) {
    if (!shot) return;
    const oldModal = document.getElementById("story-stb-modal");
    if (oldModal) oldModal.remove();

    const shotNo = formatShotNumber(shot.n);
    const existingRef = (shot.stb && shot.stb.ref) ? shot.stb.ref : "";
    const promptText = (shot.stb && shot.stb.prompt) ? shot.stb.prompt : (shot.action || "");
    const filename = getSTBFilename(shot);

    const overlay = document.createElement("div");
    overlay.id = "story-stb-modal";
    overlay.className = "story-modal-overlay";
    overlay.innerHTML = `
      <div class="story-modal-box" style="max-width: 580px;">
        <div class="story-modal-header">
          <div>
            <h3 style="margin:0;font-size:15px;color:var(--text,#e6f0ea);font-weight:700;">STB Keyframe · ${shotNo}</h3>
            <div style="font-size:11.5px;color:var(--muted,#93a39a);margin-top:2px;">Target file: <code>${_esc(filename)}</code></div>
          </div>
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">✕</button>
        </div>

        <div class="story-modal-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;">
          <!-- Preview current thumbnail -->
          <div style="display:flex;gap:14px;align-items:flex-start;">
            <div style="width:130px;height:180px;background:var(--card2,#0d1a15);border:1px solid var(--line,#1d3128);border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;">
              ${existingRef ? `
                <img src="${typeof src === 'function' ? src(existingRef) : existingRef}" style="width:100%;height:100%;object-fit:cover;" alt="STB" />
                <div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.7);padding:2px 5px;border-radius:3px;font-size:9.5px;color:#a3e635;font-weight:700;">
                  ${shot.stb && shot.stb.status ? shot.stb.status.toUpperCase() : "DONE"}
                </div>
              ` : `
                <div style="text-align:center;color:var(--muted,#93a39a);font-size:11px;padding:8px;">
                  No STB Image
                </div>
              `}
            </div>

            <div style="flex:1;display:flex;flex-direction:column;gap:8px;">
              <div>
                <label style="display:block;font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;margin-bottom:3px;">STB Prompt</label>
                <div style="font-size:11.5px;color:var(--text,#e6f0ea);background:var(--card2,#0d1a15);padding:8px;border-radius:4px;border:1px solid var(--line,#1d3128);max-height:85px;overflow-y:auto;line-height:1.4;">
                  ${_esc(promptText)}
                </div>
              </div>

              <div>
                <label style="display:block;font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;margin-bottom:3px;">Media Reference (media/... or URL)</label>
                <input type="text" id="story-stb-ref-input" value="${_esc(existingRef)}" placeholder="media/upload/... or https://..." style="width:100%;background:var(--card2,#0d1a15);border:1px solid var(--line,#1d3128);color:var(--text,#e6f0ea);padding:6px 8px;border-radius:4px;font-size:12px;" />
              </div>
            </div>
          </div>

          <!-- Quick Action Buttons -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding-top:4px;">
            <button class="story-btn-ghost" id="story-stb-open-istu-btn" style="padding:7px;font-size:11.5px;justify-content:center;">
              Open in Image Studio
            </button>
            <button class="story-btn-ghost" id="story-stb-pick-lib-btn" style="padding:7px;font-size:11.5px;justify-content:center;">
              Pick from Library
            </button>
          </div>

          <!-- Upload local image -->
          <div style="border-top:1px solid var(--line,#1d3128);padding-top:10px;">
            <label style="display:block;font-size:10.5px;font-weight:700;color:var(--muted,#93a39a);text-transform:uppercase;margin-bottom:4px;">Upload Image File</label>
            <input type="file" id="story-stb-file-input" accept="image/*" style="font-size:11.5px;color:var(--text,#e6f0ea);" />
          </div>
        </div>

        <div class="story-modal-footer" style="padding:10px 16px;border-top:1px solid var(--line,#1d3128);display:flex;justify-content:space-between;align-items:center;">
          <div>
            ${existingRef ? `
              <button class="story-btn-gold" id="story-stb-approve-btn" style="font-size:11.5px;padding:6px 12px;">Approve STB</button>
            ` : ""}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">Cancel</button>
            <button class="story-btn-gold" id="story-stb-save-ref-btn" style="font-size:11.5px;padding:6px 14px;">Save Reference</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Wire events
    overlay.querySelector("#story-stb-open-istu-btn").onclick = () => {
      overlay.remove();
      makeSTB(shot, { openImageStudio: true });
    };

    overlay.querySelector("#story-stb-pick-lib-btn").onclick = () => {
      pickFromLibrary((selectedRef) => {
        const inp = document.getElementById("story-stb-ref-input");
        if (inp) inp.value = selectedRef;
      });
    };

    const approveBtn = overlay.querySelector("#story-stb-approve-btn");
    if (approveBtn) {
      approveBtn.onclick = () => {
        approveSTB(shot.id);
        overlay.remove();
      };
    }

    overlay.querySelector("#story-stb-save-ref-btn").onclick = () => {
      const refVal = (document.getElementById("story-stb-ref-input")?.value || "").trim();
      if (!refVal) {
        if (typeof toast === "function") toast("Please enter or upload a media reference.", true);
        return;
      }
      attachSTBImage(shot.id, refVal);
      overlay.remove();
    };

    const fileInput = overlay.querySelector("#story-stb-file-input");
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        if (typeof api !== "function") throw new Error("api() function unavailable.");
        const buffer = await file.arrayBuffer();
        const uploadName = filename || file.name;
        const res = await api("/api/upload", buffer, uploadName);
        if (res && res.ref) {
          const inp = document.getElementById("story-stb-ref-input");
          if (inp) inp.value = res.ref;
          if (typeof toast === "function") toast("Uploaded image: " + res.ref);
        } else {
          throw new Error((res && res.error) || "Upload failed");
        }
      } catch (err) {
        if (typeof toast === "function") toast("Image upload failed: " + err.message, true);
      }
    };
  }

  // ---------- 7.2: Shot -> Canvas & Production Pipeline Linkage ----------
  function sendToProduction(batchNumOrAll = "all") {
    const allShots = getShots();
    const targetShots = batchNumOrAll === "all"
      ? allShots
      : allShots.filter(s => (s.batch || 1) === Number(batchNumOrAll));
    if (!targetShots.length) {
      if (typeof toast === "function") toast("No shots found for this production batch.", true);
      return false;
    }
    let gptText = "";
    if (typeof STORY !== "undefined" && STORY.shots && typeof STORY.shots.exportText === "function") {
      gptText = batchNumOrAll === "all"
        ? STORY.shots.exportText("gpt")
        : STORY.shots.exportText("gpt", targetShots);
    } else {
      gptText = buildFallbackGptShotlist(targetShots);
    }

    if (!gptText.trim()) {
      if (typeof toast === "function") toast("Shotlist is empty. Cannot send to production.", true);
      return false;
    }

    const note = `From Story Studio (${batchNumOrAll === "all" ? "All Batches" : "Batch " + batchNumOrAll})`;

    // Check if app production functions exist
    if (typeof prSetShotlist === "function") {
      try {
        const P = (typeof prodInit === "function") ? prodInit() : {};
        prSetShotlist(P, gptText, note);
        if (typeof prMakeBatches === "function") prMakeBatches(P);
        if (typeof toast === "function") toast(`Sent ${batchNumOrAll === "all" ? "full shotlist" : "Batch " + batchNumOrAll} to Production Pipeline`);
        return true;
      } catch (err) {
        console.error("sendToProduction error:", err);
        if (typeof toast === "function") toast("Failed to populate production pipeline: " + err.message, true);
        return false;
      }
    } else {
      // Fallback: Copy to clipboard
      try {
        navigator.clipboard.writeText(gptText);
        if (typeof toast === "function") toast("Production pipeline not detected. Shotlist copied to clipboard.");
      } catch (e) {
        if (typeof toast === "function") toast("Production pipeline functions (prSetShotlist) not loaded in this session.", true);
      }
      return false;
    }
  }

  // Create Video Nodes on Canvas inside Sequence Frame (Spec 7.2)
  function createVideoNodes(batchNumOrAll = "all") {
    if (typeof newNode !== "function" || typeof W === "undefined" || !W || !W.nodes) {
      if (typeof toast === "function") toast("Canvas workspace (W.nodes / newNode) is not accessible in this context.", true);
      return false;
    }

    const shots = getShots();
    const targetShots = (batchNumOrAll === "all")
      ? shots
      : shots.filter(s => (s.batch || 1) === Number(batchNumOrAll));

    if (!targetShots.length) {
      if (typeof toast === "function") toast("No shots found to generate video nodes for.", true);
      return false;
    }
    const shotsNeedingNodes = targetShots.filter(shot => !(shot.video && shot.video.node && W.nodes.some(n => n && n.id === shot.video.node && n.type === "video")));
    if (!shotsNeedingNodes.length) {
      if (typeof toast === "function") toast("Video nodes already exist for the selected shots.");
      return true;
    }

    const existingNodes = W.nodes.filter(n => n && n.type !== "seq");
    const startX = Math.max(100, ...existingNodes.map(n => (Number(n.x) || 0) + (Number(n.w) || (n.type === "video" || n.type === "image" ? 360 : 300)))) + 180;
    let nextY = Math.max(150, ...existingNodes.map(n => (Number(n.y) || 0) + (Number(n.h) || 300))) + 180;

    let createdCount = 0;
    const batchGroups = {};

    shotsNeedingNodes.forEach(s => {
      const b = s.batch || 1;
      if (!batchGroups[b]) batchGroups[b] = [];
      batchGroups[b].push(s);
    });

    let linkedCount = 0;
    for (const [batchKey, bShots] of Object.entries(batchGroups)) {
      const batchNum = Number(batchKey);
      const frameNodeIds = [];
      const imageNodesByRef = new Map();
      let rowY = nextY + 70;

      // Create video nodes per shot in the batch
      bShots.forEach((shot, shotIndex) => {
        const posX = startX + 390;
        const posY = rowY;

        // Model lookup according to shot.type
        const videoModels = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) ? C.catalog.video : [];
        let modelInfo = videoModels[0] || null;
        if (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) {
          if (shot.type === "REF") {
            modelInfo = videoModels.find(m => /seedance.*2[._ -]?5|reference/i.test(`${m.id || ""} ${m.label || ""}`)) || modelInfo;
          } else {
            modelInfo = videoModels.find(m => /fast|i2v|mini/i.test(`${m.id || ""} ${m.label || ""}`)) || modelInfo;
          }
        }
        const modelId = modelInfo && modelInfo.id ? modelInfo.id : "";

        const promptText = (shot.vprompt && shot.vprompt.text) ? shot.vprompt.text : (shot.action || "");
        const stbRef = (shot.stb && shot.stb.ref) ? shot.stb.ref : "";

        let imageNode = null;
        if (stbRef) {
          imageNode = imageNodesByRef.get(stbRef);
          if (!imageNode) {
            imageNode = W.nodes.find(n => n && n.type === "upload" && n.data && n.data.mtype === "image" && n.data.ref === stbRef) || null;
            if (!imageNode) {
              imageNode = newNode("upload", startX, posY, { ref: stbRef, mtype: "image", rtag: "@image1" });
              imageNode.title = `${formatShotNumber(shot.n)} · STB`;
              imageNode.w = 300;
              renderNode(imageNode);
            }
            imageNodesByRef.set(stbRef, imageNode);
          }
          frameNodeIds.push(imageNode.id);
        }

        const nodeData = {
          title: `${formatShotNumber(shot.n)} · ${shot.type} (${shot.dur}s)`,
          prompt: promptText,
          model: modelId,
          duration: Number(shot.dur) || 6,
          ratio: ((getBible() || {}).format || {}).aspect || "9:16",
          resolution: modelInfo && Array.isArray(modelInfo.vres) && modelInfo.vres.includes("720p") ? "720p" : (modelInfo && Array.isArray(modelInfo.vres) ? modelInfo.vres[0] : "720p"),
          shot_id: shot.id,
          shot_no: shot.n,
          batch: batchNum,
          scope: "story",
          extra: `shot:${shot.id}`,
          node: "__story__"
        };

        try {
          const n = newNode("video", posX, posY, nodeData);
          if (n && n.id) {
            n.w = 420;
            if (imageNode && !W.edges.some(e => e.from === imageNode.id && e.to === n.id)) {
              W.edges.push({ from: imageNode.id, to: n.id });
              linkedCount++;
            }
            shot.video = shot.video || {};
            shot.video.node = n.id;
            shot.video.job = n.data.job || "";
            shot.video.status = "queued";
            shot.video.sourceMode = "shot";
            shot.video.dur = Number(shot.dur) || 6;
            shot.status = "video";
            shot.u = Date.now();
            createdCount++;
            frameNodeIds.push(n.id);
            if (typeof renderNode === "function") renderNode(n);
            rowY += Math.max(500, (typeof nodeRect === "function" ? nodeRect(n).h : 360) + 70);
          }
        } catch (e) {
          console.warn("Failed creating video node for shot:", shot.n, e);
        }
      });

      if (frameNodeIds.length && typeof createSeq === "function") {
        const frame = createSeq(null, frameNodeIds);
        if (frame) {
          frame.title = `EP${getEpNumber()} · BATCH ${formatBlockNumber(batchNum)}`;
          frame.data.storyBatch = `${getEpNumber()}:${batchNum}`;
          if (typeof renderNode === "function") renderNode(frame);
        }
      }
      nextY = rowY + 120;
    }

    if (typeof refreshInputs === "function") refreshInputs();
    if (typeof drawEdges === "function") drawEdges();
    if (typeof save === "function") save();

    if (typeof STORY !== "undefined") {
      if (typeof STORY.snapshot === "function") {
        STORY.snapshot(`Create ${createdCount} canvas video nodes`);
      }
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }

    if (typeof toast === "function") toast(`Created ${createdCount} video nodes on canvas and connected ${linkedCount} STB references inside batch sequence frames.`);
    return true;
  }

  // Fallback GPT exporter if ss4_shot.js exportText is not loaded
  function buildFallbackGptShotlist(shotOverride) {
    const shots = Array.isArray(shotOverride) ? shotOverride : getShots();
    const lines = [];
    shots.forEach(s => {
      lines.push(`========== CONTENT BLOCK ${String(s.block || 1).padStart(2, "0")} | BATCH ${String(s.batch || 1).padStart(2, "0")} — SHOT ${String(s.n).padStart(2, "0")} | TYPE: ${s.type || "REF"} ==========`);
      lines.push(`Target duration: ${s.dur || 6} seconds.`);
      if (s.stb && s.stb.prompt) lines.push(`STORYBOARD: ${s.stb.prompt}`);
      if (s.vprompt && s.vprompt.text) lines.push(s.vprompt.text);
      lines.push("");
    });
    return lines.join("\n");
  }

  // ---------- 7.2 & 7.5: Status Sync from Canvas & Server Jobs ----------
  async function syncStatus() {
    const shots = getShots();
    if (!shots.length) {
      if (typeof toast === "function") toast("No shots to synchronize.");
      return;
    }

    let updatedCount = 0;

    for (const shot of shots) {
      if (!shot.video) shot.video = { node: "", job: "", ref: "", status: "none", note: "" };

      // 1. Sync from Canvas node W.nodes[id]
      const canvasNode = shot.video.node && typeof W !== "undefined" && W && Array.isArray(W.nodes)
        ? W.nodes.find(n => n && n.id === shot.video.node)
        : null;
      if (canvasNode) {
        const nd = canvasNode.data || {};
        // Check results array
        if (Array.isArray(nd.results) && nd.results.length > 0) {
          const selIdx = typeof nd.sel === "number" ? nd.sel : 0;
          const selectedResult = nd.results[selIdx] || nd.results[0];
          const finalRef = normalizeMediaRef(selectedResult);
          if (setVersionedRef(shot.video, "ref", finalRef)) {
            shot.video.sourceMode = "shot";
            shot.video.status = "done";
            if (shot.status === "stb" || shot.status === "video") shot.status = "video";
            shot.u = Date.now();
            updatedCount++;
          }
        }
        // Check node running status
        if (nd.job && nd.job !== shot.video.job) shot.video.job = nd.job;
        if (nd.status && ["running", "queued", "error", "done", "failed"].includes(nd.status)) {
          if (shot.video.status !== nd.status && shot.video.status !== "approved" && shot.video.status !== "redo") {
            shot.video.status = (nd.status === "error" || nd.status === "failed") ? "failed" : nd.status;
            updatedCount++;
          }
        }
      }

      // 2. Sync from job API if shot.video.job is present
      if (shot.video.job && typeof api === "function" && shot.video.status !== "approved" && shot.video.status !== "redo") {
        try {
          const jres = await api(`/api/job?id=${encodeURIComponent(shot.video.job)}`);
          if (jres && jres.status === "done" && jres.output) {
            const outRef = normalizeMediaRef(jres.output.ref || jres.output.video || jres.output.file || jres.output.url);
            if (setVersionedRef(shot.video, "ref", outRef)) {
              shot.video.sourceMode = "shot";
              shot.video.status = "done";
              shot.u = Date.now();
              updatedCount++;
            }
          } else if (jres && jres.status === "failed") {
            shot.video.status = "failed";
            updatedCount++;
          }
        } catch (e) {
          // ignore transient poll errors
        }
      }

      // 3. Sync STB from Image Studio ISTU.I if tracked
      if (shot.stb && shot.stb.istu && typeof window !== "undefined" && window.ISTU && window.ISTU.I) {
        const imgObj = window.ISTU.I[shot.stb.istu];
        if (imgObj && setVersionedRef(shot.stb, "ref", normalizeMediaRef(imgObj.ref))) {
          shot.stb.status = "done";
          shot.u = Date.now();
          updatedCount++;
        }
      }
    }

    // Check stale & out-of-sync flags
    const syncFlags = checkSyncFlags();

    if (typeof STORY !== "undefined") {
      if (updatedCount > 0 && typeof STORY.scheduleSave === "function") {
        STORY.scheduleSave();
      }
      if (typeof STORY.renderView === "function") STORY.renderView();
    }

    const msg = `Synced status (${updatedCount} updated, ${syncFlags.outOfSyncCount} out of sync, ${syncFlags.staleCount} stale).`;
    if (typeof toast === "function") toast(msg);
    return { updatedCount, ...syncFlags };
  }

  // Redo a shot (Spec 7.2)
  function redoShot(shotId, note = "") {
    const shots = getShots();
    const shot = shots.find(s => s.id === shotId);
    if (!shot) return false;

    if (!shot.video) shot.video = { node: "", job: "", ref: "", status: "none", note: "" };
    shot.video.status = "redo";
    shot.video.note = note || "Requested redo";
    shot.status = "video";
    shot.u = Date.now();

    // Pan to canvas node if available
    const node = shot.video.node && typeof W !== "undefined" && W && Array.isArray(W.nodes)
      ? W.nodes.find(n => n && n.id === shot.video.node)
      : null;
    if (node) {
      if (typeof toWorld === "function") {
        toWorld(node.x, node.y);
      }
    }

    if (typeof STORY !== "undefined") {
      if (typeof STORY.snapshot === "function") {
        STORY.snapshot(`Mark ${formatShotNumber(shot.n)} for Redo`);
      }
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }

    if (typeof toast === "function") toast(`Marked ${formatShotNumber(shot.n)} for Redo: ${shot.video.note}`);
    return true;
  }

  // ---------- 7.3: Shotlist -> Video Editor Linkage ----------
  async function sendToVideoEditor() {
    const shots = getShots();
    if (!shots.length) {
      if (typeof toast === "function") toast("No shots to send to Video Editor.", true);
      return false;
    }

    const bible = getBible() || {};
    const ep = getEp() || {};
    const projCode = getProjCode();
    const epNum = getEpNumber();
    const aspect = (bible.format && bible.format.aspect) || "9:16";
    const genMode = (bible.format && bible.format.genMode) || "block";
    const seqName = `${projCode}_EP${epNum}_EDIT_v1`;
    const blockOffsets = new Map();

    // Prepare shots items for Video Editor
    const items = shots.map(s => {
      const label = formatShotNumber(s.n);
      // Only QC-approved media may enter the edit. Missing/unapproved media becomes a marked matte.
      const videoRef = (s.video && s.video.status === "approved" && s.video.ref) ? s.video.ref : null;
      const dur = Number(s.dur) || 6;
      const blockNo = Number(s.block) || 1;
      const blockSrcIn = genMode === "block" ? (blockOffsets.get(blockNo) || 0) : 0;
      if (genMode === "block") blockOffsets.set(blockNo, blockSrcIn + dur);
      const sourceMode = (s.video && s.video.sourceMode) || (genMode === "block" ? "block" : "shot");
      const srcIn = genMode === "block" && sourceMode !== "shot" ? blockSrcIn : (Number(s.video && s.video.sourceIn) || 0);
      const srcOut = srcIn + dur;

      // Prepare captions from dialogue
      const captions = [];
      if (Array.isArray(s.dialogue) && s.dialogue.length) {
        let curSec = 0;
        s.dialogue.forEach(d => {
          const lineText = d.text || d.line || "";
          const words = lineText.trim().split(/\s+/).filter(Boolean).length;
          const durEst = Math.max(0.8, words / 2.5);
          const start = curSec;
          const end = Math.min(Number(s.dur) || 6, start + durEst);
          captions.push({
            text: lineText,
            start: start,
            end: end,
            char: d.char_name || d.char || ""
          });
          curSec = end + 0.08;
        });
      }

      return {
        shot: s.id,
        label: label,
        ref: videoRef,
        dur: dur,
        src_in: srcIn,
        src_out: srcOut,
        captions: captions
      };
    });

    // Check if window.VEDIT_API is present
    if (typeof window !== "undefined" && window.VEDIT_API) {
      try {
        let res = null;
        // Block-mode generation produces one multi-shot clip per block. Use EDL trims so
        // each shot uses its own time range instead of replaying the block from frame 0.
        if (typeof window.VEDIT_API.buildFromEDL === "function") {
          res = await window.VEDIT_API.buildFromEDL({
            name: seqName,
            aspect: aspect,
            fps: 30,
            items: items
          });
        } else if (genMode !== "block" && typeof window.VEDIT_API.buildFromShots === "function") {
          res = await window.VEDIT_API.buildFromShots({
            name: seqName,
            aspect: aspect,
            fps: 30,
            items: items
          });
        } else {
          throw new Error(genMode === "block"
            ? "Video Editor EDL support is required to trim multi-shot block clips correctly."
            : "Video Editor timeline builder is unavailable.");
        }

        if (res && res.pid) {
          if (!ep.links) ep.links = {};
          ep.links.vedit = res.pid;

          // Map returned clips to shots
          if (res.clips && typeof res.clips === "object") {
            shots.forEach(s => {
              if (res.clips[s.id]) {
                s.edit = {
                  clip: res.clips[s.id],
                  pid: res.pid,
                  synced_at: Date.now()
                };
                s.status = "in_edit";
                s.u = Date.now();
              }
            });
          }

          if (typeof STORY !== "undefined") {
            if (typeof STORY.snapshot === "function") STORY.snapshot("Export sequence to Video Editor");
            if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
            if (typeof STORY.renderView === "function") STORY.renderView();
          }

          if (typeof toast === "function") toast(`Exported ${items.length} shots to Video Editor.`);

          // Open Video Editor
          if (typeof window.storyClose === "function") window.storyClose();
          if (typeof window.VEDIT_API.open === "function") {
            window.VEDIT_API.open(res.pid);
          } else if (typeof window.veOpen === "function") {
            window.veOpen();
          }
          return true;
        } else {
          throw new Error("VEDIT_API did not return a valid project ID.");
        }
      } catch (err) {
        console.error("VEDIT_API error:", err);
        if (typeof toast === "function") toast("Video Editor error: " + err.message, true);
        return false;
      }
    } else {
      // VEDIT_API missing
      if (typeof toast === "function") {
        toast("Update the Video Editor", true);
      }
      return false;
    }
  }

  // ---------- 7.5: Stale & Out-of-sync Detection ----------
  function checkSyncFlags() {
    const shots = getShots();
    const ep = getEp();
    let outOfSyncCount = 0;
    let staleCount = 0;

    const scriptBlocksMap = {};
    if (ep && ep.script && Array.isArray(ep.script.blocks)) {
      ep.script.blocks.forEach(b => {
        scriptBlocksMap[b.id] = b;
      });
    }

    shots.forEach(s => {
      // 1. Out of sync with edit check: shot duration or parameters modified after sending to edit
      s.isOutOfSync = false;
      if (s.edit && s.edit.clip && s.edit.synced_at) {
        if (s.u > s.edit.synced_at + 1000) {
          s.isOutOfSync = true;
          outOfSyncCount++;
        }
      }

      // 2. Stale check: script blocks modified after shot prompt was written or shot created
      s.isStale = false;
      if (Array.isArray(s.lines) && s.lines.length > 0) {
        const hasModifiedScript = s.lines.some(bId => {
          const blk = scriptBlocksMap[bId];
          return blk && blk.u && blk.u > (s.u || 0);
        });
        if (hasModifiedScript) {
          s.isStale = true;
          staleCount++;
        }
      }
    });

    return { outOfSyncCount, staleCount };
  }

  // ---------- 7.4: Library <-> Bible Integration ----------
  async function saveToLibrary(ref, meta = {}) {
    if (!ref) return false;
    const docId = (typeof libNewId === "function") ? libNewId() : _uid("lib_");
    const name = meta.name || "Story Studio Asset";
    const doc = {
      id: docId,
      name: name,
      ref: ref,
      kind: meta.kind || "image",
      tags: meta.tags || ["story_studio"],
      source: "story_studio",
      created: Date.now()
    };

    if (typeof libPut === "function") {
      try {
        libPut(doc);
        if (typeof toast === "function") toast(`Saved ${name} to Library.`);
        return true;
      } catch (e) {
        console.warn("libPut error, falling back to desk put:", e);
      }
    }

    if (typeof api === "function") {
      try {
        await api("/api/desk/put", { coll: "ktoonlib", id: docId, doc });
        if (typeof toast === "function") toast(`Saved ${name} to Library.`);
        return true;
      } catch (err) {
        if (typeof toast === "function") toast("Failed saving to Library: " + err.message, true);
        return false;
      }
    }
    return false;
  }

  // Pick Asset from Library Modal
  async function pickFromLibrary(onSelect) {
    let items = [];
    if (typeof api === "function") {
      try {
        const res = await api("/api/desk/all");
        if (res && res.colls && res.colls.ktoonlib) {
          items = Object.values(res.colls.ktoonlib);
        }
      } catch (e) {
        console.warn("Error loading library assets:", e);
      }
    }

    const oldModal = document.getElementById("story-lib-picker-modal");
    if (oldModal) oldModal.remove();

    const overlay = document.createElement("div");
    overlay.id = "story-lib-picker-modal";
    overlay.className = "story-modal-overlay";
    overlay.innerHTML = `
      <div class="story-modal-box" style="max-width: 620px; max-height: 80vh; display: flex; flex-direction: column;">
        <div class="story-modal-header">
          <h3 style="margin:0;font-size:15px;color:var(--text,#e6f0ea);font-weight:700;">Select Image from Library</h3>
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">✕</button>
        </div>
        <div class="story-modal-body" style="padding:14px; overflow-y:auto; flex:1;">
          ${items.length ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(120px, 1fr));gap:10px;">
              ${items.map(it => `
                <div class="story-lib-item" data-ref="${_esc(it.ref)}" style="background:var(--card2,#0d1a15);border:1px solid var(--line,#1d3128);border-radius:4px;overflow:hidden;cursor:pointer;padding:4px;text-align:center;">
                  <img src="${typeof tsrc === 'function' ? tsrc(it.ref) : (typeof src === 'function' ? src(it.ref) : it.ref)}" style="width:100%;height:100px;object-fit:cover;border-radius:3px;" />
                  <div style="font-size:11px;color:var(--text,#e6f0ea);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${_esc(it.name || "Asset")}
                  </div>
                </div>
              `).join("")}
            </div>
          ` : `
            <div style="text-align:center;padding:40px;color:var(--muted,#93a39a);font-size:12px;">
              No images found in Library collection (ktoonlib).
            </div>
          `}
        </div>
        <div class="story-modal-footer" style="padding:10px 14px;border-top:1px solid var(--line,#1d3128);text-align:right;">
          <button class="story-btn-ghost story-modal-close" data-s="links.close_modal">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelectorAll(".story-lib-item").forEach(el => {
      el.onclick = () => {
        const ref = el.dataset.ref;
        if (ref && typeof onSelect === "function") {
          onSelect(ref);
        }
        overlay.remove();
      };
    });
  }

  // ---------- Register Link Commands ----------
  function registerCommands() {
    if (typeof STORY === "undefined" || !STORY.cmds) return;

    STORY.cmds["links.make_stb"] = (arg) => {
      const shots = getShots();
      const s = shots.find(x => x.id === arg);
      if (s) makeSTB(s);
    };

    STORY.cmds["links.approve_stb"] = (arg) => {
      approveSTB(arg);
    };

    STORY.cmds["links.send_production"] = (arg) => {
      sendToProduction(arg || "all");
    };

    STORY.cmds["links.create_nodes"] = (arg) => {
      createVideoNodes(arg || "all");
    };

    STORY.cmds["links.sync"] = () => {
      syncStatus();
    };

    STORY.cmds["links.send_vedit"] = () => {
      sendToVideoEditor();
    };

    STORY.cmds["links.redo"] = (arg) => {
      redoShot(arg);
    };

    STORY.cmds["links.close_modal"] = () => {
      document.querySelectorAll(".story-modal-overlay").forEach(m => m.remove());
    };
  }

  // ---------- Public APIs Exposure ----------
  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Expose STORY.links
    STORY.links = {
      makeSTB,
      attachSTBImage,
      approveSTB,
      sendToProduction,
      createVideoNodes,
      syncStatus,
      redoShot,
      sendToVideoEditor,
      checkSyncFlags,
      saveToLibrary,
      pickFromLibrary,
      getProjCode,
      getEpNumber,
      getSTBFilename,
      getVideoFilename,
      getVideoBlockFilename,
      getEditFilename
    };

    registerCommands();

    // Extension Hook: Check sync flags after loading
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) {
      STORY.hooks.afterLoad.push(() => {
        checkSyncFlags();
      });
    }
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
