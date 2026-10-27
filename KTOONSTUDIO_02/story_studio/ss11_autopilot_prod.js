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
// - window.VEDIT_API : { buildFromShots(opts), buildFromEDL(opts), open(pid), ... } (Video Editor API)
// - STORY : state store exported on window
//
// Server changes needed:
// - None for Task 009. Uses existing endpoints:
//   - POST /api/run (kind: "image", kind: "video", kind: "llm", node: "__story__", scope: "story")
//   - GET /api/job?id=, POST /api/job_stop { id }
//   - POST /api/upload (raw body with filename)
//   - GET /api/state (budget / global status)
//   - POST /api/desk/batch (handled by ss1_core.js)
//
// App changes needed:
// - None. Integrates into STORY extension registry (STORY.autopilotProd, STORY.cmds, Board tab injection).
//
// Known limitations:
// - Video generation runs asynchronously via /api/run kind:"video" or through canvas video nodes / pipeline.
// - Frame extraction for Gate B QC runs in-browser via offscreen HTML5 video and canvas elements,
//   uploading 6 timestamped JPEG frames to the server.
// - If browser video playback is blocked by CORS, frame extraction gracefully falls back to deterministic QC.
// - Video assembly delegates to window.VEDIT_API.buildFromShots if present, falling back to STORY.links.sendToVideoEditor.

