/* Orchestration for astroroot-painter: browse a dataset, paint corrections, and
 * speak RootPainter's file protocol (docs/PROTOCOL.md) to whatever trainer is
 * watching the mounted sync folder (the real one, or scripts/fake-syncdir/).
 *
 * Browsing and painting need nothing mounted: the dataset dropdown lists the
 * calibration database's collections (db-collections.js) and their images are
 * drawn straight from their URLs. The sync folder is only asked for when
 * something has to reach the trainer — saving an annotation, training,
 * segmenting — and a database image is copied into datasets/ at that point. */

const fs = new SyncFS();
const RP = window.RootPainterProtocol;
const DB = window.DbCollections;
let painter = null;
let state = {
  collections: [],   // every database collection in the dropdown
  collection: null,  // the selected database collection, or null for a local dataset
  dataset: null,     // folder under datasets/; for a collection, DB.localFolderName(collection)
  project: null,
  images: [],        // [{ name, url? }] — url for database images, absent for local files
  currentFile: null,
  selected: "",      // dropdown value of the dataset being shown, to restore on cancel
};

const $ = id => document.getElementById(id);

function el(tag, props = {}, text){
  const e = Object.assign(document.createElement(tag), props);
  if(text != null) e.textContent = text;
  return e;
}

function log(msg, cls){
  const t = new Date().toLocaleTimeString();
  $("log").prepend(el("div", { className: cls || "" }, `[${t}] ${msg}`));
}

function stem(filename){ return filename.replace(/\.[^.]+$/, ""); }
function safeName(s){ return s.trim().replace(/[^A-Za-z0-9._-]+/g, "_"); }

// Drawing another image wipes the annotation layer, so ask before discarding paint
// that hasn't been saved. On OK the paint is treated as discarded.
function okToDiscard(){
  if(!painter.dirty) return true;
  if(!confirm(`You have unsaved paint on ${state.currentFile}. Discard it?`)) return false;
  painter.markClean();
  return true;
}

function setImagesNote(text, isError){
  $("imagesNote").textContent = text;
  $("imagesNote").className = isError ? "hint err" : "hint";
}

function updateControls(){
  const mounted = !!fs.root;
  $("mountStatus").textContent = mounted ? `mounted: ${fs.root.name}` : "not mounted";
  $("projectSelect").disabled = !mounted;
  $("importFilesBtn").disabled = !mounted;
  $("importFilesBtn").title = mounted ? "Copy images from this computer into the sync folder as a new dataset" : "Mount the sync folder first";
  $("newProjectBtn").disabled = !state.dataset;
  $("saveAnnotBtn").disabled = !state.currentFile;
  $("segmentBtn").disabled = !state.currentFile;
  $("stopTrainingBtn").disabled = !state.project;
  $("statusBtn").disabled = false;
}

// ---------- dataset dropdown ----------

async function localDatasetFolders(){
  if(!fs.root) return [];
  // A collection's copied images live in datasets/db-…; that folder is the
  // collection's own entry, so it isn't listed a second time here.
  const collectionFolders = new Set(state.collections.map(DB.localFolderName));
  return (await fs.listDir("datasets"))
    .filter(e => e.kind === "directory" && !collectionFolders.has(e.name))
    .map(e => e.name);
}

