// ===== Story Studio Auto-edit (EDL) =====
(function () {
  "use strict";

  const STATE = { busy: false, plans: [], input: null, edl: null, estimate: null, error: "", mode: "ai", scoreEstimate: null };
  const $ = (sel, root = document) => root.querySelector(sel);
  const escText = (value) => {
    if (typeof esc === "function") return esc(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  const fmt = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00";
  const shots = () => (STORY.ep && Array.isArray(STORY.ep.shots) ? STORY.ep.shots : []).slice().sort((a, b) => (Number(a.block) || 1) - (Number(b.block) || 1) || (Number(a.n) || 0) - (Number(b.n) || 0));
  const pad = (n) => String(Number(n) || 0).padStart(2, "0");
  const shotKey = (s) => String(s.id || `S${pad(s.n)}`);
  const shotLabel = (s) => `S${pad(s.n)}`;
  const asSec = (m, s, f) => (Number(m) || 0) * 60 + (Number(s) || 0) + (Number(f) || 0) / 100;

  function safeName(value) {
    return String(value || "KTOONS").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "KTOONS";
  }
  function projectCode() {
    const bible = STORY.bible || {};
    const series = typeof STORY.curSeries === "function" ? STORY.curSeries() : null;
    return safeName(bible.name || (series && series.name) || "KTOONS");
  }
  function episodeNumber() {
    const ep = STORY.ep || {};
    const raw = String(ep.title || ep.ep || "01");
    const m = raw.match(/(?:EP(?:ISODE)?\s*)?(\d{1,3})/i);
    return pad(m ? m[1] : 1);
  }
  function targetSeconds() {
    return Number((STORY.ep && STORY.ep.target) || (STORY.bible && STORY.bible.format && STORY.bible.format.epDur) || 90);
  }
  function uniqueRefShots() {
    const byBlock = new Map();
    const blockDocs = STORY.ep.blocks || [];
    shots().forEach(s => {
      const b = Number(s.block) || 1;
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(s);
    });
    const map = new Map();
    byBlock.forEach((list, block) => {
      let cursor = 0;
      const blockDoc = blockDocs.find(x => Number(x.n) === block) || blockDocs[block - 1] || {};
      const blockVideo = blockDoc.video || {};
      const videoForShot = new Map(list.map(s => {
        const hasShotVideo = Boolean(s.video && s.video.ref);
        return [s, { video: hasShotVideo ? s.video : blockVideo, isBlockRef: !hasShotVideo && Boolean(blockVideo.ref) }];
      }));
      const approved = list.map(s => ({ shot: s, ...videoForShot.get(s) }))
        .filter(x => x.video && x.video.ref && x.video.status === "approved");
      const approvedRefs = new Set(approved.map(x => x.video.ref));
      const sharedRef = approvedRefs.size === 1 ? Array.from(approvedRefs)[0] : "";
      const shared = Boolean(sharedRef && (approved.length > 1 || approved.some(x => x.isBlockRef) || Number(approved[0].video.dur) > (Number(approved[0].shot.dur) || 6) * 1.5));
      let promptTimes = new Map();
      const promptText = blockDoc && blockDoc.vprompt && blockDoc.vprompt.text || "";
      const promptShots = blockDoc && blockDoc.vprompt && Array.isArray(blockDoc.vprompt.shots) ? blockDoc.vprompt.shots : [];
      promptShots.forEach(x => {
        const n = Number(x.n || x.shot);
        const start = Number(x.start), end = Number(x.end);
        if (Number.isFinite(n) && Number.isFinite(start) && Number.isFinite(end) && end > start) promptTimes.set(n, { start, end });
      });
      const timeRe = /\[\s*(\d{1,2}):(\d{2})[.,](\d{1,2})\s*[–—-]\s*(\d{1,2}):(\d{2})[.,](\d{1,2})\s*\]\s*(?:SHOT|S)\s*0?(\d+)/gi;
      let match;
      while ((match = timeRe.exec(promptText))) promptTimes.set(Number(match[7]), { start: asSec(match[1], match[2], match[3]), end: asSec(match[4], match[5], match[6]) });
      list.forEach(s => {
        const duration = Math.max(0.2, Number(s.dur) || 4);
        const sourceVideo = videoForShot.get(s).video;
        let start = 0, end = duration;
        if (shared) {
          const times = promptTimes.get(Number(s.n));
          if (times && times.end > times.start) { start = times.start; end = times.end; }
          else { start = cursor; end = cursor + duration; }
          cursor = Math.max(cursor, end);
        } else if (!(sourceVideo && sourceVideo.ref && Number(sourceVideo.dur) > duration * 1.5)) {
          // Per-shot generation uses the whole source clip; missing shots keep their planned episode duration.
          start = 0;
          end = (sourceVideo && Number(sourceVideo.dur) > 0) ? Number(sourceVideo.dur) : duration;
          cursor += duration;
        } else {
          start = cursor;
          end = cursor + duration;
          cursor = end;
        }
        const approvedClip = sourceVideo && sourceVideo.ref && sourceVideo.status === "approved" ? sourceVideo.ref : null;
        if (!approvedClip && !shared) {
          start = cursor - duration;
          end = cursor;
        }
        map.set(shotKey(s), { shot: s, key: shotKey(s), label: shotLabel(s), block, ref: approvedClip, start, end, dur: duration });
      });
    });
    return Array.from(map.values());
  }

  function motionAtFourFps(rows) {
    const src = Array.isArray(rows) ? rows : [];
    const out = [];
    let last = -1;
    src.forEach(x => {
      const t = Number(x && x.t);
      if (!Number.isFinite(t) || t - last < 0.249) return;
      out.push({ t: Number(t.toFixed(3)), diff: Number(x.diff) || 0, bright: Number(x.bright) || 0 });
      last = t;
    });
    return out;
  }

  function buildInput(plans, analyses) {
    const bible = STORY.bible || {};
    const style = [bible.style && bible.style.look, bible.style && bible.style.camera, bible.style && bible.style.grade, bible.format && bible.format.pacing].filter(Boolean).join("; ");
    const music = bible.music || bible.audio && bible.audio.music || {};
    const musicRef = typeof music === "string" ? music : (music.ref || bible.musicRef || "");
    const clipData = {};
    Object.keys(analyses).forEach(ref => {
      const a = analyses[ref] || {};
      clipData[ref] = {
        dur: Number(a.dur) || 0,
        cuts: Array.isArray(a.cuts) ? a.cuts.slice(0, 500) : [],
        silences: Array.isArray(a.silences) ? a.silences.slice(0, 500) : [],
        frozenHead: Number(a.frozenHead) || 0,
        frozenTail: Number(a.frozenTail) || Number(a.dur) || 0,
        motion: motionAtFourFps(a.motion),
        qc: (() => {
          const p = plans.find(x => x.ref === ref && x.shot.qc);
          const q = p && p.shot.qc;
          return q ? { verdict: q.verdict || "unknown", issues: q.issues || [], fix_at_sec: q.fix_at_sec == null ? null : q.fix_at_sec } : null;
        })()
      };
    });
    const inputShots = plans.map(p => ({
      key: p.key, n: Number(p.shot.n) || 0, block: p.block, label: p.label, type: p.shot.type || "REF",
      dialogue: (p.shot.dialogue || []).map(d => ({ char: d.char_name || d.char || "", line: d.text || d.line || "", mode: d.modifier || d.mode || "ON" })),
      purpose: p.shot.purpose || "", performance: p.shot.perf || "",
      planned: { clip: p.ref, start: p.start, end: p.end }
    }));
    return { target: targetSeconds(), shots: inputShots, clips: clipData, music: { ref: musicRef || null, bpm: Number(music.bpm) || null }, style };
  }

  function getEdit() {
    if (!STORY.ep) return null;
    if (!STORY.ep.edit || typeof STORY.ep.edit !== "object") STORY.ep.edit = {};
    if (!STORY.ep.edit.analysis || typeof STORY.ep.edit.analysis !== "object") STORY.ep.edit.analysis = {};
    return STORY.ep.edit;
  }
  function saveEpisode() {
    if (STORY.dirty) STORY.dirty.ep = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
  }

  async function prepare() {
    if (STATE.busy) return;
    if (!STORY.ep || !shots().length) throw new Error("Add the episode shotlist before auto-editing.");
    if (!window.VEDIT_API || typeof window.VEDIT_API.analyze !== "function" || typeof window.VEDIT_API.buildFromEDL !== "function") throw new Error("Update the Video Editor to enable Auto-edit.");
    STATE.busy = true;
    STATE.error = "";
    STATE.mode = "ai";
    STATE.plans = uniqueRefShots();
    try {
      renderModal("Analysing approved clips…", true);
      const edit = getEdit();
      const refs = Array.from(new Set(STATE.plans.map(p => p.ref).filter(Boolean)));
      const analyses = {};
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        let result = edit.analysis[ref];
        if (!result || !Number(result.dur)) {
          updateStatus(`Analysing clip ${i + 1}/${refs.length}: ${ref.split("/").pop()}`);
          try {
            result = await window.VEDIT_API.analyze(ref, { step: 0.125 });
            edit.analysis[ref] = result;
            saveEpisode();
          } catch (err) {
            edit.analysis[ref] = { dur: 0, cuts: [], motion: [], silences: [], frozenHead: 0, frozenTail: 0, analysisError: String(err.message || err) };
          }
        }
        analyses[ref] = edit.analysis[ref];
      }
      STATE.input = buildInput(STATE.plans, analyses);
      const failed = refs.filter(ref => analyses[ref] && analyses[ref].analysisError);
      if (!window.STORY.ai || typeof STORY.ai.run !== "function") {
        STATE.estimate = 0;
        STATE.mode = "fallback";
        STATE.error = failed.length ? `${failed.length} clip analysis failed; fallback will use planned timing for them.` : "AI is unavailable. Use the free deterministic edit.";
      } else {
        const dry = await STORY.ai.run("editor", STATE.input, { dry: true, noRetry: true });
        STATE.estimate = Math.max(0, Number(dry && dry.est) || 0);
        if (failed.length) STATE.error = `${failed.length} clip analysis failed; AI will use the available analysis and planned timing for those clips.`;
      }
      renderModal();
      updateBoardButton();
    } catch (err) {
      STATE.error = String(err.message || err);
      renderModal();
    } finally {
      STATE.busy = false;
    }
  }

  function updateStatus(message) {
    const node = $("#story-autoedit-status");
    if (node) node.textContent = message;
  }

  function nearestBoundary(target, cuts) {
    const near = (cuts || []).map(Number).filter(Number.isFinite).map(t => ({ t, d: Math.abs(t - target) })).filter(x => x.d <= 0.6).sort((a, b) => a.d - b.d)[0];
    return near ? near.t : target;
  }

  function fallbackEdl() {
    const edit = getEdit();
    const analyses = edit.analysis || {};
    const items = STATE.plans.map((p, idx) => {
      const a = p.ref && analyses[p.ref] || {};
      const mediaDur = Number(a.dur) || (p.ref && Number(p.shot.video && p.shot.video.dur)) || p.end;
      let srcIn = Number(p.start) || 0;
      let srcOut = Number(p.end) || (Number(p.shot.dur) || 4);
      if (srcIn <= 0.001 && Number(a.frozenHead) > 0) srcIn = Number(a.frozenHead);
      if (srcOut >= mediaDur - 0.001 && Number(a.frozenTail) > 0 && Number(a.frozenTail) < mediaDur) srcOut = Number(a.frozenTail);
      srcIn = nearestBoundary(srcIn, a.cuts);
      srcOut = nearestBoundary(srcOut, a.cuts);
      srcIn = Math.max(0, Math.min(srcIn, mediaDur));
      srcOut = Math.max(srcIn + 0.2, Math.min(srcOut, mediaDur));
      if (srcOut - srcIn < 0.2) { srcIn = Math.max(0, Number(p.start) || 0); srcOut = Math.min(mediaDur, srcIn + Math.max(0.2, p.dur)); }
      return { shot: p.key, ref: p.ref, src_in: srcIn, src_out: srcOut, dur: p.ref ? undefined : p.dur, lead: 0, trans: null, why: p.ref ? "Planned timing snapped to a nearby cut; frozen edge removed when detected." : "No approved clip; retained as a missing timeline slot." };
    });
    items.forEach((item, idx) => {
      const current = STATE.plans[idx], prev = STATE.plans[idx - 1];
      const samePlace = prev && prev.shot.loc && current.shot.loc && prev.shot.loc === current.shot.loc;
      if (samePlace && prev.shot.dialogue && prev.shot.dialogue.length && current.shot.dialogue && current.shot.dialogue.length && items[idx].ref) item.lead = 0.25;
    });
    const dropped = STATE.plans.filter(p => !p.ref).map(p => ({ shot: p.key, reason: "No approved clip is available for this shot." }));
    return { items: items.filter(it => it.ref), dropped, titles: [], music: null, total: items.reduce((sum, it) => sum + (it.ref ? it.src_out - it.src_in : it.dur || 0), 0), notes: "Deterministic fallback using planned boundaries, detected cuts and available frozen-frame measurements." };
  }

  function normalizeEdl(raw) {
    if (!raw || !Array.isArray(raw.items) || !Array.isArray(raw.dropped)) throw new Error("The EDL must contain items and dropped arrays.");
    const expected = new Map(STATE.plans.map(p => [p.key, p]));
    const itemsByKey = new Map();
    const droppedByKey = new Map();
    raw.items.forEach(it => {
      const key = String(it && it.shot || "");
      if (!expected.has(key)) throw new Error(`EDL contains an unknown shot: ${key || "(empty)"}.`);
      if (itemsByKey.has(key)) throw new Error(`EDL repeats shot ${key}.`);
      itemsByKey.set(key, it);
    });
    raw.dropped.forEach(it => {
      const key = String(it && it.shot || "");
      if (!expected.has(key)) throw new Error(`Dropped list contains unknown shot ${key || "(empty)"}.`);
      if (droppedByKey.has(key)) throw new Error(`Dropped list repeats shot ${key}.`);
      droppedByKey.set(key, it);
    });
    const normalized = [];
    for (const p of STATE.plans) {
      const source = itemsByKey.get(p.key);
      const dropped = droppedByKey.get(p.key);
      if (Boolean(source) === Boolean(dropped)) throw new Error(`${p.label} must appear exactly once in items or dropped.`);
      if (dropped) {
        const duration = Math.max(0.2, p.dur);
        normalized.push({ shot: p.key, ref: null, src_in: 0, src_out: duration, dur: duration, lead: 0, trans: null, why: String(dropped.reason || "Dropped by editor.") });
        continue;
      }
      const ref = p.ref;
      if (source.ref != null && String(source.ref) !== String(ref || "")) throw new Error(`${p.label} returned a media ref that was not assigned to that shot.`);
      const analysis = ref && getEdit().analysis[ref] || {};
      const mediaDur = Number(analysis.dur) || Number(p.shot.video && p.shot.video.dur) || Number(p.end) || p.dur;
      let start = Number(source.src_in), end = Number(source.src_out);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > mediaDur + 0.02) throw new Error(`${p.label} has invalid source in/out points.`);
      const boundaryMin = Math.max(0, p.start - 0.61), boundaryMax = Math.min(mediaDur, p.end + 0.61);
      if (ref && (start < boundaryMin || end > boundaryMax)) throw new Error(`${p.label} edit falls outside its planned clip window by more than 0.6 seconds.`);
      const lead = Math.max(0, Math.min(0.4, Number(source.lead) || 0));
      const trans = source.trans && source.trans.t === "cross" ? { t: "cross", d: Math.max(0.3, Math.min(0.5, Number(source.trans.d) || 0.4)) } : null;
      normalized.push({ shot: p.key, ref: ref || null, src_in: start, src_out: end, dur: ref ? undefined : Math.max(0.2, end - start), lead, trans, why: String(source.why || "") });
    }
    const total = normalized.reduce((sum, it) => sum + (it.ref ? it.src_out - it.src_in : Number(it.dur) || 0), 0);
    if (Math.abs(total - targetSeconds()) > 3) throw new Error(`EDL duration ${fmt(total)}s is outside the ${fmt(targetSeconds())}s ±3s target.`);
    return {
      items: normalized,
      dropped: raw.dropped.map(x => ({ shot: String(x.shot), reason: String(x.reason || "") })),
      titles: Array.isArray(raw.titles) ? raw.titles.filter(x => x && x.text).map(x => ({ text: String(x.text), start: Number(x.start) || 0, dur: Math.max(0.3, Number(x.dur) || 2.5), pos: x.pos || "top" })) : [],
      music: raw.music || null,
      total,
      notes: String(raw.notes || "")
    };
  }

  function epEditVersion() {
    const edit = getEdit();
    return Math.max(1, (Number(edit.sequenceVersion) || 0) + 1);
  }

  async function run(useFallback) {
    if (!STATE.input) await prepare();
    if (STATE.busy) return;
    STATE.busy = true;
    STATE.error = "";
    try {
      let raw;
      if (useFallback || STATE.mode === "fallback" || !window.STORY.ai || typeof STORY.ai.run !== "function") {
        STATE.mode = "fallback";
        raw = fallbackEdl();
      } else {
        updateStatus("Writing and validating the EDL with one LLM request…");
        const result = await STORY.ai.run("editor", STATE.input, { noRetry: true });
        raw = result && result.json;
      }
      STATE.edl = normalizeEdl(raw);
      const edit = getEdit();
      edit.edl = JSON.parse(JSON.stringify(STATE.edl));
      edit.target = targetSeconds();
      edit.mode = STATE.mode;
      edit.preparedAt = Date.now();
      saveEpisode();
      renderModal();
    } catch (err) {
      STATE.error = String(err.message || err);
      renderModal();
    } finally {
      STATE.busy = false;
    }
  }

  function readEdlInputs() {
    if (!STATE.edl) throw new Error("Generate the EDL first.");
    const items = STATE.edl.items.map((it, i) => {
      const row = $(`[data-ed-row="${i}"]`, modal());
      if (!row) return it;
      const start = Number($("[data-ed-field='in']", row).value);
      const end = Number($("[data-ed-field='out']", row).value);
      const lead = Number($("[data-ed-field='lead']", row).value);
      const why = $("[data-ed-field='why']", row).value;
      const transValue = $("[data-ed-field='transition']", row).value;
      const transDur = Number($("[data-ed-field='transition_duration']", row).value) || 0.4;
      const trans = transValue === "cross" ? { t: "cross", d: Math.max(0.3, Math.min(0.5, transDur)) } : null;
      return Object.assign({}, it, { src_in: start, src_out: end, dur: it.ref ? undefined : Math.max(0.2, end - start), lead, trans, why });
    });
    const total = items.reduce((sum, it) => sum + (it.ref ? Number(it.src_out) - Number(it.src_in) : Number(it.dur) || 0), 0);
    if (Math.abs(total - targetSeconds()) > 3) throw new Error(`Edited EDL is ${fmt(total)}s; keep it within ${fmt(targetSeconds())}s ±3s.`);
    items.forEach(it => {
      const p = STATE.plans.find(x => x.key === it.shot);
      if (!p) throw new Error(`Unknown shot ${it.shot}.`);
      if (it.ref) {
        const a = getEdit().analysis[it.ref] || {};
        const mediaDur = Number(a.dur) || Number(p.shot.video && p.shot.video.dur) || p.end;
        if (!(Number(it.src_in) >= 0 && Number(it.src_out) > Number(it.src_in) && Number(it.src_out) <= mediaDur + 0.02)) throw new Error(`${p.label}: source out must be after source in and within the clip.`);
      }
    });
    STATE.edl.items = items;
    STATE.edl.total = total;
    getEdit().edl = JSON.parse(JSON.stringify(STATE.edl));
    saveEpisode();
    return STATE.edl;
  }

  function renderTable() {
    if (!STATE.edl) return "";
    const target = Math.max(0.2, targetSeconds());
    const total = Number(STATE.edl.total) || 0;
    const fill = Math.min(100, Math.max(0, total / target * 100));
    const inRange = Math.abs(total - target) <= 3;
    return `<div class="story-autoedit-table-wrap"><table class="story-autoedit-table"><thead><tr><th>Shot</th><th>In</th><th>Out</th><th>Length</th><th>Lead</th><th>Transition</th><th>Why / missing reason</th></tr></thead><tbody>${STATE.edl.items.map((it, i) => {
      const p = STATE.plans.find(x => x.key === it.shot);
      const len = it.ref ? Number(it.src_out) - Number(it.src_in) : Number(it.dur) || 0;
      return `<tr data-ed-row="${i}"><td><b>${escText(p ? p.label : it.shot)}</b><small>${escText(it.ref ? (it.ref.split("/").pop() || it.ref) : "Missing approved clip")}</small></td><td><input data-ed-field="in" type="number" min="0" step="0.04" value="${fmt(it.src_in)}" ${it.ref ? "" : "disabled"}></td><td><input data-ed-field="out" type="number" min="0" step="0.04" value="${fmt(it.src_out)}" ${it.ref ? "" : "disabled"}></td><td class="ed-len">${fmt(len)}s</td><td><input data-ed-field="lead" type="number" min="0" max="0.4" step="0.05" value="${fmt(it.lead || 0)}" ${it.ref ? "" : "disabled"}></td><td><select data-ed-field="transition" ${it.ref ? "" : "disabled"}><option value="cut" ${it.trans ? "" : "selected"}>Hard cut</option><option value="cross" ${it.trans ? "selected" : ""}>Cross dissolve</option></select><input class="ed-transition-duration" data-ed-field="transition_duration" type="number" min="0.3" max="0.5" step="0.1" value="${fmt(it.trans && it.trans.d || 0.4)}" ${it.ref && it.trans ? "" : "disabled"}></td><td><input data-ed-field="why" type="text" maxlength="240" value="${escText(it.why || "")}"></td></tr>`;
    }).join("")}</tbody></table></div><div class="story-autoedit-total"><div class="story-autoedit-meter ${inRange ? "in-range" : "out-range"}" role="meter" aria-label="EDL duration compared with target" aria-valuemin="0" aria-valuemax="${fmt(target)}" aria-valuenow="${fmt(total)}"><span id="story-autoedit-meter-fill" style="width:${fill.toFixed(1)}%"></span></div><span>EDL total <b id="story-autoedit-total">${fmt(total)}s</b> · target ${fmt(target)}s (±3s)</span></div>`;
  }

  const SCORE_SYSTEM = `You are the story music supervisor and finishing colorist for this episode. Use the installed video-editing skill's guidance: make music follow dramatic turns and emotional subtext; maintain dialogue clarity, restrained dynamics, smooth cue entry/exit, and visual continuity across adjacent shots. Do not invent plot facts or alter the approved cut. Return one JSON object with a string field "reply" containing a second JSON object: {"arc_summary":"...","score_prompt":"...","grades":[{"shot":"exact shot key","brightness":100,"contrast":100,"saturation":100,"mood":"...","reason":"..."}]}. score_prompt must be concise English, instrumental-only, original, no lyrics, no dialogue, no named artist or recognizable melody. Write one evolving cinematic score with a clear opening, escalation at supplied turns, breathing space under dialogue, emotional payoff and a natural ending; include useful tempo/instrumentation/production direction. Return exactly one grade for every supplied shot key and no others. Grade values are editor percentages: brightness 94–106, contrast 96–110, saturation 88–108. Keep neighboring brightness/contrast close for raccord; only shift color intensity when the dramatic beat supports it. These are subtle Basic Color corrections, not a replacement for shot-specific lighting or a calibrated LUT.`;

  function postprod() {
    const edit = getEdit();
    if (!edit.postprod || typeof edit.postprod !== "object") edit.postprod = {};
    return edit.postprod;
  }

  function musicLocked() {
    const bible = STORY.bible || {}, ep = STORY.ep || {};
    const styleText = JSON.stringify({ style: bible.style || {}, audio: bible.audio || {}, music: bible.music || {}, episodeAudio: ep.audio || {}, episodeMusic: ep.music || {} }).toLowerCase().replace(/[^a-z0-9]+/g, " ");
    const minecraftAsmr = /minecraft.{0,40}asmr|asmr.{0,40}minecraft|minecraft culinary/.test(styleText);
    return Boolean(minecraftAsmr || /no bgm|no background music/.test(styleText) || (bible.audio && bible.audio.noBgm === true) || (ep.audio && ep.audio.noBgm === true) ||
      (bible.music && typeof bible.music === "object" && (bible.music.allowed === false || bible.music.enabled === false)) ||
      (ep.music && typeof ep.music === "object" && (ep.music.allowed === false || ep.music.enabled === false)));
  }

  function scoreDuration() { return Math.max(3, Math.ceil(Number(STATE.edl && STATE.edl.total) || targetSeconds())); }
  function scorePrice(seconds = scoreDuration()) { return Math.ceil(seconds / 60) * 0.75; }
  function planScoreInput() {
    let time = 0;
    const items = (STATE.edl && STATE.edl.items || []).map(it => {
      const p = STATE.plans.find(x => x.key === it.shot), s = p && p.shot || {};
      const dur = it.ref ? Math.max(0.2, Number(it.src_out) - Number(it.src_in)) : Number(it.dur) || 0;
      const row = { shot: it.shot, label: p && p.label || it.shot, start: +time.toFixed(2), end: +(time + dur).toFixed(2),
        location: s.loc_name || s.location || s.loc || "", purpose: s.purpose || "", action: s.action_order || s.action || s.summary || s.description || "",
        performance: s.perf || s.performance || "", dialogue: (Array.isArray(s.dialogue) ? s.dialogue : []).map(d => `${d.char_name || d.char || "Character"}: ${d.text || d.line || ""}`).join(" | ") };
      time += dur;
      return row;
    });
    const b = STORY.bible || {}, e = STORY.ep || {};
    return { episode: e.title || e.ep || "Current episode", genre: b.genre || "", tone: b.tone || b.style && b.style.look || "", visual_style: b.style && b.style.look || "", total_seconds: +time.toFixed(2),
      current_no_bgm_lock: musicLocked(), shots: items };
  }

  function normalizeScorePlan(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.score_prompt !== "string" || !raw.score_prompt.trim() || !Array.isArray(raw.grades)) throw new Error("The music/grade plan was incomplete; no media was generated.");
    const known = new Set((STATE.edl.items || []).map(x => String(x.shot)));
    const grades = raw.grades.filter(g => g && known.has(String(g.shot))).map(g => ({
      shot: String(g.shot), brightness: Math.round(Math.max(94, Math.min(106, Number(g.brightness) || 100))),
      contrast: Math.round(Math.max(96, Math.min(110, Number(g.contrast) || 100))),
      saturation: Math.round(Math.max(88, Math.min(108, Number(g.saturation) || 100))),
      mood: String(g.mood || "Neutral").slice(0, 80), reason: String(g.reason || "").slice(0, 220)
    }));
    if (grades.length !== known.size || new Set(grades.map(g => g.shot)).size !== known.size) throw new Error("The grade plan must cover every timeline shot exactly once.");
    const scorePrompt = raw.score_prompt.trim().slice(0, 4100);
    return { arc_summary: String(raw.arc_summary || "").slice(0, 1000), score_prompt: scorePrompt, grades };
  }

  function parseScoreReply(reply) {
    const text = String(reply || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return normalizeScorePlan(JSON.parse(text));
  }

  async function estimateScorePlan() {
    if (!STATE.edl) throw new Error("Generate the EDL first.");
    if (!STORY.ai || typeof STORY.ai.run !== "function") throw new Error("The Story Studio AI engine is unavailable.");
    STATE.busy = true; STATE.error = ""; renderModal("Estimating the story-aware music and grade plan…", true);
    try {
      const r = await STORY.ai.run("assistant", planScoreInput(), { dry: true, noRetry: true, system: SCORE_SYSTEM });
      STATE.scoreEstimate = Math.max(0, Number(r && r.est) || 0);
      renderModal("Estimate ready. Drafting is a separate LLM request; soundtrack generation is a separate paid step.");
    } catch (err) { STATE.error = String(err.message || err); renderModal(); }
    finally { STATE.busy = false; }
  }

  async function draftScorePlan() {
    if (STATE.scoreEstimate == null) return estimateScorePlan();
    if (STATE.busy) return;
    STATE.busy = true; STATE.error = ""; renderModal("Reading the episode arc and preparing a score cue with shot-level color notes…", true);
    try {
      const r = await STORY.ai.run("assistant", planScoreInput(), { noRetry: true, system: SCORE_SYSTEM });
      const plan = parseScoreReply(r && r.json && r.json.reply);
      const p = postprod(); p.plan = plan; p.scorePrompt = plan.score_prompt; p.plannedAt = Date.now();
      saveEpisode(); renderModal("Story-aware score prompt and per-shot mood grades are ready for review.");
    } catch (err) { STATE.error = String(err.message || err); renderModal(); }
    finally { STATE.busy = false; }
  }

  function setAllowBgm(value) {
    if (musicLocked()) { STATE.error = "This episode has an explicit no-background-music rule. Update the episode/bible rule before adding a score."; renderModal(); return; }
    postprod().allowBgm = Boolean(value); STATE.error = ""; saveEpisode(); renderModal();
  }

  async function generateScore() {
    if (STATE.busy) return;
    if (musicLocked()) throw new Error("This episode has an explicit no-background-music rule; soundtrack generation is blocked.");
    if (!postprod().allowBgm) throw new Error("Enable background music for this episode before generating a score.");
    const pp = postprod(), seconds = scoreDuration(), quote = scorePrice(seconds);
    const prompt = String(pp.scorePrompt || pp.plan && pp.plan.score_prompt || "").trim();
    if (!prompt) throw new Error("Draft a score prompt with the LLM or write one manually first.");
    if (seconds > 600) throw new Error("The soundtrack API supports up to 600 seconds per request.");
    STATE.busy = true; STATE.error = "";
    try {
      const req = { kind: "audio", model: "wavespeed/elevenlabs/music-v2.5", prompt, duration: seconds, force_instrumental: true, output_format: "mp3_48000_192" };
      renderModal(`Checking server estimate and budget for ${seconds}s of instrumental music…`, true);
      const dry = await api("/api/run", Object.assign({}, req, { dry: true }));
      if (dry && dry.error) throw new Error(dry.error);
      const actualQuote = Number(dry && dry.est);
      if (!Number.isFinite(actualQuote)) throw new Error("The server could not estimate this music request.");
      if (Math.abs(actualQuote - quote) > 0.001) throw new Error(`Server price is ${usd(actualQuote)}; review the updated estimate before running.`);
      if (!pp.musicRequestKey) {
        pp.musicRequestKey = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `score_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        saveEpisode();
      }
      const started = await api("/api/run", Object.assign({}, req, { request_key: pp.musicRequestKey }));
      if (!started || !started.job) throw new Error((started && started.error) || "The music job did not start; check the server before trying again.");
      pp.musicJobId = started.job; saveEpisode();
      let completed = null;
      for (let i = 0; i < 600; i++) {
        const job = await api(`/api/job?id=${encodeURIComponent(started.job)}`);
        if (job && (job.status === "done" || job.status === "failed")) { completed = job; break; }
        renderModal(`Generating instrumental score… ${job && job.phase || "Waiting for WaveSpeed"}${job && Number.isFinite(Number(job.progress)) ? ` · ${Math.round(job.progress)}%` : ""}`, true);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (!completed) throw new Error("Music generation is still running. The server keeps watching this job; reopen Auto-edit and check before starting another request.");
      if (completed.status !== "done") throw new Error(completed.error || "Music generation failed. Check the saved job before submitting again.");
      const out = completed.output && completed.output.audio, media = Array.isArray(out) ? out[0] : out;
      const ref = media && (media.file || media.ref || media.url);
      if (!ref) throw new Error("WaveSpeed finished but KTOONSTUDIO did not receive an audio file reference.");
      pp.music = { ref, url: media.url || "", name: `${projectCode()}_EP${episodeNumber()}_SCORE.mp3`, duration: seconds, prompt, cost: Number(completed.cost || completed.est || actualQuote), at: Date.now() };
      pp.musicJobId = ""; pp.musicRequestKey = ""; saveEpisode();
      renderModal(`Instrumental score saved (${seconds}s; estimated API cost ${usd(actualQuote)}). Rebuild the timeline to add music and apply the mood grade.`);
      if (typeof toast === "function") toast("Story score generated and saved to this episode.");
    } catch (err) { STATE.error = String(err.message || err); renderModal(); }
    finally { STATE.busy = false; }
  }

  async function applyMoodGrade() {
    const edit = getEdit(), plan = postprod().plan;
    if (!edit.pid) throw new Error("Build the timeline first.");
    if (!plan || !Array.isArray(plan.grades)) throw new Error("Draft the shot-level mood grade plan first.");
    if (!window.VEDIT_API || typeof window.VEDIT_API.applyMoodGrade !== "function") throw new Error("Update the Video Editor to enable per-shot mood grades.");
    STATE.busy = true; STATE.error = ""; renderModal("Applying the reviewed Basic Color values to matching video shots…", true);
    try {
      const r = await window.VEDIT_API.applyMoodGrade(edit.pid, plan.grades);
      if (!r || !r.changed) throw new Error("No video clips matched the score plan's shot keys.");
      postprod().gradeAppliedAt = Date.now(); saveEpisode();
      renderModal(`Mood grade applied to ${r.changed} video clips. Review shots in Video Editor before export.`);
    } catch (err) { STATE.error = String(err.message || err); renderModal(); }
    finally { STATE.busy = false; }
  }

  function renderPostprod() {
    if (!STATE.edl) return "";
    const pp = postprod(), lock = musicLocked(), secs = scoreDuration(), price = scorePrice(secs), plan = pp.plan;
    const grades = plan && Array.isArray(plan.grades) ? plan.grades : [];
    const music = pp.music;
    const planCost = STATE.scoreEstimate == null ? "not estimated" : escText(typeof usd === "function" ? usd(STATE.scoreEstimate) : `$${fmt(STATE.scoreEstimate)}`);
    const gradeRows = grades.map(g => {
      const shot = STATE.plans.find(x => x.key === g.shot);
      return `<tr><td>${escText(shot && shot.label || g.shot)}</td><td>${escText(g.mood)}</td><td>${g.brightness}% / ${g.contrast}% / ${g.saturation}%</td><td>${escText(g.reason)}</td></tr>`;
    }).join("");
    return `<section class="story-postprod-card"><h3>Story-aware soundtrack &amp; mood grade</h3><p>Plan an evolving instrumental cue from the approved shot order, then review and apply per-shot Basic Color values. Skill-guided; music is never generated until you press the priced action below.</p>${lock ? `<div class="story-autoedit-alert">Explicit no-background-music rule detected for this episode. Music generation is locked; grade planning remains available.</div>` : `<label class="story-postprod-toggle"><input type="checkbox" data-pp-allow ${pp.allowBgm ? "checked" : ""}> Allow an instrumental background score on this episode</label>`}<div class="story-postprod-meta">Score length ${secs}s · WaveSpeed estimate ${usd(price)} (${Math.ceil(secs / 60)} started minute${Math.ceil(secs / 60) === 1 ? "" : "s"}) · MP3 48 kHz / 192 kbps · instrumental${secs > 600 ? " · API maximum is 600s" : ""}</div><div class="story-autoedit-actions story-postprod-actions"><button type="button" class="story-btn-ghost" data-s="autoedit.score_estimate">Estimate LLM plan · ${planCost}</button><button type="button" class="story-btn-ghost" data-s="autoedit.score_draft">${plan ? "Refresh" : "Draft"} score + grade plan${STATE.scoreEstimate == null ? "" : ` · ${planCost}`}</button><button type="button" class="story-btn-gold" data-s="autoedit.score_generate" ${lock || secs > 600 || !pp.allowBgm || !(pp.scorePrompt || plan && plan.score_prompt) ? "disabled" : ""}>${music ? "Generate replacement score" : "Generate instrumental score"} · ${usd(price)}</button><button type="button" class="story-btn-ghost" data-s="autoedit.grade_apply" ${!editHasPid() || !grades.length ? "disabled" : ""}>Apply mood grade</button></div><label class="story-postprod-label">Editable music prompt<textarea maxlength="4100" data-pp-score placeholder="Draft with the LLM or enter an instrumental score direction manually">${escText(pp.scorePrompt || plan && plan.score_prompt || "")}</textarea></label>${plan ? `<div class="story-postprod-arc"><b>Story arc</b><span>${escText(plan.arc_summary || "")}</span></div><div class="story-autoedit-table-wrap"><table class="story-autoedit-table story-grade-table"><thead><tr><th>Shot</th><th>Mood</th><th>Brightness / contrast / saturation</th><th>Reason</th></tr></thead><tbody>${gradeRows}</tbody></table></div>` : ""}${music ? `<div class="story-postprod-saved">Saved soundtrack: <b>${escText(music.name || String(music.ref).split("/").pop())}</b> · ${Number(music.duration) || secs}s · ${usd(Number(music.cost) || price)} · ${pp.gradeAppliedAt ? "grade applied" : "grade pending"}</div>` : ""}<small>Native grade controls are brightness, contrast, and saturation per shot. External each::sense rendering is not connected in this installation; the installed video-editing skill guides the in-app plan.</small></section>`;
  }

  function editHasPid() { const edit = getEdit(); return Boolean(edit && edit.pid); }

  function modal() { return $("#story-autoedit-modal"); }
  function renderModal(status, busy = STATE.busy) {
    const root = $("#story");
    if (!root) return;
    let overlay = modal();
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "story-autoedit-modal";
      overlay.className = "story-autoedit-overlay";
      root.appendChild(overlay);
    }
    overlay.hidden = false;
    const hasEdl = Boolean(STATE.edl);
    const estimate = STATE.estimate == null ? "Not estimated" : STATE.mode === "fallback" ? "Free deterministic fallback" : `LLM estimate ${escText(typeof usd === "function" ? usd(STATE.estimate) : `$${fmt(STATE.estimate)}`)}`;
    overlay.innerHTML = `<div class="story-autoedit-dialog" role="dialog" aria-modal="true" aria-labelledby="story-autoedit-title"><header><div><h2 id="story-autoedit-title">Auto-edit episode</h2><p>${escText((STORY.ep && STORY.ep.title) || "Current episode")} · ${STATE.plans.length} planned shots</p></div><button type="button" class="story-btn-ghost" data-s="autoedit.close" aria-label="Close">Close</button></header><div class="story-autoedit-body">${STATE.error ? `<div class="story-autoedit-alert">${escText(STATE.error)}</div>` : ""}<div class="story-autoedit-status" id="story-autoedit-status">${escText(status || (busy ? "Preparing…" : hasEdl ? "EDL ready for review." : "Preparing free clip analysis and price estimate…"))}</div><div class="story-autoedit-estimate">${estimate}<span>Clip analysis is local and free. No media-generation APIs run here.</span></div>${hasEdl ? renderTable() : ""}${hasEdl ? renderPostprod() : ""}${busy ? `<div class="story-autoedit-actions"><button class="story-btn-ghost" disabled>Working…</button></div>` : hasEdl ? `<div class="story-autoedit-actions"><button type="button" class="story-btn-ghost" data-s="autoedit.fallback">Use deterministic fallback</button><button type="button" class="story-btn-ghost" data-s="autoedit.run">Generate new EDL · ${STATE.estimate == null ? "price unavailable" : escText(typeof usd === "function" ? usd(STATE.estimate) : `$${fmt(STATE.estimate)}`)}</button><button type="button" class="story-btn-ghost" data-s="autoedit.rebuild">Rebuild timeline</button><button type="button" class="story-btn-gold" data-s="autoedit.open_vedit">Open in Video Editor</button><button type="button" class="story-btn-gold" data-s="autoedit.export">Export MP4</button></div>` : `<div class="story-autoedit-actions"><button type="button" class="story-btn-ghost" data-s="autoedit.fallback">Use free deterministic edit</button><button type="button" class="story-btn-gold" data-s="autoedit.run" ${STATE.mode === "fallback" ? "disabled" : ""}>Generate EDL · ${STATE.estimate == null ? "price unavailable" : escText(typeof usd === "function" ? usd(STATE.estimate) : `$${fmt(STATE.estimate)}`)}</button></div>`}</div></div>`;
    overlay.querySelectorAll("[data-ed-field]").forEach(input => input.addEventListener("input", () => {
      const row = input.closest("tr");
      if (!row) return;
      const start = Number($("[data-ed-field='in']", row).value), end = Number($("[data-ed-field='out']", row).value);
      const cell = $(".ed-len", row);
      if (cell && Number.isFinite(start) && Number.isFinite(end)) cell.textContent = `${fmt(Math.max(0, end - start))}s`;
      const totalNode = $("#story-autoedit-total", overlay);
      if (totalNode) {
        const total = Array.from(overlay.querySelectorAll("[data-ed-row]")).reduce((sum, tr) => {
          const i = Number(tr.dataset.edRow), it = STATE.edl.items[i];
          if (!it.ref) return sum + (Number(it.dur) || 0);
          const a = Number($("[data-ed-field='in']", tr).value), b = Number($("[data-ed-field='out']", tr).value);
          return sum + (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0);
        }, 0);
        totalNode.textContent = `${fmt(total)}s`;
        const target = Math.max(0.2, targetSeconds());
        const meter = $(".story-autoedit-meter", overlay);
        const fill = $("#story-autoedit-meter-fill", overlay);
        if (meter) {
          meter.classList.toggle("in-range", Math.abs(total - target) <= 3);
          meter.classList.toggle("out-range", Math.abs(total - target) > 3);
          meter.setAttribute("aria-valuenow", fmt(total));
        }
        if (fill) fill.style.width = `${Math.min(100, Math.max(0, total / target * 100)).toFixed(1)}%`;
      }
    }));
    overlay.querySelectorAll("[data-ed-field='transition']").forEach(select => select.addEventListener("change", () => {
      const row = select.closest("tr"), duration = row && $("[data-ed-field='transition_duration']", row);
      if (duration) duration.disabled = select.value !== "cross" || select.disabled;
    }));
    overlay.querySelectorAll("[data-pp-allow]").forEach(input => input.addEventListener("change", () => setAllowBgm(input.checked)));
    overlay.querySelectorAll("[data-pp-score]").forEach(input => input.addEventListener("input", () => {
      const pp = postprod(); pp.scorePrompt = input.value; saveEpisode();
      const button = overlay.querySelector('[data-s="autoedit.score_generate"]');
      if (button) button.disabled = musicLocked() || scoreDuration() > 600 || !pp.allowBgm || !input.value.trim();
    }));
  }

  function open() {
    STATE.edl = getEdit() && getEdit().edl || null;
    STATE.input = null;
    STATE.estimate = null;
    STATE.scoreEstimate = null;
    STATE.error = "";
    STATE.plans = uniqueRefShots();
    renderModal("Preparing free clip analysis and price estimate…", true);
    prepare();
  }
  function close() { const el = modal(); if (el) el.hidden = true; }

  async function buildTimeline() {
    const edl = readEdlInputs();
    const edit = getEdit();
    const version = epEditVersion();
    const name = `${projectCode()}_EP${episodeNumber()}_EDIT_v${version}`;
    const bible = STORY.bible || {};
    const pp = edit.postprod || {};
    const musicCfg = bible.music || bible.audio && bible.audio.music || {};
    const generatedMusic = !musicLocked() && pp.allowBgm && pp.music && pp.music.ref ? pp.music : null;
    const musicRef = generatedMusic ? generatedMusic.ref : (typeof musicCfg === "string" ? musicCfg : musicCfg.ref || bible.musicRef || "");
    const gradeMap = new Map(((pp.plan && pp.plan.grades) || []).map(g => [String(g.shot), { brightness: g.brightness, contrast: g.contrast, saturation: g.saturation }]));
    const payload = {
      name, aspect: bible.format && bible.format.aspect || "9:16", fps: Number(bible.format && bible.format.fps) || 30,
      items: edl.items.map(it => ({ ref: it.ref || null, src_in: Number(it.src_in) || 0, src_out: Number(it.src_out) || Number(it.dur) || 0, dur: Number(it.dur) || Math.max(0.2, Number(it.src_out) - Number(it.src_in)), label: (STATE.plans.find(p => p.key === it.shot) || {}).label || it.shot, shot: it.shot, lead: Number(it.lead) || 0, trans: it.trans || null, grade: gradeMap.get(String(it.shot)) || null })),
      titles: edl.titles || [], markers: edl.dropped.map(x => ({ t: 0, label: `DROPPED ${x.shot}: ${x.reason}` })),
      music: musicRef ? { ref: musicRef, gain_db: generatedMusic ? -18 : (Number(musicCfg.gain_db) || -14), duck: generatedMusic ? true : musicCfg.duck !== false } : null
    };
    if (typeof STORY.snapshot === "function") STORY.snapshot("Build auto-edit timeline");
    renderModal("Building editable timeline…", true);
    const result = await window.VEDIT_API.buildFromEDL(payload);
    if (!result || !result.pid) throw new Error("Video Editor did not return a timeline ID.");
    edit.edl = JSON.parse(JSON.stringify(edl));
    edit.pid = result.pid;
    edit.sequenceName = name;
    edit.sequenceVersion = version;
    edit.builtAt = Date.now();
    edit.duration = Number(result.duration) || edl.total;
    saveEpisode();
    STATE.edl = edl;
    renderModal("Timeline ready. Review it in Video Editor or export when ready.");
    if (typeof toast === "function") toast("Auto-edit timeline built.");
  }

  async function exportEdit() {
    const edit = getEdit();
    if (!edit || !edit.pid || !window.VEDIT_API || typeof window.VEDIT_API.exportSequence !== "function") throw new Error("Build the timeline before exporting.");
    const prev = edit.exported && Number(edit.exported.version) || 0;
    const version = Math.max(prev, Number(edit.exportVersion) || 0) + 1;
    const name = `${projectCode()}_EP${episodeNumber()}_EDIT_v${version}.mp4`;
    renderModal("Exporting MP4 from the Video Editor…", true);
    const result = await window.VEDIT_API.exportSequence(edit.pid, { name, scale: 1, q: 1 });
    if (!result || !result.ref) throw new Error("Video Editor export did not return a media reference.");
    edit.exportVersion = version;
    edit.exported = { ref: result.ref, name: result.name || name, version, at: Date.now() };
    saveEpisode();
    renderModal(`Export complete: ${edit.exported.name}`);
    if (typeof toast === "function") toast(`Exported ${edit.exported.name}`);
  }

  function openEditor() {
    const edit = getEdit();
    if (!edit || !edit.pid) throw new Error("Build the timeline first.");
    if (window.VEDIT_API && typeof window.VEDIT_API.open === "function") window.VEDIT_API.open(edit.pid);
    else throw new Error("Video Editor API is unavailable.");
  }

  function decorateAutopilotModal(overlay, productionState) {
    if (!overlay || !productionState || productionState.status !== "done") return;
    const body = overlay.querySelector(".story-autopilot-body");
    if (!body) return;
    let card = body.querySelector("#story-postprod-autoedit");
    if (!card) { card = document.createElement("div"); card.id = "story-postprod-autoedit"; card.className = "story-postprod-next"; body.appendChild(card); }
    card.innerHTML = `<div><b>Next: Auto-edit</b><span>Analyse approved clips and prepare an editable EDL. The LLM price is shown before it runs.</span></div><button type="button" class="story-btn-gold">Open Auto-edit</button>`;
    card.querySelector("button").onclick = () => open();
  }

  function updateBoardButton() {
    const b = $("#story-btn-autoedit");
    if (!b) return;
    b.textContent = STATE.estimate == null ? "Auto-edit episode" : `Auto-edit episode · ${STATE.mode === "fallback" ? "Free" : (typeof usd === "function" ? usd(STATE.estimate) : `$${fmt(STATE.estimate)}`)}`;
  }

  function injectBoardButton(container) {
    const actions = container && container.querySelector(".story-board-actions");
    if (!actions || $("#story-btn-autoedit", actions)) return;
    const button = document.createElement("button");
    button.id = "story-btn-autoedit";
    button.type = "button";
    button.className = "story-btn-gold";
    button.dataset.s = "autoedit.open";
    button.textContent = "Auto-edit episode";
    button.title = "Analyse approved clips, create an editable EDL and build a timeline";
    actions.appendChild(button);
  }

  function decorateBoard() {
    const view = STORY.views && STORY.views.board;
    if (!view || typeof view.render !== "function" || view.render.__autoEditWrapped) return;
    const original = view.render;
    const wrapped = function (container) { original(container); injectBoardButton(container); updateBoardButton(); };
    wrapped.__autoEditWrapped = true;
    view.render = wrapped;
  }

  function registerCommands() {
    STORY.cmds["autoedit.open"] = open;
    STORY.cmds["autoedit.close"] = close;
    STORY.cmds["autoedit.run"] = () => run(false);
    STORY.cmds["autoedit.fallback"] = () => run(true);
    STORY.cmds["autoedit.rebuild"] = () => buildTimeline().catch(err => { STATE.error = String(err.message || err); renderModal(); });
    STORY.cmds["autoedit.open_vedit"] = () => { try { openEditor(); } catch (err) { STATE.error = String(err.message || err); renderModal(); } };
    STORY.cmds["autoedit.export"] = () => exportEdit().catch(err => { STATE.error = String(err.message || err); renderModal(); });
    STORY.cmds["autoedit.score_estimate"] = () => estimateScorePlan();
    STORY.cmds["autoedit.score_draft"] = () => draftScorePlan();
    STORY.cmds["autoedit.score_generate"] = () => generateScore();
    STORY.cmds["autoedit.grade_apply"] = () => applyMoodGrade().catch(err => { STATE.error = String(err.message || err); renderModal(); });
  }

  function init() {
    if (!window.STORY || !STORY.views || !STORY.cmds) return;
    registerCommands();
    STORY.autoEdit = { open, close, run, buildTimeline, exportEdit, prepare, decorateAutopilotModal, getState: () => STATE, normalizeEdl, fallbackEdl };
    decorateBoard();
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) STORY.hooks.afterLoad.push(() => { decorateBoard(); updateBoardButton(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
