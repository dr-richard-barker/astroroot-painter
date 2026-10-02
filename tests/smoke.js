/* Browser smoke test — paste into the page's console (or run via the preview
 * pane's javascript tool). Returns {pass, checks}. Needs no mounted folder:
 * everything it checks must work before the File System Access picker is ever
 * opened, because that picker cannot be driven by automation.
 *
 * Reproduces the 2026-09-27 report "I can't see any projects or datasets": on
 * load the dataset dropdown had zero options and was disabled until a local
 * folder was mounted. */
(async () => {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const waitFor = async (fn, ms = 20000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    return null;
  };

  const ds = document.getElementById("datasetSelect");
  const dbOptions = await waitFor(() => { const o = [...ds.options].filter(o => o.value.startsWith("db:")); return o.length ? o : null; });
  check("dataset dropdown enabled before any mount", !ds.disabled);
  check("dataset dropdown lists calibration-database collections on load", dbOptions, dbOptions ? `${dbOptions.length} collections` : "none");

  const apex = dbOptions && dbOptions.find(o => /APEX05/.test(o.textContent));
  check("APEX05 collection is listed", apex, apex && apex.textContent);
  if (!apex) return { pass: false, checks };

  ds.value = apex.value;
  ds.dispatchEvent(new Event("change"));
  const items = await waitFor(() => { const li = document.querySelectorAll("#fileList li"); return li.length ? li : null; });
  check("selecting APEX05 lists its 120 images", items && items.length === 120, items ? `${items.length} listed` : "none listed");
  if (!items) return { pass: false, checks };

  // Click the SECOND image: the first is auto-loaded on selection, so clicking it
  // wouldn't prove clicking works. Wait for the app's own "Loaded" log line — a
  // blank canvas is already 300x150, so "width > 0" would pass before any image
  // arrived (the first version of this check did exactly that).
  const target = items[1].textContent;
  items[1].click();
  const loaded = await waitFor(() => document.getElementById("log").innerText.includes(`Loaded ${target}`));
  const canvas = document.querySelector("#canvasWrap canvas");
  // Expected size comes from decoding the same file independently, not a literal.
  const raw = `https://raw.githubusercontent.com/dr-richard-barker/image-analysis-software-and-R-codes/master/APEX05/images/${encodeURIComponent(target)}`;
  const truth = await createImageBitmap(await (await fetch(raw)).blob());
  check(`clicking ${target} draws it at its natural size (${truth.width}x${truth.height}) without mounting`,
    loaded && canvas.width === truth.width && canvas.height === truth.height,
    `${loaded ? "loaded" : "never loaded"}, canvas ${canvas.width}x${canvas.height}`);

  // A correctly sized bitmap can still be displayed at 0x0 — every canvas layer
  // was position:absolute, so the wrapper collapsed and nothing showed on screen.
  const shown = [...document.querySelectorAll("#canvasWrap canvas")].map(c => c.getBoundingClientRect());
  const panel = document.getElementById("canvasWrap").parentElement.getBoundingClientRect();
  check("the image is actually visible on screen, all three layers aligned",
    shown.every(b => b.width > 200 && b.height > 200 && b.width <= panel.width &&
                     Math.abs(b.left - shown[0].left) < 1 && Math.abs(b.top - shown[0].top) < 1 &&
                     Math.abs(b.width - shown[0].width) < 1 && Math.abs(b.height - shown[0].height) < 1),
    shown.map(b => `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.left)},${Math.round(b.top)}`).join(" "));

  // Pointer → pixel mapping. paint.js reads only clientX/Y, so a dispatched pointer
  // event exercises the same path as a mouse click (a real click was also checked by
  // hand on 2026-09-27: 0.73 px off). Off-centre, so a mapping that's only right in
  // the middle of the image can't pass.
  painter.clearAnnotation();
  const pr = painter.annotCanvas.getBoundingClientRect();
  const px = pr.left + pr.width * 0.37, py = pr.top + pr.height * 0.61;
  painter.annotCanvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: px, clientY: py, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const want = { x: (px - pr.left) * painter.width / pr.width, y: (py - pr.top) * painter.height / pr.height };
  const pix = painter.annotCanvas.getContext("2d").getImageData(0, 0, painter.width, painter.height).data;
  let pn = 0, psx = 0, psy = 0;
  for (let i = 0; i < pix.length; i += 4) if (pix[i] > 0) { const p = i / 4; pn++; psx += p % painter.width; psy += Math.floor(p / painter.width); }
  const pOff = pn ? Math.hypot(psx / pn - want.x, psy / pn - want.y) : Infinity;
  check("paint lands on the pixel under the pointer (within 1 px)", pOff <= 1, `${pn} px painted, centre ${pOff.toFixed(2)} px from target`);

  // Brush semantics must match RootPainter's desktop client (graphics_scene.py paints
  // with CompositionMode_Source and no antialiasing): a stroke REPLACES the pixels
  // under it, so every pixel is exactly foreground, background or unpainted. The
  // trainer reads R>0 as root and G>0 as soil — a blended pixel would be both.
  const ALLOWED = new Set(["255,0,0,180", "0,255,0,180", "0,0,0,0"]);
  const scan = () => {
    const d = painter.annotCanvas.getContext("2d").getImageData(0, 0, painter.width, painter.height).data;
    const out = { both: 0, painted: 0, states: new Set() };
    for (let i = 0; i < d.length; i += 4) {
      out.states.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      if (d[i] > 0 && d[i + 1] > 0) out.both++;
      if (d[i + 3] > 0) out.painted++;
    }
    return out;
  };
  painter.clearAnnotation();
  painter.setBrushRadius(12);
  const bx = Math.round(painter.width / 2), by = Math.round(painter.height / 2);
  painter.setMode("fg"); painter._dab(bx, by);
  painter.setMode("bg"); painter._dab(bx + 6, by);          // overlaps half the root stroke
  const s1 = scan();
  const odd = [...s1.states].filter(s => !ALLOWED.has(s));
  check("painting soil over root replaces it — every pixel is exactly root, soil or unpainted",
    s1.both === 0 && odd.length === 0, `${s1.both} px both root and soil; ${odd.length} other pixel values${odd.length ? " e.g. " + odd.slice(0, 3).join(" | ") : ""}`);
  painter.setMode("erase"); painter._dab(bx, by); painter._dab(bx + 6, by);
  const s2 = scan();
  check("erasing over the same strokes leaves nothing behind", s2.painted === 0, `${s2.painted} px left`);
  painter.setMode("fg");

  painter.clearAnnotation();
  painter.markClean();                                   // test paint — don't trigger the discard prompt below

  // Tall images (TICTOC pouches are ~1:3) overflow the panel. Flexbox centering
  // pushed their top above the scroll origin — 224 px of the root's start could
  // never be scrolled to. The whole image must be reachable.
  const tictoc = [...ds.options].find(o => /^TICTOC/.test(o.textContent));
  ds.value = tictoc.value;
  ds.dispatchEvent(new Event("change"));
  const tallName = await waitFor(() => document.querySelector("#fileList li.current")?.textContent);
  await waitFor(() => document.getElementById("log").innerText.includes(`Loaded ${tallName}`));
  const panelEl = document.getElementById("canvasWrap").parentElement;
  panelEl.scrollTop = 0;
  await new Promise(r => setTimeout(r, 200));
  const pTop = panelEl.getBoundingClientRect().top, cTop = document.querySelector("#canvasWrap canvas").getBoundingClientRect().top;
  check("a tall TICTOC image can be scrolled to its very top", cTop >= pTop - 1, `canvas top ${Math.round(cTop)} vs panel top ${Math.round(pTop)} at scrollTop 0`);

  // Unsaved paint must not be discarded silently — re-clicking the image you're on
  // (which selection auto-loads) or switching to another one used to wipe it.
  const list = () => [...document.querySelectorAll("#fileList li")];
  const cur = document.querySelector("#fileList li.current").textContent;
  painter.setMode("fg");
  painter._dab(200, 200);
  const realConfirm = window.confirm;
  let asked = 0, answer = false;
  window.confirm = () => { asked++; return answer; };
  const logLines = () => document.getElementById("log").innerText.split("\n").filter(l => l.includes(`Loaded ${cur}`)).length;
  const before = logLines();
  list().find(li => li.textContent === cur).click();
  await new Promise(r => setTimeout(r, 400));
  check("re-clicking the current image keeps the paint and doesn't reload it",
    painter.hasAnyAnnotation() && logLines() === before && asked === 0, `asked ${asked}, reloads ${logLines() - before}`);
  const other = list().find(li => li.textContent !== cur);
  other.click();
  await new Promise(r => setTimeout(r, 400));
  check("switching images with unsaved paint asks first, and Cancel keeps you on it",
    asked === 1 && document.querySelector("#fileList li.current").textContent === cur && painter.hasAnyAnnotation(),
    `asked ${asked}, current ${document.querySelector("#fileList li.current").textContent}`);
  answer = true;
  other.click();
  const switched = await waitFor(() => document.getElementById("log").innerText.includes(`Loaded ${other.textContent}`));
  check("confirming the discard switches images", switched && !painter.hasAnyAnnotation());
  window.confirm = realConfirm;

  check("still not mounted (browsing must not require the picker)", document.getElementById("mountStatus").textContent.includes("not mounted"));

  // How the calibration database opens this tool (its tools.ts, launch: 'dataset').
  // Checked in a hidden iframe so this page's own state isn't disturbed.
  const slug = "gh:dr-richard-barker/image-analysis-software-and-R-codes/master/TASTIE_tomato/images";
  const frame = Object.assign(document.createElement("iframe"), {
    src: `${location.pathname}?embed=1&collection=${encodeURIComponent(slug)}`,
    style: "position:fixed;left:-3000px;width:1280px;height:800px",
  });
  document.body.appendChild(frame);
  const fdoc = await waitFor(() => frame.contentDocument?.getElementById("fileList")?.children.length && frame.contentDocument);
  if (fdoc) {
    const sel = fdoc.getElementById("datasetSelect");
    check("?collection= preselects that collection and lists its images",
      sel.value === "db:" + slug && fdoc.getElementById("fileList").children.length > 0,
      `${sel.options[sel.selectedIndex]?.textContent}, ${fdoc.getElementById("fileList").children.length} images`);
    const visible = id => fdoc.defaultView.getComputedStyle(fdoc.querySelector(id)).display !== "none";
    check("?embed=1 hides the title but keeps the Mount button", !visible("header h1") && visible("#mountBtn"));
  } else {
    check("?collection= preselects that collection and lists its images", false, "embedded page never listed images");
  }
  frame.remove();

  return { pass: checks.every(c => c.ok), checks };
})();