async function renderDatasetOptions(){
  const sel = $("datasetSelect");
  const current = sel.value;
  // Explicitly selected, or the browser would silently show the first collection
  // as chosen without a change event ever firing.
  sel.replaceChildren(el("option", { value: "", disabled: true, selected: true, defaultSelected: true }, "Choose a dataset…"));
  const group = (label, items) => {
    if(!items.length) return;
    const g = el("optgroup", { label });
    for(const [value, text, title] of items) g.appendChild(el("option", { value, title: title || "" }, text));
    sel.appendChild(g);
  };
  const tip = c => [c.organism, c.description].filter(Boolean).join(" — ");
  group("Calibration database", state.collections.filter(c => !c.saved).map(c => ["db:" + c.slug, c.name, tip(c)]));
  group("Saved in your database", state.collections.filter(c => c.saved).map(c => ["db:" + c.slug, c.name, c.slug]));
  group("Local sync folder", (await localDatasetFolders()).map(f => ["local:" + f, f]));
  if(current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

async function selectDataset(value, { project } = {}){
  if(!okToDiscard()){ $("datasetSelect").value = state.selected; return; }
  state.selected = value;
  state.currentFile = null;
  state.project = null;
  state.images = [];
  renderFileList();
  setImagesNote("");

  if(value.startsWith("db:")){
    const c = state.collections.find(c => "db:" + c.slug === value);
    if(!c) return;
    state.collection = c;
    state.dataset = DB.localFolderName(c);
    setImagesNote("Listing images…");
    let r;
    try{ r = await DB.listImages(c); }
    catch(err){
      if(state.collection === c) setImagesNote(`Couldn't list this collection: ${err.message}`, true);
      return;
    }
    if(state.collection !== c) return;               // another dataset was picked meanwhile
    state.images = r.images;
    const notes = [`${r.images.length} image${r.images.length === 1 ? "" : "s"} from ${c.type === "github" ? "GitHub" : "Epicollect5"}`];
    if(r.skippedTiff) notes.push(`${r.skippedTiff} TIFF not shown (browsers can't open TIFF yet)`);
    if(r.skippedVideo) notes.push(`${r.skippedVideo} video${r.skippedVideo === 1 ? "" : "s"} not shown`);
    if(r.truncated) notes.push("only the first page of entries was read");
    if(!r.images.length && c.type === "ec5") notes.push("this Epicollect5 project has no photos");
    setImagesNote(notes.join(" · "));
  } else if(value.startsWith("local:")){
    state.collection = null;
    state.dataset = value.slice("local:".length);
    const files = (await fs.listDir(`datasets/${state.dataset}`)).filter(e => e.kind === "file");
    state.images = files.filter(f => DB.DECODABLE.test(f.name)).map(f => ({ name: f.name }));
    const tiffs = files.filter(f => DB.TIFF.test(f.name)).length;
    setImagesNote(`${state.images.length} image(s) in datasets/${state.dataset}/` +
      (tiffs ? ` · ${tiffs} TIFF not shown (browsers can't open TIFF yet)` : ""));
  } else {
    return;
  }

  renderFileList();
  if(fs.root) await pickProject(project);
  await refreshAnnotationCounts();
  updateControls();
  if(state.images.length) await loadImage(state.images[0].name);
}

// ---------- projects ----------

async function listProjects(){
  if(!fs.root) return [];
  const out = [];
  for(const e of await fs.listDir("projects")){
    if(e.kind !== "directory") continue;
    try{
      const sp = await fs.readJSON(`projects/${e.name}/${e.name}.seg_proj`);
      out.push({ name: e.name, dataset: sp.dataset });
    } catch { /* not a RootPainter project folder */ }
  }
  return out;
}

async function renderProjectOptions(projects){
  projects = projects || await listProjects();
  const sel = $("projectSelect");
  sel.replaceChildren(el("option", { value: "", selected: !state.project }, projects.length ? "No project selected" : "(none yet)"));
  for(const p of projects) sel.appendChild(el("option", { value: p.name, selected: p.name === state.project }, p.name));
}

// The requested project, else the first existing one over this dataset, else none
// (saving the first annotation then creates one).
async function pickProject(requested){
  const projects = await listProjects();
  const mine = projects.filter(p => p.dataset === state.dataset);
  const chosen = mine.find(p => p.name === requested) || mine[0];
  state.project = chosen ? chosen.name : null;
  await renderProjectOptions(projects);
}

async function ensureProject(){
  if(state.project) return true;
  if(!state.dataset) return false;
  let name = safeName(state.dataset);
  const clash = (await listProjects()).find(p => p.name === name);
  if(clash && clash.dataset !== state.dataset) name = `${name}-painter`;
  if(!clash || clash.dataset !== state.dataset){
    await RP.createProject(fs, { name, datasetName: state.dataset, fileNames: state.images.map(i => i.name) });
    log(`Created project "${name}" for this dataset.`, "ok");
  }
  state.project = name;
  await renderProjectOptions();
  updateControls();
  return true;
}

// Must be the FIRST await in any click handler that calls it: the folder picker
// needs that click's user activation.
async function ensureMounted(){
  if(fs.root) return true;
  if(!fs.supported){
    log("Saving and training need folder access, which this browser doesn't have — use Chrome or Edge.", "err");
    return false;
  }
  try{ await fs.mount(); }
  catch(err){
    log(err.name === "AbortError" ? "No folder chosen." : `Mount failed: ${err.message}`, "err");
    return false;
  }
  if(!(await fs.looksLikeSyncFolder()) && !confirm(
      `"${fs.root.name}" doesn't look like a RootPainter sync folder yet — it has no projects/ or instructions/ folder inside.\n\n` +
      `OK: set it up as one.\nCancel: nothing is written. Click again and choose the folder you gave start-trainer --syncdir.`)){
    fs.forget();
    log("Mount cancelled — nothing was written.", "err");
    updateControls();
    return false;
  }
  await fs.ensureFolders();
  log(`Mounted "${fs.root.name}".`, "ok");
  await renderDatasetOptions();
  if(state.dataset) await pickProject();
  else await renderProjectOptions();
  await refreshAnnotationCounts();
  updateControls();
  if(state.currentFile && state.project) await loadOverlays(state.currentFile);
  return true;
}

// A database image exists only as a URL until the trainer needs it on disk.
async function materialize(dataset, img){
  if(!img || !img.url) return;
  const path = `datasets/${dataset}/${img.name}`;
  if(!(await fs.exists(path))) await fs.writeBytes(path, await DB.fetchImageBlob(img.url));
}

// ---------- images ----------

function renderFileList(){
  $("fileList").replaceChildren(...state.images.map(img => {
    const li = el("li", { className: img.name === state.currentFile ? "current" : "" }, img.name);
    li.onclick = () => loadImage(img.name);
    return li;
  }));
}

async function loadImage(name){
  const img = state.images.find(i => i.name === name);
  if(!img || name === state.currentFile) return;      // already showing it; reloading would wipe unsaved paint
  if(!okToDiscard()) return;
  state.currentFile = name;
  renderFileList();
  updateControls();
  try{
    const blob = img.url ? await DB.fetchImageBlob(img.url) : await fs.readFile(`datasets/${state.dataset}/${name}`);
    if(state.currentFile !== name) return;            // another image was clicked meanwhile
    await painter.loadPhoto(blob);
  } catch(err){
    log(`Couldn't open ${name}: ${err.message}`, "err");
    if(state.currentFile === name){ state.currentFile = null; renderFileList(); updateControls(); }   // so a click can retry
    return;
  }
  if(fs.root && state.project) await loadOverlays(name);
  log(`Loaded ${name}`);
}

const annotPath = (split, name) => `projects/${state.project}/annotations/${split}/${stem(name)}.png`;

// Which split already holds this image's annotation, if any.
async function savedSplit(name){
  for(const split of ["train", "val"]) if(await fs.exists(annotPath(split, name))) return split;
  return null;
}

async function loadOverlays(name){
  const segPath = `projects/${state.project}/segmentations/${stem(name)}.png`;
  if(await fs.exists(segPath)){
    const seg = await fs.readFile(segPath);
    if(state.currentFile !== name) return;
    await painter.loadSegmentation(seg);
  }
  const split = await savedSplit(name);
  if(!split) return;
  const file = await fs.readFile(annotPath(split, name));
  if(state.currentFile !== name) return;               // another image was opened meanwhile
  $("splitSelect").value = split;
  // Paint made before the folder was mounted is kept on top of what was saved,
  // not replaced by it.
  if(painter.dirty) await painter.mergeAnnotationUnder(file);
  else await painter.loadAnnotation(file);
}

// The real trainer silently never progresses past the initial random-weights
// checkpoint when val_annot_dir has zero annotated images — no error, no log line,
// nothing (confirmed by reading trainer.py and reproducing it; docs/PROTOCOL.md).
// Start training must not be enabled until there's at least one annotation on each
// side, and the reason must be visible, not just a disabled button.
async function refreshAnnotationCounts(){
  const out = $("annotCounts");
  if(!state.project){
    $("startTrainingBtn").disabled = true;
    out.textContent = state.dataset ? "No project yet — saving your first annotation creates one." : "Choose a dataset to start.";
    return { train: 0, val: 0 };
  }
  const count = async split => {
    try{ return (await fs.listDir(`projects/${state.project}/annotations/${split}`)).filter(e => e.kind === "file").length; }
    catch { return 0; }
  };
  const train = await count("train"), val = await count("val");
  const missing = [train ? null : "1 train", val ? null : "1 val"].filter(Boolean);
  out.textContent = `Project ${state.project} — train: ${train} annotated · val: ${val} annotated`;
  if(missing.length) out.textContent += ` — add at least ${missing.join(" and ")} annotation, or training will silently never progress`;
  $("startTrainingBtn").disabled = missing.length > 0;
  return { train, val };
}

// ---------- event wiring ----------

$("mountBtn").onclick = () => ensureMounted();

$("datasetSelect").onchange = () => selectDataset($("datasetSelect").value);

$("projectSelect").onchange = async () => {
  const name = $("projectSelect").value;
  if(!name) return;
  if(!okToDiscard()){ $("projectSelect").value = state.project || ""; return; }
  let sp;
  try{ sp = await fs.readJSON(`projects/${name}/${name}.seg_proj`); }
  catch(err){ log(`Couldn't read project ${name}: ${err.message}`, "err"); return; }
  const c = state.collections.find(c => DB.localFolderName(c) === sp.dataset);
  const value = c ? "db:" + c.slug : "local:" + sp.dataset;
  await renderDatasetOptions();
  $("datasetSelect").value = value;
  await selectDataset(value, { project: name });
};

$("newProjectBtn").onclick = async () => {
  if(!state.dataset){ log("Pick a dataset first.", "err"); return; }
  if(!(await ensureMounted())) return;
  const raw = prompt("Project name:", `${state.dataset}-2`);
  if(!raw) return;
  const name = safeName(raw);
  if((await listProjects()).some(p => p.name === name)){ log(`A project called "${name}" already exists.`, "err"); return; }
  await RP.createProject(fs, { name, datasetName: state.dataset, fileNames: state.images.map(i => i.name) });
  state.project = name;
  await renderProjectOptions();
  await refreshAnnotationCounts();
  updateControls();
  log(`Created project "${name}" over "${state.dataset}".`, "ok");
};

$("importFilesBtn").onclick = () => $("importFilesInput").click();   // enabled only once mounted
$("importFilesInput").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if(!files.length) return;
  const raw = prompt("Name for this dataset:", "my-images");
  if(!raw) return;
  const name = safeName(raw);
  for(const f of files) await fs.writeBytes(`datasets/${name}/${f.name}`, f);
  await renderDatasetOptions();
  $("datasetSelect").value = "local:" + name;
  await selectDataset("local:" + name);
  log(`Imported ${files.length} image(s) into datasets/${name}/`, "ok");
};

$("modeFg").onclick = () => setBrushMode("fg");
$("modeBg").onclick = () => setBrushMode("bg");
$("modeErase").onclick = () => setBrushMode("erase");
function setBrushMode(mode){
  painter.setMode(mode);
  for(const [id, m] of [["modeFg", "fg"], ["modeBg", "bg"], ["modeErase", "erase"]]) $(id).classList.toggle("active", m === mode);
}

$("brushSize").onchange = () => painter.setBrushRadius(Number($("brushSize").value) || 12);
$("clearAnnotBtn").onclick = () => painter && painter.clearAnnotation();

$("saveAnnotBtn").onclick = async () => {
  if(!state.currentFile) return;
  const name = state.currentFile, dataset = state.dataset;
  const img = state.images.find(i => i.name === name);
  // ensureMounted must be the first await (the folder picker needs this click).
  // Mounting can also merge an annotation already on disk into the canvas, so the
  // split and the canvas are read only after it.
  if(!(await ensureMounted())) return;
  if(!(await ensureProject())) return;
  if(state.currentFile !== name){ log(`Save cancelled — ${name} is no longer the open image.`, "err"); return; }
  const split = $("splitSelect").value, other = split === "train" ? "val" : "train";
  const version = painter.version;
  try{
    if(!painter.hasAnyAnnotation()){
      // The trainer asserts every annotation has painted pixels, so an empty file
      // would break training — saving nothing removes the annotation instead.
      const had = await savedSplit(name);
      await fs.removeFile(annotPath("train", name));
      await fs.removeFile(annotPath("val", name));
      log(had ? `Removed the annotation for ${name} — nothing is painted on it.` : "Nothing painted — nothing to save.", had ? "ok" : "");
    } else {
      const annotation = painter.toAnnotationBlob();     // the canvas is snapshotted synchronously, here
      await materialize(dataset, img);
      await fs.writeBytes(annotPath(split, name), await annotation);
      await fs.removeFile(annotPath(other, name));       // one image, one split — never both
      log(`Saved annotation for ${name} → ${split}/`, "ok");
    }
  } catch(err){
    log(`Save failed: ${err.message}`, "err");
    return;
  }
  if(state.currentFile === name && painter.version === version) painter.markClean();   // strokes made while saving stay unsaved
  await refreshAnnotationCounts();
};

$("startTrainingBtn").onclick = async () => {
  if(!(await ensureMounted()) || !state.project) return;
  const fname = await RP.startTrainingInstruction(fs, state.project, state.dataset);
  log(`Sent start_training (${fname}), waiting for trainer…`);
  const result = await RP.pollInstruction(fs, fname);
  log(`start_training: ${result.status}` + (result.error ? ` — ${result.error}` : ""), result.status === "executed" ? "ok" : "err");
};

$("stopTrainingBtn").onclick = async () => {
  if(!(await ensureMounted()) || !state.project) return;
  const fname = await RP.stopTrainingInstruction(fs, state.project);
  const result = await RP.pollInstruction(fs, fname);
  log(`stop_training: ${result.status}`, result.status === "executed" ? "ok" : "err");
};

$("segmentBtn").onclick = async () => {
  if(!state.currentFile) return;
  const name = state.currentFile, dataset = state.dataset;
  const img = state.images.find(i => i.name === name);
  if(!(await ensureMounted())) return;
  if(!(await ensureProject())) return;
  try{ await materialize(dataset, img); }
  catch(err){ log(`Couldn't copy ${name} into the sync folder: ${err.message}`, "err"); return; }
  const fname = await RP.segmentInstruction(fs, state.project, dataset, [name]);
  log(`Sent segment (${fname}) for ${name}, waiting for trainer…`);
  const result = await RP.pollInstruction(fs, fname);
  log(`segment: ${result.status}` + (result.error ? ` — ${result.error}` : ""), result.status === "executed" ? "ok" : "err");
  if(result.status === "executed" && state.currentFile === name){
    const segPath = `projects/${state.project}/segmentations/${stem(name)}.png`;
    if(await fs.exists(segPath)) await painter.loadSegmentation(await fs.readFile(segPath));
  }
};

$("statusBtn").onclick = async () => {
  if(!(await ensureMounted())) return;
  const fname = await RP.trainerStatusInstruction(fs);
  const result = await RP.pollInstruction(fs, fname, { timeoutMs: 15000 });
  if(result.status !== "executed"){ log(`trainer_status: ${result.status}`, "err"); return; }
  const status = await fs.readJSON("trainer_status.json");
  $("trainerStatus").textContent = `training: ${status.training}` + (status.project ? ` (${status.project})` : "") +
    ` — as of ${new Date(status.timestamp * 1000).toLocaleTimeString()}`;
  log("trainer_status refreshed", "ok");
};

// ---------- start ----------

async function init(){
  painter = new AnnotationPainter($("canvasWrap"));
  if(!fs.supported){
    $("browserNote").textContent = "This browser can browse and paint, but saving annotations and training need folder access — use Chrome or Edge.";
  }
  const r = await DB.loadCollections();
  state.collections = [...r.builtin, ...r.saved];
  if(r.error) log(`Couldn't load the calibration database's collection list: ${r.error}`, "err");
  if(r.skipped.length){
    log(`${r.skipped.length} saved database source(s) aren't image folders this tool can read yet (uploads, cloud or video): ${r.skipped.join(", ")}`);
  }
  await renderDatasetOptions();
  await refreshAnnotationCounts();
  updateControls();

  // Opened from the calibration database (its tools.ts, launch: 'dataset'):
  // ?collection=<slug> preselects the collection the user was looking at there.
  const wanted = new URLSearchParams(location.search).get("collection");
  if(wanted){
    const value = "db:" + wanted;
    if([...$("datasetSelect").options].some(o => o.value === value)){
      $("datasetSelect").value = value;
      await selectDataset(value);
    } else {
      log(`The database's current collection (${wanted}) isn't an image folder this tool can read — pick one from the list.`);
    }
  }
}

init();
