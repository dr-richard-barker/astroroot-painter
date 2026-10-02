/* Corrective-annotation brush, adapted from astroroot's canvas-overlay pattern
 * (cose-rollout/astroroot-main/app.js's octx pointerdown/move/up handling and its
 * display-vs-natural-resolution split) — repurposed here from point-by-point tracing
 * to a freehand R/G brush, since that's the actual annotation format RootPainter's
 * trainer reads (see docs/PROTOCOL.md: R>0=foreground, G>0=background, unpainted
 * pixels excluded from the loss).
 *
 * Three stacked, same-size layers inside a position:relative wrapper:
 *   photoCanvas  — the source image, for reference only, never exported
 *   segCanvas    — the model's last prediction (cyan), for reference only
 *   annotCanvas  — what the user paints; THIS is what gets saved as the annotation PNG
 * All three share one CSS size (so they visually line up) but their pixel buffers are
 * the image's natural resolution, so the exported PNG matches the source photo 1:1. */

class AnnotationPainter {
  constructor(wrapperEl){
    this.wrapper = wrapperEl;
    this.wrapper.style.position = "relative";
    this.wrapper.style.lineHeight = "0";

    // The photo layer stays in normal flow so it gives the wrapper its size; the
    // two overlays sit on top of it. (With all three absolutely positioned, the
    // wrapper collapsed to 0x0 and loaded images never appeared on screen.)
    this.photoCanvas = this._makeCanvas(false);
    this.segCanvas = this._makeCanvas(true);
    this.annotCanvas = this._makeCanvas(true);
    this.segCanvas.style.opacity = "0.7";
    // Strokes are written pixel by pixel (see _dab), so this layer is read back
    // constantly; the hint keeps it in CPU memory where that's cheap.
    this.ctx = this.annotCanvas.getContext("2d", { willReadFrequently: true });

    this.wrapper.append(this.photoCanvas, this.segCanvas, this.annotCanvas);

    this.mode = "fg";       // "fg" | "bg" | "erase"
    this.brushRadius = 12;  // in natural-image pixels
    this._drawing = false;
    this.dirty = false;     // annotation changed since it was loaded or saved
    this.version = 0;       // bumped on every change, so a save can tell if strokes came after its snapshot

    const ac = this.annotCanvas;
    ac.style.cursor = "crosshair";
    ac.addEventListener("pointerdown", e => this._start(e));
    ac.addEventListener("pointermove", e => this._move(e));
    window.addEventListener("pointerup", () => { this._drawing = false; });
  }

  _makeCanvas(overlay){
    const c = document.createElement("canvas");
    c.style.display = "block";
    if(overlay){
      c.style.position = "absolute";
      c.style.top = "0";
      c.style.left = "0";
    }
    c.style.width = "100%";
    c.style.height = "auto";
    c.style.imageRendering = "pixelated";
    return c;
  }

  // Loads the source photo and sizes every layer to its natural resolution.
  async loadPhoto(fileOrBlob){
    const bitmap = await createImageBitmap(fileOrBlob);
    this.width = bitmap.width;
    this.height = bitmap.height;
    for(const c of [this.photoCanvas, this.segCanvas, this.annotCanvas]){
      c.width = this.width;
      c.height = this.height;
    }
    this.photoCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    this.segCanvas.getContext("2d").clearRect(0, 0, this.width, this.height);
    this.ctx.clearRect(0, 0, this.width, this.height);
    bitmap.close();
    this.dirty = false;
  }

  async loadSegmentation(fileOrBlob){
    const bitmap = await createImageBitmap(fileOrBlob);
    const ctx = this.segCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
  }

  // A saved annotation's exact pixel values, at this photo's size. No colour-space
  // conversion and no smoothing, so root/soil values come back unchanged.
  async _savedPixels(fileOrBlob){
    const bitmap = await createImageBitmap(fileOrBlob, { colorSpaceConversion: "none" });
    const ctx = new OffscreenCanvas(this.width, this.height).getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
    return ctx.getImageData(0, 0, this.width, this.height);
  }

