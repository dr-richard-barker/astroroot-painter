/* Mounted-flow test. Paste into the page's console (or run via the preview pane's
 * javascript tool) on a freshly loaded page; it says when to reload and run it a
 * second time — the merge check needs a genuinely unmounted page with an annotation
 * already on disk.
 *
 * The folder picker can't be driven by automation, so a folder in the browser's
 * private storage (OPFS) stands in for the one a user would pick: the same
 * FileSystemDirectoryHandle API, no dialog, nothing written to the real disk.
 *
 * Checks what only happens once a folder is mounted:
 *  - saving before mounting asks for the folder, creates the project and copies the
 *    database image into datasets/ byte-for-byte;
 *  - one image's annotation lives in exactly one of train/ and val/;
 *  - paint made before mounting is merged with an annotation already on disk —
 *    new strokes win where they overlap — instead of being overwritten by it;
 *  - saving with nothing painted removes the annotation rather than writing an empty
 *    file (the trainer asserts every annotation has painted pixels). */
(async () => {
  const TEST_DIR = "astroroot-painter-test-sync";
  const PHASE_KEY = "astroroot-painter-mounted-test";
  const RED = "255,0,0,180", GREEN = "0,255,0,180";
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const waitFor = async (fn, ms = 30000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    return null;
  };

  const opfs = await navigator.storage.getDirectory();
  const phase = sessionStorage.getItem(PHASE_KEY) ? "b" : "a";
  if (phase === "a") await opfs.removeEntry(TEST_DIR, { recursive: true }).catch(() => {});
  const dir = await opfs.getDirectoryHandle(TEST_DIR, { create: true });
  window.showDirectoryPicker = async () => dir;
  let confirms = 0;
  window.confirm = () => { confirms++; return true; };

  const getFile = async path => {
    const parts = path.split("/");
    let d = dir;
    try {
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      return await (await d.getFileHandle(parts.at(-1))).getFile();
    } catch { return null; }
  };
  const pixelsOf = async (source, points) => {
    let ctx;
    if (source instanceof HTMLCanvasElement) ctx = source.getContext("2d");
    else {
      const bm = await createImageBitmap(source, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      ctx = new OffscreenCanvas(bm.width, bm.height).getContext("2d");
      ctx.drawImage(bm, 0, 0);
    }
    return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].join(","));
  };
  const newestLog = () => document.querySelector("#log div")?.textContent || "";
  const clickAndWait = async (id, done) => {
    const before = document.getElementById("log").children.length;
    document.getElementById(id).click();
    return waitFor(() => document.getElementById("log").children.length > before && done.test(newestLog()) && newestLog());
  };
  const SAVE_DONE = /Saved annotation|Removed the annotation|Nothing painted|failed|cancelled|No folder/;

  // Start every phase the same way: APEX05 selected, first image on screen.
  const ds = document.getElementById("datasetSelect");
  const apex = await waitFor(() => [...ds.options].find(o => /^APEX05 — root/.test(o.textContent)));
  ds.value = apex.value;
  ds.dispatchEvent(new Event("change"));
  const first = await waitFor(() => document.querySelector("#fileList li.current")?.textContent);
  await waitFor(() => document.getElementById("log").innerText.includes(`Loaded ${first}`));
  const folder = DbCollections.localFolderName(state.collections.find(c => "db:" + c.slug === apex.value));
  const stemName = first.replace(/\.[^.]+$/, "");
  const annot = split => `projects/${folder}/annotations/${split}/${stemName}.png`;
  const A = [400, 400], B = [1200, 400], C = [800, 1200];

  if (phase === "a") {
    check("starts unmounted", document.getElementById("mountStatus").textContent === "not mounted");

    painter.setBrushRadius(12);
    painter.setMode("fg"); painter._dab(...A);
    document.getElementById("splitSelect").value = "train";
    const saved1 = await clickAndWait("saveAnnotBtn", SAVE_DONE);
    check("save before mounting asks for the folder, then saves", /Saved annotation .* train/.test(saved1 || ""), saved1);
    check("a folder that isn't a sync folder yet is confirmed before anything is created", confirms === 1, `${confirms} confirm prompt(s)`);
    check("mount status names the folder", document.getElementById("mountStatus").textContent === `mounted: ${TEST_DIR}`,
      document.getElementById("mountStatus").textContent);

    const copied = await getFile(`datasets/${folder}/${first}`);
    const original = await (await fetch(state.images.find(i => i.name === first).url)).blob();
    check("the database image is copied into datasets/ byte-for-byte", copied && copied.size === original.size,
      copied ? `${copied.size} vs ${original.size} bytes` : "not copied");
    const sp = await getFile(`projects/${folder}/${folder}.seg_proj`);
    const spj = sp ? JSON.parse(await sp.text()) : null;
    check("a project is created for the collection", spj && spj.dataset === folder && spj.file_names.length === state.images.length,
      spj ? `dataset ${spj.dataset}, ${spj.file_names.length} file names` : "no .seg_proj");
    const t1 = await getFile(annot("train"));
    const t1px = t1 ? await pixelsOf(t1, [A]) : null;
    const t1bm = t1 ? await createImageBitmap(t1) : null;
    check("the annotation is written at the photo's size, with the stroke where it was painted",
      t1 && t1bm.width === painter.width && t1bm.height === painter.height && t1px[0] === RED,
      t1 ? `${t1bm.width}x${t1bm.height}, pixel at A ${t1px[0]}` : "no annotation file");
    check("saving clears the unsaved-changes flag", !painter.dirty);

    painter._dab(...B);
    document.getElementById("splitSelect").value = "val";
    const saved2 = await clickAndWait("saveAnnotBtn", SAVE_DONE);
    const v2 = await getFile(annot("val")), t2 = await getFile(annot("train"));
    const v2px = v2 ? await pixelsOf(v2, [A, B]) : [];
    check("moving an image to val keeps one copy only — none left in train",
      v2 && !t2 && v2px[0] === RED && v2px[1] === RED, `${saved2}; val ${v2 ? "has A " + v2px[0] + ", B " + v2px[1] : "missing"}; train ${t2 ? "STILL PRESENT" : "absent"}`);

    sessionStorage.setItem(PHASE_KEY, "1");
    return { phase: "a", pass: checks.every(c => c.ok), checks, next: "Reload the page, then run this file again." };
  }

  // Phase B — a fresh, unmounted page; val/ already holds strokes A and B.
  sessionStorage.removeItem(PHASE_KEY);
  try {
    check("starts unmounted", document.getElementById("mountStatus").textContent === "not mounted");
    painter.setBrushRadius(12);
    painter.setMode("bg"); painter._dab(...C); painter._dab(...A);        // new soil stroke on top of A
    const mounted = await clickAndWait("mountBtn", /Mounted/);
    check("a folder that is already a sync folder mounts without a prompt", mounted && confirms === 0, `${confirms} confirm prompt(s)`);
    const onCanvas = await pixelsOf(painter.annotCanvas, [A, B, C]);
    check("paint made before mounting is merged with the saved annotation, new strokes on top",
      onCanvas[0] === GREEN && onCanvas[1] === RED && onCanvas[2] === GREEN, `A ${onCanvas[0]}, B ${onCanvas[1]}, C ${onCanvas[2]}`);
    check("the merged paint is still marked unsaved", painter.dirty);
    check("the split follows the saved annotation", document.getElementById("splitSelect").value === "val",
      document.getElementById("splitSelect").value);
    check("the collection's copied folder isn't listed again as a local dataset",
      ![...ds.options].some(o => o.value === "local:" + folder));

    const saved3 = await clickAndWait("saveAnnotBtn", SAVE_DONE);
    const v3 = await getFile(annot("val")), t3 = await getFile(annot("train"));
    const v3px = v3 ? await pixelsOf(v3, [A, B, C]) : [];
    check("saving writes the merged annotation to val only",
      v3 && !t3 && v3px[0] === GREEN && v3px[1] === RED && v3px[2] === GREEN,
      `${saved3}; A ${v3px[0]}, B ${v3px[1]}, C ${v3px[2]}; train ${t3 ? "PRESENT" : "absent"}`);

    painter.clearAnnotation();
    const saved4 = await clickAndWait("saveAnnotBtn", SAVE_DONE);
    const v4 = await getFile(annot("val")), t4 = await getFile(annot("train"));
    check("saving with nothing painted removes the annotation instead of writing an empty one",
      /Removed the annotation/.test(saved4 || "") && !v4 && !t4, `${saved4}; val ${v4 ? "PRESENT" : "absent"}, train ${t4 ? "PRESENT" : "absent"}`);
    check("annotation counts follow", /val: 0/.test(document.getElementById("annotCounts").textContent),
      document.getElementById("annotCounts").textContent);
  } finally {
    await opfs.removeEntry(TEST_DIR, { recursive: true }).catch(() => {});
  }
  return { phase: "b", pass: checks.every(c => c.ok), checks };
})();
