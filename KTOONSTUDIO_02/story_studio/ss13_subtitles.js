// ===== Story Studio Subtitles =====
(function () {
  "use strict";

  const LANGS = ["vi", "es", "pt", "id", "th", "zh", "ja", "ko", "fr", "de"];
  const STATE = { busy: false, pid: "", lang: "en", cues: [], estimate: null, target: "", error: "", message: "", burnOnExport: true };
  const $ = (sel, root = document) => root.querySelector(sel);
  const escText = (value) => {
    if (typeof esc === "function") return esc(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  const fmt = n => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00";
  const subtitleStore = () => {
    if (!STORY.ep) return {};
    if (!STORY.ep.subs || typeof STORY.ep.subs !== "object") STORY.ep.subs = {};
    return STORY.ep.subs;
  };
  const editState = () => STORY.ep && STORY.ep.edit && typeof STORY.ep.edit === "object" ? STORY.ep.edit : null;
  const activePid = () => String((editState() && editState().pid) || "");
  const bibleLang = () => String((STORY.bible && STORY.bible.format && STORY.bible.format.lang) || "en").toLowerCase();
  const pad = n => String(Number(n) || 0).padStart(2, "0");
  function slug(value) { return String(value || "KTOONS").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "KTOONS"; }
  function projectName() { const series = typeof STORY.curSeries === "function" ? STORY.curSeries() : null; return slug((STORY.bible && STORY.bible.name) || (series && series.name) || "KTOONS"); }
  function episodeNum() { const ep = STORY.ep || {}; const m = String(ep.title || ep.ep || "01").match(/(?:EP(?:ISODE)?\s*)?(\d{1,3})/i); return pad(m ? m[1] : 1); }
  function saveEpisode() { if (STORY.dirty) STORY.dirty.ep = true; if (typeof STORY.scheduleSave === "function") STORY.scheduleSave(); }
  function shotList() { return STORY.ep && Array.isArray(STORY.ep.shots) ? STORY.ep.shots.slice().sort((a, b) => (Number(a.block) || 1) - (Number(b.block) || 1) || (Number(a.n) || 0) - (Number(b.n) || 0)) : []; }
  function linesForEpisode() {
    return shotList().flatMap(s => (Array.isArray(s.dialogue) ? s.dialogue : []).map(d => ({
      shot: String(s.id || `S${pad(s.n)}`), char: String(d.char_name || d.char || ""), text: String(d.text || d.line || "").trim(), mode: String(d.modifier || d.mode || "ON").toUpperCase()
    })).filter(x => x.text));
  }
  function getFromTrack(lang) {
    const saved = subtitleStore()[lang];
    if (saved && Array.isArray(saved.cues)) return saved.cues;
    const native = window.VEDIT_API && window.VEDIT_API.getSubtitles && window.VEDIT_API.getSubtitles(STATE.pid);
    if (native && native.lang === lang && Array.isArray(native.cues)) return native.cues;
    return [];
  }

  async function run(lang, force = false) {
    const pid = activePid();
    if (!pid) throw new Error("Run Auto-edit first to create the Video Editor sequence.");
    STATE.pid = pid;
    STATE.lang = String(lang || bibleLang() || "en").toLowerCase();
    const saved = getFromTrack(STATE.lang);
    if (!force && saved.length) {
      STATE.cues = saved.map(c => Object.assign({}, c));
      STATE.message = `Loaded ${saved.length} saved ${STATE.lang} subtitle cues.`;
      render();
      return { cues: STATE.cues };
    }
    if (!window.VEDIT_API || typeof window.VEDIT_API.autoSubtitles !== "function") throw new Error("Update the Video Editor to enable subtitle timing.");
    const lines = linesForEpisode();
    if (!lines.length) throw new Error("The shotlist has no dialogue lines to subtitle.");
    STATE.busy = true;
    STATE.message = "Finding speech regions and aligning shotlist dialogue…";
    STATE.error = "";
    render();
    const oldTrack = window.VEDIT_API.getSubtitles ? window.VEDIT_API.getSubtitles(pid) : null;
    try {
      // burn:false keeps the timeline untouched until the user clicks Apply.
      const result = await window.VEDIT_API.autoSubtitles(pid, { lang: STATE.lang, lines, burn: false });
      if (!result || !Array.isArray(result.cues)) throw new Error("Subtitle timing returned no cue list.");
      STATE.cues = result.cues.map(c => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text || ""), shot: String(c.shot || ""), char: String(c.char || "") }));
      subtitleStore()[STATE.lang] = { cues: JSON.parse(JSON.stringify(STATE.cues)), pid, sourceLang: bibleLang(), at: Date.now() };
      saveEpisode();
      STATE.message = `Created ${STATE.cues.length} draft subtitle cues from the shotlist.`;
      return result;
    } catch (err) {
      STATE.error = String(err.message || err);
      throw err;
    } finally {
      // autoSubtitles replaces the editor's current subtitle track even with burn:false.
      // Restore the user's previous track while keeping the generated draft in Story Studio.
      try {
        if (oldTrack && Array.isArray(oldTrack.cues)) await window.VEDIT_API.setSubtitles(pid, oldTrack.cues, { lang: oldTrack.lang || STATE.lang, burn: true });
        else await window.VEDIT_API.setSubtitles(pid, [], { lang: STATE.lang, burn: false });
      } catch (_) {}
      STATE.busy = false;
      render();
    }
  }

  function cueWarnings(cue, index, cues) {
    const issues = [];
    const start = Number(cue.start), end = Number(cue.end), text = String(cue.text || "");
    const lines = text.split(/\r?\n/);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) issues.push("End must follow start");
    const dur = end - start;
    if (dur < 0.8) issues.push("Under 0.8 s");
    if (dur > 6) issues.push("Over 6 s");
    if (lines.length > 2) issues.push("More than 2 lines");
    if (lines.some(line => line.length > 32)) issues.push("Line over 32 chars");
    if (dur > 0 && text.length / dur > 17) issues.push("Over 17 chars/s");
    const next = cues[index + 1];
    if (next && Number(next.start) - end < 0.08) issues.push("Gap under 0.08 s");
    return issues;
  }

  function renderRows() {
    if (!STATE.cues.length) return `<div class="story-sub-empty">No subtitle cues yet. Generate subtitles from the episode dialogue.</div>`;
    return `<div class="story-sub-table-wrap"><table class="story-sub-table"><thead><tr><th># / Shot</th><th>Start</th><th>End</th><th>Text</th><th>Character</th><th>Checks</th></tr></thead><tbody>${STATE.cues.map((cue, i) => {
      const warnings = cueWarnings(cue, i, STATE.cues);
      return `<tr data-sub-row="${i}"><td><b>${i + 1}</b><small>${escText(cue.shot || "")}</small></td><td><input data-sub-field="start" type="number" min="0" step="0.01" value="${fmt(cue.start)}"></td><td><input data-sub-field="end" type="number" min="0" step="0.01" value="${fmt(cue.end)}"></td><td><textarea data-sub-field="text" rows="2" maxlength="160">${escText(cue.text || "")}</textarea></td><td><input data-sub-field="char" type="text" maxlength="64" value="${escText(cue.char || "")}"></td><td class="story-sub-warnings ${warnings.length ? "has-warning" : "ok"}">${warnings.length ? warnings.map(escText).join(" · ") : "OK"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function syncRowsToState() {
    const overlay = $("#story-subtitles-modal");
    if (!overlay) return STATE.cues;
    overlay.querySelectorAll("[data-sub-row]").forEach(row => {
      const i = Number(row.dataset.subRow);
      if (!STATE.cues[i]) return;
      STATE.cues[i].start = Number($("[data-sub-field='start']", row).value);
      STATE.cues[i].end = Number($("[data-sub-field='end']", row).value);
      STATE.cues[i].text = $("[data-sub-field='text']", row).value;
      STATE.cues[i].char = $("[data-sub-field='char']", row).value;
    });
    return STATE.cues;
  }

  function warningsForAll() {
    syncRowsToState();
    return STATE.cues.flatMap((c, i) => cueWarnings(c, i, STATE.cues).map(w => `Cue ${i + 1}: ${w}`));
  }

  function ensureOverlay() {
    const root = $("#story");
    if (!root) throw new Error("Open Story Studio first.");
    let overlay = $("#story-subtitles-modal");
    if (!overlay) { overlay = document.createElement("div"); overlay.id = "story-subtitles-modal"; overlay.className = "story-subtitles-overlay"; root.appendChild(overlay); }
    return overlay;
  }

  function render() {
    let overlay;
    try { overlay = ensureOverlay(); } catch (_) { return; }
    overlay.hidden = false;
    const savedTargets = LANGS.map(code => `<option value="${code}" ${STATE.target === code ? "selected" : ""}>${code.toUpperCase()}</option>`).join("");
    const estimate = STATE.estimate == null ? "Estimate translation" : `Translate · ${typeof usd === "function" ? usd(STATE.estimate) : `$${fmt(STATE.estimate)}`}`;
    const canTranslate = Boolean(STATE.cues.length && window.STORY.ai && typeof STORY.ai.run === "function" && STATE.target);
    overlay.innerHTML = `<div class="story-sub-dialog" role="dialog" aria-modal="true" aria-labelledby="story-sub-title"><header><div><h2 id="story-sub-title">Subtitles</h2><p>${escText((STORY.ep && STORY.ep.title) || "Current episode")} · ${escText(STATE.lang.toUpperCase())}</p></div><button type="button" class="story-btn-ghost" data-s="subtitles.close">Close</button></header><div class="story-sub-body">${STATE.error ? `<div class="story-sub-alert">${escText(STATE.error)}</div>` : ""}<div class="story-sub-status">${escText(STATE.message || "Generate subtitles from the shotlist dialogue and align them to speech regions.")}</div><div class="story-sub-toolbar"><button type="button" class="story-btn-gold" data-s="subtitles.generate" ${STATE.busy ? "disabled" : ""}>Generate / reload source subtitles</button><label>Translate to <select id="story-sub-target">${savedTargets}</select></label><button type="button" class="story-btn-ghost" data-s="subtitles.estimate" ${!canTranslate || STATE.busy ? "disabled" : ""}>${estimate}</button><button type="button" class="story-btn-gold" data-s="subtitles.translate" ${!canTranslate || STATE.busy || STATE.estimate == null ? "disabled" : ""}>Translate to ${escText((STATE.target || "").toUpperCase())}</button></div><div class="story-sub-toolbar secondary"><button type="button" class="story-btn-ghost" data-s="subtitles.download:srt" ${!STATE.cues.length ? "disabled" : ""}>Download .SRT</button><button type="button" class="story-btn-ghost" data-s="subtitles.download:vtt" ${!STATE.cues.length ? "disabled" : ""}>Download .VTT</button><button type="button" class="story-btn-gold" data-s="subtitles.apply" ${!STATE.cues.length || STATE.busy ? "disabled" : ""}>Apply subtitles to timeline</button><label class="story-sub-burn-toggle"><input id="story-sub-burn" type="checkbox" ${STATE.burnOnExport ? "checked" : ""}> Burn-in on export</label><button type="button" class="story-btn-gold" data-s="subtitles.export" ${!STATE.cues.length || STATE.busy ? "disabled" : ""}>Export ${STATE.burnOnExport ? "with subtitles" : "without subtitles"}</button></div><div id="story-sub-warning-summary" class="story-sub-warning-summary"></div>${renderRows()}</div></div>`;
    const target = $("#story-sub-target", overlay);
    if (target) target.addEventListener("change", () => { STATE.target = target.value; STATE.estimate = null; render(); });
    const burn = $("#story-sub-burn", overlay);
    if (burn) burn.addEventListener("change", () => { STATE.burnOnExport = burn.checked; render(); });
    overlay.querySelectorAll("[data-sub-field]").forEach(input => input.addEventListener("input", () => {
      const summary = $("#story-sub-warning-summary", overlay);
      const warnings = warningsForAll();
      if (summary) summary.textContent = warnings.length ? `${warnings.length} timing / reading warnings. Review before applying.` : "All cues meet the subtitle checks.";
      const row = input.closest("tr");
      if (row) {
        const i = Number(row.dataset.subRow), w = cueWarnings(STATE.cues[i], i, STATE.cues), node = $(".story-sub-warnings", row);
        if (node) { node.className = `story-sub-warnings ${w.length ? "has-warning" : "ok"}`; node.textContent = w.length ? w.join(" · ") : "OK"; }
      }
    }));
    const summary = $("#story-sub-warning-summary", overlay);
    if (summary && STATE.cues.length) { const warnings = warningsForAll(); summary.textContent = warnings.length ? `${warnings.length} timing / reading warnings. Review before applying.` : "All cues meet the subtitle checks."; }
  }

  async function generate() {
    STATE.estimate = null;
    STATE.error = "";
    STATE.cues = [];
    STATE.lang = bibleLang();
    await run(STATE.lang, true);
  }

  async function estimateTranslation() {
    syncRowsToState();
    if (!STATE.cues.length) throw new Error("Generate subtitles before translating.");
    if (!window.STORY.ai || typeof STORY.ai.run !== "function") throw new Error("The Story Studio AI engine is unavailable.");
    STATE.target = String($("#story-sub-target") && $("#story-sub-target").value || STATE.target || "vi").toLowerCase();
    if (!LANGS.includes(STATE.target)) throw new Error("Choose a supported translation language.");
    const input = { from: STATE.lang, to: STATE.target, cues: STATE.cues.map((c, i) => ({ i, text: c.text, char: c.char || "" })), glossary: (STORY.bible && STORY.bible.glossary) || {} };
    const dry = await STORY.ai.run("subtitler", input, { dry: true, noRetry: true });
    STATE.estimate = Math.max(0, Number(dry && dry.est) || 0);
    STATE.message = `Translation price estimate ready for ${STATE.target.toUpperCase()}. Click Translate to confirm the paid LLM call.`;
  }

  async function translate() {
    syncRowsToState();
    if (STATE.estimate == null) throw new Error("Estimate the translation price first.");
    STATE.busy = true;
    STATE.error = "";
    STATE.message = `Translating ${STATE.cues.length} cues to ${STATE.target.toUpperCase()}…`;
    render();
    try {
      const source = STATE.cues.map((c, i) => ({ i, text: c.text, char: c.char || "" }));
      const result = await STORY.ai.run("subtitler", { from: STATE.lang, to: STATE.target, cues: source, glossary: (STORY.bible && STORY.bible.glossary) || {} }, { noRetry: true });
      const translated = result && result.json && result.json.cues;
      if (!Array.isArray(translated) || translated.length !== source.length) throw new Error("Translation must return exactly one cue for each source cue.");
      const next = translated.map((x, i) => {
        if (Number(x.i) !== i || typeof x.text !== "string") throw new Error(`Translation cue order/count mismatch at cue ${i + 1}.`);
        return Object.assign({}, STATE.cues[i], { text: x.text });
      });
      STATE.cues = next;
      STATE.lang = STATE.target;
      subtitleStore()[STATE.lang] = { cues: JSON.parse(JSON.stringify(next)), pid: STATE.pid, sourceLang: bibleLang(), at: Date.now() };
      STATE.estimate = null;
      STATE.message = `Saved ${next.length} translated cues as ${STATE.lang.toUpperCase()}. Timing is unchanged.`;
      saveEpisode();
    } catch (err) { STATE.error = String(err.message || err); }
    finally { STATE.busy = false; render(); }
  }

  async function apply() {
    const cues = syncRowsToState().map(c => ({ start: Number(c.start), end: Number(c.end), text: String(c.text || ""), shot: String(c.shot || ""), char: String(c.char || "") }));
    const hard = cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start);
    if (hard) throw new Error("Fix invalid start/end times before applying.");
    if (!window.VEDIT_API || typeof window.VEDIT_API.setSubtitles !== "function") throw new Error("Video Editor subtitle API is unavailable.");
    await window.VEDIT_API.setSubtitles(STATE.pid, cues, { lang: STATE.lang, burn: true });
    subtitleStore()[STATE.lang] = { cues: JSON.parse(JSON.stringify(cues)), pid: STATE.pid, sourceLang: bibleLang(), appliedAt: Date.now() };
    saveEpisode();
    STATE.message = `Applied ${cues.length} ${STATE.lang.toUpperCase()} captions to the Video Editor timeline.`;
    render();
  }

  function download(kind) {
    const cues = syncRowsToState();
    const api = window.VEDIT_API || {};
    if (!cues.length) throw new Error("There are no subtitle cues to download.");
    const text = kind === "vtt" ? api.toVTT(cues) : api.toSRT(cues);
    const ext = kind === "vtt" ? "vtt" : "srt";
    const name = `${projectName()}_EP${episodeNum()}_${STATE.lang}.${ext}`;
    const blob = new Blob([text], { type: kind === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    STATE.message = `Downloaded ${name}.`;
    render();
  }

  async function exportBurned() {
    if (!STATE.pid || !window.VEDIT_API || typeof window.VEDIT_API.exportSequence !== "function") throw new Error("Build the Auto-edit timeline first.");
    const cues = syncRowsToState().map(c => ({ start: Number(c.start), end: Number(c.end), text: String(c.text || ""), shot: String(c.shot || ""), char: String(c.char || "") }));
    if (cues.some(c => c.end <= c.start)) throw new Error("Fix invalid cue timing before exporting.");
    const old = window.VEDIT_API.getSubtitles ? window.VEDIT_API.getSubtitles(STATE.pid) : null;
    const burn = STATE.burnOnExport !== false;
    const edit = editState();
    const version = Math.max(1, Number(edit && edit.exportVersion || 0) + 1);
    const name = `${projectName()}_EP${episodeNum()}_EDIT_${STATE.lang}_v${version}.mp4`;
    STATE.busy = true; STATE.error = ""; STATE.message = burn ? `Burning ${STATE.lang.toUpperCase()} subtitles into an MP4…` : "Exporting an MP4 without burned-in subtitles…"; render();
    try {
      await window.VEDIT_API.setSubtitles(STATE.pid, burn ? cues : [], { lang: STATE.lang, burn });
      const result = await window.VEDIT_API.exportSequence(STATE.pid, { name, scale: 1, q: 1 });
      if (!result || !result.ref) throw new Error("Video Editor export did not return a media reference.");
      subtitleStore()[STATE.lang] = Object.assign({}, subtitleStore()[STATE.lang] || {}, { cues: JSON.parse(JSON.stringify(cues)), pid: STATE.pid, exported: { ref: result.ref, name: result.name || name, version, burn, at: Date.now() } });
      if (edit) { edit.exportVersion = version; edit.subtitlesExported = edit.subtitlesExported || {}; edit.subtitlesExported[STATE.lang] = { ref: result.ref, name: result.name || name, version, burn, at: Date.now() }; }
      STATE.message = `Export complete: ${result.name || name}`;
    } catch (err) { STATE.error = String(err.message || err); }
    finally {
      try { await window.VEDIT_API.setSubtitles(STATE.pid, old && Array.isArray(old.cues) ? old.cues : [], { lang: old && old.lang || STATE.lang, burn: true }); } catch (_) {}
      STATE.busy = false; saveEpisode(); render();
    }
  }

  function open(lang) {
    STATE.pid = activePid();
    if (!STATE.pid) { STATE.error = "Run Auto-edit first to create the Video Editor sequence."; render(); return; }
    STATE.lang = String(lang || bibleLang()).toLowerCase();
    STATE.target = LANGS.includes(STATE.lang) ? STATE.lang : "vi";
    STATE.cues = getFromTrack(STATE.lang).map(c => Object.assign({}, c));
    STATE.estimate = null; STATE.error = ""; STATE.message = "";
    render();
  }
  function close() { const el = $("#story-subtitles-modal"); if (el) el.hidden = true; }

  function decorateAutopilotModal(overlay, productionState) {
    if (!overlay || !productionState || productionState.status !== "done") return;
    const body = overlay.querySelector(".story-autopilot-body");
    if (!body) return;
    let card = body.querySelector("#story-postprod-subtitles");
    if (!card) { card = document.createElement("div"); card.id = "story-postprod-subtitles"; card.className = "story-postprod-next"; body.appendChild(card); }
    const ready = Boolean(activePid());
    card.innerHTML = `<div><b>Next: Subtitles</b><span>${ready ? "Generate timed cues, edit them, translate, then export." : "Run Auto-edit first to create a Video Editor timeline."}</span></div><button type="button" class="story-btn-gold" ${ready ? "" : "disabled"}>Open Subtitles</button>`;
    const button = card.querySelector("button");
    button.onclick = () => { if (ready) open(); };
  }

  function injectBoardButton(container) {
    const actions = container && container.querySelector(".story-board-actions");
    if (!actions || $("#story-btn-subtitles", actions)) return;
    const button = document.createElement("button"); button.id = "story-btn-subtitles"; button.type = "button";
    button.className = "story-btn-ghost"; button.dataset.s = "subtitles.open"; button.textContent = "Subtitles";
    button.title = "Generate, edit and translate subtitles for the auto-edit timeline"; actions.appendChild(button);
  }
  function decorateBoard() {
    const view = STORY.views && STORY.views.board;
    if (!view || typeof view.render !== "function" || view.render.__subtitlesWrapped) return;
    const original = view.render;
    const wrapped = function (container) { original(container); injectBoardButton(container); };
    wrapped.__subtitlesWrapped = true;
    view.render = wrapped;
  }

  function registerCommands() {
    STORY.cmds["subtitles.open"] = () => open();
    STORY.cmds["subtitles.close"] = close;
    STORY.cmds["subtitles.generate"] = () => generate().catch(err => { STATE.error = String(err.message || err); render(); });
    STORY.cmds["subtitles.estimate"] = () => estimateTranslation().then(render).catch(err => { STATE.error = String(err.message || err); render(); });
    STORY.cmds["subtitles.translate"] = () => translate();
    STORY.cmds["subtitles.apply"] = () => apply().catch(err => { STATE.error = String(err.message || err); render(); });
    STORY.cmds["subtitles.download"] = arg => { try { download(arg); } catch (err) { STATE.error = String(err.message || err); render(); } };
    STORY.cmds["subtitles.export"] = () => exportBurned();
  }

  function init() {
    if (!window.STORY || !STORY.views || !STORY.cmds) return;
    registerCommands();
    STORY.subtitles = { run, open, close, apply, translate, exportBurned, download, decorateAutopilotModal, getState: () => STATE, warningList: warningsForAll };
    decorateBoard();
    if (STORY.hooks && Array.isArray(STORY.hooks.afterLoad)) STORY.hooks.afterLoad.push(() => decorateBoard());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