  async loadAnnotation(fileOrBlob){
    this.ctx.putImageData(await this._savedPixels(fileOrBlob), 0, 0);
    this.dirty = false;
  }

  // Paint made before a saved annotation could be loaded (nothing mounted yet) is
  // kept, and the saved annotation fills in everywhere that paint doesn't cover.
  async mergeAnnotationUnder(fileOrBlob){
    const saved = (await this._savedPixels(fileOrBlob)).data;
    const cur = this.ctx.getImageData(0, 0, this.width, this.height);
    const c = cur.data;
    for(let i = 0; i < c.length; i += 4){
      if(c[i + 3] === 0){ c[i] = saved[i]; c[i + 1] = saved[i + 1]; c[i + 2] = saved[i + 2]; c[i + 3] = saved[i + 3]; }
    }
    this.ctx.putImageData(cur, 0, 0);
    this.dirty = true;
    this.version++;
  }

  clearAnnotation(){
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.dirty = true;
    this.version++;
  }

  markClean(){ this.dirty = false; }

  setMode(mode){ this.mode = mode; }
  setBrushRadius(r){ this.brushRadius = r; }

  // CSS-displayed size can differ from the natural pixel buffer — convert pointer
  // coordinates the same way astroroot's octx handlers do (rect-relative, then scaled).
  _toCanvasCoords(e){
    const rect = this.annotCanvas.getBoundingClientRect();
    const scaleX = this.annotCanvas.width / rect.width;
    const scaleY = this.annotCanvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }

  _start(e){
    if(!this.width) return;
    e.preventDefault();
    this._drawing = true;
    this._last = this._toCanvasCoords(e);
    this._dab(...this._last);
  }

  _move(e){
    if(!this._drawing) return;
    e.preventDefault();
    const [x, y] = this._toCanvasCoords(e), [lx, ly] = this._last;
    // Fill the gap since the last pointer event, so a fast stroke stays continuous
    // (the desktop client draws a line segment between events).
    const n = Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(1, this.brushRadius / 2));
    for(let i = 1; i <= n; i++) this._dab(lx + (x - lx) * i / n, ly + (y - ly) * i / n);
    this._last = [x, y];
  }

  // Matches RootPainter's desktop client (graphics_scene.py), which paints with
  // CompositionMode_Source and no antialiasing: every pixel the brush covers is SET
  // to exactly foreground rgba(255,0,0,180), background rgba(0,255,0,180), or —
  // erasing — unpainted (0,0,0,0). Blending semi-transparent colour over what was
  // there would leave pixels that are both root (R>0) and soil (G>0) to the trainer,
  // and an antialiased eraser would leave a faint ring that still counts as painted.
  _dab(x, y){
    const r = this.brushRadius;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(this.width, Math.ceil(x + r) + 1);
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(this.height, Math.ceil(y + r) + 1);
    if(x1 <= x0 || y1 <= y0) return;
    const [R, G, B, A] = this.mode === "fg" ? [255, 0, 0, 180] : this.mode === "bg" ? [0, 255, 0, 180] : [0, 0, 0, 0];
    const img = this.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const d = img.data, w = x1 - x0, r2 = r * r;
    for(let py = y0; py < y1; py++){
      const dy = py + 0.5 - y;
      for(let px = x0; px < x1; px++){
        const dx = px + 0.5 - x;
        if(dx * dx + dy * dy > r2) continue;
        const i = ((py - y0) * w + (px - x0)) * 4;
        d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
      }
    }
    this.ctx.putImageData(img, x0, y0);
    this.dirty = true;
    this.version++;
  }

  // Exports exactly what the trainer expects: an RGBA PNG at the photo's native
  // resolution, transparent everywhere unpainted.
  toAnnotationBlob(){
    return new Promise(resolve => this.annotCanvas.toBlob(resolve, "image/png"));
  }

  hasAnyAnnotation(){
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height);
    for(let i = 3; i < data.length; i += 4) if(data[i] !== 0) return true;
    return false;
  }
}

window.AnnotationPainter = AnnotationPainter;
