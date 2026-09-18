/* File System Access API wrapper for the RootPainter sync directory.
 * Chrome/Edge 86+ only (see docs/PROTOCOL.md). Adapted from the pattern proven in
 * cose-fiji/NATIVE_FILESYSTEM.md, simplified: this talks to a real Python trainer
 * over plain files, so there's no CheerpJ/IndexedDB shim layer to patch around. */

const REQUIRED_SUBDIRS = ["projects", "datasets", "instructions", "executed_instructions", "failed_instructions"];

class SyncFS {
  constructor(){ this.root = null; }

  get supported(){ return "showDirectoryPicker" in window; }

  async mount(){
    if(!this.supported) throw new Error("File System Access API not available — use Chrome or Edge 86+.");
    this.root = await window.showDirectoryPicker({ mode: "readwrite" });
    return this.root;
  }

  async ensureFolders(){
    for(const name of REQUIRED_SUBDIRS) await this.root.getDirectoryHandle(name, { create: true });
  }

  async _split(path, create){
    const parts = path.split("/").filter(Boolean);
    let dir = this.root;
    for(let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create });
    return { dir, name: parts[parts.length - 1] };
  }

  async getDir(path, create = false){
    const parts = path.split("/").filter(Boolean);
    let dir = this.root;
    for(const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  }

  async writeBytes(path, bytesOrBlob){
    const { dir, name } = await this._split(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytesOrBlob);
    await writable.close();
  }

  writeText(path, text){ return this.writeBytes(path, new Blob([text], { type: "text/plain" })); }
  writeJSON(path, obj){ return this.writeText(path, JSON.stringify(obj)); }

  async readFile(path){
    const { dir, name } = await this._split(path, false);
    const handle = await dir.getFileHandle(name);
    return handle.getFile();
  }

  async readText(path){ return (await this.readFile(path)).text(); }
  async readJSON(path){ return JSON.parse(await this.readText(path)); }

  async exists(path){
    try{ const { dir, name } = await this._split(path, false); await dir.getFileHandle(name); return true; }
    catch{ return false; }
  }

  async dirExists(path){
    try{ await this.getDir(path, false); return true; }
    catch{ return false; }
  }

  async listDir(path){
    const dir = await this.getDir(path, false);
    const entries = [];
    for await (const [name, handle] of dir.entries()) entries.push({ name, kind: handle.kind });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  // FS Access API has no atomic cross-directory rename yet — copy the bytes, then
  // remove the source. Fine for our purposes; the trainer does the same on its side.
  async removeFile(path){
    const { dir, name } = await this._split(path, false);
    await dir.removeEntry(name).catch(() => {});
  }
}

window.SyncFS = SyncFS;