(function () {
  "use strict";

  const QC_LLM_COST_ESTIMATE_USD = 0.02;

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

  // Safe currency formatting
  function _usd(n) {
    if (typeof usd === "function") return usd(n);
    const num = Number(n) || 0;
    return "$" + num.toFixed(2);
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

  // ---------- KTOONS_STANDARDS §2 Naming Helpers ----------
  function getProjCode() {
    if (typeof STORY !== "undefined" && STORY.links && typeof STORY.links.getProjCode === "function") {
      return STORY.links.getProjCode();
    }
    const b = getBible();
    if (b && b.proj) return String(b.proj).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (b && b.name) return String(b.name).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return "PROJECT";
  }

  function getEpNumber() {
    if (typeof STORY !== "undefined" && STORY.links && typeof STORY.links.getEpNumber === "function") {
      return STORY.links.getEpNumber();
    }
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

  function getSTBFilename(shot, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const sNo = formatShotNumber(shot ? shot.n : 1);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_STB_${sNo}${v}.png`;
  }

  function getVideoBlockFilename(blockNum, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const bNo = formatBlockNumber(blockNum);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_${bNo}${v}.mp4`;
  }

  function getVideoFilename(shot, ver = 1) {
    const proj = getProjCode();
    const epNum = getEpNumber();
    const bNo = formatBlockNumber(shot ? shot.block : 1);
    const sNo = formatShotNumber(shot ? shot.n : 1);
    const v = ver > 1 ? `_v${ver}` : "_v1";
    return `${proj}_EP${epNum}_${bNo}_${sNo}${v}.mp4`;
  }

  function selectVideoModel(preferFast = false) {
    const models = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) ? C.catalog.video : [];
    const rx = preferFast ? /fast|i2v|mini/i : /seedance.*2[._ -]?5|seedance/i;
    return models.find(m => rx.test(`${m.id || ""} ${m.label || ""}`)) || models[0] || null;
  }

  function defaultVideoResolution(modelId) {
    const models = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) ? C.catalog.video : [];
    const model = models.find(m => m.id === modelId) || null;
    const resolutions = model && Array.isArray(model.vres) ? model.vres : ["480p", "720p", "1080p"];
    return resolutions.includes("720p") ? "720p" : (resolutions[0] || "720p");
  }

  function shortFixDuration(shot, model) {
    const min = Number(model && model.min_s) || 4;
    const max = Number(model && model.max_s) || 15;
    const wanted = Math.max(min, Math.min(max, Math.ceil(Number(shot && shot.dur) || 6)));
    const allowed = model && Array.isArray(model.durations)
      ? model.durations.map(Number).filter(value => Number.isFinite(value) && value >= min && value <= max)
      : [];
    if (!allowed.length) return wanted;
    return allowed.sort((a, b) => a - b).find(value => value >= wanted) || allowed.filter(value => value <= max).pop() || wanted;
  }

  function videoPricePerSecond(modelId, resolution = "720p") {
    const models = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.video)) ? C.catalog.video : [];
    const model = models.find(m => m.id === modelId) || null;
    if (model && model.price_s != null && Number.isFinite(Number(model.price_s))) return Number(model.price_s);
    if (model && model.video_prices && typeof model.video_prices === "object") {
      const selected = Number(model.video_prices[resolution]);
      if (Number.isFinite(selected)) return selected;
      const prices = Object.values(model.video_prices).map(Number).filter(Number.isFinite);
      if (prices.length) return Math.max(...prices);
    }
    if (model && model.price != null && Number.isFinite(Number(model.price))) return Number(model.price);
    return 0.16;
  }

  function defaultImageResolution(modelId) {
    const models = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.image)) ? C.catalog.image : [];
    const model = models.find(m => m.id === modelId) || null;
    const resolutions = model && Array.isArray(model.res) ? model.res : ["1k", "2k"];
    return resolutions.includes("2k") ? "2k" : (resolutions[0] || "2k");
  }

  function imagePricePerOutput(modelId, resolution) {
    const models = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.image)) ? C.catalog.image : [];
    const model = models.find(m => m.id === modelId) || null;
    if (model && model.prices && typeof model.prices === "object") {
      const selected = Number(model.prices[resolution || defaultImageResolution(modelId)]);
      if (Number.isFinite(selected)) return selected;
      const prices = Object.values(model.prices).map(Number).filter(Number.isFinite);
      if (prices.length) return Math.min(...prices);
    }
    if (model && model.price != null && Number.isFinite(Number(model.price))) return Number(model.price);
    return 0.04;
  }

  function jobOutputRef(jobResult, kind) {
    const out = jobResult && jobResult.output;
    if (!out) return "";
    const asRef = value => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return asRef(value[0]);
      if (value && typeof value === "object") return value.ref || value.file || value.url || "";
      return "";
    };
    if (kind === "image") return asRef(out.ref || out.image || out.images || out.file || out.url);
    return asRef(out.ref || out.video || out.file || out.url);
  }

  function jobCost(jobResult, fallback) {
    const raw = jobResult && (jobResult.cost_usd ?? jobResult.cost ?? (jobResult.usage && jobResult.usage.cost_usd));
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  // ---------- Autopilot State Structure ----------
  const STEP_DEFS = [
    { id: "s4_stb", num: "S4", title: "Storyboard (STB) Keyframes", desc: "Generate missing opening keyframes with bank references" },
    { id: "s6_video", num: "S6", title: "Video Generation & QC Gate B", desc: "Generate multi-shot blocks or I2V shots with frame QC" },
    { id: "s7_naming", num: "S7", title: "Asset Organization & Naming", desc: "Standardize filenames matching KTOONS_STANDARDS §2" },
    { id: "s8_edit", num: "S8", title: "Video Editor Assembly", desc: "Build sequence timeline with subtitles and Color Mattes" }
  ];

  function getInitAutopilotState() {
    return {
      mode: "production",
      status: "idle", // 'idle' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'stopped'
      currentStepId: "s4_stb",
      stepIndex: 0,
      steps: STEP_DEFS.map(d => ({
        id: d.id,
        num: d.num,
        title: d.title,
        status: "pending", // 'pending' | 'running' | 'done' | 'failed'
        progress: 0,
        total: 0,
        cost: 0,
        message: ""
      })),
      attempts: {}, // [blockKey]: count (max 2)
      spent: 0,
      budgetCap: 20,
      estimateBreakdown: null,
      error: "",
      estimatedTotal: 0,
      approvedCost: 0,
      activeJobId: null,
      startedAt: null,
      updatedAt: null,
      logs: []
    };
  }

  function ensureAutopilotState() {
    const ep = getEp();
    if (!ep) return getInitAutopilotState();
    if (!ep.autopilot || ep.autopilot.mode !== "production") {
      ep.autopilot = getInitAutopilotState();
    }
    return ep.autopilot;
  }

  function saveState() {
    const ep = getEp();
    if (ep && ep.autopilot) {
      ep.autopilot.updatedAt = Date.now();
    }
    if (typeof STORY !== "undefined") {
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    }
  }

  function addLog(tag, message) {
    const state = ensureAutopilotState();
    const timeStr = new Date().toTimeString().split(" ")[0];
    state.logs.push({
      time: timeStr,
      tag: tag || "INFO",
      text: String(message)
    });
    if (state.logs.length > 200) {
      state.logs.shift();
    }
    saveState();
    updateDashboardUI();
  }

  // ---------- Cost Estimation & Budget Gate (Gates + Money §5) ----------
  async function estimateProductionCosts() {
    const shots = getShots();
    const bible = getBible() || {};
    const format = bible.format || {};
    const genMode = format.genMode || "block"; // 'block' | 'shot'

    // 1. Missing STB Count
    const missingStbShots = shots.filter(s => !s.stb || !s.stb.ref);
    const imgModel = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.image) && C.catalog.image.length)
      ? C.catalog.image[0]
      : null;
    const stbResolution = defaultImageResolution(imgModel && imgModel.id);
    const stbUnitCost = imagePricePerOutput(imgModel && imgModel.id, stbResolution);
    const stbTotalCost = missingStbShots.length * stbUnitCost;

    // 2. Video Generation Cost
    const blockModel = selectVideoModel(false);
    const blockModelId = blockModel && blockModel.id ? blockModel.id : "seedance-2.5";
    const blockResolution = defaultVideoResolution(blockModelId);
    const videoSecPrice = videoPricePerSecond(blockModelId, blockResolution);
    const fixModel = selectVideoModel(true);
    const fixModelId = fixModel && fixModel.id ? fixModel.id : blockModelId;
    const fixResolution = defaultVideoResolution(fixModelId);
    const fixVideoSecPrice = videoPricePerSecond(fixModelId, fixResolution);

    let videoTotalSecs = 0;
    let videoBlocksCount = 0;
    let videoShotsCount = 0;
    let videoTotalCost = 0;
    let fixFrameImageCount = 0;
    let fixVideoTotalSecs = 0;
    let fixVideoTotalCost = 0;
    let qcCalls = 0;
    const retryLimitBlocks = [];

    if (genMode === "block") {
      // Group shots by block (default 3 blocks x 30s)
      const blockGroups = {};
      shots.forEach(s => {
        const b = s.block || 1;
        if (!blockGroups[b]) blockGroups[b] = [];
        blockGroups[b].push(s);
      });

      const blockNums = Object.keys(blockGroups).map(Number).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
      // Check only blocks that actually contain shots; never generate placeholder blocks.
      let blocksNeedingGen = 0;
      for (const b of blockNums) {
        const bShots = blockGroups[b];
        const hasApproved = bShots.length > 0 && bShots.every(s => s.video && s.video.status === "approved" && s.video.ref);
        if (!hasApproved) {
          blocksNeedingGen++;
          const attemptsUsed = Number((ensureAutopilotState().attempts || {})[`B${b}`]) || 0;
          const attemptsLeft = Math.max(0, 2 - attemptsUsed);
          if (!attemptsLeft) {
            retryLimitBlocks.push(b);
            continue;
          }
          // Reserve only the remaining full-block attempts plus one broken-shot repair.
          videoTotalSecs += attemptsLeft * 30;
          videoTotalCost += attemptsLeft * 30 * videoSecPrice;
          fixFrameImageCount++;
          qcCalls += attemptsLeft + 1; // one QC per possible full attempt, plus one short repair clip
          const likelyBrokenShot = bShots.reduce((longest, shot) => shortFixDuration(shot, fixModel) > shortFixDuration(longest, fixModel) ? shot : longest, bShots[0]);
          const fixSeconds = shortFixDuration(likelyBrokenShot, fixModel);
          fixVideoTotalSecs += fixSeconds;
          fixVideoTotalCost += fixSeconds * fixVideoSecPrice;
        }
      }
      videoBlocksCount = blocksNeedingGen;
    } else {
      // Per-shot mode
      const shotsNeedingGen = shots.filter(s => !s.video || s.video.status !== "approved" || !s.video.ref);
      videoShotsCount = shotsNeedingGen.length;
      shotsNeedingGen.forEach(s => {
        const dur = Number(s.dur) || 6;
        const model = selectVideoModel(s.type !== "REF");
        const modelId = model && model.id ? model.id : "seedance-2.5";
        const resolution = defaultVideoResolution(modelId);
        videoTotalSecs += dur;
        videoTotalCost += dur * videoPricePerSecond(modelId, resolution);
      });
      qcCalls = shotsNeedingGen.length;
    }

    const fixFrameImageCost = fixFrameImageCount * stbUnitCost;
    const qcLLMCost = qcCalls * QC_LLM_COST_ESTIMATE_USD;
    const estimatedTotal = Number((stbTotalCost + videoTotalCost + fixFrameImageCost + fixVideoTotalCost + qcLLMCost).toFixed(2));

    // Episode Budget Cap check
    let budgetCap = 20.00;
    if (format.budgetCap && typeof format.budgetCap === "number") {
      budgetCap = format.budgetCap;
    }
    // Query /api/state if available
    try {
      if (typeof api === "function") {
        const stateRes = await api("/api/state");
        if (stateRes && typeof stateRes.budget === "number") {
          budgetCap = stateRes.budget;
        }
      }
    } catch (e) {
      // transient
    }

    // Current spent
    let alreadySpent = 0;
    if (typeof STORY !== "undefined" && STORY.views && STORY.views.board) {
      // Count each generated file once; block-mode outputs are shared by their shots.
      const seenStbRefs = new Set();
      const seenVideoRefs = new Set();
      shots.forEach(s => {
        if (s.stb && s.stb.ref && !seenStbRefs.has(s.stb.ref)) {
          seenStbRefs.add(s.stb.ref);
          alreadySpent += imagePricePerOutput(s.stb.model || (imgModel && imgModel.id), s.stb.resolution || stbResolution);
        }
        if (s.video && s.video.ref && !seenVideoRefs.has(s.video.ref)) {
          seenVideoRefs.add(s.video.ref);
          const vModelId = s.video.model || blockModelId;
          const dur = Number(s.video.dur) || (genMode === "block" ? 30 : (Number(s.dur) || 6));
          alreadySpent += dur * videoPricePerSecond(vModelId, s.video.resolution || defaultVideoResolution(vModelId));
        }
      });
    }

    const isOverCap = (alreadySpent + estimatedTotal) > budgetCap;

    return {
      genMode,
      missingStbCount: missingStbShots.length,
      stbUnitCost,
      stbTotalCost,
      videoBlocksCount,
      videoShotsCount,
      videoTotalSecs,
      videoSecPrice,
      videoTotalCost,
      fixFrameImageCost,
      fixVideoTotalSecs,
      fixVideoTotalCost,
      qcCalls,
      qcLLMCost,
      retryLimitBlocks,
      estimatedTotal,
      alreadySpent: Number(alreadySpent.toFixed(2)),
      budgetCap,
      isOverCap
    };
  }

  // ---------- S4: STB Keyframe Generation Engine ----------
  async function runStepS4(state) {
    const step = state.steps.find(s => s.id === "s4_stb");
    step.status = "running";
    state.currentStepId = "s4_stb";
    saveState();

    const shots = getShots();
    const missingShots = shots.filter(s => !s.stb || !s.stb.ref);
    step.total = missingShots.length;
    step.progress = 0;

    if (missingShots.length === 0) {
      step.status = "done";
      step.progress = 0;
      step.message = "All shots already have STB keyframes";
      addLog("INFO", "S4: All shots already possess STB keyframes. Skipping to S6.");
      saveState();
      return true;
    }

    let failedCount = 0;

    addLog("RUN", `S4: Starting STB image generation for ${missingShots.length} shots.`);
    const bible = getBible() || {};
    const ep = getEp() || {};
    const aspect = (bible.format && bible.format.aspect) || "9:16";

    // Model selection
    let imgModel = "flux-schnell";
    if (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.image) && C.catalog.image.length) {
      imgModel = C.catalog.image[0].id || imgModel;
    }

    const imgResolution = defaultImageResolution(imgModel);
    const stbUnitCost = imagePricePerOutput(imgModel, imgResolution);
    for (let i = 0; i < missingShots.length; i++) {
      if (state.status === "paused" || state.status === "stopped") {
        addLog("WARN", "S4: Generation halted by user.");
        return false;
      }

      const shot = missingShots[i];
      const shotNo = formatShotNumber(shot.n);
      step.message = `Generating STB for ${shotNo} (${i + 1}/${missingShots.length})...`;
      updateDashboardUI();

      // Build resolved STB prompt
      let promptText = (shot.stb && shot.stb.prompt) ? shot.stb.prompt : (shot.action || "");
      if (typeof STORY !== "undefined" && STORY.prompts && typeof STORY.prompts.resolveVariables === "function") {
        promptText = STORY.prompts.resolveVariables(promptText, shot);
      }
      if (!promptText.trim()) {
        promptText = `${shot.size || "MCU"}, ${shot.angle || "eye-level"}. Action: ${shot.action || "character"}. Photoreal, cinematic.`;
      }

      // Collect reference images
      const refs = [];
      if (shot.type === "REF" && Array.isArray(shot.bank) && shot.bank.length) {
        shot.bank.forEach(b => { if (b.ref) refs.push(b.ref); });
      } else if (Array.isArray(shot.chars) && bible.chars) {
        shot.chars.forEach(cId => {
          const ch = bible.chars.find(c => c.id === cId || c.name === cId);
          if (ch && Array.isArray(ch.refs) && ch.refs.length) {
            refs.push(ch.refs[0].ref || ch.refs[0]);
          }
        });
      }

      const targetFilename = getSTBFilename(shot);

      try {
        if (typeof api !== "function") throw new Error("api() unavailable.");
        const runPayload = {
          kind: "image",
          model: imgModel,
          prompt: promptText,
          images: refs.slice(0, 4),
          aspect: aspect,
          res: imgResolution,
          node: "__story__",
          scope: "story",
          extra: `stb:${shot.id}`,
          episode: ep.ep || (ep.id || null),
          series: bible.series || null
        };

        const runRes = await api("/api/run", runPayload);
        if (!runRes || !runRes.job) {
          throw new Error((runRes && runRes.error) || "Image generation job failed to start");
        }

        state.activeJobId = runRes.job;
        saveState();

        // Poll job
        const jobResult = await pollJob(runRes.job, 1500, 300);
        state.activeJobId = null;

        if (!jobResult || jobResult.status !== "done") {
          throw new Error((jobResult && jobResult.error) || "Job did not complete successfully");
        }

        const outRef = jobOutputRef(jobResult, "image");
        if (!outRef) {
          throw new Error("No image reference returned in job output");
        }

        // Attach STB image
        if (typeof STORY !== "undefined" && STORY.links && typeof STORY.links.attachSTBImage === "function") {
          STORY.links.attachSTBImage(shot.id, outRef);
        } else {
          if (!shot.stb) shot.stb = {};
          shot.stb.version = (Number(shot.stb.version) || 0) + 1;
          shot.stb.ref = outRef;
          shot.stb.status = "done";
          shot.status = "stb";
          shot.u = Date.now();
        }

        step.progress++;
        state.spent += jobCost(jobResult, imagePricePerOutput(imgModel, imgResolution));
        addLog("RUN", `S4: [OK] STB generated for ${shotNo} -> ${targetFilename}`);
      } catch (err) {
        addLog("ERR", `S4: Failed STB for ${shotNo}: ${err.message}`);
        if (!shot.stb) shot.stb = { prompt: "", ref: "", status: "none" };
        shot.stb.status = "failed";
        shot.status = "failed";
        step.progress++;
        failedCount++;
      }

      saveState();
      updateDashboardUI();
    }

    if (failedCount) {
      step.status = "failed";
      step.message = `${failedCount} STB image(s) failed; successful images were saved. Review provider/job results before retrying.`;
      state.status = "failed";
      addLog("ERR", `S4: ${failedCount} STB image(s) failed. Autopilot stopped without creating placeholder references.`);
      saveState();
      updateDashboardUI();
      return false;
    }

    step.status = "done";
    step.message = `Completed all ${missingShots.length} STB keyframes`;
    addLog("SUCCESS", "S4: All STB keyframes generated and attached.");
    saveState();
    return true;
  }

  // ---------- In-Browser Frame Extraction for Gate B QC ----------
  // Draws video at 6 evenly distributed timestamps to an offscreen canvas and uploads as JPEG
  function extractVideoFrames(videoRef, count = 6, totalDur = 30, sourceStart = 0, rangeDur = totalDur, exactTimes = null) {
    return new Promise((resolve) => {
      if (!videoRef) {
        resolve([]);
        return;
      }

      const videoUrl = typeof src === "function" ? src(videoRef) : videoRef;
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.src = videoUrl;

      const frames = [];
      let isResolved = false;

      const timeoutId = setTimeout(() => {
        cleanup();
        if (!isResolved) {
          isResolved = true;
          addLog("WARN", `QC Frame Capture: Video load timed out after 20s. Proceeding with ${frames.length} frames.`);
          resolve(frames);
        }
      }, 20000);

      function cleanup() {
        clearTimeout(timeoutId);
        video.pause();
        video.removeAttribute("src");
        video.load();
      }

      video.onerror = (e) => {
        cleanup();
        if (!isResolved) {
          isResolved = true;
          addLog("WARN", "QC frame capture failed (likely CORS). Gate B will remain unverified.");
          resolve([]);
        }
      };

      video.onloadedmetadata = async () => {
        try {
          const actualDur = (video.duration && !isNaN(video.duration)) ? video.duration : totalDur;
          // 6 distinct timestamps: 10%, 25%, 45%, 65%, 85%, 96%; optionally constrain to a shot range.
          const pctSteps = [0.10, 0.25, 0.45, 0.65, 0.85, 0.96];
          const start = Math.max(0, Number(sourceStart) || 0);
          const available = Math.max(0.1, actualDur - start);
          const span = Math.max(0.1, Math.min(Number(rangeDur) || Number(totalDur) || available, available));
          const tsList = Array.isArray(exactTimes)
            ? exactTimes.slice(0, count).map(t => Math.max(0.1, Math.min(actualDur - 0.1, Number(t) || 0.1)))
            : pctSteps.slice(0, count).map(p => Math.max(0.1, Math.min(actualDur - 0.1, start + span * p)));

          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 720;
          canvas.height = video.videoHeight || 1280;
          const ctx = canvas.getContext("2d");

          for (let i = 0; i < tsList.length; i++) {
            const seekTime = tsList[i];
            await new Promise((seekDone, seekFail) => {
              const onSeeked = () => {
                clearTimeout(timer);
                video.removeEventListener("seeked", onSeeked);
                seekDone();
              };
              const timer = setTimeout(() => {
                video.removeEventListener("seeked", onSeeked);
                seekFail(new Error(`Frame seek timed out at ${seekTime.toFixed(2)}s.`));
              }, 2500);
              video.addEventListener("seeked", onSeeked);
              video.currentTime = seekTime;
            });

            try {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const blob = await new Promise(bRes => canvas.toBlob(bRes, "image/jpeg", 0.82));
              if (blob && typeof api === "function") {
                const proj = getProjCode();
                const epNum = getEpNumber();
                const frameName = `${proj}_EP${epNum}_QC_F${i + 1}_${Date.now()}.jpg`;
                const uploadRes = await api("/api/upload", blob, frameName);
                if (uploadRes && uploadRes.ref) {
                  frames.push(uploadRes.ref);
                }
              }
            } catch (drawErr) {
              console.warn("Canvas frame draw/upload error:", drawErr);
            }
          }
        } catch (procErr) {
          console.warn("Frame extraction process error:", procErr);
        } finally {
          cleanup();
          if (!isResolved) {
            isResolved = true;
            resolve(frames);
          }
        }
      };
    });
  }

  // ---------- Gate B QC Evaluation Engine (KTOONS_STANDARDS §4.4) ----------
  async function runQCEvaluation(targetId, blockNum, videoRef, dur, promptText, sourceStart = 0, state = null) {
    addLog("QC", `Running Gate B QC on ${targetId}... Extracting 6 validation frames.`);
    const extractedFrames = await extractVideoFrames(videoRef, 6, dur, sourceStart, dur);
    addLog("QC", `Extracted ${extractedFrames.length}/6 frames for vision analysis.`);

    if (extractedFrames.length !== 6) {
      return {
        target: targetId,
        scores: {},
        issues: [`QC requires six readable frames; received ${extractedFrames.length}.`],
        verdict: "unverified",
        fix_at_sec: 0,
        fix_prompt: ""
      };
    }

    let qcResult = null;

    if (typeof STORY !== "undefined" && STORY.ai && typeof STORY.ai.run === "function" && extractedFrames.length > 0) {
      try {
        const aiRes = await STORY.ai.run(
          "qc_reviewer",
          {
            target: targetId,
            dur: dur,
            prompt: promptText ? promptText.substring(0, 1500) : "",
            frames_extracted: extractedFrames.length
          },
          {
            images: extractedFrames,
            timeout_s: 180
          }
        );
        if (state && aiRes) state.spent += jobCost(aiRes, QC_LLM_COST_ESTIMATE_USD);
        if (aiRes && aiRes.json) {
          qcResult = aiRes.json;
        }
      } catch (aiErr) {
        addLog("WARN", `QC AI evaluation failed: ${aiErr.message}. The clip remains unverified.`);
      }
    }

    const requiredScores = ["identity", "raccord", "action", "lighting", "artifacts"];
    const rawScores = qcResult && qcResult.scores;
    if (!rawScores || requiredScores.some(k => !Number.isFinite(Number(rawScores[k])) || Number(rawScores[k]) < 0 || Number(rawScores[k]) > 5)) {
      return {
        target: targetId,
        scores: rawScores || {},
        issues: ["QC reviewer did not return all five valid 0–5 scores."],
        verdict: "unverified",
        fix_at_sec: 0,
        fix_prompt: ""
      };
    }

    // Compute pass / fail criteria per KTOONS_STANDARDS §4.4
    // Pass condition: All scores >= 3 AND mean >= 3.8
    const scores = qcResult.scores || {};
    const scoreVals = requiredScores.map(k => Number(scores[k]));
    const meanScore = scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length;
    const allGte3 = scoreVals.every(v => v >= 3);
    const passesRules = (allGte3 && meanScore >= 3.8);
    qcResult.verdict = String(qcResult.verdict || "regen").toLowerCase();
    qcResult.issues = Array.isArray(qcResult.issues) ? qcResult.issues : [];

    if (passesRules) {
      qcResult.verdict = "pass";
    } else if (qcResult.verdict !== "fix_frame") {
      qcResult.verdict = "regen";
    }

    addLog("QC", `${targetId} QC Verdict: ${qcResult.verdict.toUpperCase()} (Avg: ${meanScore.toFixed(2)})`);
    return qcResult;
  }

  // ---------- Fix Frame Handler (KTOONS_STANDARDS §5) ----------
  async function applyFixFrame(shot, qcResult, state, sourceFrameRef) {
    const shotNo = formatShotNumber(shot.n);
    const fixPrompt = qcResult.fix_prompt || "Correct face deformation and posture consistency";
    addLog("QC", `Applying Fix Frame on ${shotNo} at ${qcResult.fix_at_sec || 0}s: "${fixPrompt}"`);

    // Flag shot for redo with note
    if (!shot.video) shot.video = {};
    if (!shot.stb) shot.stb = {};
    shot.video.status = "redo";
    shot.video.note = fixPrompt;
    shot.qc = qcResult;
    shot.status = "video";
    shot.u = Date.now();

    // Generate corrected STB keyframe using existing STB image as reference
    const bible = getBible() || {};
    const aspect = (bible.format && bible.format.aspect) || "9:16";
    const refImg = [sourceFrameRef, shot.stb && shot.stb.ref].filter(Boolean).slice(0, 4);
    const imageModels = (typeof C !== "undefined" && C && C.catalog && Array.isArray(C.catalog.image)) ? C.catalog.image : [];
    const imageModel = imageModels[0] || null;
    const imageResolution = defaultImageResolution(imageModel && imageModel.id);

    let fixed = false;
    try {
      if (typeof api !== "function") throw new Error("Image API is unavailable.");
      if (!sourceFrameRef) throw new Error("Could not extract the failed frame at the QC timestamp.");
      {
        const fixRes = await api("/api/run", {
          kind: "image",
          model: imageModel && imageModel.id ? imageModel.id : "flux-schnell",
          prompt: `FIX KEYFRAME using the failed video frame as the composition/continuity source and the storyboard reference for identity: ${fixPrompt}. Preserve camera, framing, action phase, and all correct details; change only the identified defect.`,
          images: refImg,
          aspect: aspect,
          res: imageResolution,
          node: "__story__",
          scope: "story",
          extra: `fix_frame:${shot.id}`
        });

        if (!fixRes || !fixRes.job) throw new Error((fixRes && fixRes.error) || "Fix-frame image job failed to start.");
        if (state) { state.activeJobId = fixRes.job; saveState(); }
        const fixJobRes = await pollJob(fixRes.job, 1500, 200);
        if (state) state.activeJobId = null;
        if (!fixJobRes || fixJobRes.status !== "done") throw new Error((fixJobRes && fixJobRes.error) || "Fix-frame image job did not complete.");
        const newRef = jobOutputRef(fixJobRes, "image");
        if (!newRef) throw new Error("Fix-frame job returned no image reference.");
        shot.stb.version = (Number(shot.stb.version) || (shot.stb.ref ? 1 : 0)) + 1;
        shot.stb.ref = newRef;
        shot.stb.status = "done";
        if (state) state.spent += jobCost(fixJobRes, imagePricePerOutput(imageModel && imageModel.id, imageResolution));
        fixed = newRef;
        addLog("SUCCESS", `Generated corrected STB keyframe for ${shotNo}; the corrected video still requires generation and QC.`);
      }
    } catch (e) {
      addLog("ERR", `Fix-frame image failed for ${shotNo}: ${e.message}`);
      console.warn("Fix frame STB gen error:", e);
    }
    return fixed;
  }

  async function renderFixShot(shot, qcResult, state, blockNum, sourceFrameRef) {
    const correctedImageRef = await applyFixFrame(shot, qcResult, state, sourceFrameRef);
    if (!correctedImageRef) return false;

    const model = selectVideoModel(true);
    const modelId = model && model.id ? model.id : "bytedance/seedance-2.0-fast/image-to-video";
    const duration = shortFixDuration(shot, model);
    const resolution = defaultVideoResolution(modelId);
    const prompt = `${(shot.vprompt && shot.vprompt.text) || shot.action || "Preserve the shot action and camera."}\n\nUse the corrected storyboard as the first frame. Fix only this shot's defect: ${qcResult.fix_prompt || "preserve identity, continuity, and natural motion"}. Keep the same scene geography, screen direction, action phase, lighting, and visual style.`;

    try {
      if (typeof api !== "function") throw new Error("Video API is unavailable.");
      const runRes = await api("/api/run", {
        kind: "video",
        model: modelId,
        prompt,
        images: [correctedImageRef],
        duration,
        ratio: ((getBible() || {}).format || {}).aspect || "9:16",
        resolution,
        strict: true,
        node: "__story__",
        scope: "story",
        extra: `fix_shot:${shot.id}`
      });
      if (!runRes || !runRes.job) throw new Error((runRes && runRes.error) || "Corrected-shot video job failed to start.");
      state.activeJobId = runRes.job;
      saveState();
      const jobResult = await pollJob(runRes.job, 2500, 300);
      state.activeJobId = null;
      if (!jobResult || jobResult.status !== "done") throw new Error((jobResult && jobResult.error) || "Corrected-shot video job did not complete.");
      const ref = jobOutputRef(jobResult, "video");
      if (!ref) throw new Error("Corrected-shot video returned no playable media reference.");

      if (!shot.video) shot.video = {};
      shot.video.ref = ref;
      shot.video.model = modelId;
      shot.video.dur = duration;
      shot.video.resolution = resolution;
      shot.video.version = (Number(shot.video.version) || 0) + 1;
      shot.video.sourceMode = "shot";
      shot.video.status = "done";
      shot.status = "video";
      state.spent += jobCost(jobResult, duration * videoPricePerSecond(modelId, resolution));

      const fixQC = await runQCEvaluation(formatShotNumber(shot.n), blockNum, ref, duration, prompt, 0, state);
      shot.qc = fixQC;
      if (fixQC.verdict !== "pass") {
        shot.video.status = fixQC.verdict === "unverified" ? "needs_review" : "redo";
        shot.video.note = "Corrected short clip did not pass verified QC; manual review required.";
        addLog("ERR", `Corrected short clip for ${formatShotNumber(shot.n)} is ${fixQC.verdict}; the shot remains unapproved.`);
        return false;
      }

      // A passing repair clip remains in review; the original multi-shot block failed Gate B.
      shot.video.status = "done";
      addLog("SUCCESS", `Corrected short clip generated and QC-passed for ${formatShotNumber(shot.n)}; manual approval is still required.`);
      return true;
    } catch (err) {
      state.activeJobId = null;
      if (!shot.video) shot.video = {};
      shot.video.status = "failed";
      shot.video.note = err.message;
      shot.status = "failed";
      addLog("ERR", `Corrected short clip failed for ${formatShotNumber(shot.n)}: ${err.message}`);
      return false;
    }
  }

  // ---------- S6: Video Generation & QC Engine ----------
  async function runStepS6(state) {
    const step = state.steps.find(s => s.id === "s6_video");
    step.status = "running";
    state.currentStepId = "s6_video";
    saveState();

    const shots = getShots();
    const bible = getBible() || {};
    const ep = getEp() || {};
    const format = bible.format || {};
    const genMode = format.genMode || "block"; // 'block' | 'shot'

    if (!shots.length) {
      step.status = "failed";
      step.message = "No shots are available for video generation.";
      state.status = "failed";
      addLog("ERR", "S6: Empty shotlist; no video jobs were submitted.");
      saveState();
      updateDashboardUI();
      return false;
    }

    // Determine target video model
    const selectedVideoModel = selectVideoModel(false);
    const vModel = selectedVideoModel && selectedVideoModel.id ? selectedVideoModel.id : "seedance-2.5";
    const vResolution = defaultVideoResolution(vModel);
    const videoSecPrice = videoPricePerSecond(vModel, vResolution);

    if (genMode === "block") {
      // Group shots by block (3 blocks default)
      const blockGroups = {};
      shots.forEach(s => {
        const b = s.block || 1;
        if (!blockGroups[b]) blockGroups[b] = [];
        blockGroups[b].push(s);
      });

      const blockNums = Object.keys(blockGroups).map(Number).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
      if (!blockNums.length) {
        step.status = "failed";
        step.message = "No populated video blocks were found.";
        state.status = "failed";
        addLog("ERR", "S6: No populated blocks; no video jobs were submitted.");
        saveState();
        updateDashboardUI();
        return false;
      }
      step.total = blockNums.length;
      step.progress = 0;

      for (const bNum of blockNums) {
        if (state.status === "paused" || state.status === "stopped") {
          addLog("WARN", "S6: Video generation paused by user.");
          return false;
        }

        const blockShots = blockGroups[bNum] || [];
        const blockKey = `B${bNum}`;
        const baseVideoVersion = Math.max(0, ...blockShots.map(s => {
          const current = Number(s.video && s.video.version);
          return Number.isFinite(current) && current > 0 ? current : (s.video && s.video.ref ? 1 : 0);
        }));

        // Check if block is already approved
        const isApproved = blockShots.length > 0 && blockShots.every(s => s.video && s.video.status === "approved" && s.video.ref);
        if (isApproved) {
          step.progress++;
          addLog("INFO", `S6: Block ${bNum} already approved. Skipping.`);
          continue;
        }

        let blockSuccess = false;
        while (!blockSuccess) {
          const attempt = (state.attempts[blockKey] || 0) + 1;
          state.attempts[blockKey] = attempt;
          saveState();

          step.message = `Generating Video for Block ${bNum} (Attempt ${attempt}/2)...`;
          updateDashboardUI();
          addLog("RUN", `S6: Generating Block ${bNum} (Attempt ${attempt}/2) via ${vModel}...`);

          // Prepare block prompt
          let blockPrompt = "";
          if (ep.blocks && ep.blocks[bNum - 1] && ep.blocks[bNum - 1].vprompt && ep.blocks[bNum - 1].vprompt.text) {
            blockPrompt = ep.blocks[bNum - 1].vprompt.text;
          } else if (typeof STORY !== "undefined" && STORY.prompts && typeof STORY.prompts.fillBlock === "function") {
            const fillRes = STORY.prompts.fillBlock(bNum);
            blockPrompt = fillRes ? fillRes.prompt : "";
          }

          if (!blockPrompt) {
            blockPrompt = `[GLOBAL PARAMETERS] Duration: 30s. Episode: ${getEpNumber()}. Location: INT. LOCATION.\n[TIMESTAMP STORYBOARD]\n00:00-00:30 Cinematic action sequence.`;
          }

          // Build Reference Bank (KTOONS_STANDARDS §3 <= 9 images)
          let bankRefs = [];
          if (typeof STORY !== "undefined" && STORY.prompts && typeof STORY.prompts.buildReferenceBank === "function") {
            const bData = STORY.prompts.buildReferenceBank(bNum);
            if (bData && Array.isArray(bData.items)) {
              bankRefs = bData.items.map(it => it.ref).filter(Boolean);
            }
          }
          if (!bankRefs.length) {
            // Collect from shot STBs
            blockShots.forEach(s => {
              if (s.stb && s.stb.ref) bankRefs.push(s.stb.ref);
            });
          }
          bankRefs = bankRefs.slice(0, 9); // Enforce <= 9 images

          let videoRef = "";
          let jobResult = null;
          try {
            if (typeof api !== "function") throw new Error("api() unavailable.");
            const runPayload = {
              kind: "video",
              model: vModel,
              prompt: blockPrompt,
              images: bankRefs,
              duration: 30,
              ratio: format.aspect || "9:16",
              resolution: vResolution,
              node: "__story__",
              scope: "story",
              extra: `block:${bNum}`,
              episode: ep.ep || ep.id || null,
              series: bible.series || null
            };

            const runRes = await api("/api/run", runPayload);
            if (!runRes || !runRes.job) {
              throw new Error((runRes && runRes.error) || "Video job failed to start");
            }

            state.activeJobId = runRes.job;
            saveState();

            // Poll video job (takes longer, up to 15 mins)
            jobResult = await pollJob(runRes.job, 2500, 400);
            state.activeJobId = null;

            if (!jobResult || jobResult.status !== "done") {
              throw new Error((jobResult && jobResult.error) || "Video generation job failed");
            }

            videoRef = jobOutputRef(jobResult, "video");
            if (!videoRef) throw new Error("Video job completed without a playable video reference.");
          } catch (vErr) {
            addLog("ERR", `Video generation error on Block ${bNum}: ${vErr.message}`);
            step.status = "failed";
            step.message = `Block ${bNum} failed. Check the provider/job before retrying; no placeholder video was recorded.`;
            state.status = "failed";
            saveState();
            updateDashboardUI();
            return false;
          }

          state.spent += jobCost(jobResult, 30 * videoPricePerSecond(vModel, vResolution));
          addLog("RUN", `S6: Block ${bNum} video output ready: ${videoRef}`);

          // Assign video ref to block shots
          blockShots.forEach(s => {
            if (!s.video) s.video = {};
            s.video.ref = videoRef;
            s.video.dur = 30;
            s.video.model = vModel;
            s.video.resolution = vResolution;
            s.video.version = baseVideoVersion + attempt;
            s.video.sourceMode = "block";
            s.video.status = "done";
            s.status = "video";
            s.u = Date.now();
          });

          // Run Gate B QC with 6 extracted frames (KTOONS_STANDARDS §4.4)
          step.message = `Running Gate B QC on Block ${bNum}...`;
          updateDashboardUI();
          const qcResult = await runQCEvaluation(`B${bNum}`, bNum, videoRef, 30, blockPrompt, 0, state);

          if (qcResult.verdict === "unverified") {
            blockShots.forEach(s => {
              if (!s.video) s.video = {};
              s.video.status = "needs_review";
              s.qc = qcResult;
              s.status = "video";
            });
            step.status = "failed";
            step.message = `Block ${bNum} has no valid six-frame QC result. It was not approved.`;
            state.status = "failed";
            addLog("ERR", `S6: Block ${bNum} remains unverified; Autopilot stopped before edit assembly.`);
            saveState();
            updateDashboardUI();
            return false;
          }

          if (qcResult.verdict === "pass") {
            // QC Passed
            blockShots.forEach(s => {
              s.video.status = "approved";
              s.status = "approved";
              s.qc = qcResult;
            });
            blockSuccess = true;
            addLog("SUCCESS", `S6: [PASS] Block ${bNum} approved after attempt ${attempt}.`);
          } else if (attempt < 2) {
            // Attempt 1 failed QC -> Regenerate whole block (Max 2 attempts per block, §5)
            addLog("WARN", `S6: Block ${bNum} failed QC on attempt 1 (${qcResult.issues.join(", ") || "scores low"}). Retrying attempt 2...`);
            continue;
          } else {
            // Attempt 2 failed QC -> repair only the broken shot; never submit a third full block.
            addLog("WARN", `S6: Block ${bNum} reached attempt limit (2/2). Extracting the failed frame and rendering one short repair clip.`);
            const fixAt = Math.max(0, Number(qcResult.fix_at_sec) || 0);
            let cursor = 0;
            let brokenShot = null;
            for (const candidate of blockShots) {
              const end = cursor + (Number(candidate.dur) || 6);
              if (fixAt >= cursor && fixAt < end) {
                brokenShot = candidate;
                break;
              }
              cursor = end;
            }
            if (!brokenShot) {
              brokenShot = blockShots[blockShots.length - 1] || blockShots[0];
            }
            blockShots.forEach(s => {
              if (!s.video) s.video = {};
              s.video.status = "needs_review";
              s.blockQc = qcResult;
              s.qc = qcResult;
              s.status = "video";
            });
            const failedFrame = brokenShot
              ? await extractVideoFrames(videoRef, 1, 30, 0, 30, [fixAt])
              : [];
            const repairReady = brokenShot && failedFrame.length
              ? await renderFixShot(brokenShot, qcResult, state, bNum, failedFrame[0])
              : false;
            step.status = "failed";
            step.message = repairReady
              ? `A short repair clip for ${formatShotNumber(brokenShot.n)} passed QC. Review and approve every shot in the failed block before continuing.`
              : `The block reached its 2-attempt limit. The repair clip did not pass or could not be generated; review the block manually.`;
            state.status = "failed";
            addLog("ERR", repairReady
              ? `S6: Short repair clip passed QC for ${formatShotNumber(brokenShot.n)}. Original block QC failed, so all shots remain unapproved pending Board review.`
              : `S6: Short repair clip could not be verified for Block ${bNum}. No shot was auto-approved.`);
            saveState();
            updateDashboardUI();
            return false;
          }
        }

        step.progress++;
        saveState();
        updateDashboardUI();
      }
    } else {
      // Per-shot generation mode
        const shotsNeedingGen = shots.filter(s => !s.video || s.video.status !== "approved" || !s.video.ref);
      step.total = shotsNeedingGen.length;
      step.progress = 0;

      for (let i = 0; i < shotsNeedingGen.length; i++) {
        if (state.status === "paused" || state.status === "stopped") {
          addLog("WARN", "S6: Video generation paused by user.");
          return false;
        }

        const shot = shotsNeedingGen[i];
        const shotNo = formatShotNumber(shot.n);
        step.message = `Generating Video for ${shotNo} (${i + 1}/${shotsNeedingGen.length})...`;
        updateDashboardUI();

        const dur = Number(shot.dur) || 6;
        const promptText = (shot.vprompt && shot.vprompt.text) ? shot.vprompt.text : (shot.action || "");
        const stbRef = (shot.stb && shot.stb.ref) ? shot.stb.ref : "";
        const shotModelInfo = selectVideoModel(shot.type !== "REF");
        const shotModel = (shotModelInfo && shotModelInfo.id) || vModel;
        const shotResolution = defaultVideoResolution(shotModel);
        const shotVideoVersion = (Number(shot.video && shot.video.version) || (shot.video && shot.video.ref ? 1 : 0)) + 1;

        try {
          if (typeof api !== "function") throw new Error("api() unavailable.");
          const runRes = await api("/api/run", {
            kind: "video",
            model: shotModel,
            prompt: promptText,
            images: stbRef ? [stbRef] : [],
            duration: dur,
            ratio: format.aspect || "9:16",
            resolution: shotResolution,
            node: "__story__",
            scope: "story",
            extra: `shot:${shot.id}`
          });

          if (runRes && runRes.job) {
            state.activeJobId = runRes.job;
            saveState();
            const jobResult = await pollJob(runRes.job, 2000, 300);
            state.activeJobId = null;
            if (!jobResult || jobResult.status !== "done") {
              throw new Error((jobResult && jobResult.error) || "Video job did not complete successfully.");
            }
            const outRef = jobOutputRef(jobResult, "video");
            if (!outRef) throw new Error("Video job completed without a playable video reference.");
            if (!shot.video) shot.video = {};
            shot.video.ref = outRef;
            shot.video.status = "done";
            shot.video.model = shotModel;
            shot.video.dur = dur;
            shot.video.resolution = shotResolution;
            shot.video.version = shotVideoVersion;
            shot.video.sourceMode = "shot";
            state.spent += jobCost(jobResult, dur * videoPricePerSecond(shot.video.model, shotResolution));
            const shotQC = await runQCEvaluation(shotNo, shot.block || 1, outRef, dur, promptText, 0, state);
            shot.qc = shotQC;
            if (shotQC.verdict === "pass") {
              shot.video.status = "approved";
              shot.status = "approved";
              addLog("SUCCESS", `S6: [PASS] Video generated and QC-approved for ${shotNo}`);
            } else {
              shot.video.status = shotQC.verdict === "unverified" ? "needs_review" : "redo";
              shot.status = "video";
              step.status = "failed";
              step.message = `${shotNo} did not pass verified QC; it remains unapproved.`;
              state.status = "failed";
              addLog("ERR", `S6: ${shotNo} QC is ${shotQC.verdict}. Stopping before timeline assembly.`);
              saveState();
              updateDashboardUI();
              return false;
            }
          } else {
            throw new Error((runRes && runRes.error) || "Video job failed to start.");
          }
        } catch (e) {
          addLog("ERR", `S6: Failed video for ${shotNo}: ${e.message}`);
          if (!shot.video) shot.video = {};
          shot.video.status = "failed";
          shot.status = "failed";
          step.status = "failed";
          step.message = `${shotNo} failed. Check provider/job state before retrying.`;
          state.status = "failed";
          saveState();
          updateDashboardUI();
          return false;
        }

        step.progress++;
        saveState();
        updateDashboardUI();
      }
    }

    step.status = "done";
    step.message = "All video blocks/shots generated and approved";
    addLog("SUCCESS", "S6: Video generation & Gate B QC complete.");
    saveState();
    return true;
  }

  // ---------- S7: Download & Asset Naming Engine (KTOONS_STANDARDS §2) ----------
  async function runStepS7(state) {
    const step = state.steps.find(s => s.id === "s7_naming");
    step.status = "running";
    state.currentStepId = "s7_naming";
    saveState();

    const shots = getShots();
    step.total = shots.length;
    step.progress = 0;
    step.message = "Verifying KTOONS asset naming conventions...";
    updateDashboardUI();

    addLog("RUN", "S7: Organizing assets and verifying naming conventions per §2...");
    const bible = getBible() || {};
    const genMode = (bible.format && bible.format.genMode) || "block";
    const renameCache = new Map();
    const renameErrors = [];

    async function uploadNamedCopy(ref, filename) {
      const mediaUrl = typeof src === "function" ? src(ref) : ref;
      const response = await fetch(mediaUrl);
      if (!response.ok) throw new Error(`Could not read existing media (${response.status}).`);
      if (typeof api !== "function") throw new Error("Upload API is unavailable.");
      const uploaded = await api("/api/upload", await response.blob(), filename);
      if (!uploaded || !uploaded.ref) throw new Error((uploaded && uploaded.error) || "Named upload returned no media reference.");
      return uploaded.ref;
    }

    function hasTargetFilename(ref, filename) {
      const leaf = String(ref || "").split(/[?#]/)[0].split("/").pop();
      let normalized = leaf;
      try { normalized = decodeURIComponent(leaf); } catch (e) {}
      const actual = normalized.toLowerCase();
      const expected = filename.toLowerCase();
      // /api/upload prepends HHMMSS_ to the requested standard filename.
      return actual === expected || actual.endsWith(`_${expected}`);
    }

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const targetSTBName = getSTBFilename(shot, Number(shot.stb && shot.stb.version) || 1);
      const targetVideoName = getVideoFilename(shot, Number(shot.video && shot.video.version) || 1);

      if (shot.stb && shot.stb.ref && !hasTargetFilename(shot.stb.ref, targetSTBName)) {
        try {
          const cacheKey = `${shot.stb.ref}|${targetSTBName}`;
          shot.stb.ref = renameCache.get(cacheKey) || await uploadNamedCopy(shot.stb.ref, targetSTBName);
          renameCache.set(cacheKey, shot.stb.ref);
        } catch (e) {
          renameErrors.push(`${formatShotNumber(shot.n)} STB: ${e.message}`);
        }
      }

      if (shot.video && shot.video.ref) {
        const originalRef = shot.video.ref;
        const isBlockClip = genMode === "block" && (shot.video.sourceMode || "block") !== "shot";
        const target = isBlockClip
          ? getVideoBlockFilename(shot.block || 1, Number(shot.video.version) || 1)
          : targetVideoName;
        if (!hasTargetFilename(originalRef, target)) {
          try {
            const cacheKey = `${originalRef}|${target}`;
            const namedRef = renameCache.get(cacheKey) || await uploadNamedCopy(originalRef, target);
            renameCache.set(cacheKey, namedRef);
            shots.forEach(other => {
              const otherIsBlockClip = genMode === "block" && (other.video && other.video.sourceMode || "block") !== "shot";
              const sameAsset = other.video && other.video.ref === originalRef &&
                (isBlockClip
                  ? otherIsBlockClip && (Number(other.block) || 1) === (Number(shot.block) || 1)
                  : !otherIsBlockClip);
              if (sameAsset) other.video.ref = namedRef;
            });
          } catch (e) {
            renameErrors.push(`${formatShotNumber(shot.n)} video: ${e.message}`);
          }
        }
      }

      step.progress++;
    }

    if (renameErrors.length) {
      step.status = "failed";
      step.message = `Could not copy/name ${renameErrors.length} asset(s). Existing source refs were kept.`;
      state.status = "failed";
      renameErrors.forEach(message => addLog("ERR", `S7: ${message}`));
      saveState();
      updateDashboardUI();
      return false;
    }

    step.status = "done";
    step.message = "Asset naming standards verified";
    addLog("SUCCESS", "S7: Existing STB/video files were copied to the standard names and their references updated.");
    saveState();
    return true;
  }

  // ---------- S8: Assemble in Video Editor Engine ----------
  async function runStepS8(state) {
    const step = state.steps.find(s => s.id === "s8_edit");
    step.status = "running";
    state.currentStepId = "s8_edit";
    saveState();

    step.message = "Assembling sequence timeline in Video Editor...";
    updateDashboardUI();
    addLog("RUN", "S8: Creating the edit through the reviewed Story Links → Video Editor path...");

    const ep = getEp() || {};
    try {
      if (typeof STORY === "undefined" || !STORY.links || typeof STORY.links.sendToVideoEditor !== "function") {
        throw new Error("Story Links timeline builder is unavailable.");
      }
      const built = await STORY.links.sendToVideoEditor();
      const pid = ep.links && ep.links.vedit;
      if (!built || !pid) throw new Error("Video Editor did not confirm a timeline project ID.");

      step.status = "done";
      step.message = "Timeline created and opened in Video Editor";
      state.status = "done";
      state.currentStepId = "done";
      addLog("SUCCESS", `S8: Timeline created and confirmed (PID: ${pid}).`);
      addLog("SUCCESS", "Autopilot Production finished successfully.");
      saveState();
      updateDashboardUI();
      if (typeof toast === "function") toast("Autopilot Production Complete!");
      return true;
    } catch (editErr) {
      step.status = "failed";
      step.message = `Timeline assembly failed: ${editErr.message}`;
      state.status = "failed";
      addLog("ERR", `S8: ${editErr.message}. Autopilot was not marked complete.`);
      saveState();
      updateDashboardUI();
      if (typeof toast === "function") toast("Video Editor assembly failed; Autopilot remains incomplete.", true);
      return false;
    }
  }

  // ---------- General Server Job Poller with Cancel Support ----------
  function pollJob(jobId, intervalMs = 1500, maxAttempts = 300) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const pollTimer = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(pollTimer);
          reject(new Error("Job polling timed out after max attempts"));
          return;
        }

        const state = ensureAutopilotState();
        if (state.status === "stopped" || state.status === "paused") {
          clearInterval(pollTimer);
          // Cancel job on server
          if (typeof api === "function") {
            try { await api("/api/job_stop", { id: jobId }); } catch (e) { /* ignore */ }
          }
          resolve({ status: "cancelled" });
          return;
        }

        try {
          if (typeof api !== "function") throw new Error("api() unavailable.");
          const res = await api(`/api/job?id=${encodeURIComponent(jobId)}`);
          if (res && (res.status === "done" || res.status === "failed")) {
            clearInterval(pollTimer);
            resolve(res);
          }
        } catch (pollErr) {
          console.warn("Transient job poll error:", pollErr);
        }
      }, intervalMs);
    });
  }

  // ---------- Main Autopilot Orchestrator ----------
  async function runAutopilotProduction() {
    const state = ensureAutopilotState();
    if (state.status === "running") {
      addLog("WARN", "Autopilot is already running.");
      return;
    }
    if (state.status === "failed") {
      if (typeof toast === "function") toast("Autopilot stopped on a generation or QC failure. Check the provider/job and fix the failed shot before Reset and retry.", true);
      return;
    }

    // Step 0: Cost Estimation & Approval Gate
    state.status = "estimating";
    updateDashboardUI();
    const estimates = await estimateProductionCosts();
    if (estimates.retryLimitBlocks && estimates.retryLimitBlocks.length) {
      const list = estimates.retryLimitBlocks.map(formatBlockNumber).join(", ");
      state.status = "failed";
      state.error = `Retry limit reached for ${list}. Review and approve or correct every shot in those blocks before continuing.`;
      addLog("ERR", `Cost Gate: ${state.error} No generation request was sent.`);
      saveState();
      updateDashboardUI();
      renderAutopilotModal(true);
      if (typeof toast === "function") toast("The block retry limit is reached; manual review is required before production can continue.", true);
      return;
    }
    state.estimatedTotal = estimates.estimatedTotal;
    state.budgetCap = estimates.budgetCap;
    state.estimateBreakdown = {
      stb: estimates.stbTotalCost,
      video: estimates.videoTotalCost,
      fixFrameImage: estimates.fixFrameImageCost,
      fixVideo: estimates.fixVideoTotalCost,
      qcLLM: estimates.qcLLMCost,
      qcCalls: estimates.qcCalls,
      videoSeconds: estimates.videoTotalSecs,
      reserveAttempts: 2
    };
    state.error = "";

    if (estimates.isOverCap) {
      state.status = "failed";
      state.error = `Maximum planned spend ${_usd(estimates.alreadySpent + estimates.estimatedTotal)} exceeds episode cap ${_usd(estimates.budgetCap)}.`;
      addLog("ERR", `Cost Gate: ${state.error} Paid generation was blocked.`);
      saveState();
      updateDashboardUI();
      renderAutopilotModal(true);
      if (typeof toast === "function") toast("Cost gate blocked production because the maximum plan exceeds the episode cap.", true);
      return;
    }

    const bible = getBible() || {};
    const autoApprove = Boolean(bible.format && (bible.format.autoApprove || (bible.format.auto && bible.format.auto.VIDEO)));

    if (!autoApprove && state.approvedCost < estimates.estimatedTotal) {
      state.status = "awaiting_approval";
      addLog("INFO", `Cost Gate: Estimated production cost is ${_usd(estimates.estimatedTotal)}. Awaiting user approval.`);
      saveState();
      updateDashboardUI();
      renderAutopilotModal(true);
      return;
    }

    // Start production execution
    state.status = "running";
    state.startedAt = state.startedAt || Date.now();
    addLog("INFO", "Starting Autopilot Production execution loop...");
    saveState();
    updateDashboardUI();

    // Step S4
    const s4Success = await runStepS4(state);
    if (!s4Success || state.status !== "running") return;

    // Step S6
    const s6Success = await runStepS6(state);
    if (!s6Success || state.status !== "running") return;

    // Step S7
    const s7Success = await runStepS7(state);
    if (!s7Success || state.status !== "running") return;

    // Step S8
    await runStepS8(state);
  }

  function pauseAutopilot() {
    const state = ensureAutopilotState();
    if (state.status === "running") {
      state.status = "paused";
      addLog("WARN", "Autopilot Production paused.");
      saveState();
      updateDashboardUI();
    }
  }

  function resumeAutopilot() {
    const state = ensureAutopilotState();
    if (state.status === "paused") {
      state.status = "running";
      addLog("INFO", "Resuming Autopilot Production...");
      saveState();
      runAutopilotProduction();
    }
  }

  function cancelAutopilot() {
    const state = ensureAutopilotState();
    state.status = "stopped";
    if (state.activeJobId && typeof api === "function") {
      try { api("/api/job_stop", { id: state.activeJobId }); } catch (e) { /* ignore */ }
    }
    state.activeJobId = null;
    addLog("ERR", "Autopilot Production stopped by user.");
    saveState();
    updateDashboardUI();
  }

  function resetAutopilot() {
    const ep = getEp();
    if (ep) {
      const previous = ensureAutopilotState();
      const reset = getInitAutopilotState();
      reset.attempts = Object.assign({}, previous.attempts || {});
      reset.spent = Number(previous.spent) || 0;
      ep.autopilot = reset;
    }
    saveState();
    updateDashboardUI();
    if (typeof toast === "function") toast("Autopilot status reset; per-block generation attempt counts and spend history were preserved.");
  }

  function approveAndStart() {
    const state = ensureAutopilotState();
    state.approvedCost = state.estimatedTotal || 20.00;
    saveState();
    runAutopilotProduction();
  }

  // ---------- UI Modal & Dashboard Renderer ----------
  function renderAutopilotModal(forceOpen = false) {
    let overlay = document.getElementById("story-autopilot-modal");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "story-autopilot-modal";
      overlay.className = "story-modal-overlay";
      document.body.appendChild(overlay);
    }

    if (forceOpen) {
      overlay.hidden = false;
    }

    const state = ensureAutopilotState();
    const ep = getEp() || {};
    const epTitle = ep.title || `Episode ${getEpNumber()}`;
    const bible = getBible() || {};
    const budgetCap = Number(state.budgetCap) || (bible.format && bible.format.budgetCap) || 20.00;
    const budgetPct = Math.min(100, Math.round((state.spent / budgetCap) * 100));

    let budgetFillClass = "fill-ok";
    if (state.spent > budgetCap) budgetFillClass = "fill-danger";
    else if (budgetPct >= 70) budgetFillClass = "fill-warn";

    overlay.innerHTML = `
      <div class="story-autopilot-modal-box">
        <!-- Header -->
        <div class="story-autopilot-header">
          <div style="display:flex;align-items:center;">
            <span class="story-autopilot-title">Autopilot: Produce Episode</span>
            <span class="story-autopilot-ep-tag">${_esc(epTitle)}</span>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <span class="story-autopilot-status-badge status-${state.status}">${state.status.replace("_", " ")}</span>
            <button class="story-btn-ghost story-modal-close" data-s="autopilot_prod.close">✕</button>
          </div>
        </div>

        <!-- Body -->
        <div class="story-autopilot-body">
          <!-- Budget & Spend Gauge -->
          <div class="story-autopilot-budget-card">
            <div class="story-budget-header">
              <span class="story-budget-label">Production Spend vs Episode Cap</span>
              <span class="story-budget-stats">${_usd(state.spent)} / ${_usd(budgetCap)} (Est: ${_usd(state.estimatedTotal)})</span>
            </div>
            <div class="story-budget-bar-bg">
              <div class="story-budget-bar-fill ${budgetFillClass}" style="width: ${budgetPct}%;"></div>
            </div>
          </div>
          ${state.error ? `<div class="story-cost-gate-box"><div class="story-cost-gate-title">Production stopped</div><div>${_esc(state.error)}</div></div>` : ""}

          <!-- Cost Gate Approval Notice (if awaiting approval) -->
          ${state.status === "awaiting_approval" ? `
            <div class="story-cost-gate-box">
              <div class="story-cost-gate-title">Cost Gate: Production Approval Required</div>
              <div class="story-cost-gate-breakdown">
                <div>Estimated Total: <strong>${_usd(state.estimatedTotal)}</strong></div>
                <div>Episode Budget Cap: <strong>${_usd(budgetCap)}</strong></div>
                <div>Mode: <strong>${bible.format?.genMode === "shot" ? "Per-Shot (I2V)" : "3 Blocks x 30s (Seedance 2.5)"}</strong></div>
                <div>Retry policy: <strong>${bible.format?.genMode === "shot" ? "Per-shot stops for review after QC failure" : "up to 2 attempts per block"}</strong></div>
                <div>Fix-frame image reserve: <strong>${_usd(state.estimateBreakdown && state.estimateBreakdown.fixFrameImage || 0)}</strong></div>
                <div>Short replacement clip reserve: <strong>${_usd(state.estimateBreakdown && state.estimateBreakdown.fixVideo || 0)}</strong></div>
                <div>Gate B QC LLM reserve: <strong>${_usd(state.estimateBreakdown && state.estimateBreakdown.qcLLM || 0)}</strong> (${Number(state.estimateBreakdown && state.estimateBreakdown.qcCalls) || 0} checks)</div>
                <div>QC Gate B: <strong>Active (6 Vision Frames)</strong></div>
              </div>
              <div class="story-cost-gate-actions">
                <button class="story-btn-ghost" data-s="autopilot_prod.cancel">Decline</button>
                <button class="story-btn-gold" data-s="autopilot_prod.approve" style="font-weight:700;">
                  Approve ${_usd(state.estimatedTotal)} & Start Production
                </button>
              </div>
            </div>
          ` : ""}

          <!-- Stepper Checklist -->
          <div class="story-autopilot-stepper">
            ${state.steps.map(step => {
              const isActive = (state.currentStepId === step.id && state.status === "running");
              const isDone = (step.status === "done");
              const isFailed = (step.status === "failed");
              const pct = step.total > 0 ? Math.round((step.progress / step.total) * 100) : (isDone ? 100 : 0);

              let cardClass = "";
              if (isActive) cardClass = "active";
              else if (isDone) cardClass = "completed";
              else if (isFailed) cardClass = "error";

              return `
                <div class="story-step-card ${cardClass}">
                  <div class="story-step-top">
                    <div class="story-step-title-wrap">
                      <span class="story-step-num">${step.num}</span>
                      <span class="story-step-title">${step.title}</span>
                    </div>
                    <span class="story-step-badge badge-${step.status}">${step.status}</span>
                  </div>
                  <div class="story-step-desc">${step.message || step.title}</div>
                  <div class="story-step-progress-bar">
                    <div class="story-step-progress-fill" style="width: ${pct}%;"></div>
                  </div>
                  <div class="story-step-meta-row">
                    <span>${step.total > 0 ? `${step.progress}/${step.total} items` : (isDone ? "Complete" : "Pending")}</span>
                    <span>${pct}%</span>
                  </div>
                </div>
              `;
            }).join("")}
          </div>

          <!-- Live Event Log Console -->
          <div class="story-autopilot-log-wrap">
            <div class="story-autopilot-log-header">
              <span>Event Log (${state.logs.length} entries)</span>
              <button class="story-btn-ghost" data-s="autopilot_prod.clear_logs" style="font-size:9.5px;padding:1px 5px;">Clear</button>
            </div>
            <div class="story-autopilot-log-content" id="story-autopilot-log-view">
              ${state.logs.length ? state.logs.map(lg => {
                let tagClass = "log-tag-info";
                if (lg.tag === "RUN") tagClass = "log-tag-run";
                else if (lg.tag === "QC") tagClass = "log-tag-qc";
                else if (lg.tag === "WARN") tagClass = "log-tag-warn";
                else if (lg.tag === "ERR") tagClass = "log-tag-err";
                else if (lg.tag === "SUCCESS") tagClass = "log-tag-success";

                return `
                  <div class="log-line">
                    <span class="log-time">[${_esc(lg.time)}]</span>
                    <span class="${tagClass}">[${_esc(lg.tag)}]</span>
                    <span>${_esc(lg.text)}</span>
                  </div>
                `;
              }).join("") : `
                <div style="color:#64748b;padding:8px 0;">No log entries recorded yet. Click Start to begin production.</div>
              `}
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="story-autopilot-footer">
          <div class="story-autopilot-footer-left">
            ${state.status === "running" ? `
              <button class="story-btn-ghost" data-s="autopilot_prod.pause">Pause</button>
              <button class="story-btn-ghost" data-s="autopilot_prod.cancel" style="color:#ef4444;">Cancel</button>
            ` : (state.status === "paused" ? `
              <button class="story-btn-gold" data-s="autopilot_prod.resume">Resume</button>
              <button class="story-btn-ghost" data-s="autopilot_prod.cancel" style="color:#ef4444;">Cancel</button>
            ` : `
              <button class="story-btn-ghost" data-s="autopilot_prod.reset">Reset Status</button>
            `)}
          </div>
          <div class="story-autopilot-footer-right">
            <button class="story-btn-ghost story-modal-close" data-s="autopilot_prod.close">Close Panel</button>
            ${state.status !== "running" && state.status !== "awaiting_approval" ? `
              <button class="story-btn-gold" data-s="autopilot_prod.start" style="font-weight:700;">
                ${state.status === "done" ? "Re-Run Production" : "Start Production"}
              </button>
            ` : ""}
          </div>
        </div>
      </div>
    `;

    // Post-production hand-off: these actions remain separate cost / user-control gates.
    if (window.STORY && STORY.autoEdit && typeof STORY.autoEdit.decorateAutopilotModal === "function") {
      STORY.autoEdit.decorateAutopilotModal(overlay, state);
    }
    if (window.STORY && STORY.subtitles && typeof STORY.subtitles.decorateAutopilotModal === "function") {
      STORY.subtitles.decorateAutopilotModal(overlay, state);
    }

    // Auto-scroll log to bottom
    const logBox = overlay.querySelector("#story-autopilot-log-view");
    if (logBox) logBox.scrollTop = logBox.scrollHeight;
  }

  function updateDashboardUI() {
    const modal = document.getElementById("story-autopilot-modal");
    if (modal && !modal.hidden) {
      renderAutopilotModal(false);
    }
    updateFloatingPill();
  }

  // Floating running pill shown when modal is closed during execution
  function updateFloatingPill() {
    const state = ensureAutopilotState();
    let pill = document.getElementById("story-autopilot-floating-pill");

    if (state.status === "running" || state.status === "paused") {
      if (!pill) {
        pill = document.createElement("div");
        pill.id = "story-autopilot-floating-pill";
        pill.setAttribute("data-s", "autopilot_prod.open");
        pill.setAttribute("title", "Click to view Autopilot Production progress");
        const storyEl = document.getElementById("story");
        if (storyEl) storyEl.appendChild(pill);
        else document.body.appendChild(pill);
      }
      const curStep = state.steps.find(s => s.id === state.currentStepId);
      const stepName = curStep ? curStep.num : "PROD";
      pill.innerHTML = `
        <div class="pill-pulse-dot" style="${state.status === 'paused' ? 'background:#eab308;box-shadow:0 0 6px #eab308;' : ''}"></div>
        <div>
          <div class="pill-text">Autopilot: ${state.status.toUpperCase()} (${stepName})</div>
          <div class="pill-sub">${_usd(state.spent)} spent · click to view</div>
        </div>
      `;
      pill.hidden = false;
    } else {
      if (pill) pill.hidden = true;
    }
  }

  // ---------- Board Tab Header Injection ----------
  function injectBoardButton(container) {
    if (!container) return;
    const actionsBar = container.querySelector(".story-board-actions");
    if (!actionsBar) return;

    if (!actionsBar.querySelector("#story-btn-autopilot-prod")) {
      const state = ensureAutopilotState();
      const btn = document.createElement("button");
      btn.id = "story-btn-autopilot-prod";
      btn.className = "story-btn-autopilot-prod" + (state.status === "running" ? " running" : "");
      btn.setAttribute("data-s", "autopilot_prod.open");
      btn.setAttribute("title", "One-click automated production: STB -> Video -> QC -> Edit");
      btn.innerHTML = (state.status === "running")
        ? `Autopilot: Producing...`
        : `Autopilot: Produce Episode`;

      // Insert as first button in actions
      actionsBar.insertBefore(btn, actionsBar.firstChild);
    }
  }

  function decorateBoardView() {
    if (typeof STORY === "undefined" || !STORY.views) return;
    const origBoard = STORY.views.board;
    if (origBoard && typeof origBoard.render === "function") {
      const originalRender = origBoard.render;
      origBoard.render = function (container) {
        originalRender(container);
        injectBoardButton(container);
        updateFloatingPill();
      };
    }
  }

  // ---------- Register Story Commands ----------
  function registerCommands() {
    if (typeof STORY === "undefined" || !STORY.cmds) return;

    STORY.cmds["autopilot_prod.open"] = () => {
      renderAutopilotModal(true);
    };

    STORY.cmds["autopilot_prod.close"] = () => {
      const m = document.getElementById("story-autopilot-modal");
      if (m) m.hidden = true;
    };

    STORY.cmds["autopilot_prod.start"] = () => {
      runAutopilotProduction();
    };

    STORY.cmds["autopilot_prod.approve"] = () => {
      approveAndStart();
    };

    STORY.cmds["autopilot_prod.pause"] = () => {
      pauseAutopilot();
    };

    STORY.cmds["autopilot_prod.resume"] = () => {
      resumeAutopilot();
    };

    STORY.cmds["autopilot_prod.cancel"] = () => {
      cancelAutopilot();
    };

    STORY.cmds["autopilot_prod.reset"] = () => {
      resetAutopilot();
    };

    STORY.cmds["autopilot_prod.clear_logs"] = () => {
      const state = ensureAutopilotState();
      state.logs = [];
      saveState();
      updateDashboardUI();
    };

    // Generic command alias
    STORY.cmds["autopilot.produce"] = () => {
      renderAutopilotModal(true);
    };
  }

  // ---------- Public Module Exposure ----------
  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Expose STORY.autopilotProd API
    STORY.autopilotProd = {
      run: runAutopilotProduction,
      pause: pauseAutopilot,
      resume: resumeAutopilot,
      cancel: cancelAutopilot,
      reset: resetAutopilot,
      approveAndStart: approveAndStart,
      estimateCosts: estimateProductionCosts,
      extractVideoFrames: extractVideoFrames,
      openDashboard: () => renderAutopilotModal(true),
      closeDashboard: () => {
        const m = document.getElementById("story-autopilot-modal");
        if (m) m.hidden = true;
      },
      getState: ensureAutopilotState
    };

    registerCommands();
    decorateBoardView();

    // Extension Hook: Resume or restore pill if running after reload
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) {
      STORY.hooks.afterLoad.push(() => {
        const state = ensureAutopilotState();
        if (state.status === "running") {
          addLog("INFO", "Resuming active Autopilot Production after page reload.");
          updateFloatingPill();
          runAutopilotProduction();
        }
      });
    }
  }

  // Auto-initialize
  if (typeof window !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initModule);
    } else {
      initModule();
    }
  }
})();
