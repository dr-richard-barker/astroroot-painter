/* Orchestration for astroroot-painter Phase 1: mount a real sync folder, paint
 * corrections, and speak RootPainter's protocol (docs/PROTOCOL.md). No ML runs here —
 * this talks to whatever real (or, for testing, stub — scripts/fake-syncdir/) trainer
 * is watching the mounted folder. */

const fs = new SyncFS();
const RP = window.RootPainterProtocol;
let painter = null;
let state = { dataset: null, project: null, fileNames: [], currentFile: null };

const $ = id => document.getElementById(id);

function log(msg, cls){
  const line = document.createElement("div");
  if(cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  $("log").prepend(line);
}

function stem(filename){ return filename.replace(/\.[^.]+$/, ""); }

function setMounted(mounted){
  $("mountStatus").textContent = mounted ? "mounted" : "not mounted";
  for(const id of ["importFilesBtn", "newProjectBtn", "datasetSelect", "projectSelect"]){
    $(id).disabled = !mounted;
  }
}

function setProjectControlsEnabled(enabled){
  for(const id of ["startTrainingBtn", "stopTrainingBtn", "segmentBtn", "statusBtn"]) $(id).disabled = !enabled;
}

async function refreshDatasetList(){
  const entries = (await fs.listDir("datasets")).filter(e => e.kind === "directory");
  const sel = $("datasetSelect");
  sel.innerHTML = entries.map(e => `<option value="${e.name}">${e.name}</option>`).join("") || "<option value=''>(none yet)</option>";
}

async function refreshProjectList(){
  const entries = (await fs.listDir("projects")).filter(e => e.kind === "directory");
  const sel = $("projectSelect");
  sel.innerHTML = entries.map(e => `<option value="${e.name}">${e.name}</option>`).join("") || "<option value=''>(none yet)</option>";
}

async function renderFileList(){
  const ul = $("fileList");
  ul.innerHTML = "";
  for(const name of state.fileNames){
    const li = document.createElement("li");
    li.textContent = name;
    if(name === state.currentFile) li.className = "current";
    li.onclick = () => loadImage(name);
    ul.appendChild(li);
  }
}

async function loadImage(filename){
  if(!state.dataset || !state.project) return;
  state.currentFile = filename;
  await renderFileList();
  const file = await fs.readFile(`datasets/${state.dataset}/${filename}`);
  await painter.loadPhoto(file);

  const segPath = `projects/${state.project}/segmentations/${stem(filename)}.png`;
  if(await fs.exists(segPath)) await painter.loadSegmentation(await fs.readFile(segPath));

  const trainPath = `projects/${state.project}/annotations/train/${stem(filename)}.png`;
  const valPath = `projects/${state.project}/annotations/val/${stem(filename)}.png`;
  if(await fs.exists(trainPath)){ await painter.loadAnnotation(await fs.readFile(trainPath)); $("splitSelect").value = "train"; }
  else if(await fs.exists(valPath)){ await painter.loadAnnotation(await fs.readFile(valPath)); $("splitSelect").value = "val"; }

  $("saveAnnotBtn").disabled = false;
  log(`Loaded ${filename}`);
}

$("mountBtn").onclick = async () => {
  try{
    await fs.mount();
    await fs.ensureFolders();
    setMounted(true);
    await refreshDatasetList();
    await refreshProjectList();
    log("Mounted sync folder and confirmed the 5 required subfolders.", "ok");
  } catch(err){
    log(`Mount failed: ${err.message}`, "err");
  }
};

$("importFilesBtn").onclick = () => $("importFilesInput").click();
$("importFilesInput").onchange = async e => {
  const files = [...e.target.files];
  if(!files.length) return;
  const name = prompt("Dataset name:", "demo");
  if(!name) return;
  for(const f of files) await fs.writeBytes(`datasets/${name}/${f.name}`, f);
  await refreshDatasetList();
  $("datasetSelect").value = name;
  log(`Imported ${files.length} image(s) into datasets/${name}/`, "ok");
};

$("newProjectBtn").onclick = async () => {
  const dataset = $("datasetSelect").value;
  if(!dataset){ log("Pick a dataset first.", "err"); return; }
  const name = prompt("Project name:", "demo-project");
  if(!name) return;
  const fileNames = (await fs.listDir(`datasets/${dataset}`)).filter(e => e.kind === "file").map(e => e.name);
  await RP.createProject(fs, { name, datasetName: dataset, fileNames });
  await refreshProjectList();
  $("projectSelect").value = name;
  $("projectSelect").onchange();
  log(`Created project "${name}" over dataset "${dataset}" (${fileNames.length} images).`, "ok");
};

$("datasetSelect").onchange = () => { state.dataset = $("datasetSelect").value || null; };

$("projectSelect").onchange = async () => {
  const name = $("projectSelect").value;
  if(!name){ setProjectControlsEnabled(false); return; }
  state.project = name;
  const segProj = await fs.readJSON(`projects/${name}/${name}.seg_proj`);
  state.dataset = segProj.dataset;
  state.fileNames = segProj.file_names || [];
  $("datasetSelect").value = state.dataset;
  setProjectControlsEnabled(true);
  await renderFileList();
  if(state.fileNames.length) await loadImage(state.fileNames[0]);
};

$("modeFg").onclick = () => setBrushMode("fg");
$("modeBg").onclick = () => setBrushMode("bg");
$("modeErase").onclick = () => setBrushMode("erase");
function setBrushMode(mode){
  painter.setMode(mode);
  for(const [id, m] of [["modeFg","fg"],["modeBg","bg"],["modeErase","erase"]]) $(id).classList.toggle("active", m === mode);
}

$("brushSize").onchange = () => painter.setBrushRadius(Number($("brushSize").value) || 12);
$("clearAnnotBtn").onclick = () => painter && painter.clearAnnotation();

$("saveAnnotBtn").onclick = async () => {
  if(!state.currentFile) return;
  const split = $("splitSelect").value;
  const blob = await painter.toAnnotationBlob();
  await fs.writeBytes(`projects/${state.project}/annotations/${split}/${stem(state.currentFile)}.png`, blob);
  log(`Saved annotation for ${state.currentFile} → ${split}/`, "ok");
};

$("startTrainingBtn").onclick = async () => {
  const fname = await RP.startTrainingInstruction(fs, state.project, state.dataset);
  log(`Sent start_training (${fname}), waiting for trainer…`);
  const result = await RP.pollInstruction(fs, fname);
  log(`start_training: ${result.status}` + (result.error ? ` — ${result.error}` : ""), result.status === "executed" ? "ok" : "err");
};

$("stopTrainingBtn").onclick = async () => {
  const fname = await RP.stopTrainingInstruction(fs, state.project);
  const result = await RP.pollInstruction(fs, fname);
  log(`stop_training: ${result.status}`, result.status === "executed" ? "ok" : "err");
};

$("segmentBtn").onclick = async () => {
  if(!state.currentFile) return;
  const fname = await RP.segmentInstruction(fs, state.project, state.dataset, [state.currentFile]);
  log(`Sent segment (${fname}) for ${state.currentFile}, waiting for trainer…`);
  const result = await RP.pollInstruction(fs, fname);
  log(`segment: ${result.status}` + (result.error ? ` — ${result.error}` : ""), result.status === "executed" ? "ok" : "err");
  if(result.status === "executed"){
    const segPath = `projects/${state.project}/segmentations/${stem(state.currentFile)}.png`;
    if(await fs.exists(segPath)) await painter.loadSegmentation(await fs.readFile(segPath));
  }
};

$("statusBtn").onclick = async () => {
  const fname = await RP.trainerStatusInstruction(fs);
  const result = await RP.pollInstruction(fs, fname, { timeoutMs: 15000 });
  if(result.status !== "executed"){ log(`trainer_status: ${result.status}`, "err"); return; }
  const status = await fs.readJSON("trainer_status.json");
  $("trainerStatus").textContent = `training: ${status.training}` + (status.project ? ` (${status.project})` : "") + ` — as of ${new Date(status.timestamp * 1000).toLocaleTimeString()}`;
  log("trainer_status refreshed", "ok");
};

painter = new AnnotationPainter($("canvasWrap"));
setMounted(false);
if(!fs.supported) log("This browser does not support the File System Access API — use Chrome or Edge 86+.", "err");
