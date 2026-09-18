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

    this.photoCanvas = this._makeCanvas();
    this.segCanvas = this._makeCanvas();
    this.annotCanvas = this._makeCanvas();
    this.segCanvas.style.opacity = "0.7";

    this.wrapper.append(this.photoCanvas, this.segCanvas, this.annotCanvas);

    this.mode = "fg";       // "fg" | "bg" | "erase"
    this.brushRadius = 12;  // in natural-image pixels
    this._drawing = false;

    const ac = this.annotCanvas;
    ac.style.cursor = "crosshair";
    ac.addEventListener("pointerdown", e => this._start(e));
    ac.addEventListener("pointermove", e => this._move(e));
    window.addEventListener("pointerup", () => { this._drawing = false; });
  }

  _makeCanvas(){
    const c = document.createElement("canvas");
    c.style.position = "absolute";
    c.style.top = "0";
    c.style.left = "0";
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
    this.annotCanvas.getContext("2d").clearRect(0, 0, this.width, this.height);
    bitmap.close();
  }

  async loadSegmentation(fileOrBlob){
    const bitmap = await createImageBitmap(fileOrBlob);
    const ctx = this.segCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
  }

  async loadAnnotation(fileOrBlob){
    const bitmap = await createImageBitmap(fileOrBlob);
    const ctx = this.annotCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
  }

  clearAnnotation(){
    this.annotCanvas.getContext("2d").clearRect(0, 0, this.width, this.height);
  }

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
    this._dab(...this._toCanvasCoords(e));
  }

  _move(e){
    if(!this._drawing) return;
    e.preventDefault();
    this._dab(...this._toCanvasCoords(e));
  }

  // Brush colors match the desktop client's live paint colors (docs/PROTOCOL.md):
  // foreground rgba(255,0,0,180), background rgba(0,255,0,180). Eraser punches back
  // to fully transparent so those pixels go back to "unpainted, excluded from loss."
  _dab(x, y){
    const ctx = this.annotCanvas.getContext("2d");
    if(this.mode === "erase"){
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = this.mode === "fg" ? "rgba(255,0,0,0.706)" : "rgba(0,255,0,0.706)";
    }
    ctx.beginPath();
    ctx.arc(x, y, this.brushRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Exports exactly what the trainer expects: an RGBA PNG at the photo's native
  // resolution, transparent everywhere unpainted.
  toAnnotationBlob(){
    return new Promise(resolve => this.annotCanvas.toBlob(resolve, "image/png"));
  }

  hasAnyAnnotation(){
    const ctx = this.annotCanvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, this.width, this.height);
    for(let i = 3; i < data.length; i += 4) if(data[i] !== 0) return true;
    return false;
  }
}

window.AnnotationPainter = AnnotationPainter;
