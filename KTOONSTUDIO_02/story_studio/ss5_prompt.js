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
// - None for Task 005. Relies on /api/desk/batch for saving story_ep and story_tpl.
//
// App changes needed:
// - None. Integrates into STORY module registry (STORY.views.prompts, STORY.cmds).
//
// Known limitations:
// - AI generation of prompts (via STORY.ai.run) will be connected in TASK 006.
//   In TASK 005, prompt generation is performed deterministically from rich, configurable
//   templates and shot/block/bible data with full variable substitution and reference bank assembly.

(function () {
  "use strict";

  // ---------- Blocked Names & Explicit Terms Dictionaries ----------
  const BLOCKED_CELEBRITY_NAMES = [
    "tom cruise", "taylor swift", "donald trump", "elon musk", "joe biden",
    "brad pitt", "scarlett johansson", "leonardo dicaprio", "keanu reeves",
    "zendaya", "angelina jolie", "will smith", "johnny depp", "dwayne johnson",
    "the rock", "margot robbie", "chris evans", "robert downey", "barack obama",
    "kamala harris", "kanye west", "kim kardashian", "beyonce", "rihanna"
  ];

  const EXPLICIT_CONTENT_TERMS = [
    "porn", "xxx", "nude", "naked", "nudity", "nipples", "genitals", "penis",
    "vagina", "clitoris", "intercourse", "penetration", "anal", "oral sex",
    "blowjob", "cum", "masturbation", "fetish", "erotic explicit", "orgasm"
  ];

  // ---------- Local State & Preferences ----------
  let promptMode = "block"; // 'block' (Seedance 2.5) | 'shot' (I2V / per-shot)
  let selBlockNum = 1;
  let selShotId = null;
  let searchQuery = "";
  let filterLockedOnly = false;
  let showStbPreview = false;
  let showVideoPreview = false;
  let tplModalOpen = false;
  let activeModalTplId = null;

  try {
    const rawMode = localStorage.getItem("ktoon_prompt_mode");
    if (rawMode === "block" || rawMode === "shot") promptMode = rawMode;
  } catch (e) {
    // safe fail
  }

  function savePrefs() {
    try {
      localStorage.setItem("ktoon_prompt_mode", promptMode);
    } catch (e) {
      // safe fail
    }
  }

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

  function _uid(prefix = "tpl_") {
    if (typeof STORY !== "undefined" && typeof STORY.uid === "function") {
      return STORY.uid(prefix);
    }
    return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  // Format shot number e.g. S01, S12
  function padShotNo(n) {
    const num = Number(n) || 1;
    return num < 10 ? "0" + num : String(num);
  }

  // Format timecode e.g. 00:03.75
  function formatTimecode(seconds) {
    const sec = Math.max(0, Number(seconds) || 0);
    const m = Math.floor(sec / 60);
    const rem = sec - m * 60;
    const s = Math.floor(rem);
    const frac = Math.round((rem - s) * 100);
    const mm = m < 10 ? "0" + m : String(m);
    const ss = s < 10 ? "0" + s : String(s);
    const ff = frac < 10 ? "0" + frac : String(frac);
    return `${mm}:${ss}.${ff}`;
  }

  // Helper to get series bible
  function getBible() {
    return (typeof STORY !== "undefined" && STORY && STORY.bible) ? STORY.bible : null;
  }

  // Helper to get current episode
  function getEp() {
    return (typeof STORY !== "undefined" && STORY && STORY.ep) ? STORY.ep : null;
  }

  // Helper to get shots array
  function getShots() {
    const ep = getEp();
    if (!ep) return [];
    if (!Array.isArray(ep.shots)) ep.shots = [];
    return ep.shots;
  }

  // Ensure blocks exist in STORY.ep (3 blocks x 30s standard)
  function ensureBlocks() {
    const ep = getEp();
    if (!ep) return [];
    if (!Array.isArray(ep.blocks) || ep.blocks.length === 0) {
      ep.blocks = [
        { n: 1, duration: 30, location: "", summary: "", vprompt: { text: "", ver: 1, history: [], lint: [], locked: false } },
        { n: 2, duration: 30, location: "", summary: "", vprompt: { text: "", ver: 1, history: [], lint: [], locked: false } },
        { n: 3, duration: 30, location: "", summary: "", vprompt: { text: "", ver: 1, history: [], lint: [], locked: false } }
      ];
    }
    // Guarantee properties for all blocks
    ep.blocks.forEach((b, idx) => {
      b.n = b.n || (idx + 1);
      b.duration = b.duration || 30;
      if (!b.vprompt) {
        b.vprompt = { text: "", ver: 1, history: [], lint: [], locked: false };
      }
      if (!Array.isArray(b.vprompt.history)) b.vprompt.history = [];
      if (!Array.isArray(b.vprompt.lint)) b.vprompt.lint = [];
    });
    return ep.blocks;
  }

  // Ensure shot prompt containers exist
  function ensureShotPrompts(s) {
    if (!s) return;
    if (!s.vprompt) {
      s.vprompt = { text: "", ver: 1, history: [], lint: [], locked: false };
    }
    if (!Array.isArray(s.vprompt.history)) s.vprompt.history = [];
    if (!Array.isArray(s.vprompt.lint)) s.vprompt.lint = [];

    if (!s.stb) {
      s.stb = { prompt: "", ref: "", status: "none", istu: "", ver: 1, history: [], locked: false };
    }
    if (!Array.isArray(s.stb.history)) s.stb.history = [];
  }

  // ---------- Default Built-in Templates (Spec 9.2, Roles & Standards) ----------
  const DEFAULT_TEMPLATES = {
    tpl_seedance_block_default: {
      id: "tpl_seedance_block_default",
      name: "Seedance 2.5 Block Prompt (Standard)",
      kind: "block",
      model: "seedance-2.5",
      type_match: "ALL",
      is_default: true,
      text:
`{{series.name}} — EP{{ep.n_pad}} — BLOCK {{block.n}} ({{block.location_name}}) — SEEDANCE 2.5
[GLOBAL PARAMETERS] Duration: {{block.dur}}s · Aspect: {{aspect}} · Format: {{shot_count}}-shot cinematic sequence · Audio: dialogue + natural ambience only · No BGM · No subtitles · No captions · No on-screen text (except a title explicitly given in a shot).
[REFERENCE BANK]
{{ref_bank_lines}}
[ONE-SENTENCE SUMMARY] {{block.summary}}
[TIMESTAMP STORYBOARD]
{{storyboard_shots}}
[GLOBAL SUPPLEMENT] GEOGRAPHY / RACCORD lock ({{block.geography}} · 180° axis maintained: characters preserve screen positions and gaze direction across cuts · posture progression preserved) · ART STYLE / LIGHTING / COMP ({{style}}; critical re-lighting: characters re-lit by scene lighting and blended seamlessly into background; lighting changes dynamically between shadow and sunlight; restrained specular highlights) · MOTION (continuous locomotion with real footfalls, natural weight transfer, no sliding still images, no teleporting, no instant standing).
[AUDIO] ambience: {{block.ambience}}; foley: physical props and footsteps; dialogue list: {{block.dialogue_list}}; No BGM; no subtitles.
[HARD NEGATIVES] identity drift, costume drift, broken 180-degree axis, extra characters, CGI 3D photoreal unless style says so, explicit sexual content, watermarks, text, logos.
[FINAL PRIORITY] Ensure character identity consistency with @image references, seamless scene lighting integration, and natural physical motion pacing.`
    },

    tpl_video_ref_default: {
      id: "tpl_video_ref_default",
      name: "Per-Shot Video Prompt: REF (Spec 9.2)",
      kind: "video",
      model: "seedance-2.5",
      type_match: "REF",
      is_default: true,
      text:
`========== CONTENT BLOCK {{shot.block_pad}} | BATCH {{shot.batch_pad}} — SHOT {{shot.n_pad}} | TYPE: REF ==========
Target duration: {{shot.dur}} seconds.
Reference bank: {{bank.id}}
[VIDEO TARGET] Aspect: {{aspect}}. Cinematic narrative scene.
[REFERENCE BANK] {{bank.summary}}
[STORYBOARD] image1 is the storyboard keyframe: follow its composition and framing.
[SHOT ACTION] S{{shot.n_pad}} - {{shot.size}} {{shot.angle}} {{shot.move}}. {{shot.action}}. Placement: {{shot.placement}}. Performance: {{shot.perf}}. Dialogue: {{shot.dialogue_str}}
[CONTINUITY] Start: {{shot.cont_start}} -> End: {{shot.cont_end}}
[EXCLUSIONS] {{shot.excl}} {{negative}}`
    },

    tpl_video_i2v_default: {
      id: "tpl_video_i2v_default",
      name: "Per-Shot Video Prompt: I2V / MINI (Spec 9.2)",
      kind: "video",
      model: "seedance-2.0-fast",
      type_match: "I2V",
      is_default: true,
      text:
`========== CONTENT BLOCK {{shot.block_pad}} | BATCH {{shot.batch_pad}} — SHOT {{shot.n_pad}} | TYPE: {{shot.type}} ==========
Target duration: {{shot.dur}} seconds.
[VIDEO TARGET] Aspect: {{aspect}}. Cinematic narrative scene.
[STORYBOARD] The storyboard (image1) is the opening frame of this shot.
[SHOT ACTION] S{{shot.n_pad}} - {{shot.size}} {{shot.angle}} {{shot.move}}. {{shot.action}}. Placement: {{shot.placement}}. Performance: {{shot.perf}}. Dialogue: {{shot.dialogue_str}}
[CONTINUITY] Start: {{shot.cont_start}} -> End: {{shot.cont_end}}
[EXCLUSIONS] {{shot.excl}} {{negative}}`
    },

    tpl_stb_keyframe_default: {
      id: "tpl_stb_keyframe_default",
      name: "STB Opening Keyframe Prompt (Standard)",
      kind: "stb",
      model: "default",
      type_match: "ALL",
      is_default: true,
      text:
`Opening keyframe for S{{shot.n_pad}}, {{aspect}} cinematic framing, {{shot.size}} shot, {{shot.angle}} camera angle. Placement: {{shot.placement}}. Subject: {{shot.chars_desc}}. Initial pose: {{shot.action}}. Expression and mood: {{shot.perf}}. Environment: {{loc_desc}}, scene lighting matching time of day, cinematic tone. Art style: {{style}}. Negatives: text, watermark, logo, extra limbs, extra people, face distortion.`
    }
  };

  // Seed default templates into STORY.tpls
  function ensureDefaultTemplates() {
    if (!STORY.tpls) STORY.tpls = {};
    let added = false;
    Object.keys(DEFAULT_TEMPLATES).forEach(k => {
      if (!STORY.tpls[k]) {
        STORY.tpls[k] = Object.assign({}, DEFAULT_TEMPLATES[k], { u: Date.now() });
        if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(k);
        added = true;
      }
    });
    if (added && typeof STORY.scheduleSave === "function") {
      STORY.scheduleSave();
    }
  }

  function getTemplates(kind) {
    ensureDefaultTemplates();
    const list = Object.values(STORY.tpls || {});
    if (!kind) return list;
    return list.filter(t => t.kind === kind);
  }

  function getDefaultTemplate(kind, typeMatch = "ALL") {
    const list = getTemplates(kind);
    // Find matching type_match first
    const match = list.find(t => t.is_default && (t.type_match === typeMatch || t.type_match === "ALL"));
    if (match) return match;
    const anyDef = list.find(t => t.is_default);
    if (anyDef) return anyDef;
    return list[0] || null;
  }

  // ---------- Reference Bank Builder (KTOONS_STANDARDS §3) ----------
  function buildBlockReferenceBank(blockNum) {
    const bNum = Number(blockNum) || 1;
    const ep = getEp();
    const bible = getBible();
    const shots = getShots().filter(s => (s.block || 1) === bNum);

    const items = [];
    const usedCharIds = new Set();
    const usedLocIds = new Set();
    const usedPropIds = new Set();
    let imgIndex = 1;

    // 1. Characters in order of appearance in block
    shots.forEach(s => {
      (s.chars || []).forEach(cId => {
        if (!usedCharIds.has(cId)) {
          usedCharIds.add(cId);
          let cName = cId;
          let cLook = "";
          let refImg = "";
          if (bible && Array.isArray(bible.chars)) {
            const ch = bible.chars.find(c => c.id === cId || c.name === cId);
            if (ch) {
              cName = ch.name;
              cLook = ch.look || "";
              if (Array.isArray(ch.refs) && ch.refs.length) refImg = ch.refs[0].ref || "";
            }
          }
          items.push({
            tag: `@image${imgIndex++}`,
            kind: "character",
            id: cId,
            name: cName,
            desc: cLook,
            ref: refImg,
            sentence: `@image${imgIndex - 1} — ${cName}. Hard design / identity reference only. Preserve face, hair, costume, build and proportions. Do not preserve reference lighting or shading.`
          });
        }
      });
    });

    // 2. Environment / Location
    shots.forEach(s => {
      const locId = s.loc;
      if (locId && !usedLocIds.has(locId)) {
        usedLocIds.add(locId);
        let locName = locId;
        let locDesc = "";
        let refImg = "";
        if (bible && Array.isArray(bible.locs)) {
          const lc = bible.locs.find(l => l.id === locId || l.name === locId);
          if (lc) {
            locName = lc.name;
            locDesc = lc.desc || "";
            if (Array.isArray(lc.refs) && lc.refs.length) refImg = lc.refs[0].ref || "";
          }
        }
        items.push({
          tag: `@image${imgIndex++}`,
          kind: "environment",
          id: locId,
          name: locName,
          desc: locDesc,
          ref: refImg,
          sentence: `@image${imgIndex - 1} — ${locName} environment reference ONLY: architecture, materials, mood. Never use directly as background; never copy its camera or composition.`
        });
      }
    });

    // 3. Key Props
    shots.forEach(s => {
      (s.props || []).forEach(pId => {
        if (!usedPropIds.has(pId)) {
          usedPropIds.add(pId);
          let propName = pId;
          let propDesc = "";
          let refImg = "";
          if (bible && Array.isArray(bible.props)) {
            const pp = bible.props.find(p => p.id === pId || p.name === pId);
            if (pp) {
              propName = pp.name;
              propDesc = pp.desc || "";
              if (Array.isArray(pp.refs) && pp.refs.length) refImg = pp.refs[0].ref || "";
            }
          }
          items.push({
            tag: `@image${imgIndex++}`,
            kind: "prop",
            id: pId,
            name: propName,
            desc: propDesc,
            ref: refImg,
            sentence: `@image${imgIndex - 1} — ${propName}. Preserve shape, material and color.`
          });
        }
      });
    });

    // 4. Style Reference
    if (bible && bible.style && bible.style.ref) {
      items.push({
        tag: `@image${imgIndex++}`,
        kind: "style",
        id: "style_ref",
        name: "Art Style",
        desc: bible.style.look || "",
        ref: bible.style.ref,
        sentence: `@image${imgIndex - 1} — art-style / mood reference ONLY. Never reproduce its characters or environments.`
      });
    }

    // 5. STB Keyframes of shots in block
    shots.forEach(s => {
      if (s.stb && s.stb.ref) {
        items.push({
          tag: `@image${imgIndex++}`,
          kind: "storyboard",
          shot: s.n,
          id: s.id,
          name: `Shot S${padShotNo(s.n)} STB`,
          ref: s.stb.ref,
          sentence: `@image${imgIndex - 1} — Shot ${s.n} keyframe: follow framing, staging and emotional intent; do not reproduce literally.`
        });
      }
    });

    // Enforce <= 9 images rule (KTOONS_STANDARDS §3)
    // If > 9 images, prioritize dropping STB of MINI shots first, then props
    if (items.length > 9) {
      // 1. Drop MINI shot STBs
      for (let i = items.length - 1; i >= 0 && items.length > 9; i--) {
        if (items[i].kind === "storyboard") {
          const matchShot = shots.find(s => s.n === items[i].shot);
          if (matchShot && matchShot.type === "MINI") {
            items.splice(i, 1);
          }
        }
      }
      // 2. Drop props if still > 9
      for (let i = items.length - 1; i >= 0 && items.length > 9; i--) {
        if (items[i].kind === "prop" && items.length > 9) {
          items.splice(i, 1);
        }
      }
      // 3. Drop remaining STBs if still > 9
      for (let i = items.length - 1; i >= 0 && items.length > 9; i--) {
        if (items[i].kind === "storyboard" && items.length > 9) {
          items.splice(i, 1);
        }
      }
      // Re-index tags
      items.forEach((it, idx) => {
        const oldTag = it.tag;
        it.tag = `@image${idx + 1}`;
        it.sentence = it.sentence.replace(oldTag, it.tag);
      });
    }

    // Video animation reference
    const videoRefs = [
      {
        tag: "@video1",
        sentence: "@video1 — MASTER ANIMATION REFERENCE: follow its animation style, timing and rendering. Do not use its characters, environments or scenes. If any instruction conflicts with @video1 on style, follow @video1."
      }
    ];

    const linesText = items.map(it => it.sentence).concat(videoRefs.map(v => v.sentence)).join("\n");

    return {
      items,
      videoRefs,
      linesText,
      totalCount: items.length
    };
  }

  // ---------- Variables Engine ----------
  function resolveVariables(text, ctx = {}) {
    if (!text) return "";
    const ep = getEp();
    const bible = getBible();
    const shot = ctx.shot || null;
    const block = ctx.block || null;

    let res = text;

    // Series & Episode
    const sName = (bible && bible.name) || "THE SERIES";
    const epNum = (ep && ep.ep && ep.ep.replace(/[^0-9]/g, "")) || "01";
    const epPad = padShotNo(epNum);
    const epTitle = (ep && ep.title) || `Episode ${epNum}`;
    const aspect = (bible && bible.format && bible.format.aspect) || "9:16";
    const styleLook = (bible && bible.style && bible.style.look) || "photoreal cinematic";
    const negPrompt = (bible && bible.style && bible.style.negative) || "text, watermark, extra fingers, blurry, distorted";

    res = res.replace(/\{\{series\.name\}\}/g, sName);
    res = res.replace(/\{\{ep\.n\}\}/g, epNum);
    res = res.replace(/\{\{ep\.n_pad\}\}/g, epPad);
    res = res.replace(/\{\{ep\.title\}\}/g, epTitle);
    res = res.replace(/\{\{aspect\}\}/g, aspect);
    res = res.replace(/\{\{style\}\}/g, styleLook);
    res = res.replace(/\{\{negative\}\}/g, negPrompt);

    // Block variables
    if (block) {
      const bShots = getShots().filter(s => (s.block || 1) === (block.n || 1));
      const refBank = buildBlockReferenceBank(block.n);
      const locObj = (bible && Array.isArray(bible.locs))
        ? bible.locs.find(l => l.id === block.location || l.name === block.location)
        : null;
      const locName = locObj ? locObj.name : (block.location || "SCENE LOCATION");
      const locGeo = (locObj && locObj.geography) ? locObj.geography : "entrance screen-left, characters framed on eye-level axis";

      res = res.replace(/\{\{block\.n\}\}/g, String(block.n || 1));
      res = res.replace(/\{\{block\.dur\}\}/g, String(block.duration || 30));
      res = res.replace(/\{\{block\.location_name\}\}/g, locName);
      const bSummary = block.summary || (ep && ep.outline && (ep.outline.premise || (Array.isArray(ep.outline.beats) && ep.outline.beats[0] && ep.outline.beats[0].text))) || "{{summary}}";
      res = res.replace(/\{\{block\.summary\}\}/g, bSummary);
      res = res.replace(/\{\{block\.geography\}\}/g, locGeo);
      res = res.replace(/\{\{block\.ambience\}\}/g, "room acoustic tone, faint air draft");
      res = res.replace(/\{\{ref_bank_lines\}\}/g, refBank.linesText);
      res = res.replace(/\{\{shot_count\}\}/g, String(bShots.length || 1));

      // Build dialogue list string
      const dlgLines = [];
      bShots.forEach(s => {
        (s.dialogue || []).forEach(d => {
          if (d && d.text) {
            dlgLines.push(`${d.char_name || d.char || "SPEAKER"}: "${d.text}"`);
          }
        });
      });
      res = res.replace(/\{\{block\.dialogue_list\}\}/g, dlgLines.length ? dlgLines.join("; ") : "Natural English dialogue");

      // Build timestamp storyboard
      let curSec = 0;
      const sbLines = bShots.map(s => {
        const sDur = Number(s.dur) || 4;
        const startTc = formatTimecode(curSec);
        curSec += sDur;
        const endTc = formatTimecode(curSec);

        const sTitle = s.action || s.title || s.content || "{{action}}";
        const camStr = `${s.size || "MS"} · ${s.angle || "eye-level"} · ${s.move || "static"}${s.cam_rel ? " · " + s.cam_rel : ""}`;
        const placeStr = s.placement || "subject center-frame";
        const actOrder = s.action || "{{action}}";
        const perfStr = s.perf || "{{perf}}";

        const shotDlgs = (s.dialogue || []).map(d => {
          const mod = d.modifier === "VO" ? "INTERNAL VOICEOVER, mouth closed" : "Natural English lip-sync";
          return `"${d.text}" (${d.char_name || d.char || "SPEAKER"}, ${mod})`;
        }).join(" ");

        return `[${startTc}–${endTc}] SHOT ${padShotNo(s.n)} — ${sTitle}
Camera: ${camStr}
Placement: ${placeStr}
ACTION ORDER: ${actOrder}
Acting: ${perfStr}
Dialogue: ${shotDlgs || "none"}
Audio: ${s.sfx ? s.sfx + "; " : ""}natural foley footsteps`;
      });
      res = res.replace(/\{\{storyboard_shots\}\}/g, sbLines.join("\n\n"));
    }

    // Shot variables
    if (shot) {
      const sPad = padShotNo(shot.n);
      const bPad = padShotNo(shot.block || 1);
      const batPad = padShotNo(shot.batch || 1);

      res = res.replace(/\{\{shot\.n\}\}/g, String(shot.n || 1));
      res = res.replace(/\{\{shot\.n_pad\}\}/g, sPad);
      res = res.replace(/\{\{shot\.block\}\}/g, String(shot.block || 1));
      res = res.replace(/\{\{shot\.block_pad\}\}/g, bPad);
      res = res.replace(/\{\{shot\.batch\}\}/g, String(shot.batch || 1));
      res = res.replace(/\{\{shot\.batch_pad\}\}/g, batPad);
      res = res.replace(/\{\{shot\.type\}\}/g, shot.type || "REF");
      res = res.replace(/\{\{shot\.dur\}\}/g, String(shot.dur || 6));
      res = res.replace(/\{\{shot\.size\}\}/g, shot.size || "MCU");
      res = res.replace(/\{\{shot\.angle\}\}/g, shot.angle || "eye level");
      res = res.replace(/\{\{shot\.move\}\}/g, shot.move || "slow push-in");
      res = res.replace(/\{\{shot\.action\}\}/g, shot.action || shot.content || "Performs focused cinematic action.");
      res = res.replace(/\{\{shot\.placement\}\}/g, shot.placement || "subject centered in frame");
      res = res.replace(/\{\{shot\.perf\}\}/g, shot.perf || "sharp eye contact, intense focus");
      res = res.replace(/\{\{shot\.cont_start\}\}/g, (shot.cont && shot.cont.start) || "continuous from previous cut");
      res = res.replace(/\{\{shot\.cont_end\}\}/g, (shot.cont && shot.cont.end) || "settles in place");
      res = res.replace(/\{\{shot\.excl\}\}/g, shot.excl || "no abrupt movements, no jerky camera");

      // Character string
      const cDescs = (shot.chars || []).map(cId => {
        if (bible && Array.isArray(bible.chars)) {
          const ch = bible.chars.find(c => c.id === cId || c.name === cId);
          if (ch) return `${ch.name} (${ch.look || "standard wardrobe"})`;
        }
        return cId;
      }).join(", ");
      res = res.replace(/\{\{shot\.chars_desc\}\}/g, cDescs || "cinematic actor");

      // Dialogue strings
      const dlgs = (shot.dialogue || []).map(d => `${d.char_name || d.char || "SPEAKER"}: "${d.text}"`).join(" ");
      res = res.replace(/\{\{shot\.dialogue_str\}\}/g, dlgs || "none");
      res = res.replace(/\{\{shot\.dialogue_prompt\}\}/g, dlgs || "none");

      // Location description
      let locDesc = "cinematic set";
      if (shot.loc && bible && Array.isArray(bible.locs)) {
        const lc = bible.locs.find(l => l.id === shot.loc || l.name === shot.loc);
        if (lc) locDesc = `${lc.name}. ${lc.desc || ""}`;
      }
      res = res.replace(/\{\{loc\}\}/g, locDesc);
      res = res.replace(/\{\{loc_desc\}\}/g, locDesc);

      // Bank reference
      const bankId = (shot.bank && shot.bank[0] && shot.bank[0].bank) || `REFBANK_EP${epPad}_S${sPad}`;
      res = res.replace(/\{\{bank\.id\}\}/g, bankId);
      res = res.replace(/\{\{bank\.name\}\}/g, bankId);
      res = res.replace(/\{\{bank\.summary\}\}/g, `${bankId}/image1.jpg — character key identity`);
    }

    // Explicit variable lookup {{char:NAME}} and {{loc:NAME}}
    res = res.replace(/\{\{char:([^}]+)\}\}/g, (m, name) => {
      if (bible && Array.isArray(bible.chars)) {
        const ch = bible.chars.find(c => c.name.toLowerCase() === name.trim().toLowerCase() || c.id === name.trim());
        if (ch) return ch.look || ch.name;
      }
      return name;
    });

    res = res.replace(/\{\{loc:([^}]+)\}\}/g, (m, name) => {
      if (bible && Array.isArray(bible.locs)) {
        const lc = bible.locs.find(l => l.name.toLowerCase() === name.trim().toLowerCase() || l.id === name.trim());
        if (lc) return `${lc.name} (${lc.desc || lc.time || ""})`;
      }
      return name;
    });

    return res;
  }

  // ---------- Realtime Lint Engine (Spec 5.D #4 & Workflow §3) ----------
  function lintPrompt(text, opts = {}) {
    const issues = [];
    const raw = String(text || "");
    const charCount = raw.length;
    const wordCount = raw.trim() ? raw.trim().split(/\s+/).length : 0;

    if (!raw.trim()) {
      return {
        issues: [{ id: "EMPTY", level: "warn", message: "Prompt is empty. Use 'Fill from template' or write a prompt.", fixable: false }],
        valid: false,
        charCount: 0,
        wordCount: 0
      };
    }

    // 1. Length check (> 2000 chars warning, block prompt word budget check)
    if (opts.kind === "block") {
      if (wordCount > 800 || charCount > 4000) {
        issues.push({
          id: "LENGTH_TOO_LONG",
          level: "warn",
          message: `Block prompt is lengthy (${wordCount} words, ${charCount} chars). Target budget is 350–700 words to avoid provider timeouts.`,
          fixable: false
        });
      }
    } else {
      if (charCount > 2000) {
        issues.push({
          id: "LENGTH_EXCEEDED",
          level: "warn",
          message: `Prompt exceeds recommended 2000 characters (${charCount} chars). Consider shortening descriptions.`,
          fixable: false
        });
      }
    }

    // 2. Mandatory STB sentence check (Spec 9.2 #5)
    if (opts.kind === "video_shot" && opts.shot) {
      const isRef = opts.shot.type === "REF";
      const refSentence = "image1 is the storyboard keyframe: follow its composition and framing.";
      const i2vSentence = "The storyboard (image1) is the opening frame of this shot.";

      if (isRef) {
        if (!raw.includes(refSentence)) {
          issues.push({
            id: "MANDATORY_STB_REF",
            level: "error",
            message: `Missing mandatory REF storyboard keyframe sentence: "${refSentence}"`,
            fixable: true,
            fixType: "insert_stb_sentence",
            fixData: { sentence: refSentence }
          });
        }
      } else {
        if (!raw.includes(i2vSentence)) {
          issues.push({
            id: "MANDATORY_STB_I2V",
            level: "error",
            message: `Missing mandatory I2V storyboard sentence: "${i2vSentence}"`,
            fixable: true,
            fixType: "insert_stb_sentence",
            fixData: { sentence: i2vSentence }
          });
        }
      }
    }

    // 3. Unreplaced variables check
    const unreplacedMatches = raw.match(/\{\{([^}]+)\}\}/g);
    if (unreplacedMatches && unreplacedMatches.length > 0) {
      const sample = unreplacedMatches.slice(0, 3).join(", ");
      issues.push({
        id: "UNREPLACED_VARS",
        level: "error",
        message: `Unreplaced variables detected: ${sample}${unreplacedMatches.length > 3 ? "..." : ""}`,
        fixable: true,
        fixType: "resolve_vars"
      });
    }

    // 4. "SHOT 09" instead of "S09" check (Spec 9.2 #1)
    // Ignore in block headers like "[00:00] SHOT 01 — Title" or "— SHOT 08 | TYPE:"
    const shotBodyMatches = [];
    const shotNumRegex = /\b(SHOT|Shot)\s+0?([0-9]{1,3})\b/g;
    let m;
    while ((m = shotNumRegex.exec(raw)) !== null) {
      const idx = m.index;
      const prefix = raw.substring(Math.max(0, idx - 25), idx);
      // Check if it's in a standardized title header
      if (!prefix.includes("—") && !prefix.includes("]") && !prefix.includes("|")) {
        shotBodyMatches.push({ full: m[0], num: m[2] });
      }
    }
    if (shotBodyMatches.length > 0) {
      issues.push({
        id: "INVALID_SHOT_NUMBERING",
        level: "warn",
        message: `Write "S09" instead of "SHOT 09" in prompt body text (found: ${shotBodyMatches[0].full}).`,
        fixable: true,
        fixType: "fix_shot_naming"
      });
    }

    // 5. Configurable blocked real names check
    const lower = raw.toLowerCase();
    for (const celeb of BLOCKED_CELEBRITY_NAMES) {
      if (lower.includes(celeb)) {
        issues.push({
          id: "BLOCKED_NAME",
          level: "error",
          message: `Contains blocked celebrity / real person name: "${celeb}". Use fictional character names.`,
          fixable: false
        });
        break;
      }
    }

    // 6. Explicit content word list check
    for (const term of EXPLICIT_CONTENT_TERMS) {
      const termRegex = new RegExp(`\\b${term}\\b`, "i");
      if (termRegex.test(raw)) {
        issues.push({
          id: "EXPLICIT_CONTENT",
          level: "error",
          message: `Contains explicit / NSFW prohibited term: "${term}". Keep content sensual but non-explicit and adult-safe.`,
          fixable: false
        });
        break;
      }
    }

    // 7. Block mode: timestamp duration & gap check
    if (opts.kind === "block" && opts.block) {
      const targetDur = Number(opts.block.duration) || 30;
      const tcRegex = /\[([0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)–([0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)\]/g;
      let tcMatch;
      let lastEnd = 0;
      let totalSpan = 0;
      let foundTc = false;

      function parseTc(str) {
        const parts = str.split(":");
        const mm = Number(parts[0]) || 0;
        const ss = Number(parts[1]) || 0;
        return mm * 60 + ss;
      }

      while ((tcMatch = tcRegex.exec(raw)) !== null) {
        foundTc = true;
        const sTime = parseTc(tcMatch[1]);
        const eTime = parseTc(tcMatch[2]);
        if (sTime < lastEnd - 0.1) {
          issues.push({
            id: "TIMECODE_OVERLAP",
            level: "warn",
            message: `Timecode overlap detected around ${tcMatch[1]}. Consecutive shots should not overlap.`,
            fixable: false
          });
        }
        lastEnd = eTime;
        totalSpan = eTime;
      }

      if (foundTc && Math.abs(totalSpan - targetDur) > 0.5) {
        issues.push({
          id: "TIMECODE_DURATION_MISMATCH",
          level: "warn",
          message: `Storyboard timestamps span ${totalSpan.toFixed(2)}s, but block target duration is ${targetDur.toFixed(2)}s.`,
          fixable: false
        });
      }

      // 8. Block mode: @imageN definition check
      const usedImages = new Set();
      const imgRegex = /@image([0-9]+)/g;
      let imgM;
      while ((imgM = imgRegex.exec(raw)) !== null) {
        usedImages.add(`@image${imgM[1]}`);
      }

      // Check if declared in [REFERENCE BANK]
      const refBankSec = raw.includes("[REFERENCE BANK]")
        ? raw.substring(raw.indexOf("[REFERENCE BANK]"), raw.indexOf("[ONE-SENTENCE SUMMARY]") !== -1 ? raw.indexOf("[ONE-SENTENCE SUMMARY]") : raw.length)
        : "";

      for (const imgTag of usedImages) {
        if (!refBankSec.includes(imgTag)) {
          issues.push({
            id: "UNDEFINED_CREATIVE_REF",
            level: "warn",
            message: `${imgTag} is used in storyboard but not defined in [REFERENCE BANK].`,
            fixable: false
          });
        }
      }

      // 9. Block mode: repeated paragraphs check
      const paragraphs = raw.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 50);
      const seenParas = new Set();
      for (const p of paragraphs) {
        if (seenParas.has(p)) {
          issues.push({
            id: "REPEATED_PARAGRAPH",
            level: "warn",
            message: "Duplicate paragraph detected in prompt. Keep prompts compact without repeating blocks.",
            fixable: false
          });
          break;
        }
        seenParas.add(p);
      }
    }

    const hasError = issues.some(i => i.level === "error");
    return {
      issues,
      valid: !hasError,
      charCount,
      wordCount
    };
  }

  // ---------- Push Version History ----------
  function pushPromptVersion(targetObj, fieldName = "vprompt") {
    if (!targetObj || !targetObj[fieldName]) return;
    const p = targetObj[fieldName];
    if (!Array.isArray(p.history)) p.history = [];

    const curText = p.text || "";
    if (curText.trim()) {
      const last = p.history[0];
      if (!last || last.text !== curText) {
        p.history.unshift({
          text: curText,
          ver: p.ver || 1,
          at: Date.now()
        });
        if (p.history.length > 3) p.history.pop();
        p.ver = (p.ver || 1) + 1;
      }
    }
  }

  // ---------- Fill from Template Operations ----------
  function fillShotPrompts(shotId, opts = {}) {
    const shots = getShots();
    const s = shots.find(x => x.id === shotId);
    if (!s) return false;
    ensureShotPrompts(s);

    let changed = false;

    // Fill STB if requested and unlocked
    if (opts.stb !== false) {
      if (s.stb.locked) {
        // skip locked
      } else if (!opts.onlyMissing || !s.stb.prompt || !s.stb.prompt.trim()) {
        const tpl = getDefaultTemplate("stb", "ALL");
        if (tpl) {
          pushPromptVersion(s, "stb");
          s.stb.prompt = resolveVariables(tpl.text, { shot: s });
          s.stb.u = Date.now();
          changed = true;
        }
      }
    }

    // Fill Video if requested and unlocked
    if (opts.video !== false) {
      if (s.vprompt.locked) {
        // skip locked
      } else if (!opts.onlyMissing || !s.vprompt.text || !s.vprompt.text.trim()) {
        const tpl = getDefaultTemplate("video", s.type || "REF");
        if (tpl) {
          pushPromptVersion(s, "vprompt");
          s.vprompt.text = resolveVariables(tpl.text, { shot: s });
          const lintRes = lintPrompt(s.vprompt.text, { kind: "video_shot", shot: s });
          s.vprompt.lint = lintRes.issues;
          s.vprompt.u = Date.now();
          changed = true;
        }
      }
    }

    return changed;
  }

  function fillBlockPrompt(blockNum, opts = {}) {
    const ep = getEp();
    const blocks = ensureBlocks();
    const b = blocks.find(x => x.n === Number(blockNum));
    if (!b) return false;

    if (b.vprompt.locked) {
      if (typeof toast === "function") toast(`Block ${b.n} prompt is locked. Unlock to regenerate.`);
      return false;
    }

    if (opts.onlyMissing && b.vprompt.text && b.vprompt.text.trim()) {
      return false;
    }

    const tpl = getDefaultTemplate("block", "ALL");
    if (!tpl) return false;

    pushPromptVersion(b, "vprompt");
    b.vprompt.text = resolveVariables(tpl.text, { block: b });
    const lintRes = lintPrompt(b.vprompt.text, { kind: "block", block: b });
    b.vprompt.lint = lintRes.issues;
    b.vprompt.u = Date.now();

    // Also fill STBs for shots in this block if missing
    const bShots = getShots().filter(s => (s.block || 1) === b.n);
    bShots.forEach(s => {
      ensureShotPrompts(s);
      if (!s.stb.locked && (!s.stb.prompt || !s.stb.prompt.trim())) {
        const stbTpl = getDefaultTemplate("stb", "ALL");
        if (stbTpl) {
          s.stb.prompt = resolveVariables(stbTpl.text, { shot: s });
          s.stb.u = Date.now();
        }
      }
    });

    return true;
  }

  function fillAllMissingPrompts() {
    let filledShots = 0;
    let lockedShots = 0;
    let filledBlocks = 0;

    const blocks = ensureBlocks();
    const shots = getShots();

    // Fill missing blocks
    blocks.forEach(b => {
      if (b.vprompt && b.vprompt.locked) {
        // locked
      } else if (!b.vprompt || !b.vprompt.text || !b.vprompt.text.trim()) {
        if (fillBlockPrompt(b.n, { onlyMissing: true })) filledBlocks++;
      }
    });

    // Fill missing shots
    shots.forEach(s => {
      ensureShotPrompts(s);
      if (s.vprompt.locked || s.stb.locked) {
        lockedShots++;
      }
      if (fillShotPrompts(s.id, { onlyMissing: true })) {
        filledShots++;
      }
    });

    if (typeof STORY.snapshot === "function") STORY.snapshot("Fill All Missing Prompts");
    if (STORY.dirty) STORY.dirty.ep = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    if (typeof STORY.renderView === "function") STORY.renderView();

    let msg = `Filled prompts for ${filledShots} shots and ${filledBlocks} blocks.`;
    if (lockedShots > 0) msg += ` (${lockedShots} locked skipped).`;
    if (typeof toast === "function") toast(msg);
  }

  // ---------- Auto-Fix Handlers ----------
  function applyFix(fixType, targetObj, fixData = {}) {
    if (!targetObj) return;

    if (fixType === "insert_stb_sentence" && fixData.sentence) {
      const cur = targetObj.text || "";
      if (cur.includes("[STORYBOARD]")) {
        targetObj.text = cur.replace(/\[STORYBOARD\][^\n]*/, `[STORYBOARD] ${fixData.sentence}`);
      } else {
        targetObj.text = cur + `\n\n[STORYBOARD] ${fixData.sentence}`;
      }
    } else if (fixType === "fix_shot_naming") {
      targetObj.text = (targetObj.text || "").replace(/\b(SHOT|Shot)\s+0?([0-9]{1,3})\b/g, (match, prefix, num) => {
        return "S" + padShotNo(num);
      });
    } else if (fixType === "resolve_vars") {
      targetObj.text = resolveVariables(targetObj.text || {}, fixData.ctx || {});
    }

    targetObj.u = Date.now();
  }

  // ---------- Render: Left Sidebar ----------
  function renderSidebar(container) {
    const ep = getEp();
    const bible = getBible();
    const blocks = ensureBlocks();
    const shots = getShots();

    let html = `
      <div class="story-prompt-sidebar-header">
        <span>${promptMode === "block" ? "Production Blocks" : "Shot Sequence"}</span>
        <label style="display:flex;align-items:center;gap:4px;font-size:10.5px;cursor:pointer;font-weight:normal;text-transform:none;">
          <input type="checkbox" id="story-prompt-filter-locked" ${filterLockedOnly ? "checked" : ""} data-s="prompt.toggle_filter_locked"> Locked only
        </label>
      </div>
      <div class="story-prompt-sidebar-list">
    `;

    if (promptMode === "block") {
      // List of Blocks (Block 1, Block 2, Block 3)
      blocks.forEach(b => {
        const bShots = shots.filter(s => (s.block || 1) === b.n);
        const isLocked = b.vprompt && b.vprompt.locked;
        if (filterLockedOnly && !isLocked) return;

        const hasPrompt = b.vprompt && b.vprompt.text && b.vprompt.text.trim();
        const lintRes = hasPrompt ? lintPrompt(b.vprompt.text, { kind: "block", block: b }) : null;
        const hasErrors = lintRes && lintRes.issues.some(i => i.level === "error");

        let statusClass = "empty";
        let statusText = "Empty";
        if (hasPrompt) {
          if (hasErrors) {
            statusClass = "error";
            statusText = "Issues";
          } else {
            statusClass = "filled";
            statusText = "Ready";
          }
        }

        const isActive = selBlockNum === b.n;

        // Find primary location
        const locObj = (bible && Array.isArray(bible.locs))
          ? bible.locs.find(l => l.id === b.location || l.name === b.location)
          : null;
        const locLabel = locObj ? locObj.name : (b.location || "Location not set");

        html += `
          <div class="story-prompt-card ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}" data-s="prompt.select_block:${b.n}">
            <div class="story-prompt-card-top">
              <div class="story-prompt-card-title">
                <span>Block ${b.n}</span>
                <span class="story-badge-pill">${b.duration || 30}s</span>
              </div>
              <div class="story-prompt-card-badges">
                ${isLocked ? `<span class="story-badge-locked">Locked</span>` : ""}
                <span class="story-badge-status ${statusClass}">${statusText}</span>
              </div>
            </div>
            <div class="story-prompt-card-desc">
              ${_esc(locLabel)} · ${bShots.length} shots
            </div>
          </div>
        `;
      });
    } else {
      // List of Shots
      shots.forEach(s => {
        ensureShotPrompts(s);
        const isLocked = s.vprompt.locked || s.stb.locked;
        if (filterLockedOnly && !isLocked) return;

        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const matchNo = `s${padShotNo(s.n)}`.includes(q) || String(s.n).includes(q);
          const matchAction = (s.action || "").toLowerCase().includes(q);
          const matchTitle = (s.title || "").toLowerCase().includes(q);
          if (!matchNo && !matchAction && !matchTitle) return;
        }

        const isActive = selShotId === s.id;
        const hasV = s.vprompt && s.vprompt.text && s.vprompt.text.trim();
        const hasStb = s.stb && s.stb.prompt && s.stb.prompt.trim();

        let statusClass = "empty";
        let statusText = "No Prompt";
        if (hasV && hasStb) {
          statusClass = "filled";
          statusText = "STB+Video";
        } else if (hasV || hasStb) {
          statusClass = "filled";
          statusText = hasV ? "Video Only" : "STB Only";
        }

        html += `
          <div class="story-prompt-card ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}" data-s="prompt.select_shot:${s.id}">
            <div class="story-prompt-card-top">
              <div class="story-prompt-card-title">
                <span>S${padShotNo(s.n)}</span>
                <span class="story-badge-type ${s.type || 'REF'}">${s.type || 'REF'}</span>
                <span class="story-badge-pill">${s.dur || 6}s</span>
              </div>
              <div class="story-prompt-card-badges">
                ${isLocked ? `<span class="story-badge-locked">Locked</span>` : ""}
                <span class="story-badge-status ${statusClass}">${statusText}</span>
              </div>
            </div>
            <div class="story-prompt-card-desc">
              ${_esc(s.title || s.action || s.content || "No description")}
            </div>
          </div>
        `;
      });
    }

    html += `</div>`;
    container.innerHTML = html;
  }

  // ---------- Render: Block Editor Workspace ----------
  function renderBlockEditor(container) {
    const ep = getEp();
    const bible = getBible();
    const blocks = ensureBlocks();
    const b = blocks.find(x => x.n === selBlockNum) || blocks[0];
    if (!b) {
      container.innerHTML = `<div class="story-empty-state"><div class="story-empty-title">No Blocks Found</div></div>`;
      return;
    }

    const bShots = getShots().filter(s => (s.block || 1) === b.n);
    const refBank = buildBlockReferenceBank(b.n);
    const isLocked = b.vprompt && b.vprompt.locked;
    const curText = (b.vprompt && b.vprompt.text) || "";

    // Lint results
    const lintRes = lintPrompt(curText, { kind: "block", block: b });
    b.vprompt.lint = lintRes.issues;

    // Version history
    const history = b.vprompt.history || [];
    const curVer = b.vprompt.ver || 1;

    let html = `
      <!-- Editor Header -->
      <div class="story-prompt-editor-header">
        <div class="story-prompt-editor-title">
          <span>Block ${b.n} (Seedance 2.5 Multi-Shot)</span>
          <span class="story-badge-pill">${b.duration || 30}s target</span>
          <span class="story-badge-pill">${bShots.length} shots</span>
          ${isLocked ? `<span class="story-badge-locked">Locked (Protected)</span>` : ""}
        </div>
        <div class="story-prompt-editor-actions">
          <button class="story-btn-ghost" data-s="prompt.toggle_block_lock:${b.n}">
            ${isLocked ? "Unlock" : "Lock Prompt"}
          </button>
          <button class="story-btn-ghost" data-s="prompt.fill_block:${b.n}">Fill from Template</button>
          <button class="story-btn-ghost" data-s="prompt.copy_block:${b.n}">Copy</button>
          <button class="story-btn-ghost ${showVideoPreview ? 'active' : ''}" data-s="prompt.toggle_video_preview">
            ${showVideoPreview ? "Hide Preview" : "Preview Variables"}
          </button>
        </div>
      </div>

      <!-- Reference Bank Box (KTOONS_STANDARDS §3) -->
      <div class="story-prompt-refbank">
        <div class="story-prompt-refbank-head">
          <span>Block Reference Bank (Standard Roles · ${refBank.totalCount} / 9 images)</span>
          <span style="font-size:10.5px;color:var(--muted);font-weight:normal;">Auto-built per KTOONS_STANDARDS §3</span>
        </div>
        <div class="story-prompt-refbank-grid">
          ${refBank.items.map(it => `
            <div class="story-prompt-refbank-item">
              <span class="story-prompt-refbank-tag">${it.tag}</span>
              <div class="story-prompt-refbank-detail">
                <div style="font-weight:600;">${_esc(it.name)} <span style="font-size:9.5px;color:var(--muted);">(${it.kind})</span></div>
                <div class="story-prompt-refbank-role">${_esc(it.sentence)}</div>
              </div>
            </div>
          `).join("")}
          ${refBank.videoRefs.map(v => `
            <div class="story-prompt-refbank-item" style="grid-column: 1 / -1; border-color: #3b5042;">
              <span class="story-prompt-refbank-tag" style="color:#34d399;">${v.tag}</span>
              <div class="story-prompt-refbank-detail">
                <div style="font-weight:600;">Animation Master Reference</div>
                <div class="story-prompt-refbank-role">${_esc(v.sentence)}</div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Block Prompt Section -->
      <div class="story-prompt-sec ${isLocked ? 'locked' : ''}">
        <div class="story-prompt-sec-head">
          <div class="story-prompt-sec-title">
            <span>Seedance 2.5 Multi-Shot Block Prompt</span>
            <span class="story-badge-pill">${lintRes.wordCount} words · ${lintRes.charCount} chars</span>
          </div>
          <div class="story-prompt-sec-tools">
            <!-- Version History Controls -->
            <div class="story-ver-ctrl">
              <span class="story-ver-label">Ver ${curVer}</span>
              <button class="story-ver-btn" data-s="prompt.block_ver_prev:${b.n}" ${history.length === 0 ? "disabled" : ""}>‹</button>
              <button class="story-ver-btn" data-s="prompt.block_ver_restore:${b.n}" ${history.length === 0 ? "disabled" : ""}>Restore Older</button>
            </div>
          </div>
        </div>

        <!-- Quick Variable Insertion Chips -->
        <div class="story-prompt-vars-bar">
          <span style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-right:4px;">Insert:</span>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{style}}">+ {{style}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{aspect}}">+ {{aspect}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{negative}}">+ {{negative}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{ref_bank_lines}}">+ {{ref_bank}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{storyboard_shots}}">+ {{storyboard}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{block.geography}}">+ {{geography}}</button>
        </div>

        <!-- Textarea -->
        <div class="story-prompt-textarea-wrap">
          <textarea
            id="story-block-prompt-textarea"
            class="story-prompt-textarea block-mode"
            data-block-num="${b.n}"
            placeholder="Type or generate Seedance 2.5 multi-shot prompt..."
          >${_esc(curText)}</textarea>
        </div>

        <!-- Live Preview Box (Variables Resolved) -->
        ${showVideoPreview ? `
          <div class="story-prompt-preview">
            <div class="story-prompt-preview-title">Variables Resolved Preview</div>
            <div>${_esc(resolveVariables(curText, { block: b }))}</div>
          </div>
        ` : ""}

        <!-- Realtime Lint Box -->
        <div class="story-prompt-lint">
          <div class="story-prompt-lint-summary">
            <div class="story-prompt-lint-stats">
              <span><b>${lintRes.wordCount}</b> words (budget: 350–700)</span>
              <span><b>${lintRes.charCount}</b> chars</span>
            </div>
            <div>
              <span class="story-badge-status ${lintRes.valid ? 'filled' : 'error'}">
                ${lintRes.valid ? "Lint Passed" : `${lintRes.issues.length} Issues Detected`}
              </span>
            </div>
          </div>
          ${lintRes.issues.length > 0 ? `
            <div class="story-prompt-lint-issues">
              ${lintRes.issues.map(iss => `
                <div class="story-prompt-lint-item ${iss.level}">
                  <span class="story-prompt-lint-msg">${_esc(iss.message)}</span>
                  ${iss.fixable ? `
                    <button class="story-prompt-lint-btn" data-s="prompt.apply_lint_fix:block:${b.n}:${iss.id}">Fix</button>
                  ` : ""}
                </div>
              `).join("")}
            </div>
          ` : ""}
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  // ---------- Render: Shot Editor Workspace ----------
  function renderShotEditor(container) {
    const shots = getShots();
    const s = shots.find(x => x.id === selShotId) || shots[0];
    if (!s) {
      container.innerHTML = `<div class="story-empty-state"><div class="story-empty-title">No Shots Found</div></div>`;
      return;
    }

    ensureShotPrompts(s);

    const isLocked = s.vprompt.locked || s.stb.locked;
    const curVText = s.vprompt.text || "";
    const curStbText = s.stb.prompt || "";

    // Lint results for video prompt
    const vLint = lintPrompt(curVText, { kind: "video_shot", shot: s });
    s.vprompt.lint = vLint.issues;

    // Lint results for STB prompt
    const stbLint = lintPrompt(curStbText, { kind: "stb", shot: s });

    let html = `
      <!-- Editor Header -->
      <div class="story-prompt-editor-header">
        <div class="story-prompt-editor-title">
          <span>Shot S${padShotNo(s.n)}</span>
          <span class="story-badge-type ${s.type || 'REF'}">${s.type || 'REF'}</span>
          <span class="story-badge-pill">${s.dur || 6}s</span>
          <span class="story-badge-pill">Block ${s.block || 1} · Batch ${s.batch || 1}</span>
          ${isLocked ? `<span class="story-badge-locked">Locked</span>` : ""}
        </div>
        <div class="story-prompt-editor-actions">
          <button class="story-btn-ghost" data-s="prompt.toggle_shot_lock:${s.id}">
            ${isLocked ? "Unlock Shot" : "Lock Shot"}
          </button>
          <button class="story-btn-ghost" data-s="prompt.fill_shot:${s.id}">Fill from Template</button>
          <button class="story-btn-ghost" data-s="prompt.prev_shot:${s.id}">‹ Prev</button>
          <button class="story-btn-ghost" data-s="prompt.next_shot:${s.id}">Next ›</button>
        </div>
      </div>

      <!-- STB Image Prompt Section -->
      <div class="story-prompt-sec ${s.stb.locked ? 'locked' : ''}">
        <div class="story-prompt-sec-head">
          <div class="story-prompt-sec-title">
            <span>STB Opening Keyframe Image Prompt</span>
            <span class="story-badge-pill">${stbLint.charCount} chars</span>
          </div>
          <div class="story-prompt-sec-tools">
            <button class="story-btn-ghost" data-s="prompt.fill_shot_stb:${s.id}">Fill STB</button>
            <button class="story-btn-ghost" data-s="prompt.copy_shot_stb:${s.id}">Copy</button>
            <button class="story-btn-ghost ${showStbPreview ? 'active' : ''}" data-s="prompt.toggle_stb_preview">
              ${showStbPreview ? "Hide Preview" : "Preview"}
            </button>
          </div>
        </div>

        <div class="story-prompt-textarea-wrap">
          <textarea
            id="story-shot-stb-textarea"
            class="story-prompt-textarea"
            data-shot-id="${s.id}"
            placeholder="Type or generate STB opening keyframe image prompt..."
          >${_esc(curStbText)}</textarea>
        </div>

        ${showStbPreview ? `
          <div class="story-prompt-preview">
            <div class="story-prompt-preview-title">Variables Resolved Preview</div>
            <div>${_esc(resolveVariables(curStbText, { shot: s }))}</div>
          </div>
        ` : ""}

        <div class="story-prompt-lint">
          <div class="story-prompt-lint-summary">
            <span style="color:var(--muted);">${stbLint.charCount} chars · ${stbLint.wordCount} words</span>
            <span class="story-badge-status ${stbLint.valid ? 'filled' : 'error'}">
              ${stbLint.valid ? "Lint Passed" : `${stbLint.issues.length} Issues`}
            </span>
          </div>
        </div>
      </div>

      <!-- Per-Shot Video Prompt Section -->
      <div class="story-prompt-sec ${s.vprompt.locked ? 'locked' : ''}">
        <div class="story-prompt-sec-head">
          <div class="story-prompt-sec-title">
            <span>Video Prompt (${s.type || 'REF'} · Spec 9.2)</span>
            <span class="story-badge-pill">${vLint.charCount} chars</span>
          </div>
          <div class="story-prompt-sec-tools">
            <!-- Version History Controls -->
            <div class="story-ver-ctrl">
              <span class="story-ver-label">Ver ${s.vprompt.ver || 1}</span>
              <button class="story-ver-btn" data-s="prompt.shot_ver_prev:${s.id}" ${(s.vprompt.history || []).length === 0 ? "disabled" : ""}>‹</button>
              <button class="story-ver-btn" data-s="prompt.shot_ver_restore:${s.id}" ${(s.vprompt.history || []).length === 0 ? "disabled" : ""}>Restore</button>
            </div>
            <button class="story-btn-ghost" data-s="prompt.fill_shot_video:${s.id}">Fill Video</button>
            <button class="story-btn-ghost" data-s="prompt.copy_shot_video:${s.id}">Copy</button>
            <button class="story-btn-ghost ${showVideoPreview ? 'active' : ''}" data-s="prompt.toggle_video_preview">
              ${showVideoPreview ? "Hide Preview" : "Preview"}
            </button>
          </div>
        </div>

        <!-- Quick Variable Insertion Chips -->
        <div class="story-prompt-vars-bar">
          <span style="font-size:10px;color:var(--muted);text-transform:uppercase;margin-right:4px;">Insert:</span>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{shot.action}}">+ {{action}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{shot.dialogue_str}}">+ {{dialogue}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{shot.placement}}">+ {{placement}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{style}}">+ {{style}}</button>
          <button class="story-prompt-var-chip" data-s="prompt.insert_var:{{negative}}">+ {{negative}}</button>
        </div>

        <div class="story-prompt-textarea-wrap">
          <textarea
            id="story-shot-video-textarea"
            class="story-prompt-textarea"
            data-shot-id="${s.id}"
            placeholder="Type or generate per-shot video prompt..."
          >${_esc(curVText)}</textarea>
        </div>

        ${showVideoPreview ? `
          <div class="story-prompt-preview">
            <div class="story-prompt-preview-title">Variables Resolved Preview</div>
            <div>${_esc(resolveVariables(curVText, { shot: s }))}</div>
          </div>
        ` : ""}

        <!-- Video Lint Results -->
        <div class="story-prompt-lint">
          <div class="story-prompt-lint-summary">
            <span style="color:var(--muted);">${vLint.charCount} chars · ${vLint.wordCount} words</span>
            <span class="story-badge-status ${vLint.valid ? 'filled' : 'error'}">
              ${vLint.valid ? "Lint Passed" : `${vLint.issues.length} Issues`}
            </span>
          </div>
          ${vLint.issues.length > 0 ? `
            <div class="story-prompt-lint-issues">
              ${vLint.issues.map(iss => `
                <div class="story-prompt-lint-item ${iss.level}">
                  <span class="story-prompt-lint-msg">${_esc(iss.message)}</span>
                  ${iss.fixable ? `
                    <button class="story-prompt-lint-btn" data-s="prompt.apply_lint_fix:shot:${s.id}:${iss.id}">Fix</button>
                  ` : ""}
                </div>
              `).join("")}
            </div>
          ` : ""}
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  // ---------- Render: Template Manager Modal ----------
  function renderTemplateModal() {
    let modalEl = document.getElementById("story-tpl-modal-backdrop");
    if (!tplModalOpen) {
      if (modalEl) modalEl.remove();
      return;
    }

    if (!modalEl) {
      modalEl = document.createElement("div");
      modalEl.id = "story-tpl-modal-backdrop";
      modalEl.className = "story-tpl-modal-backdrop";
      document.body.appendChild(modalEl);
    }

    ensureDefaultTemplates();
    const allTpls = getTemplates();
    const activeTpl = allTpls.find(t => t.id === activeModalTplId) || allTpls[0] || null;

    modalEl.innerHTML = `
      <div class="story-tpl-modal">
        <div class="story-tpl-modal-head">
          <div class="story-tpl-modal-title">Prompt Template Manager (story_tpl)</div>
          <button class="story-btn-ghost" data-s="prompt.close_tpl_modal">Close</button>
        </div>
        <div class="story-tpl-modal-body">
          <!-- Left List Pane -->
          <div class="story-tpl-list-pane">
            <button class="story-btn-gold" style="margin-bottom:6px;" data-s="prompt.new_tpl">+ New Template</button>
            ${allTpls.map(t => `
              <div class="story-tpl-item ${activeTpl && activeTpl.id === t.id ? 'active' : ''}" data-s="prompt.select_tpl:${t.id}">
                <div style="font-weight:600;font-size:11.5px;color:var(--text);">${_esc(t.name)}</div>
                <div style="font-size:10px;color:var(--muted);display:flex;justify-content:space-between;">
                  <span>${t.kind} (${t.type_match || 'ALL'})</span>
                  ${t.is_default ? `<span style="color:#fbbf24;font-weight:600;">Default</span>` : ""}
                </div>
              </div>
            `).join("")}
          </div>

          <!-- Right Edit Pane -->
          <div class="story-tpl-form-pane">
            ${activeTpl ? `
              <div class="story-tpl-form-row">
                <label class="story-tpl-label">Template Name</label>
                <input type="text" id="story-tpl-input-name" class="story-tpl-input" value="${_esc(activeTpl.name)}">
              </div>
              <div style="display:flex;gap:12px;">
                <div class="story-tpl-form-row" style="flex:1;">
                  <label class="story-tpl-label">Kind</label>
                  <select id="story-tpl-input-kind" class="story-select-sm" style="height:32px;">
                    <option value="block" ${activeTpl.kind === "block" ? "selected" : ""}>Block (Seedance 2.5)</option>
                    <option value="video" ${activeTpl.kind === "video" ? "selected" : ""}>Video (Per-shot)</option>
                    <option value="stb" ${activeTpl.kind === "stb" ? "selected" : ""}>STB Keyframe</option>
                  </select>
                </div>
                <div class="story-tpl-form-row" style="flex:1;">
                  <label class="story-tpl-label">Type Match</label>
                  <select id="story-tpl-input-type" class="story-select-sm" style="height:32px;">
                    <option value="ALL" ${activeTpl.type_match === "ALL" ? "selected" : ""}>ALL Types</option>
                    <option value="REF" ${activeTpl.type_match === "REF" ? "selected" : ""}>REF Only</option>
                    <option value="I2V" ${activeTpl.type_match === "I2V" ? "selected" : ""}>I2V Only</option>
                    <option value="MINI" ${activeTpl.type_match === "MINI" ? "selected" : ""}>MINI Only</option>
                  </select>
                </div>
                <div class="story-tpl-form-row" style="flex:1;">
                  <label class="story-tpl-label">Default Template</label>
                  <label style="display:flex;align-items:center;gap:6px;font-size:11.5px;margin-top:6px;cursor:pointer;">
                    <input type="checkbox" id="story-tpl-input-default" ${activeTpl.is_default ? "checked" : ""}> Set as Default
                  </label>
                </div>
              </div>

              <div class="story-tpl-form-row">
                <label class="story-tpl-label">Template Body (Variables: {{shot.action}}, {{style}}, {{loc}}, etc.)</label>
                <textarea id="story-tpl-input-text" class="story-tpl-textarea">${_esc(activeTpl.text || "")}</textarea>
              </div>
            ` : `<div style="color:var(--muted);padding:20px;">Select or create a template.</div>`}
          </div>
        </div>

        <div class="story-tpl-modal-foot">
          <div>
            ${activeTpl && !activeTpl.is_default ? `
              <button class="story-btn-ghost" style="color:#f87171;" data-s="prompt.delete_tpl:${activeTpl.id}">Delete</button>
            ` : ""}
            ${activeTpl ? `
              <button class="story-btn-ghost" data-s="prompt.dup_tpl:${activeTpl.id}">Duplicate</button>
            ` : ""}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="story-btn-ghost" data-s="prompt.close_tpl_modal">Cancel</button>
            ${activeTpl ? `<button class="story-btn-gold" data-s="prompt.save_tpl:${activeTpl.id}">Save Template</button>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Main View Render ----------
  function renderPromptView(el) {
    if (!el) return;

    ensureBlocks();
    ensureDefaultTemplates();

    const shots = getShots();
    if (!selShotId && shots.length > 0) {
      selShotId = shots[0].id;
    }

    el.innerHTML = `
      <div class="story-prompt-wrap">
        <!-- Top Toolbar -->
        <div class="story-prompt-toolbar">
          <div class="story-prompt-toolbar-left">
            <div class="story-prompt-mode-toggle">
              <button class="${promptMode === 'block' ? 'active' : ''}" data-s="prompt.set_mode:block">
                Block Mode (Seedance 2.5)
              </button>
              <button class="${promptMode === 'shot' ? 'active' : ''}" data-s="prompt.set_mode:shot">
                Per-Shot Mode (I2V / Fast)
              </button>
            </div>
            <input
              type="text"
              class="story-prompt-search"
              placeholder="Search prompts..."
              value="${_esc(searchQuery)}"
              data-s="prompt.search_input"
            >
          </div>
          <div class="story-prompt-toolbar-right">
            <button class="story-btn-ghost" data-s="prompt.fill_all_missing">Fill All Missing</button>
            <button class="story-btn-ghost" data-s="prompt.open_tpl_modal">Templates ▾</button>
          </div>
        </div>

        <!-- Main Body -->
        <div class="story-prompt-body">
          <aside class="story-prompt-sidebar" id="story-prompt-sidebar"></aside>
          <main class="story-prompt-main" id="story-prompt-main"></main>
        </div>
      </div>
    `;

    const sideEl = el.querySelector("#story-prompt-sidebar");
    const mainEl = el.querySelector("#story-prompt-main");

    if (sideEl) renderSidebar(sideEl);
    if (mainEl) {
      if (promptMode === "block") {
        renderBlockEditor(mainEl);
      } else {
        renderShotEditor(mainEl);
      }
    }

    setupTextareaAutoSave(el);
    renderTemplateModal();
  }

  // ---------- Live Typing Auto-Save Listeners ----------
  function setupTextareaAutoSave(container) {
    // Block prompt textarea
    const bTa = container.querySelector("#story-block-prompt-textarea");
    if (bTa) {
      bTa.addEventListener("input", (e) => {
        const bNum = Number(bTa.dataset.blockNum);
        const blocks = ensureBlocks();
        const b = blocks.find(x => x.n === bNum);
        if (b) {
          b.vprompt.text = e.target.value;
          b.vprompt.u = Date.now();
          if (STORY.dirty) STORY.dirty.ep = true;
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        }
      });
    }

    // Shot STB textarea
    const stbTa = container.querySelector("#story-shot-stb-textarea");
    if (stbTa) {
      stbTa.addEventListener("input", (e) => {
        const sId = stbTa.dataset.shotId;
        const s = getShots().find(x => x.id === sId);
        if (s) {
          ensureShotPrompts(s);
          s.stb.prompt = e.target.value;
          s.stb.u = Date.now();
          if (STORY.dirty) STORY.dirty.ep = true;
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        }
      });
    }

    // Shot Video textarea
    const vTa = container.querySelector("#story-shot-video-textarea");
    if (vTa) {
      vTa.addEventListener("input", (e) => {
        const sId = vTa.dataset.shotId;
        const s = getShots().find(x => x.id === sId);
        if (s) {
          ensureShotPrompts(s);
          s.vprompt.text = e.target.value;
          s.vprompt.u = Date.now();
          if (STORY.dirty) STORY.dirty.ep = true;
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        }
      });
    }

    // Search input
    const searchInput = container.querySelector(".story-prompt-search");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        searchQuery = e.target.value;
        const sideEl = container.querySelector("#story-prompt-sidebar");
        if (sideEl) renderSidebar(sideEl);
      });
    }
  }

  // ---------- Register STORY Commands (data-s="prompt.action:arg") ----------
  function registerCommands() {
    if (!STORY.cmds) STORY.cmds = {};

    STORY.cmds["prompt.set_mode"] = (arg) => {
      promptMode = arg === "shot" ? "shot" : "block";
      savePrefs();
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.select_block"] = (arg) => {
      selBlockNum = Number(arg) || 1;
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.select_shot"] = (arg) => {
      selShotId = arg;
      if (typeof STORY.select === "function") STORY.select("shot", arg);
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.prev_shot"] = (arg) => {
      const shots = getShots();
      const idx = shots.findIndex(x => x.id === arg);
      if (idx > 0) {
        selShotId = shots[idx - 1].id;
        if (typeof STORY.select === "function") STORY.select("shot", selShotId);
        if (typeof STORY.renderView === "function") STORY.renderView();
      }
    };

    STORY.cmds["prompt.next_shot"] = (arg) => {
      const shots = getShots();
      const idx = shots.findIndex(x => x.id === arg);
      if (idx !== -1 && idx < shots.length - 1) {
        selShotId = shots[idx + 1].id;
        if (typeof STORY.select === "function") STORY.select("shot", selShotId);
        if (typeof STORY.renderView === "function") STORY.renderView();
      }
    };

    STORY.cmds["prompt.toggle_filter_locked"] = () => {
      filterLockedOnly = !filterLockedOnly;
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.toggle_block_lock"] = (arg) => {
      const blocks = ensureBlocks();
      const b = blocks.find(x => x.n === Number(arg));
      if (b) {
        b.vprompt.locked = !b.vprompt.locked;
        if (typeof STORY.snapshot === "function") {
          STORY.snapshot(`${b.vprompt.locked ? 'Lock' : 'Unlock'} Block ${b.n} prompt`);
        }
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") {
          toast(`Block ${b.n} prompt ${b.vprompt.locked ? 'locked (protected)' : 'unlocked'}.`);
        }
      }
    };

    STORY.cmds["prompt.toggle_shot_lock"] = (arg) => {
      const shots = getShots();
      const s = shots.find(x => x.id === arg);
      if (s) {
        ensureShotPrompts(s);
        const next = !s.vprompt.locked;
        s.vprompt.locked = next;
        s.stb.locked = next;
        if (typeof STORY.snapshot === "function") {
          STORY.snapshot(`${next ? 'Lock' : 'Unlock'} Shot S${padShotNo(s.n)} prompt`);
        }
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") {
          toast(`Shot S${padShotNo(s.n)} prompts ${next ? 'locked' : 'unlocked'}.`);
        }
      }
    };

    STORY.cmds["prompt.fill_block"] = (arg) => {
      const bNum = Number(arg);
      if (typeof STORY.snapshot === "function") STORY.snapshot(`Fill Block ${bNum} prompt`);
      if (fillBlockPrompt(bNum)) {
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Generated Seedance 2.5 prompt for Block ${bNum}.`);
      }
    };

    STORY.cmds["prompt.fill_shot"] = (arg) => {
      if (typeof STORY.snapshot === "function") STORY.snapshot(`Fill Shot prompt`);
      if (fillShotPrompts(arg)) {
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast("Filled shot STB and Video prompts.");
      }
    };

    STORY.cmds["prompt.fill_shot_stb"] = (arg) => {
      if (typeof STORY.snapshot === "function") STORY.snapshot(`Fill Shot STB prompt`);
      if (fillShotPrompts(arg, { stb: true, video: false })) {
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast("Filled STB keyframe prompt.");
      }
    };

    STORY.cmds["prompt.fill_shot_video"] = (arg) => {
      if (typeof STORY.snapshot === "function") STORY.snapshot(`Fill Shot Video prompt`);
      if (fillShotPrompts(arg, { stb: false, video: true })) {
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast("Filled Video prompt.");
      }
    };

    STORY.cmds["prompt.fill_all_missing"] = () => {
      fillAllMissingPrompts();
    };

    STORY.cmds["prompt.copy_block"] = (arg) => {
      const blocks = ensureBlocks();
      const b = blocks.find(x => x.n === Number(arg));
      if (b && b.vprompt && b.vprompt.text) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(b.vprompt.text);
          if (typeof toast === "function") toast("Block prompt copied to clipboard.");
        }
      }
    };

    STORY.cmds["prompt.copy_shot_stb"] = (arg) => {
      const s = getShots().find(x => x.id === arg);
      if (s && s.stb && s.stb.prompt) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(s.stb.prompt);
          if (typeof toast === "function") toast("STB prompt copied.");
        }
      }
    };

    STORY.cmds["prompt.copy_shot_video"] = (arg) => {
      const s = getShots().find(x => x.id === arg);
      if (s && s.vprompt && s.vprompt.text) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(s.vprompt.text);
          if (typeof toast === "function") toast("Video prompt copied.");
        }
      }
    };

    STORY.cmds["prompt.toggle_video_preview"] = () => {
      showVideoPreview = !showVideoPreview;
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.toggle_stb_preview"] = () => {
      showStbPreview = !showStbPreview;
      if (typeof STORY.renderView === "function") STORY.renderView();
    };

    STORY.cmds["prompt.insert_var"] = (arg) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")) {
        const start = activeEl.selectionStart || 0;
        const end = activeEl.selectionEnd || 0;
        const val = activeEl.value;
        activeEl.value = val.substring(0, start) + arg + val.substring(end);
        activeEl.selectionStart = activeEl.selectionEnd = start + arg.length;
        activeEl.dispatchEvent(new Event("input"));
        activeEl.focus();
      } else {
        // Fallback to currently visible active textarea
        const ta = document.getElementById("story-block-prompt-textarea") || document.getElementById("story-shot-video-textarea");
        if (ta) {
          ta.value += " " + arg;
          ta.dispatchEvent(new Event("input"));
          ta.focus();
        }
      }
    };

    // Auto-fix command
    STORY.cmds["prompt.apply_lint_fix"] = (arg) => {
      const parts = arg.split(":");
      const targetType = parts[0]; // 'block' or 'shot'
      const targetId = parts[1];
      const issueId = parts[2];

      if (targetType === "block") {
        const b = ensureBlocks().find(x => x.n === Number(targetId));
        if (b) {
          if (typeof STORY.snapshot === "function") STORY.snapshot("Auto-fix Block prompt lint");
          if (issueId === "UNREPLACED_VARS") {
            applyFix("resolve_vars", b.vprompt, { ctx: { block: b } });
          } else if (issueId === "INVALID_SHOT_NUMBERING") {
            applyFix("fix_shot_naming", b.vprompt);
          }
          if (STORY.dirty) STORY.dirty.ep = true;
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          if (typeof STORY.renderView === "function") STORY.renderView();
          if (typeof toast === "function") toast("Applied fix to Block prompt.");
        }
      } else {
        const s = getShots().find(x => x.id === targetId);
        if (s) {
          if (typeof STORY.snapshot === "function") STORY.snapshot("Auto-fix Shot prompt lint");
          if (issueId === "MANDATORY_STB_REF") {
            applyFix("insert_stb_sentence", s.vprompt, { sentence: "image1 is the storyboard keyframe: follow its composition and framing." });
          } else if (issueId === "MANDATORY_STB_I2V") {
            applyFix("insert_stb_sentence", s.vprompt, { sentence: "The storyboard (image1) is the opening frame of this shot." });
          } else if (issueId === "INVALID_SHOT_NUMBERING") {
            applyFix("fix_shot_naming", s.vprompt);
          } else if (issueId === "UNREPLACED_VARS") {
            applyFix("resolve_vars", s.vprompt, { ctx: { shot: s } });
          }
          if (STORY.dirty) STORY.dirty.ep = true;
          if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
          if (typeof STORY.renderView === "function") STORY.renderView();
          if (typeof toast === "function") toast("Applied fix to Shot prompt.");
        }
      }
    };

    // Version history restoration
    STORY.cmds["prompt.block_ver_restore"] = (arg) => {
      const b = ensureBlocks().find(x => x.n === Number(arg));
      if (b && b.vprompt.history && b.vprompt.history.length > 0) {
        if (typeof STORY.snapshot === "function") STORY.snapshot(`Restore older Block ${b.n} prompt`);
        const prev = b.vprompt.history.shift();
        const oldCurrent = b.vprompt.text;
        b.vprompt.text = prev.text;
        b.vprompt.history.push({ text: oldCurrent, ver: b.vprompt.ver, at: Date.now() });
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Restored version from ${new Date(prev.at).toLocaleTimeString()}`);
      }
    };

    STORY.cmds["prompt.shot_ver_restore"] = (arg) => {
      const s = getShots().find(x => x.id === arg);
      if (s && s.vprompt.history && s.vprompt.history.length > 0) {
        if (typeof STORY.snapshot === "function") STORY.snapshot(`Restore older Shot S${padShotNo(s.n)} prompt`);
        const prev = s.vprompt.history.shift();
        const oldCurrent = s.vprompt.text;
        s.vprompt.text = prev.text;
        s.vprompt.history.push({ text: oldCurrent, ver: s.vprompt.ver, at: Date.now() });
        if (STORY.dirty) STORY.dirty.ep = true;
        if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
        if (typeof STORY.renderView === "function") STORY.renderView();
        if (typeof toast === "function") toast(`Restored version from ${new Date(prev.at).toLocaleTimeString()}`);
      }
    };

    // Template Modal Commands
    STORY.cmds["prompt.open_tpl_modal"] = () => {
      tplModalOpen = true;
      renderTemplateModal();
    };

    STORY.cmds["prompt.close_tpl_modal"] = () => {
      tplModalOpen = false;
      renderTemplateModal();
    };

    STORY.cmds["prompt.select_tpl"] = (arg) => {
      activeModalTplId = arg;
      renderTemplateModal();
    };

    STORY.cmds["prompt.new_tpl"] = () => {
      const newId = _uid("tpl_");
      STORY.tpls[newId] = {
        id: newId,
        name: "New Prompt Template",
        kind: promptMode === "block" ? "block" : "video",
        model: "seedance-2.5",
        type_match: "ALL",
        is_default: false,
        text: "Prompt content with {{style}} {{negative}} ...",
        u: Date.now()
      };
      if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(newId);
      activeModalTplId = newId;
      renderTemplateModal();
    };

    STORY.cmds["prompt.save_tpl"] = (arg) => {
      const t = STORY.tpls[arg];
      if (!t) return;

      const nameEl = document.getElementById("story-tpl-input-name");
      const kindEl = document.getElementById("story-tpl-input-kind");
      const typeEl = document.getElementById("story-tpl-input-type");
      const textEl = document.getElementById("story-tpl-input-text");
      const defEl = document.getElementById("story-tpl-input-default");

      if (nameEl) t.name = nameEl.value.trim() || t.name;
      if (kindEl) t.kind = kindEl.value;
      if (typeEl) t.type_match = typeEl.value;
      if (textEl) t.text = textEl.value;

      if (defEl && defEl.checked) {
        // clear existing default for same kind & type_match
        Object.values(STORY.tpls).forEach(ot => {
          if (ot.kind === t.kind && ot.type_match === t.type_match && ot.id !== t.id) {
            ot.is_default = false;
            if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(ot.id);
          }
        });
        t.is_default = true;
      } else {
        t.is_default = false;
      }

      t.u = Date.now();
      if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(t.id);
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      renderTemplateModal();
      if (typeof toast === "function") toast(`Saved template: ${t.name}`);
    };

    STORY.cmds["prompt.dup_tpl"] = (arg) => {
      const orig = STORY.tpls[arg];
      if (!orig) return;
      const dupId = _uid("tpl_");
      STORY.tpls[dupId] = Object.assign({}, orig, {
        id: dupId,
        name: orig.name + " (Copy)",
        is_default: false,
        u: Date.now()
      });
      if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(dupId);
      activeModalTplId = dupId;
      renderTemplateModal();
      if (typeof toast === "function") toast("Template duplicated.");
    };

    STORY.cmds["prompt.delete_tpl"] = (arg) => {
      const t = STORY.tpls[arg];
      if (!t) return;
      if (t.is_default) {
        if (typeof toast === "function") toast("Cannot delete the active default template.", true);
        return;
      }
      delete STORY.tpls[arg];
      if (STORY.dirty && STORY.dirty.tpls) STORY.dirty.tpls.add(arg);
      if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
      activeModalTplId = null;
      renderTemplateModal();
      if (typeof toast === "function") toast("Template deleted.");
    };
  }

  // ---------- Module Registry Registration ----------
  function initModule() {
    if (typeof window.STORY === "undefined") {
      console.warn("STORY state store not yet initialized.");
      return;
    }

    // Register Prompts view
    STORY.views.prompts = {
      render(el) {
        renderPromptView(el);
      }
    };

    // Register commands
    registerCommands();

    // Cross-module APIs
    STORY.prompts = {
      fillShot: fillShotPrompts,
      fillBlock: fillBlockPrompt,
      fillAllMissing: fillAllMissingPrompts,
      lint: lintPrompt,
      resolveVariables,
      buildReferenceBank: buildBlockReferenceBank,
      getTemplates,
      getDefaultTemplate
    };

    // Extension Hook: After Desk load, ensure templates and blocks are ready
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) {
      STORY.hooks.afterLoad.push(() => {
        ensureBlocks();
        ensureDefaultTemplates();
      });
    }

    // Initialize immediately if state exists
    if (STORY.ep) {
      ensureBlocks();
      ensureDefaultTemplates();
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
