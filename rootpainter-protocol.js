/* Speaks RootPainter's file-sync protocol exactly as confirmed in docs/PROTOCOL.md
 * (read from root_painter_trainer 0.3.0's own source, and verified by running the
 * real trainer against a throwaway sync dir). RootPainter's code is never vendored;
 * this only writes/reads the plain files its trainer already understands. */

// The real Python client names instructions "{name}_{hash(json.dumps(content))}" and
// the trainer recovers the instruction name via fname.rpartition('_')[0] — it only
// cares that stripping the LAST underscore-separated segment yields a valid name, not
// that the suffix is CPython's hash. So any collision-safe suffix works, as long as it
// contains no underscores itself.
function uniqueSuffix(){
  return Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36);
}

const INSTRUCTION_NAMES = ["start_training", "segment", "stop_training", "trainer_status"];

function projectPaths(projectName){
  const base = `projects/${projectName}`;
  return {
    base,
    segProj: `${base}/${projectName}.seg_proj`,
    trainAnnot: `${base}/annotations/train`,
    valAnnot: `${base}/annotations/val`,
    segDir: `${base}/segmentations`,
    modelDir: `${base}/models`,
    logDir: `${base}/logs`,
    messageDir: `${base}/messages`,
  };
}

async function createProject(fs, { name, datasetName, fileNames }){
  const p = projectPaths(name);
  for(const dir of [p.trainAnnot, p.valAnnot, p.segDir, p.modelDir, p.logDir, p.messageDir]){
    await fs.getDir(dir, true);
  }
  const segProj = {
    name,
    dataset: datasetName,
    original_model_file: null,
    location: p.base,
    file_names: fileNames,
  };
  await fs.writeJSON(p.segProj, segProj);
  return p;
}

// Writes one instruction JSON into instructions/ and returns its filename so the
// caller can poll executed_instructions/ or failed_instructions/ for it.
async function sendInstruction(fs, name, content){
  if(!INSTRUCTION_NAMES.includes(name)) throw new Error(`Not a valid RootPainter instruction: ${name}`);
  const fname = `${name}_${uniqueSuffix()}`;
  await fs.writeJSON(`instructions/${fname}`, content);
  return fname;
}

function startTrainingInstruction(fs, projectName, datasetName){
  const p = projectPaths(projectName);
  return sendInstruction(fs, "start_training", {
    model_dir: p.modelDir,
    dataset_dir: `datasets/${datasetName}`,
    train_annot_dir: p.trainAnnot,
    val_annot_dir: p.valAnnot,
    seg_dir: p.segDir,
    log_dir: p.logDir,
    message_dir: p.messageDir,
  });
}

function stopTrainingInstruction(fs, projectName){
  const p = projectPaths(projectName);
  return sendInstruction(fs, "stop_training", { message_dir: p.messageDir });
}

function segmentInstruction(fs, projectName, datasetName, fileNames){
  const p = projectPaths(projectName);
  return sendInstruction(fs, "segment", {
    dataset_dir: `datasets/${datasetName}`,
    seg_dir: p.segDir,
    file_names: fileNames,
    message_dir: p.messageDir,
    model_dir: p.modelDir,
  });
}

// trainer_status.json is written ONLY on demand (confirmed by reading trainer.py) —
// it does not update spontaneously, so "checking status" means: send the instruction,
// wait for it to land in executed_instructions/, then read the file it wrote.
function trainerStatusInstruction(fs){
  return sendInstruction(fs, "trainer_status", {});
}

// Polls executed_instructions/ and failed_instructions/ for a filename this client
// wrote. Real trainer retries up to 60x before giving up, so give it real time.
async function pollInstruction(fs, fname, { intervalMs = 500, timeoutMs = 60000 } = {}){
  const start = performance.now();
  while(performance.now() - start < timeoutMs){
    if(await fs.exists(`executed_instructions/${fname}`)) return { status: "executed" };
    if(await fs.exists(`failed_instructions/${fname}`)){
      const errText = await fs.readText(`failed_instructions/${fname}_exception.txt`).catch(() => null);
      return { status: "failed", error: errText };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: "timeout" };
}

window.RootPainterProtocol = {
  uniqueSuffix, projectPaths, createProject, sendInstruction,
  startTrainingInstruction, stopTrainingInstruction, segmentInstruction, trainerStatusInstruction,
  pollInstruction,
};
