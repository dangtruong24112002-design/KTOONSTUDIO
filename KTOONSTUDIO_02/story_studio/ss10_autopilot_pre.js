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
// - None for Task 008. Relies on /api/run (kind: "llm", node: "__story__", scope: "story"),
//   /api/job?id=, /api/job_stop, and /api/desk/batch.
//
// App changes needed:
// - None. Dynamically integrates into Story Studio header and Script view,
//   and registers commands under STORY.cmds["autopilot.*"].
//
// Known limitations:
// - Autopilot pre-production runs text-only generation (S1 to S5): no image or video generation is performed here.
// - All-episodes queue sequentially switches episodes via loadDesk and runs the full chain.
// - Execution progress is persisted in STORY.ep.autopilot and is fully resumable across page reloads.

(function () {
  "use strict";

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

  // Helper to extract numeric episode number (e.g. "EP02" -> 2)
  function getEpisodeNumber(epDoc) {
    if (!epDoc) return 1;
    const name = epDoc.title || epDoc.name || "";
    const m = name.match(/EP(?:ISODE)?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    if (typeof CUR !== "undefined" && CUR && CUR.ep && CUR.ep.name) {
      const mCur = CUR.ep.name.match(/EP(?:ISODE)?\s*(\d+)/i);
      if (mCur) return parseInt(mCur[1], 10);
    }
    return 1;
  }

  // =========================================================================
  // 1. DATA MODEL & STATE NORMALIZATION (STORY.ep.autopilot)
  // =========================================================================

  const STEP_DEFINITIONS = [
    {
      id: "s1",
      num: 1,
      name: "Season Skeleton",
      role: "plot_analyst",
      desc: "Episode arc & 3s opening hook (if season empty)",
      defaultCost: 0.02
    },
    {
      id: "s2",
      num: 2,
      name: "Episode Shotlist",
      role: "shotlist_writer",
      desc: "3 blocks × 30s shotlist (Refined v13, Gate A)",
      defaultCost: 0.04
    },
    {
      id: "s3",
      num: 3,
      name: "Reference Banks",
      role: "deterministic",
      desc: "Block ref banks: characters, env, props, style (§3)",
      defaultCost: 0.00
    },
    {
      id: "s4",
      num: 4,
      name: "Storyboard Prompts",
      role: "stb_prompter",
      desc: "Keyframe prompts for all shots (text only)",
      defaultCost: 0.03
    },
    {
      id: "s5",
      num: 5,
      name: "Video Prompts",
      role: "seedance_prompter",
      desc: "Seedance 2.5 multi-shot or per-shot prompts",
      defaultCost: 0.03
    }
  ];

  function ensureAutopilotState(epDoc) {
    if (!epDoc) return null;
    if (!epDoc.autopilot || typeof epDoc.autopilot !== "object") {
      epDoc.autopilot = {
        status: "idle", // 'idle' | 'running' | 'paused' | 'gate_wait' | 'done' | 'failed'
        currentStepId: null,
        stopOnGate: true,
        dryCost: 0.12,
        actualCost: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        gateIssues: [],
        steps: STEP_DEFINITIONS.map(d => ({
          id: d.id,
          name: d.name,
          role: d.role,
          state: "waiting", // 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'gate_wait'
          msg: "",
          cost: d.defaultCost,
          durationMs: 0
        })),
        queue: null
      };
    } else {
      // Ensure all steps exist in schema
      if (!Array.isArray(epDoc.autopilot.steps)) {
        epDoc.autopilot.steps = [];
      }
      STEP_DEFINITIONS.forEach(d => {
        let existing = epDoc.autopilot.steps.find(s => s.id === d.id);
        if (!existing) {
          existing = {
            id: d.id,
            name: d.name,
            role: d.role,
            state: "waiting",
            msg: "",
            cost: d.defaultCost,
            durationMs: 0
          };
          epDoc.autopilot.steps.push(existing);
        }
      });
      // Sort in order s1..s5
      epDoc.autopilot.steps.sort((a, b) => {
        const numA = parseInt(a.id.replace("s", ""), 10) || 0;
        const numB = parseInt(b.id.replace("s", ""), 10) || 0;
        return numA - numB;
      });
    }
    return epDoc.autopilot;
  }

  // =========================================================================
  // 2. DETERMINISTIC REFERENCE BANK BUILDER (KTOONS_STANDARDS §3)
  // =========================================================================

  function buildBlockReferenceBank(blockNum, blockShots, bible, ep) {
    const bank = [];
    let tagIdx = 1;
    const maxBankImages = 9;

    // 1. Characters in block (ordered by appearance)
    const charIds = new Set();
    const charsInOrder = [];

    (blockShots || []).forEach(shot => {
      const shotChars = Array.isArray(shot.chars) ? shot.chars : [];
      shotChars.forEach(cid => {
        if (!charIds.has(cid)) {
          charIds.add(cid);
          charsInOrder.push(cid);
        }
      });

      if (Array.isArray(shot.dialogue)) {
        shot.dialogue.forEach(d => {
          const cName = d.char || d.char_name;
          if (cName && bible && Array.isArray(bible.chars)) {
            const match = bible.chars.find(c =>
              (c.name && c.name.toUpperCase() === cName.toUpperCase()) ||
              (c.id && c.id === cName) ||
              (Array.isArray(c.aliases) && c.aliases.some(a => a.toUpperCase() === cName.toUpperCase()))
            );
            if (match && !charIds.has(match.id)) {
              charIds.add(match.id);
              charsInOrder.push(match.id);
            }
          }
        });
      }
    });

    charsInOrder.forEach(cid => {
      if (tagIdx > maxBankImages) return;
      const cObj = bible && Array.isArray(bible.chars) ? bible.chars.find(c => c.id === cid) : null;
      const name = cObj ? cObj.name : cid;
      const refImg = cObj ? (cObj.ref || (Array.isArray(cObj.refs) ? cObj.refs[0] : null)) : null;

      bank.push({
        tag: `@image${tagIdx}`,
        kind: "character",
        id: cid,
        name: name,
        ref: refImg || "",
        role_desc: `@image${tagIdx} — ${name}. Hard design / identity reference only. Preserve face, hair, costume, build and proportions. Do not preserve reference lighting or shading.`
      });
      tagIdx++;
    });

    // 2. Environment / Locations for this block
    const locIdentifiers = new Set();
    (blockShots || []).forEach(s => {
      const l = s.location || s.loc || s.slug;
      if (l) locIdentifiers.add(l);
    });

    locIdentifiers.forEach(locIdentifier => {
      if (tagIdx > maxBankImages) return;
      const lObj = bible && Array.isArray(bible.locs) ? bible.locs.find(l =>
        l.id === locIdentifier || (l.name && locIdentifier.toUpperCase().includes(l.name.toUpperCase()))
      ) : null;
      const name = lObj ? lObj.name : locIdentifier;
      const refImg = lObj ? (lObj.ref || (Array.isArray(lObj.refs) ? lObj.refs[0] : null)) : null;

      bank.push({
        tag: `@image${tagIdx}`,
        kind: "environment",
        id: lObj ? lObj.id : locIdentifier,
        name: name,
        ref: refImg || "",
        role_desc: `@image${tagIdx} — ${name} environment reference ONLY: architecture, materials, mood. Never use directly as background; never copy its camera or composition.`
      });
      tagIdx++;
    });

    // 3. Props in block
    if (bible && Array.isArray(bible.props)) {
      bible.props.forEach(p => {
        if (tagIdx > maxBankImages) return;
        const isMentioned = (blockShots || []).some(s => {
          const txt = ((s.action || "") + " " + (s.content || "")).toUpperCase();
          return p.name && txt.includes(p.name.toUpperCase());
        });
        if (isMentioned) {
          bank.push({
            tag: `@image${tagIdx}`,
            kind: "prop",
            id: p.id,
            name: p.name,
            ref: p.ref || (Array.isArray(p.refs) ? p.refs[0] : "") || "",
            role_desc: `@image${tagIdx} — ${p.name}. Preserve shape, material and color.`
          });
          tagIdx++;
        }
      });
    }

    // 4. Style Reference Images
    if (bible && bible.style && Array.isArray(bible.style.refs)) {
      bible.style.refs.forEach(sRef => {
        if (tagIdx > maxBankImages) return;
        bank.push({
          tag: `@image${tagIdx}`,
          kind: "style",
          ref: sRef,
          role_desc: `@image${tagIdx} — art-style / mood reference ONLY. Never reproduce its characters or environments.`
        });
        tagIdx++;
      });
    }

    // 5. Video Reference (@video1)
    const videos = (bible && Array.isArray(bible.videos)) ? bible.videos : [];
    const v1 = videos.find(v => v.tag === "@video1" || v.role === "style") || videos[0];
    if (v1) {
      bank.push({
        tag: "@video1",
        kind: "video",
        ref: v1.ref || "",
        title: v1.title || "Master animation style",
        role_desc: `@video1 — MASTER ANIMATION REFERENCE: follow its animation style, timing and rendering. Do not use its characters, environments or scenes. If any instruction conflicts with @video1 on style, follow @video1.`
      });
    }

    return bank;
  }

  function getBlockLocationGeography(block, bible, ep) {
    if (!block) return "Standard 3-point cinematic coverage; 180-degree axis locked.";
    const locId = block.location;
    // Check in ep.locations first
    if (ep && Array.isArray(ep.locations)) {
      const epLoc = ep.locations.find(l => l.id === locId || l.name === locId);
      if (epLoc && epLoc.geography) return epLoc.geography;
    }
    // Check in bible.locs
    if (bible && Array.isArray(bible.locs)) {
      const bLoc = bible.locs.find(l => l.id === locId || l.name === locId);
      if (bLoc && (bLoc.geography || bLoc.raccord || bLoc.desc)) {
        return bLoc.geography || bLoc.raccord || bLoc.desc;
      }
    }
    return "Interior/Exterior room geography: Entrance screen-left, main staging center, background depth right. 180-degree axis preserved.";
  }

  // =========================================================================
  // 3. GATE A VALIDATION
  // =========================================================================

  function evaluateGateA(epDoc, bibleDoc) {
    const issues = [];
    const ep = epDoc || {};
    const bible = bibleDoc || {};
    const shots = Array.isArray(ep.shots) ? ep.shots : [];
    const blocks = Array.isArray(ep.blocks) ? ep.blocks : [];
    const target = ep.target || 90;

    if (!shots.length) {
      issues.push({ level: "error", msg: "Episode has no shots generated." });
      return issues;
    }

    // 1. Block duration sum
    if (blocks.length > 0) {
      const blockSum = blocks.reduce((acc, b) => acc + (Number(b.duration) || 0), 0);
      if (Math.abs(blockSum - target) > 1.5) {
        issues.push({
          level: "warn",
          msg: `Block durations sum to ${blockSum.toFixed(1)}s, target is ${target}s.`
        });
      }

      // Check shots in each block
      blocks.forEach(b => {
        const bShots = shots.filter(s => s.block === b.n);
        const bShotsDur = bShots.reduce((acc, s) => acc + (Number(s.dur) || 0), 0);
        if (Math.abs(bShotsDur - (b.duration || 30)) > 2.0) {
          issues.push({
            level: "warn",
            msg: `Block ${b.n} shots sum to ${bShotsDur.toFixed(1)}s (expected ${b.duration || 30}s).`
          });
        }
      });
    } else {
      const totalShotDur = shots.reduce((acc, s) => acc + (Number(s.dur) || 0), 0);
      if (Math.abs(totalShotDur - target) > 2.0) {
        issues.push({
          level: "warn",
          msg: `Total shot duration is ${totalShotDur.toFixed(1)}s (target: ${target}s).`
        });
      }
    }

    // 2. Dialogue pacing (<= 2.5 words/s)
    let overflowCount = 0;
    shots.forEach(s => {
      if (Array.isArray(s.dialogue)) {
        s.dialogue.forEach(d => {
          const txt = d.line || d.text || "";
          const words = txt.split(/\s+/).filter(Boolean).length;
          const dur = Number(s.dur) || 6;
          if (words / 2.5 > dur + 0.6) {
            overflowCount++;
          }
        });
      }
    });
    if (overflowCount > 0) {
      issues.push({
        level: "warn",
        msg: `${overflowCount} dialogue line(s) exceed speech pacing limit (2.5 words/s).`
      });
    }

    return issues;
  }

  // =========================================================================
  // 4. AUTOPILOT STEP RUNNERS (S1 -> S5)
  // =========================================================================

  let cancelRequested = false;

  async function runStepS1(ep, bible) {
    // S1: Season Skeleton (plot_analyst)
    // Rule: "only if the season list is empty"
    if (bible && Array.isArray(bible.season) && bible.season.length > 0) {
      return {
        skipped: true,
        msg: `Season list already has ${bible.season.length} episodes.`
      };
    }

    if (!window.STORY || !window.STORY.ai || typeof window.STORY.ai.run !== "function") {
      throw new Error("STORY.ai engine not available. Please ensure TASK_006 (ss8_ai.js) is loaded.");
    }

    const seriesName = (bible && bible.name) || "Untitled Series";
    const logline = (bible && bible.logline) || "";
    const sourceStory = (bible && (bible.master_screenplay || bible.sourceStory)) || "";
    if (!String(sourceStory).trim()) throw new Error("Add/analyze a source and create the master screenplay before running the season map.");

    const inputPayload = {
      series: {
        name: seriesName,
        logline: logline,
        genre: (bible && bible.genre) || "Drama",
        tone: (bible && bible.tone) || "Cinematic tension",
        audience: (bible && bible.audience) || "US, 18+",
        characters: (bible && Array.isArray(bible.chars)) ? bible.chars.map(c => ({ id: c.id, name: c.name, role: c.role, look: c.look })) : [],
        locations: (bible && Array.isArray(bible.locs)) ? bible.locs.map(l => ({ id: l.id, name: l.name, desc: l.desc })) : []
      },
      source_story: sourceStory,
      master_screenplay: sourceStory,
      source_analysis: (bible && bible.sourceAnalysis) || null,
      dialogue_authority: (bible && bible.dialogueAuthority) || "VIDEO_SAMPLE",
      requested_episode_count: (bible && bible.requestedEpisodeCount) || null,
      format: {
        duration_min: (bible && bible.format && bible.format.epMin) || 90,
        duration_max: (bible && bible.format && bible.format.epMax) || 120,
        duration_override: (ep && ep.target) || null
      }
    };

    const res = await window.STORY.ai.run("plot_analyst", inputPayload);
    if (!res || !res.json || !Array.isArray(res.json.episodes)) {
      throw new Error("Invalid output received from plot_analyst role.");
    }

    if (typeof STORY.snapshot === "function") {
      STORY.snapshot("Autopilot S1: Season skeleton");
    }

    if (!bible) bible = STORY.bible || {};
    bible.season = res.json.episodes;
    if (res.json.master_screenplay) bible.master_screenplay = res.json.master_screenplay;
    if (Array.isArray(res.json.new_entities) && res.json.new_entities.length) {
      bible.season_new_entities = res.json.new_entities;
    }
    STORY.dirty.bible = true;

    // Apply matching skeleton to current episode outline
    const curNum = getEpisodeNumber(ep);
    const matchingEp = bible.season.find(e => e.n === curNum) || bible.season[0];
    if (matchingEp && ep) {
      if (!ep.outline) ep.outline = { premise: "", hook: "", beats: [] };
      ep.outline.premise = matchingEp.skeleton || "";
      ep.outline.hook = matchingEp.hook || "";
      ep.title = matchingEp.title || ep.title;
      STORY.dirty.ep = true;
    }

    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();

    return {
      success: true,
      cost: res.cost || 0.02,
      msg: `Created season arc with ${bible.season.length} episodes.`
    };
  }

  async function runStepS2(ep, bible) {
    // S2: Episode Shotlist (shotlist_writer)
    if (!window.STORY || !window.STORY.ai || typeof window.STORY.ai.run !== "function") {
      throw new Error("STORY.ai engine not available.");
    }

    const curNum = getEpisodeNumber(ep);
    let skeletonText = (ep && ep.outline && ep.outline.premise) || "";
    let hookText = (ep && ep.outline && ep.outline.hook) || "";
    let endingText = "";
    let episodeScript = (ep && ep.script && Array.isArray(ep.script.blocks) ? ep.script.blocks : []).map(b => {
      if (!b || !b.text) return "";
      return b.k === "character" ? "\n" + String(b.text).toUpperCase() : b.text;
    }).filter(Boolean).join("\n");
    let sourceEventIds = [];

    // Fallback to Bible season if outline is empty
    if (!skeletonText && bible && Array.isArray(bible.season)) {
      const sItem = bible.season.find(e => e.n === curNum);
      if (sItem) {
        skeletonText = sItem.skeleton || "";
        hookText = hookText || sItem.hook || "";
        endingText = sItem.ending || "";
        episodeScript = episodeScript || sItem.screenplay || "";
        sourceEventIds = (sItem.beats || []).flatMap(b => b.source_event_ids || []);
      }
    }
    if (!skeletonText && !episodeScript) throw new Error(`EP${String(curNum).padStart(2, "0")} has no approved episode outline or screenplay.`);

    let previousEpisode = null;
    if (curNum > 1) {
      const seriesId = (typeof CUR !== "undefined" && CUR && CUR.series && CUR.series.id) || (bible && bible.series) || "";
      const eps = (typeof PJ !== "undefined" && PJ && Array.isArray(PJ.episodes) ? PJ.episodes : [])
        .filter(x => seriesId && x.series === seriesId)
        .sort((a, b) => (Number(a.no) || getEpisodeNumber(a)) - (Number(b.no) || getEpisodeNumber(b)));
      const currentIndex = eps.findIndex(x => x.id === (CUR && CUR.ep && CUR.ep.id));
      const previous = currentIndex > 0 ? eps[currentIndex - 1] : eps.find(x => (Number(x.no) || getEpisodeNumber(x)) === curNum - 1);
      if (previous) {
        const desk = await api("/api/desk/all");
        const prevDoc = desk && desk.colls && desk.colls.story_ep && desk.colls.story_ep[previous.id];
        const prevSeason = ((bible && bible.season) || []).find(e => Number(e.n) === curNum - 1);
        if (prevDoc || prevSeason) {
          const lastShot = prevDoc && (prevDoc.shots || []).slice(-1)[0];
          previousEpisode = {
            n: curNum - 1,
            title: (prevDoc && prevDoc.title) || (prevSeason && prevSeason.title) || previous.name,
            summary: (prevDoc && prevDoc.outline && prevDoc.outline.premise) || (prevSeason && prevSeason.skeleton) || "",
            state_out: (lastShot && lastShot.cont && lastShot.cont.end) || (prevSeason && prevSeason.state_out) || ""
          };
        }
      }
    }

    const inputPayload = {
      bible: {
        series: (bible && bible.name) || "SERIES",
        logline: (bible && bible.logline) || "",
        characters: (bible && Array.isArray(bible.chars)) ? bible.chars.map(c => ({ id: c.id, name: c.name, role: c.role, look: c.look })) : [],
        locations: (bible && Array.isArray(bible.locs)) ? bible.locs.map(l => ({ id: l.id, name: l.name, desc: l.desc })) : [],
        props: (bible && Array.isArray(bible.props)) ? bible.props.map(p => ({ id: p.id, name: p.name, desc: p.desc })) : [],
        art_style: (bible && bible.style) || {}
      },
      episode: {
        n: curNum,
        title: (ep && ep.title) || `Episode ${curNum}`,
        skeleton: skeletonText,
        hook: hookText,
        ending: endingText
      },
      episode_script: episodeScript,
      source_event_ids: sourceEventIds,
      source_analysis: (bible && bible.sourceAnalysis) || null,
      dialogue_authority: (bible && bible.dialogueAuthority) || "VIDEO_SAMPLE",
      previous_episode: previousEpisode,
      format: {
        target: (ep && ep.target) || 90,
        duration_min: (bible && bible.format && bible.format.epMin) || 90,
        duration_max: (bible && bible.format && bible.format.epMax) || 120,
        blocks: (bible && bible.format && bible.format.blocks) || 3,
        block_seconds: (bible && bible.format && bible.format.batchMax) || 30,
        genMode: (bible && bible.format && bible.format.genMode) || "block",
        aspect: (bible && bible.format && bible.format.aspect) || "9:16",
        mix: (bible && bible.format && bible.format.mix) || { REF: 40, I2V: 40, MINI: 20 }
      }
    };

    const res = await window.STORY.ai.run("shotlist_writer", inputPayload);
    if (!res || !res.json) {
      throw new Error("Invalid output received from shotlist_writer role.");
    }

    if (typeof STORY.snapshot === "function") {
      STORY.snapshot("Autopilot S2: Shotlist");
    }

    // Load output using STORY.shots.importJSON if available
    if (STORY.shots && typeof STORY.shots.importJSON === "function") {
      STORY.shots.importJSON(res.json);
    } else {
      // Direct assignment fallback
      const data = res.json;
      if (data.title) ep.title = data.title;
      if (Array.isArray(data.locations)) ep.locations = data.locations;
      if (Array.isArray(data.blocks)) ep.blocks = data.blocks;
      if (Array.isArray(data.shots)) {
        ep.shots = data.shots.map((rs, idx) => ({
          id: rs.id || `sh_${Date.now()}_${idx}`,
          n: rs.n || (idx + 1),
          block: rs.block || 1,
          slug: rs.slug || "",
          location: rs.location || "",
          size: rs.size || "MCU",
          angle: rs.angle || "eye-level",
          move: rs.movement || rs.move || "static",
          cam_rel: rs.camera_relative || "",
          placement: rs.placement || "",
          purpose: rs.purpose || "",
          perf: rs.performance || "",
          dur: Number(rs.duration || rs.dur) || 6,
          type: rs.type || "REF",
          action: rs.content || (Array.isArray(rs.action_order) ? rs.action_order.join(". ") : rs.action) || "",
          content: rs.content || "",
          dialogue: Array.isArray(rs.dialogue) ? rs.dialogue.map(d => ({ char: d.char || "", text: d.line || d.text || "", modifier: d.mode || "ON" })) : [],
          sfx: rs.sfx || "",
          stb: { prompt: "", ref: "", status: "none" },
          video: { node: "", job: "", ref: "", status: "none" },
          u: Date.now()
        }));
      }
      STORY.dirty.ep = true;
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      if (typeof STORY.renderView === "function") STORY.renderView();
    }

    const shotCount = (ep.shots || []).length;
    const blockCount = (ep.blocks || []).length;

    return {
      success: true,
      cost: res.cost || 0.04,
      msg: `Generated ${shotCount} shots across ${blockCount} blocks.`
    };
  }

  async function runStepS3(ep, bible) {
    // S3: Reference bank per block (§3, No AI)
    if (!ep) ep = STORY.ep || {};
    if (!bible) bible = STORY.bible || {};

    const blocks = Array.isArray(ep.blocks) && ep.blocks.length ? ep.blocks : [
      { n: 1, duration: 30, location: "L1" },
      { n: 2, duration: 30, location: "L1" },
      { n: 3, duration: 30, location: "L1" }
    ];
    ep.blocks = blocks;

    const shots = Array.isArray(ep.shots) ? ep.shots : [];

    if (typeof STORY.snapshot === "function") {
      STORY.snapshot("Autopilot S3: Reference banks");
    }

    let totalBankImages = 0;
    blocks.forEach(b => {
      const bShots = shots.filter(s => s.block === b.n);
      const bank = buildBlockReferenceBank(b.n, bShots, bible, ep);
      b.bank = bank;
      totalBankImages += bank.length;
    });

    STORY.dirty.ep = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();

    return {
      success: true,
      cost: 0.00,
      msg: `Built reference banks for ${blocks.length} blocks (${totalBankImages} refs total).`
    };
  }

  async function runStepS4(ep, bible) {
    // S4: STB prompts (text only) via stb_prompter
    if (!window.STORY || !window.STORY.ai || typeof window.STORY.ai.run !== "function") {
      throw new Error("STORY.ai engine not available.");
    }

    const shots = Array.isArray(ep.shots) ? ep.shots : [];
    if (!shots.length) {
      throw new Error("No shots available in episode to generate STB prompts.");
    }

    const blocks = Array.isArray(ep.blocks) && ep.blocks.length ? ep.blocks : [{ n: 1, duration: 30 }];
    const aspect = (bible && bible.format && bible.format.aspect) || "9:16";

    if (typeof STORY.snapshot === "function") {
      STORY.snapshot("Autopilot S4: Storyboard prompts");
    }

    let promptsCount = 0;
    let totalCost = 0;

    // Process block by block
    for (const b of blocks) {
      if (cancelRequested) throw new Error("Autopilot stopped by user.");

      const bShots = shots.filter(s => s.block === b.n);
      if (!bShots.length) continue;

      const inputPayload = {
        block: b.n,
        duration: b.duration || 30,
        aspect: aspect,
        location_geography: getBlockLocationGeography(b, bible, ep),
        art_style: (bible && bible.style) || {},
        ref_bank: b.bank || [],
        shots: bShots.map(s => ({
          n: s.n,
          slug: s.slug || "",
          size: s.size || "MCU",
          angle: s.angle || "eye-level",
          movement: s.move || s.movement || "static",
          camera_relative: s.cam_rel || s.camera_relative || "",
          placement: s.placement || "",
          action: s.action || s.content || "",
          action_order: s.action_order || [s.action || s.content || ""],
          dialogue: s.dialogue || [],
          type: s.type || "REF",
          duration: s.dur || 6
        }))
      };

      const res = await window.STORY.ai.run("stb_prompter", inputPayload);
      if (res && res.json) {
        totalCost += (res.cost || 0.015);
        const list = Array.isArray(res.json) ? res.json : (Array.isArray(res.json.prompts) ? res.json.prompts : [res.json]);
        list.forEach((item, idx) => {
          const targetShot = bShots.find(s => s.n === item.shot) || bShots[idx];
          if (targetShot && item.prompt) {
            if (!targetShot.stb) targetShot.stb = {};
            targetShot.stb.prompt = item.prompt;
            targetShot.stb.refs = Array.isArray(item.refs) ? item.refs : [];
            targetShot.stb_prompt = item.prompt;
            targetShot.stb_refs = targetShot.stb.refs;
            targetShot.u = Date.now();
            promptsCount++;
          }
        });
      }
    }

    STORY.dirty.ep = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();

    return {
      success: true,
      cost: totalCost || 0.03,
      msg: `Created ${promptsCount} storyboard keyframe prompts.`
    };
  }

  async function runStepS5(ep, bible) {
    // S5: Video prompts (per-block or per-shot) via seedance_prompter
    if (!window.STORY || !window.STORY.ai || typeof window.STORY.ai.run !== "function") {
      throw new Error("STORY.ai engine not available.");
    }

    const genMode = (bible && bible.format && bible.format.genMode) || "block";
    const blocks = Array.isArray(ep.blocks) && ep.blocks.length ? ep.blocks : [{ n: 1, duration: 30 }];
    const shots = Array.isArray(ep.shots) ? ep.shots : [];
    const aspect = (bible && bible.format && bible.format.aspect) || "9:16";
    const curNum = getEpisodeNumber(ep);

    if (typeof STORY.snapshot === "function") {
      STORY.snapshot("Autopilot S5: Video prompts");
    }

    let promptsCount = 0;
    let totalCost = 0;

    if (genMode === "block") {
      // Per-block Seedance 2.5 multi-shot prompt
      for (const b of blocks) {
        if (cancelRequested) throw new Error("Autopilot stopped by user.");

        const bShots = shots.filter(s => s.block === b.n);
        const inputPayload = {
          series: (bible && bible.name) || "SERIES",
          episode_n: curNum,
          block: b.n,
          duration: b.duration || 30,
          aspect: aspect,
          location: b.location || (bShots[0] && bShots[0].slug) || "MAIN LOCATION",
          location_geography: getBlockLocationGeography(b, bible, ep),
          ref_bank: b.bank || [],
          art_style: (bible && bible.style) || {},
          negatives: (bible && bible.style && bible.style.negative) || "",
          shots: bShots.map(s => ({
            n: s.n,
            title: s.slug || `SHOT ${s.n}`,
            size: s.size || "MCU",
            angle: s.angle || "eye-level",
            movement: s.move || s.movement || "static",
            placement: s.placement || "",
            action: s.action || s.content || "",
            action_order: s.action_order || [s.action || s.content || ""],
            dialogue: s.dialogue || [],
            duration: s.dur || 6,
            stb_prompt: s.stb ? s.stb.prompt : ""
          }))
        };

        const res = await window.STORY.ai.run("seedance_prompter", inputPayload);
        if (res && res.json && res.json.prompt) {
          b.vprompt = res.json.prompt;
          b.prompt = res.json.prompt;
          b.u = Date.now();
          promptsCount++;
          totalCost += (res.cost || 0.01);
        }
      }
    } else {
      // Per-shot I2V prompts
      for (const s of shots) {
        if (cancelRequested) throw new Error("Autopilot stopped by user.");

        const b = blocks.find(blk => blk.n === s.block) || blocks[0];
        const inputPayload = {
          genMode: "shot",
          shot: s.n,
          duration: s.dur || 6,
          aspect: aspect,
          size: s.size || "MCU",
          action: s.action || s.content || "",
          dialogue: s.dialogue || [],
          stb_prompt: (s.stb && s.stb.prompt) || "",
          ref_bank: (b && b.bank) || [],
          art_style: (bible && bible.style) || {}
        };

        const res = await window.STORY.ai.run("seedance_prompter", inputPayload);
        if (res && res.json && res.json.prompt) {
          s.vprompt = res.json.prompt;
          s.u = Date.now();
          promptsCount++;
          totalCost += (res.cost || 0.005);
        }
      }
    }

    STORY.dirty.ep = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();

    return {
      success: true,
      cost: totalCost || 0.03,
      msg: `Generated ${promptsCount} ${genMode}-level video prompt(s).`
    };
  }

  // =========================================================================
  // 5. AUTOPILOT ORCHESTRATOR
  // =========================================================================

  async function executeAutopilotPipeline(options = {}) {
    cancelRequested = false;
    const ep = STORY.ep;
    const bible = STORY.bible;
    if (!ep) {
      if (typeof toast === "function") toast("No active episode loaded.", true);
      return;
    }

    const state = ensureAutopilotState(ep);
    if (typeof options.stopOnGate === "boolean") {
      state.stopOnGate = options.stopOnGate;
    }

    state.status = "running";
    state.startedAt = Date.now();
    state.error = null;
    state.actualCost = 0;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    updateModalUI();

    const startFromStep = options.resumeStepId || null;
    let canRun = startFromStep ? false : true;

    for (const def of STEP_DEFINITIONS) {
      if (cancelRequested) {
        state.status = "paused";
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        updateModalUI();
        return;
      }

      if (startFromStep && def.id === startFromStep) {
        canRun = true;
      }
      if (!canRun) continue;

      const stepState = state.steps.find(s => s.id === def.id);
      state.currentStepId = def.id;
      stepState.state = "running";
      stepState.msg = "Processing...";
      updateModalUI();

      const startTime = Date.now();
      try {
        let res = null;
        if (def.id === "s1") {
          res = await runStepS1(ep, bible);
        } else if (def.id === "s2") {
          res = await runStepS2(ep, bible);
        } else if (def.id === "s3") {
          res = await runStepS3(ep, bible);
        } else if (def.id === "s4") {
          res = await runStepS4(ep, bible);
        } else if (def.id === "s5") {
          res = await runStepS5(ep, bible);
        }

        stepState.durationMs = Date.now() - startTime;
        if (res && res.skipped) {
          stepState.state = "skipped";
          stepState.msg = res.msg || "Skipped";
        } else {
          stepState.state = "done";
          stepState.msg = res.msg || "Completed successfully.";
          stepState.cost = res.cost || 0;
          state.actualCost = Number((state.actualCost + (res.cost || 0)).toFixed(4));
        }

        // Post-step check for S2: Gate A check & Respect Bible.format.auto.A
        if (def.id === "s2") {
          const gateIssues = evaluateGateA(ep, bible);
          state.gateIssues = gateIssues;
          const autoA = (bible && bible.format && bible.format.auto && bible.format.auto.A) !== false;
          const hasCriticalError = gateIssues.some(i => i.level === "error");

          if (state.stopOnGate || !autoA || hasCriticalError) {
            state.status = "gate_wait";
            stepState.state = "gate_wait";
            stepState.msg = `Gate A check: ${gateIssues.length} issue(s) reported. Waiting for approval.`;
            if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
            updateModalUI();
            if (typeof toast === "function") toast("Autopilot paused at Gate A for review.");
            return; // Pause pipeline here until user approves
          }
        }

      } catch (err) {
        stepState.durationMs = Date.now() - startTime;
        stepState.state = "failed";
        stepState.msg = err.message || "Failed during execution.";
        state.status = "failed";
        state.error = err.message;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        updateModalUI();
        if (typeof toast === "function") toast(`Autopilot failed at Step ${def.num}: ${err.message}`, true);
        return;
      }

      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      updateModalUI();
    }

    state.status = "done";
    state.currentStepId = null;
    state.finishedAt = Date.now();
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    updateModalUI();
    if (typeof toast === "function") toast("Autopilot: Write Episode completed successfully!");

    // If part of all-episodes queue, advance to next episode
    if (state.queue && state.queue.active) {
      await advanceQueue(state.queue);
    }
  }

  // =========================================================================
  // 6. ALL EPISODES QUEUE (EPa - EPb)
  // =========================================================================

  async function startAllEpisodesQueue(fromEpId, toEpId) {
    const allEps = (typeof STORY.curSeriesEpisodes === "function") ? STORY.curSeriesEpisodes() : [];
    if (!allEps.length) {
      if (typeof toast === "function") toast("No episodes found in series.", true);
      return;
    }

    const fromIdx = allEps.findIndex(e => e.id === fromEpId);
    const toIdx = allEps.findIndex(e => e.id === toEpId);

    const start = fromIdx >= 0 ? Math.min(fromIdx, toIdx) : 0;
    const end = toIdx >= 0 ? Math.max(fromIdx, toIdx) : allEps.length - 1;

    const queueList = allEps.slice(start, end + 1);
    if (!queueList.length) {
      if (typeof toast === "function") toast("Invalid episode range selected.", true);
      return;
    }

    const queueObj = {
      active: true,
      fromEp: queueList[0].id,
      toEp: queueList[queueList.length - 1].id,
      epList: queueList.map(e => ({ id: e.id, name: e.name })),
      currentIdx: 0
    };

    if (STORY.ep) {
      const state = ensureAutopilotState(STORY.ep);
      state.queue = queueObj;
    }

    await processQueueIndex(queueObj, 0);
  }

  async function processQueueIndex(queueObj, idx) {
    if (cancelRequested || !queueObj.active) return;
    if (idx >= queueObj.epList.length) {
      queueObj.active = false;
      if (typeof toast === "function") toast("Autopilot queue complete for all selected episodes!");
      updateModalUI();
      return;
    }

    queueObj.currentIdx = idx;
    const targetEp = queueObj.epList[idx];

    // Switch episode if needed
    if (typeof window.selectEpisode === "function") {
      await window.selectEpisode(targetEp.id);
    } else if (typeof STORY.loadDesk === "function") {
      if (typeof CUR !== "undefined" && CUR && CUR.ep) CUR.ep.id = targetEp.id;
      await STORY.loadDesk();
      if (typeof STORY.renderAll === "function") STORY.renderAll();
    }

    const state = ensureAutopilotState(STORY.ep);
    state.queue = queueObj;
    // Reset steps for this episode
    state.steps.forEach(s => {
      s.state = "waiting";
      s.msg = "";
    });

    updateModalUI();
    await executeAutopilotPipeline({ stopOnGate: false });
  }

  async function advanceQueue(queueObj) {
    if (!queueObj || !queueObj.active) return;
    const nextIdx = (queueObj.currentIdx || 0) + 1;
    if (nextIdx < queueObj.epList.length) {
      if (typeof toast === "function") {
        toast(`Autopilot: Moving to episode ${nextIdx + 1} of ${queueObj.epList.length}...`);
      }
      setTimeout(() => {
        processQueueIndex(queueObj, nextIdx);
      }, 1000);
    } else {
      queueObj.active = false;
      if (typeof toast === "function") toast("Autopilot queue finished for all episodes!");
      updateModalUI();
    }
  }

  // =========================================================================
  // 7. MODAL UI & USER INTERFACE
  // =========================================================================

  let activeTabMode = "single"; // 'single' | 'queue'

  function openAutopilotModal() {
    const root = document.getElementById("story") || document.body;
    let overlay = document.getElementById("story-autopilot-modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "story-autopilot-modal-overlay";
      overlay.className = "story-autopilot-overlay";
      root.appendChild(overlay);
    }

    renderModalContent(overlay);
    overlay.hidden = false;
  }

  function closeAutopilotModal() {
    const overlay = document.getElementById("story-autopilot-modal-overlay");
    if (overlay) overlay.remove();
  }

  function updateModalUI() {
    const overlay = document.getElementById("story-autopilot-modal-overlay");
    if (overlay && !overlay.hidden) {
      renderModalContent(overlay);
    }
    // Update trigger buttons
    updateTriggerButtons();
  }

  function renderModalContent(overlay) {
    const ep = STORY.ep || {};
    const bible = STORY.bible || {};
    const state = ensureAutopilotState(ep);
    const eps = (typeof STORY.curSeriesEpisodes === "function") ? STORY.curSeriesEpisodes() : [];

    const isRunning = state.status === "running";
    const isGateWait = state.status === "gate_wait";
    const isDone = state.status === "done";
    const isFailed = state.status === "failed";
    const isPaused = state.status === "paused";

    const epTitle = ep.title || (CUR && CUR.ep && CUR.ep.name) || "Current Episode";
    const curNum = getEpisodeNumber(ep);

    overlay.innerHTML = `
      <div class="story-autopilot-modal" role="dialog" aria-modal="true">
        <!-- Modal Header -->
        <div class="story-autopilot-hdr">
          <div class="story-autopilot-hdr-title">
            <span class="story-autopilot-title-text">Autopilot: Pre-Production</span>
            <span class="story-autopilot-ep-badge">EP${curNum < 10 ? "0" + curNum : curNum} · ${_esc(epTitle)}</span>
            <span class="story-autopilot-cost-badge">Est. ~$0.12 · Actual $${state.actualCost.toFixed(3)}</span>
          </div>
          <button class="story-autopilot-close-btn" data-s="autopilot.closeModal" title="Close modal">✕</button>
        </div>

        <!-- Modal Body -->
        <div class="story-autopilot-body">
          <!-- Queue Banner if active -->
          ${state.queue && state.queue.active ? `
            <div class="story-autopilot-queue-banner">
              <span>Queue Active: Episode ${(state.queue.currentIdx || 0) + 1} of ${state.queue.epList.length}</span>
              <button class="story-btn-ghost" style="padding:2px 8px;font-size:10.5px;" data-s="autopilot.cancelQueue">Stop Queue</button>
            </div>
          ` : ""}

          <!-- Mode Switcher Tabs -->
          <div class="story-autopilot-tabs">
            <button class="story-autopilot-tab-btn ${activeTabMode === 'single' ? 'active' : ''}" data-s="autopilot.setTab:single">
              This Episode (EP${curNum})
            </button>
            <button class="story-autopilot-tab-btn ${activeTabMode === 'queue' ? 'active' : ''}" data-s="autopilot.setTab:queue">
              All Episodes Queue (EPa–EPb)
            </button>
          </div>

          <!-- Queue Config Box -->
          ${activeTabMode === "queue" ? `
            <div class="story-autopilot-queue-box">
              <span>Run range from:</span>
              <select id="story-autopilot-queue-from" class="story-autopilot-select">
                ${eps.map((e, idx) => `
                  <option value="${e.id}" ${idx === 0 ? "selected" : ""}>${_esc(e.name)}</option>
                `).join("")}
              </select>
              <span>to:</span>
              <select id="story-autopilot-queue-to" class="story-autopilot-select">
                ${eps.map((e, idx) => `
                  <option value="${e.id}" ${idx === eps.length - 1 ? "selected" : ""}>${_esc(e.name)}</option>
                `).join("")}
              </select>
              <button class="story-btn-gold" style="margin-left:auto;" data-s="autopilot.startQueueBtn" ${isRunning ? "disabled" : ""}>
                Start Queue
              </button>
            </div>
          ` : ""}

          <!-- Options Bar -->
          <div class="story-autopilot-options">
            <label class="story-autopilot-check-label">
              <input type="checkbox" id="story-autopilot-stop-gate" ${state.stopOnGate ? "checked" : ""} data-s="autopilot.toggleStopOnGate">
              Stop on Gate A (pause before prompts)
            </label>
            <div class="story-autopilot-meta-text">
              Chain: S1 Season → S2 Shotlist → S3 Ref Banks → S4 STB → S5 Video Prompts
            </div>
          </div>

          <!-- Gate A Alert Box if paused on Gate A -->
          ${isGateWait ? `
            <div class="story-autopilot-gate-box">
              <div class="story-autopilot-gate-hdr">
                <span>GATE A REVIEW PAUSE</span>
                <button class="story-btn-gold" style="padding:3px 12px;font-size:11px;" data-s="autopilot.approveGate">
                  Approve & Continue to S3 ➔
                </button>
              </div>
              <div>Shotlist generation completed. Review shot durations and formatting below before continuing:</div>
              ${state.gateIssues && state.gateIssues.length ? `
                <ul class="story-autopilot-gate-list">
                  ${state.gateIssues.map(iss => `<li>[${iss.level.toUpperCase()}] ${_esc(iss.msg)}</li>`).join("")}
                </ul>
              ` : `
                <div style="font-size:11px;color:var(--accent,#1fd6a5);">✓ All Gate A duration and structure metrics clear.</div>
              `}
            </div>
          ` : ""}

          <!-- Pipeline Step Cards (S1 - S5) -->
          <div class="story-autopilot-steps">
            ${STEP_DEFINITIONS.map(def => {
              const step = state.steps.find(s => s.id === def.id) || { state: "waiting", msg: "" };
              const isStepRunning = step.state === "running";
              const isStepDone = step.state === "done";
              const isStepSkipped = step.state === "skipped";
              const isStepFailed = step.state === "failed";
              const isStepGate = step.state === "gate_wait";

              return `
                <div class="story-autopilot-step-card ${step.state}">
                  <div class="story-autopilot-step-left">
                    <div class="story-autopilot-step-num">
                      ${isStepDone ? "✓" : (isStepFailed ? "✕" : def.num)}
                    </div>
                    <div class="story-autopilot-step-meta">
                      <div class="story-autopilot-step-name">
                        <span>S${def.num}. ${def.name}</span>
                        <span class="story-autopilot-role-pill">${def.role}</span>
                        ${step.durationMs ? `<span style="font-size:10px;color:var(--muted);">${(step.durationMs / 1000).toFixed(1)}s</span>` : ""}
                      </div>
                      <div class="story-autopilot-step-desc">
                        ${_esc(step.msg || def.desc)}
                      </div>
                    </div>
                  </div>

                  <div class="story-autopilot-step-right">
                    ${isStepFailed ? `
                      <button class="story-btn-ghost" style="padding:2px 8px;font-size:10.5px;color:var(--danger,#e05252);border-color:var(--danger,#e05252);" data-s="autopilot.retryStep:${def.id}">
                        Retry
                      </button>
                    ` : ""}

                    ${isStepGate ? `
                      <button class="story-btn-gold" style="padding:2px 8px;font-size:10.5px;" data-s="autopilot.approveGate">
                        Approve
                      </button>
                    ` : ""}

                    <span class="story-autopilot-badge ${step.state}">
                      ${isStepRunning ? "RUNNING..." : (isStepDone ? "DONE" : (isStepSkipped ? "SKIPPED" : (isStepFailed ? "FAILED" : (isStepGate ? "GATE WAIT" : "WAITING"))))}
                    </span>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="story-autopilot-ftr">
          <div class="story-autopilot-ftr-left">
            <span>Status: <b>${state.status.toUpperCase()}</b></span>
            ${state.error ? `<span style="color:var(--danger,#e05252);">${_esc(state.error)}</span>` : ""}
          </div>

          <div class="story-autopilot-ftr-right">
            ${isRunning ? `
              <button class="story-btn-ghost" data-s="autopilot.pause">Pause</button>
            ` : (isPaused || isFailed ? `
              <button class="story-btn-gold" data-s="autopilot.resume">Resume</button>
            ` : (isDone ? `
              <button class="story-btn-ghost" data-s="autopilot.start">Re-run All</button>
            ` : `
              <button class="story-btn-gold" data-s="autopilot.start">Start Autopilot (~$0.12)</button>
            `))}
            <button class="story-btn-ghost" data-s="autopilot.closeModal">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 8. DYNAMIC BUTTON INJECTIONS & HOOKS
  // =========================================================================

  function updateTriggerButtons() {
    const ep = STORY.ep;
    const state = ep ? ep.autopilot : null;
    const isRunning = state && state.status === "running";

    // 1. Header Button
    const hdrRight = document.querySelector("#story-header .story-hdr-right");
    if (hdrRight) {
      let btn = document.getElementById("story-btn-autopilot-hdr");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "story-btn-autopilot-hdr";
        btn.className = "story-btn-gold";
        btn.setAttribute("data-s", "autopilot.openModal");
        btn.setAttribute("title", "Autopilot: Write episode pre-production (S1–S5)");
        // Insert right after cost pill or before undo
        const costPill = hdrRight.querySelector(".story-cost-pill");
        if (costPill && costPill.nextSibling) {
          hdrRight.insertBefore(btn, costPill.nextSibling);
        } else {
          hdrRight.prepend(btn);
        }
      }
      btn.innerHTML = isRunning ? "Autopilot: Running..." : "Autopilot: write episode";
    }

    // 2. Script Tab Button
    const scriptAiBar = document.querySelector(".script-ai-bar");
    if (scriptAiBar) {
      let scriptBtn = document.getElementById("story-btn-autopilot-script");
      if (!scriptBtn) {
        scriptBtn = document.createElement("button");
        scriptBtn.id = "story-btn-autopilot-script";
        scriptBtn.className = "story-btn-gold script-btn-cost";
        scriptBtn.setAttribute("data-s", "autopilot.openModal");
        scriptBtn.setAttribute("title", "Autopilot: Write episode pre-production (S1–S5)");
        const firstAction = scriptAiBar.querySelector("button");
        if (firstAction) {
          scriptAiBar.insertBefore(scriptBtn, firstAction);
        } else {
          scriptAiBar.appendChild(scriptBtn);
        }
      }
      scriptBtn.innerHTML = isRunning
        ? `Autopilot: Running... <span class="script-cost-pill">Active</span>`
        : `Autopilot: write episode <span class="script-cost-pill">~$0.12</span>`;
    }
  }

  // Check if autopilot was running when reloaded and prompt resume
  function checkResumableAutopilot() {
    if (STORY.ep && STORY.ep.autopilot && STORY.ep.autopilot.status === "running") {
      STORY.ep.autopilot.status = "paused";
      if (typeof toast === "function") {
        toast("Autopilot was active before reload. Open Autopilot to resume.");
      }
    }
    updateTriggerButtons();
  }

  // =========================================================================
  // 9. COMMAND HANDLERS REGISTRATION (STORY.cmds)
  // =========================================================================

  function registerCommands() {
    if (!STORY || !STORY.cmds) return;

    STORY.cmds["autopilot.openModal"] = () => {
      openAutopilotModal();
    };

    STORY.cmds["autopilot.closeModal"] = () => {
      closeAutopilotModal();
    };

    STORY.cmds["autopilot.setTab"] = (arg) => {
      activeTabMode = arg === "queue" ? "queue" : "single";
      updateModalUI();
    };

    STORY.cmds["autopilot.toggleStopOnGate"] = (arg, el) => {
      if (STORY.ep) {
        const state = ensureAutopilotState(STORY.ep);
        state.stopOnGate = el ? el.checked : !state.stopOnGate;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      }
    };

    STORY.cmds["autopilot.start"] = () => {
      executeAutopilotPipeline();
    };

    STORY.cmds["autopilot.pause"] = () => {
      cancelRequested = true;
      if (STORY.ep && STORY.ep.autopilot) {
        STORY.ep.autopilot.status = "paused";
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      }
      updateModalUI();
      if (typeof toast === "function") toast("Autopilot paused.");
    };

    STORY.cmds["autopilot.resume"] = () => {
      const state = STORY.ep && STORY.ep.autopilot;
      const lastFailed = state && state.steps.find(s => s.state === "failed" || s.state === "waiting");
      const resumeId = lastFailed ? lastFailed.id : null;
      executeAutopilotPipeline({ resumeStepId: resumeId });
    };

    STORY.cmds["autopilot.retryStep"] = (stepId) => {
      executeAutopilotPipeline({ resumeStepId: stepId });
    };

    STORY.cmds["autopilot.approveGate"] = () => {
      if (STORY.ep && STORY.ep.autopilot) {
        const s2 = STORY.ep.autopilot.steps.find(s => s.id === "s2");
        if (s2) {
          s2.state = "done";
          s2.msg = "Approved by user.";
        }
        STORY.ep.autopilot.status = "running";
        executeAutopilotPipeline({ resumeStepId: "s3" });
      }
    };

    STORY.cmds["autopilot.startQueueBtn"] = () => {
      const fromSel = document.getElementById("story-autopilot-queue-from");
      const toSel = document.getElementById("story-autopilot-queue-to");
      const fromId = fromSel ? fromSel.value : null;
      const toId = toSel ? toSel.value : null;
      if (fromId && toId) {
        startAllEpisodesQueue(fromId, toId);
      }
    };

    STORY.cmds["autopilot.cancelQueue"] = () => {
      cancelRequested = true;
      if (STORY.ep && STORY.ep.autopilot && STORY.ep.autopilot.queue) {
        STORY.ep.autopilot.queue.active = false;
      }
      updateModalUI();
      if (typeof toast === "function") toast("Autopilot queue cancelled.");
    };
  }

  // =========================================================================
  // 10. MODULE INITIALIZATION & EXPORTS
  // =========================================================================

  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Export STORY.autopilot interface
    STORY.autopilot = {
      writeEpisode: () => executeAutopilotPipeline(),
      pause: () => { cancelRequested = true; },
      resume: (stepId) => executeAutopilotPipeline({ resumeStepId: stepId }),
      queueEpisodes: startAllEpisodesQueue,
      openModal: openAutopilotModal,
      closeModal: closeAutopilotModal,
      getState: () => (STORY.ep ? ensureAutopilotState(STORY.ep) : null)
    };

    registerCommands();

    // Extension Hooks
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) {
      STORY.hooks.afterLoad.push(() => {
        checkResumableAutopilot();
        updateTriggerButtons();
      });
    }

    // Observer / Interval to ensure button exists when UI mounts
    setTimeout(updateTriggerButtons, 100);
    setTimeout(updateTriggerButtons, 500);
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
