// KTOONSTUDIO source-to-story workflow and fixed export naming.
(function () {
  "use strict";

  const state = { mode: "text", sourceType: "complete", file: null, videoFile: null, analysis: null, screenplay: "", episodeMap: null, job: null, busy: false };
  const escHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ascii = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[Đđ]/g, "D").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "PROJECT";

  function seriesId() {
    return (typeof CUR !== "undefined" && CUR && CUR.series && CUR.series.id) || (STORY.bible && STORY.bible.series) || "";
  }
  function projectCode() {
    const bible = STORY.bible || {};
    const s = typeof STORY.curSeries === "function" ? STORY.curSeries() : null;
    const currentName = typeof CUR !== "undefined" && CUR && CUR.series && CUR.series.name;
    return ascii(bible.projectCode || bible.name || (s && s.name) || currentName || "PROJECT");
  }
  function episodeNumber(ep) {
    const current = ep || STORY.ep || (typeof CUR !== "undefined" && CUR && CUR.ep) || {};
    if (Number(current.no) > 0) return Number(current.no);
    const match = String(current.title || current.name || "").match(/(?:EP(?:ISODE)?\s*|\b)(\d{1,3})\b/i);
    if (match) return Number(match[1]);
    const list = typeof STORY.curSeriesEpisodes === "function" ? STORY.curSeriesEpisodes() : [];
    const found = list.findIndex(x => x.id === current.id);
    return found >= 0 ? found + 1 : 1;
  }
  function nextFilename(kind, ext, ep) {
    const bible = STORY.bible || (STORY.bible = {});
    if (!bible.fileVersions || typeof bible.fileVersions !== "object") bible.fileVersions = {};
    const isEpisode = ["SCRIPT", "SHOTLIST"].includes(kind);
    const epPart = isEpisode ? `_EP${String(episodeNumber(ep)).padStart(2, "0")}` : "";
    const key = `${kind}${epPart}`;
    const version = Math.max(0, Number(bible.fileVersions[key]) || 0) + 1;
    bible.fileVersions[key] = version;
    STORY.dirty.bible = true;
    if (typeof STORY.scheduleSave === "function") STORY.scheduleSave();
    return `${projectCode()}${epPart}_${kind}_v${version}.${String(ext || "txt").replace(/^\./, "")}`;
  }
  window.KTOON_FILENAME = { next: nextFilename, projectCode, episodeNumber };

  function mount() {
    const bar = document.querySelector(".script-ai-bar");
    if (bar && !bar.querySelector("[data-s='source.open']")) {
      const button = document.createElement("button");
      button.className = "story-btn-gold";
      button.dataset.s = "source.open";
      button.textContent = "Source → Story workflow";
      button.title = "Analyze a script, shotlist, story document, video, or public YouTube link";
      bar.appendChild(button);
    }
  }

  function ensureModal() {
    let root = document.getElementById("source-story-modal");
    if (root) return root;
    root = document.createElement("div");
    root.id = "source-story-modal";
    root.hidden = true;
    root.innerHTML = `<style>
      #source-story-modal{position:fixed;inset:0;z-index:10050;background:#000b;display:flex;align-items:center;justify-content:center;padding:20px;color:#e6eee9;font:13px/1.45 system-ui,sans-serif}
      #source-story-modal[hidden]{display:none}#sw-card{width:min(980px,96vw);max-height:92vh;overflow:auto;background:#101b16;border:1px solid #c4a748;border-radius:14px;box-shadow:0 18px 60px #000c;padding:18px}
      #sw-card h2{margin:0 0 12px;color:#e4c75d;font-size:19px}#sw-card h3{font-size:13px;color:#e4c75d;margin:14px 0 6px}
      #sw-card label{display:block;color:#b8c7bf;font-size:11px;margin:8px 0 4px}#sw-card input,#sw-card select,#sw-card textarea{box-sizing:border-box;width:100%;background:#07110c;color:#eef5f1;border:1px solid #34463d;border-radius:7px;padding:8px;font:12px/1.45 system-ui,sans-serif}
      #sw-card textarea{resize:vertical;min-height:110px}#sw-card .sw-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}#sw-card .sw-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
      #sw-card button{background:#1b5d40;color:#f5fff9;border:1px solid #368960;border-radius:7px;padding:7px 11px;cursor:pointer}#sw-card button.secondary{background:#192820;border-color:#40564a}#sw-card button:disabled{opacity:.55;cursor:wait}
      #sw-card .sw-note{color:#9bb0a4;font-size:11px;margin:6px 0}#sw-card .sw-status{color:#f2c65b;margin:10px 0;min-height:18px;white-space:pre-wrap}#sw-card progress{width:100%;height:8px;accent-color:#35ae72}
      @media(max-width:680px){#sw-card .sw-row{grid-template-columns:1fr}}
    </style><div id="sw-card" role="dialog" aria-modal="true" aria-labelledby="sw-title">
      <div style="display:flex;align-items:center;gap:12px"><h2 id="sw-title" style="flex:1">Source → Story workflow</h2><button class="secondary" data-sw="close">Close</button></div>
      <div class="sw-note">Không cần chuyển kịch bản sang JSON: có thể dán nội dung hoặc nhập TXT, MD, Fountain, Final Draft FDX, DOC/DOCX, RTF, PDF, ODT, HTML, CSV/TSV, XLSX, EPUB, PPTX và JSON/XML. JSON chỉ là cấu trúc kết quả nội bộ để các bước sau xử lý. PDF dạng scan cần OCR; DOC cũ cần LibreOffice (nếu chưa có, lưu thành DOCX/RTF/PDF/TXT). Nguồn chỉ được đọc để phân tích. Thoại từ kịch bản/shotlist hoàn chỉnh được giữ nguyên; video mẫu giữ nguyên ý thoại nghe được. Gemini video analysis là API tính phí, chỉ chạy khi anh bấm và xác nhận.</div>
      <div class="sw-row"><div><label for="sw-mode">Nguồn đầu vào</label><select id="sw-mode"><option value="text">Text / script / shotlist / story document</option><option value="video">Video file / YouTube / direct video URL</option></select></div>
      <div><label for="sw-source-type">Loại tài liệu text</label><select id="sw-source-type"><option value="complete">Kịch bản hoặc shotlist hoàn chỉnh — thoại nguyên văn</option><option value="narrative">Story / brief / tài liệu nội dung</option></select></div></div>
      <div id="sw-text-input"><label for="sw-doc-file">Import kịch bản / tài liệu ở định dạng phổ biến (tuỳ chọn)</label><input id="sw-doc-file" type="file" accept=".txt,.md,.fountain,.fdx,.doc,.docx,.docm,.dotx,.rtf,.pdf,.odt,.ott,.html,.htm,.xhtml,.csv,.tsv,.xlsx,.xlsm,.epub,.pptx,.json,.xml,.srt,.vtt,.yaml,.yml"><label for="sw-source-text">Hoặc dán nội dung nguồn</label><textarea id="sw-source-text" rows="7" placeholder="Dán kịch bản, shotlist hoặc tài liệu nội dung ở dạng văn bản bất kỳ…"></textarea></div>
      <div id="sw-video-input" hidden><label for="sw-video-file">Video trên máy (upload tới 2 GB)</label><input id="sw-video-file" type="file" accept="video/*"><label for="sw-video-url">Hoặc link YouTube công khai / link HTTPS trực tiếp tới file video</label><input id="sw-video-url" type="url" placeholder="https://youtube.com/watch?v=… hoặc URL file MP4/MOV/WebM"><div class="sw-row"><div><label for="sw-processing">Cách đọc timeline</label><select id="sw-processing"><option value="static">Static sampling 2 fps — tổng quan video</option><option value="agentic">Agentic — video dài / cần phân tích có mục tiêu</option></select></div><div><label for="sw-note">Yêu cầu bổ sung</label><input id="sw-note" type="text" placeholder="Tuỳ chọn"></div></div><div class="sw-note">Link trang web thông thường chưa hỗ trợ trích xuất video tự động; hãy tải video lên hoặc dùng link YouTube công khai/direct video file.</div></div>
      <div class="sw-row"><div><label for="sw-min">Thời lượng tập tối thiểu (giây)</label><input id="sw-min" type="number" min="30" max="3600" value="90"></div><div><label for="sw-max">Thời lượng tập tối đa (giây)</label><input id="sw-max" type="number" min="30" max="3600" value="120"></div></div>
      <label for="sw-episode-count">Số tập mong muốn (tuỳ chọn — để trống để AI chia theo cấu trúc truyện)</label><input id="sw-episode-count" type="number" min="1" max="200" placeholder="Tự xác định theo nội dung">
      <div class="sw-actions"><button data-sw="analyze">1. Analyze source</button><button data-sw="write" class="secondary" disabled>2. Write master screenplay</button><button data-sw="map" class="secondary" disabled>3. Create episode map</button></div>
      <div id="sw-status" class="sw-status"></div><progress id="sw-progress" value="0" max="100" hidden></progress>
      <div id="sw-analysis-wrap" hidden><h3>Source event ledger (editable)</h3><textarea id="sw-analysis" rows="9" spellcheck="false"></textarea><div class="sw-actions"><button data-sw="download-analysis" class="secondary">Download event ledger</button></div></div>
      <div id="sw-screenplay-wrap" hidden><h3>Master screenplay (editable)</h3><textarea id="sw-screenplay" rows="10"></textarea><div class="sw-actions"><button data-sw="download-screenplay" class="secondary">Download master screenplay</button></div></div>
      <div id="sw-map-wrap" hidden><h3>Episode map (editable before apply)</h3><div id="sw-map-list" class="sw-note"></div><textarea id="sw-map-json" rows="8" spellcheck="false"></textarea><div class="sw-actions"><button data-sw="apply">Apply to episode list and empty episode documents</button><button data-sw="download-map" class="secondary">Download episode map</button><button data-sw="autopilot" class="secondary">Open pre-production Autopilot</button></div><div class="sw-note">Apply không ghi đè episode đã có script, shotlist hoặc nội dung. Các episode trống được điền kịch bản/outline từ map.</div></div>
    </div>`;
    document.body.appendChild(root);
    root.addEventListener("click", handleClick);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleInput);
    return root;
  }

  function status(text, progress) {
    const root = document.getElementById("source-story-modal");
    if (!root) return;
    root.querySelector("#sw-status").textContent = text || "";
    const bar = root.querySelector("#sw-progress");
    bar.hidden = progress == null;
    if (progress != null) bar.value = Math.max(0, Math.min(100, Number(progress) || 0));
  }
  function setBusy(on) {
    state.busy = !!on;
    document.querySelectorAll("#source-story-modal [data-sw]").forEach(b => { if (b.dataset.sw !== "close" && b.dataset.sw !== "autopilot") b.disabled = state.busy; });
  }
  function renderStages() {
    const root = document.getElementById("source-story-modal");
    if (!root) return;
    root.querySelector("[data-sw='write']").disabled = state.busy || !state.analysis;
    root.querySelector("[data-sw='map']").disabled = state.busy || !state.screenplay.trim();
    root.querySelector("#sw-analysis-wrap").hidden = !state.analysis;
    root.querySelector("#sw-screenplay-wrap").hidden = !state.analysis;
    root.querySelector("#sw-map-wrap").hidden = !state.episodeMap;
  }
  function openModal() {
    const root = ensureModal();
    root.hidden = false;
    root.querySelector("#sw-source-text").value = state.sourceText || "";
    root.querySelector("#sw-analysis").value = state.analysis ? JSON.stringify(state.analysis, null, 2) : "";
    root.querySelector("#sw-screenplay").value = state.screenplay || "";
    renderStages();
  }
  function closeModal() { const root = document.getElementById("source-story-modal"); if (root) root.hidden = true; }

  async function readTextSource(root) {
    const file = root.querySelector("#sw-doc-file").files[0];
    let text = root.querySelector("#sw-source-text").value.trim();
    if (file) {
      const extracted = await api("/api/extract", await file.arrayBuffer(), file.name);
      if (extracted && extracted.error) throw new Error(extracted.error);
      text = String(extracted && extracted.text || "").trim();
      root.querySelector("#sw-source-text").value = text;
      state.file = file.name;
    }
    if (!text) throw new Error("Chọn tài liệu hoặc dán nội dung nguồn trước.");
    const type = root.querySelector("#sw-source-type").value;
    const authority = type === "complete" ? "COMPLETE_SCRIPT_OR_SHOTLIST" : "NARRATIVE_SOURCE";
    return { text, sourceKind: type === "complete" ? "complete_script_or_shotlist" : "narrative_document", authority };
  }
  async function analyzeText(root) {
    const src = await readTextSource(root);
    state.sourceText = src.text;
    state.dialogueAuthority = src.authority;
    status("Analyzing source events and dialogue…");
    const result = await STORY.ai.run("source_analyzer", { source_kind: src.sourceKind, dialogue_authority: src.authority, source_text: src.text });
    if (!result || !result.json) throw new Error("Source analyzer returned no structured result.");
    state.analysis = result.json;
    root.querySelector("#sw-analysis").value = JSON.stringify(state.analysis, null, 2);
    status(`Source analysis complete${result.cost ? ` · estimated cost ${usd(result.cost)}` : ""}. Review the event ledger, then write the master screenplay.`);
    renderStages();
  }

  async function uploadVideo(file, root) {
    const start = await api("/api/source/upload_start", { name: file.name, size: file.size });
    if (!start || start.error || !start.upload_id) throw new Error((start && start.error) || "Could not start video upload.");
    const chunkSize = Number(start.chunk_bytes) || 4 * 1024 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const response = await fetch(`/api/source/upload_chunk?id=${encodeURIComponent(start.upload_id)}`, { method: "POST", headers: { "X-Token": TOKEN, "X-Ep": (CUR.ep && CUR.ep.id) || "", "X-Upload-Offset": String(offset) }, body: chunk });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error((body && body.error) || `Video upload failed (${response.status}).`);
      offset += chunk.size;
      status(`Uploading video to local KTOONSTUDIO server… ${(offset / file.size * 100).toFixed(0)}%`, Math.round(offset / file.size * 15));
    }
    const finished = await api("/api/source/upload_finish", { upload_id: start.upload_id });
    if (!finished || finished.error || !finished.ref) throw new Error((finished && finished.error) || "Video upload did not finish.");
    return finished.ref;
  }
  async function pollVideoJob(jobId, root) {
    const started = Date.now();
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const job = await api(`/api/source/video_job?id=${encodeURIComponent(jobId)}`);
      if (job && job.error) throw new Error(job.error);
      status(`${job.stage || "Gemini analysis"}${job.progress != null ? ` · ${job.progress}%` : ""}${job.error ? `\n${job.error}` : ""}`, job.progress || 0);
      if (job.status === "done") return job.result;
      if (job.status === "failed") throw new Error(job.error || "Gemini video analysis failed.");
      if (Date.now() - started > 45 * 60 * 1000) throw new Error("Analysis is still running or timed out. Check the Gemini activity before submitting again; the result may already be billed.");
    }
  }
  async function analyzeVideo(root) {
    const file = root.querySelector("#sw-video-file").files[0];
    const url = root.querySelector("#sw-video-url").value.trim();
    if (Boolean(file) === Boolean(url)) throw new Error("Choose one video file or one URL.");
    if (!window.confirm("Gemini 3.8 Flash video analysis is a paid API call. Review the Google AI Studio usage/cost after the run. Start analysis now?")) return;
    let ref = "";
    if (file) ref = await uploadVideo(file, root);
    const started = await api("/api/source/video_start", { ref, url, processing: root.querySelector("#sw-processing").value, note: root.querySelector("#sw-note").value.trim() });
    if (!started || started.error || !started.job) throw new Error((started && started.error) || "Could not start Gemini analysis.");
    state.job = started.job;
    state.dialogueAuthority = "VIDEO_SAMPLE";
    status(`Gemini ${started.model || "video model"} is analyzing the video. This may take several minutes.`, 17);
    state.analysis = await pollVideoJob(started.job, root);
    root.querySelector("#sw-analysis").value = JSON.stringify(state.analysis, null, 2);
    state.sourceText = "";
    status("Video timeline analysis complete. Review the event ledger, then write the master screenplay.", 100);
    renderStages();
  }

  async function writeMaster(root) {
    let ledger;
    try { ledger = JSON.parse(root.querySelector("#sw-analysis").value); } catch (_) { throw new Error("The event ledger is not valid JSON."); }
    if (!ledger || !Array.isArray(ledger.events) || !ledger.events.length) throw new Error("The event ledger has no plot events.");
    state.analysis = ledger;
    const authority = state.dialogueAuthority || ledger.dialogue_authority || "VIDEO_SAMPLE";
    status("Writing source-faithful master screenplay…");
    const res = await STORY.ai.run("master_screenplay_writer", { source_kind: ledger.source_kind || "source", source_material: state.sourceText || "", source_analysis: ledger, dialogue_authority: authority });
    if (!res || !res.json || !res.json.master_screenplay) throw new Error("Master screenplay writer returned no screenplay.");
    state.screenplay = res.json.master_screenplay;
    state.screenplayMeta = res.json;
    root.querySelector("#sw-screenplay").value = state.screenplay;
    const missingDialogue = missingCanonicalDialogue(state.screenplay);
    if (authority === "COMPLETE_SCRIPT_OR_SHOTLIST" && missingDialogue.length) {
      status(`Master screenplay omitted ${missingDialogue.length} canonical dialogue line(s). Restore them verbatim in the editable screenplay before creating the episode map.`);
      renderStages();
      return;
    }
    status(`Master screenplay ready${res.cost ? ` · estimated cost ${usd(res.cost)}` : ""}. Review or edit it before creating the episode map.`);
    renderStages();
  }

  async function createEpisodeMap(root) {
    const screenplay = root.querySelector("#sw-screenplay").value.trim();
    if (!screenplay) throw new Error("Master screenplay is empty.");
    const min = Math.max(30, Number(root.querySelector("#sw-min").value) || 90);
    const max = Math.max(min, Number(root.querySelector("#sw-max").value) || 120);
    state.screenplay = screenplay;
    const bible = STORY.bible || {};
    status("Splitting screenplay into source-complete episode arcs…");
    const res = await STORY.ai.run("plot_analyst", {
      series: { name: bible.name || (CUR.series && CUR.series.name) || "Series", logline: bible.logline || "", genre: bible.genre || "Drama", tone: bible.tone || "Cinematic", audience: bible.audience || "Adults" },
      source_story: screenplay,
      master_screenplay: screenplay,
      source_analysis: state.analysis,
      screenplay_coverage: state.screenplayMeta && state.screenplayMeta.coverage || [],
      dialogue_authority: state.dialogueAuthority || "VIDEO_SAMPLE",
      requested_episode_count: Number(document.getElementById("sw-episode-count") && document.getElementById("sw-episode-count").value) || null,
      format: { duration_min: min, duration_max: max, duration_override: null }
    });
    if (!res || !res.json || !Array.isArray(res.json.episodes) || !res.json.episodes.length) throw new Error("Episode map writer returned no episodes.");
    const missing = res.json.episodes.find(e => !String(e.screenplay || "").trim());
    if (missing) throw new Error(`EP${String(missing.n).padStart(2, "0")} has no screenplay excerpt. No episode map was applied.`);
    const outOfRange = res.json.episodes.find(e => !Number.isFinite(Number(e.duration)) || Number(e.duration) < min || Number(e.duration) > max);
    if (outOfRange) throw new Error(`EP${String(outOfRange.n).padStart(2, "0")} duration ${outOfRange.duration}s is outside ${min}–${max}s. Review the model output and run the map again.`);
    const eventIds = (state.analysis && state.analysis.events || []).map(e => e && e.id).filter(Boolean);
    const episodeEventIds = res.json.episodes.flatMap(e => (e.beats || []).flatMap(b => b.source_event_ids || []));
    const mappedEventIds = new Set(episodeEventIds);
    const uncovered = eventIds.filter(id => !mappedEventIds.has(id));
    if (uncovered.length) throw new Error(`Episode map omitted source event(s): ${uncovered.join(", ")}. No map was applied.`);
    const missingDialogue = missingCanonicalDialogue(res.json.episodes.map(e => e.screenplay).join("\n"));
    if ((state.dialogueAuthority || state.analysis.dialogue_authority) === "COMPLETE_SCRIPT_OR_SHOTLIST" && missingDialogue.length) {
      state.episodeMap = res.json;
      root.querySelector("#sw-map-json").value = JSON.stringify(res.json, null, 2);
      renderStages();
      throw new Error(`The episode excerpts omitted ${missingDialogue.length} canonical dialogue line(s). Restore them verbatim in the editable episode map before applying.`);
    }
    state.episodeMap = res.json;
    const mapRoot = root.querySelector("#sw-map-wrap");
    root.querySelector("#sw-map-json").value = JSON.stringify(res.json, null, 2);
    root.querySelector("#sw-map-list").textContent = `${res.json.episodes.length} episodes · ${min}–${max}s each${res.cost ? ` · estimated cost ${usd(res.cost)}` : ""}`;
    status("Episode map ready. Apply creates documents only for empty episodes and leaves existing work untouched.");
    renderStages();
  }

  function sourceDescriptor() {
    return { kind: state.analysis && state.analysis.source_kind || "source", name: state.file || (state.videoFile && state.videoFile.name) || (document.getElementById("sw-video-url") && document.getElementById("sw-video-url").value) || "pasted text", analyzedAt: new Date().toISOString(), model: state.analysis && state.analysis.analysis_model || "KTOONSTUDIO LLM roles" };
  }
  function download(content, kind, ext) {
    const name = nextFilename(kind, ext);
    const blob = new Blob([content], { type: ext === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    if (typeof toast === "function") toast(`Downloaded ${name}`);
  }

  function hasExistingWork(doc) {
    return !!(doc && ((doc.script && doc.script.blocks && doc.script.blocks.length) || (doc.shots && doc.shots.length) || (doc.outline && (doc.outline.premise || (doc.outline.beats || []).length))));
  }
  function missingCanonicalDialogue(text) {
    if (!state.analysis || !Array.isArray(state.analysis.events)) return [];
    const lines = state.analysis.events.flatMap(event => Array.isArray(event.dialogue) ? event.dialogue : [])
      .filter(line => line && line.text && (state.dialogueAuthority !== "VIDEO_SAMPLE" || line.fidelity === "verbatim"))
      .map(line => String(line.text).trim()).filter(Boolean);
    return [...new Set(lines)].filter(line => !String(text || "").includes(line));
  }
  async function applyMap(root) {
    let map;
    try { map = JSON.parse(root.querySelector("#sw-map-json").value); } catch (_) { throw new Error("Episode map JSON is invalid."); }
    if (!map || !Array.isArray(map.episodes) || !map.episodes.length) throw new Error("Episode map contains no episodes.");
    if (map.episodes.some(e => !String(e.screenplay || "").trim())) throw new Error("Every mapped episode must include its screenplay excerpt before apply.");
    const rangeMin = Math.max(30, Number(root.querySelector("#sw-min").value) || 90);
    const rangeMax = Math.max(rangeMin, Number(root.querySelector("#sw-max").value) || 120);
    if (map.episodes.some(e => !Number.isFinite(Number(e.duration)) || Number(e.duration) < rangeMin || Number(e.duration) > rangeMax)) throw new Error(`Every episode duration must be within ${rangeMin}–${rangeMax} seconds before apply.`);
    const uncovered = ((state.analysis && state.analysis.events) || []).map(e => e && e.id).filter(Boolean).filter(id => !new Set(map.episodes.flatMap(e => (e.beats || []).flatMap(b => b.source_event_ids || []))).has(id));
    if (uncovered.length) throw new Error(`The editable episode map still omits source event(s): ${uncovered.join(", ")}.`);
    const missingDialogue = missingCanonicalDialogue(map.episodes.map(e => e.screenplay).join("\n"));
    if ((state.dialogueAuthority || (state.analysis && state.analysis.dialogue_authority)) === "COMPLETE_SCRIPT_OR_SHOTLIST" && missingDialogue.length) throw new Error(`The episode map must preserve all ${missingDialogue.length} missing dialogue line(s) verbatim.`);
    const sid = seriesId();
    if (!sid) throw new Error("Open a series/episode in Story Studio before applying the episode map.");
    if (!window.confirm(`Apply ${map.episodes.length} mapped episodes to this series? Existing episodes with script, shotlist, or outline content will be skipped.`)) return;
    setBusy(true);
    try {
      await STORY.saveNow();
      const min = Math.max(30, Number(root.querySelector("#sw-min").value) || 90);
      const max = Math.max(min, Number(root.querySelector("#sw-max").value) || 120);
      const bible = STORY.bible || (STORY.bible = STORY.newBible(sid, (CUR.series && CUR.series.name) || "Series"));
      bible.series = sid;
      bible.master_screenplay = state.screenplay;
      bible.sourceAnalysis = state.analysis;
      bible.sourceMeta = sourceDescriptor();
      bible.dialogueAuthority = state.dialogueAuthority || (state.analysis && state.analysis.dialogue_authority) || "VIDEO_SAMPLE";
      bible.season = map.episodes;
      bible.requestedEpisodeCount = map.episodes.length;
      bible.format = bible.format || {};
      bible.format.epMin = min; bible.format.epMax = max;
      STORY.dirty.bible = true;
      await STORY.saveNow();

      let episodes = (typeof PJ !== "undefined" && PJ && Array.isArray(PJ.episodes) ? PJ.episodes : []).filter(e => e.series === sid).sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
      if (episodes.length < map.episodes.length) {
        const added = await api("/api/projects", { op: "add_episodes", series: sid, count: map.episodes.length - episodes.length });
        if (added && added.error) throw new Error(added.error);
        if (typeof PJ !== "undefined" && added && Array.isArray(added.episodes)) PJ = added;
        episodes = (typeof PJ !== "undefined" && PJ && Array.isArray(PJ.episodes) ? PJ.episodes : []).filter(e => e.series === sid).sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
      }
      const desk = await api("/api/desk/all");
      if (desk && desk.error) throw new Error(desk.error);
      const coll = desk && desk.colls && desk.colls.story_ep || {};
      const ops = [], skipped = [];
      map.episodes.forEach((item, index) => {
        const projectEp = episodes[index];
        if (!projectEp) { skipped.push(`EP${String(index + 1).padStart(2, "0")}: no project episode`); return; }
        const existing = coll[projectEp.id];
        if (hasExistingWork(existing)) { skipped.push(`EP${String(index + 1).padStart(2, "0")}: existing work preserved`); return; }
        const doc = existing || STORY.newEpisodeDoc(projectEp.id, sid, projectEp.name || `Episode ${index + 1}`);
        doc.ep = projectEp.id; doc.series = sid; doc.title = item.title || projectEp.name || `Episode ${index + 1}`;
        doc.target = Number(item.duration) || Math.round((min + max) / 2);
        doc.sourceEventIds = (item.beats || []).flatMap(b => b.source_event_ids || []);
        doc.outline = { ...(doc.outline || {}), premise: item.skeleton || item.summary || "", hook: item.hook || "", beats: (item.beats || []).map((b, i) => ({ id: `src_${index + 1}_${i + 1}`, t: b.summary || b.text || "Beat", sec: 15, text: b.summary || b.text || "" })) };
        const parsed = STORY.script && typeof STORY.script.parseScreenplayText === "function" ? STORY.script.parseScreenplayText(item.screenplay) : [];
        doc.script = doc.script || { blocks: [], rev: 1, revs: [] };
        doc.script.blocks = parsed.length ? parsed : [{ id: STORY.uid("sb_"), k: "action", text: item.screenplay }];
        doc.script.rev = Math.max(1, Number(doc.script.rev) || 1);
        doc.sourceDialogueAuthority = bible.dialogueAuthority;
        doc.sourceScreenplay = item.screenplay;
        doc.sourceEventIds = (item.beats || []).flatMap(b => b.source_event_ids || []);
        doc.u = Date.now();
        ops.push({ coll: "story_ep", id: projectEp.id, doc });
      });
      for (let i = 0; i < ops.length; i += 25) {
        const saved = await api("/api/desk/batch", { ops: ops.slice(i, i + 25) });
        if (saved && saved.error) throw new Error(saved.error);
      }
      if (typeof STORY.loadDesk === "function") await STORY.loadDesk();
      if (typeof STORY.renderAll === "function") STORY.renderAll();
      const summary = `Applied ${ops.length} episode document(s). ${skipped.length ? `Skipped: ${skipped.join("; ")}` : "Existing work: none."}`;
      status(summary);
      if (typeof toast === "function") toast(summary, skipped.length > 0);
    } finally { setBusy(false); }
  }

  async function handleClick(event) {
    const action = event.target.closest("[data-sw]");
    if (!action || state.busy) return;
    const root = ensureModal();
    try {
      switch (action.dataset.sw) {
        case "close": closeModal(); break;
        case "analyze":
          setBusy(true); state.analysis = null; state.screenplay = ""; state.episodeMap = null; renderStages();
          try { if (root.querySelector("#sw-mode").value === "video") await analyzeVideo(root); else await analyzeText(root); }
          finally { setBusy(false); renderStages(); }
          break;
        case "write": setBusy(true); try { await writeMaster(root); } finally { setBusy(false); renderStages(); } break;
        case "map": setBusy(true); try { await createEpisodeMap(root); } finally { setBusy(false); renderStages(); } break;
        case "apply": await applyMap(root); break;
        case "download-analysis": download(root.querySelector("#sw-analysis").value, "SOURCE_ANALYSIS", "json"); break;
        case "download-screenplay": download(root.querySelector("#sw-screenplay").value, "MASTER_SCREENPLAY", "md"); break;
        case "download-map": download(root.querySelector("#sw-map-json").value, "EPISODE_MAP", "json"); break;
        case "autopilot": if (STORY.cmds && STORY.cmds["autopilot.openModal"]) STORY.cmds["autopilot.openModal"](); break;
      }
    } catch (error) {
      console.error("Source → Story workflow:", error);
      status(error.message || String(error));
      if (typeof toast === "function") toast(error.message || String(error), true);
    }
  }
  function handleChange(event) {
    const root = event.currentTarget;
    if (event.target.id === "sw-mode") {
      const video = event.target.value === "video";
      root.querySelector("#sw-text-input").hidden = video;
      root.querySelector("#sw-video-input").hidden = !video;
    }
    if (event.target.id === "sw-video-file") state.videoFile = event.target.files[0] || null;
  }
  function handleInput(event) {
    if (event.target.id === "sw-source-text") state.sourceText = event.target.value;
    if (event.target.id === "sw-screenplay") state.screenplay = event.target.value;
  }

  STORY.cmds["source.open"] = openModal;
  STORY.script = STORY.script || {};
  if (Array.isArray(STORY.hooks && STORY.hooks.afterLoad)) STORY.hooks.afterLoad.push(mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
})();
