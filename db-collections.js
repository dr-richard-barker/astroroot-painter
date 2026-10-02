/* The AstroBotany calibration database's image collections, for the dataset
 * dropdown. Everything here works before any local folder is mounted.
 *
 * Two lists:
 *  - collections.json — the database's built-in collections, generated from its
 *    source by scripts/sync_collections.py (the file records the commit it came from).
 *  - localStorage "ec5-projects" — collections the user saved in the database
 *    itself. Both sites are served from dr-richard-barker.github.io and
 *    localStorage is per-origin, so the database's saved list is readable here.
 *    (On any other origin, e.g. a localhost preview, this list is simply empty.)
 *
 * Images are listed the way the database lists them (its src/api/github.ts and
 * src/api/epicollect.ts): the GitHub contents API for folders, the Epicollect5
 * entries API for projects. Both APIs and the image URLs they return are CORS-open,
 * so images can be fetched and drawn on a canvas straight from the browser. */

const DB_SAVED_KEY = "ec5-projects";                 // the database's own key (epicollect.ts CUSTOM_KEY)
const EC5_BASE = "https://five.epicollect.net";
const DECODABLE = /\.(jpe?g|png|webp|gif|bmp)$/i;     // what createImageBitmap can open
const TIFF = /\.tiff?$/i;                             // RootPainter reads these; browsers can't
const VIDEO = /\.(avi|mp4|webm|ogv|mov|m4v|mkv)$/i;

function parseGhId(slug){
  const m = slug.match(/^gh:([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
  return m ? { owner: m[1], repo: m[2], ref: m[3], path: m[4] } : null;
}

// Saved entries can also be uploads, cloud collections or videos, which have no
// image list this tool can read yet.
function kindOf(p){
  const slug = p.slug || "";
  if(slug.startsWith("gh:")) return "github";
  if(/^(yt|cv|local|cloud):/.test(slug)) return null;
  if(p.type && p.type !== "ec5") return null;
  return "ec5";
}

function readSaved(builtinSlugs){
  let list;
  try { list = JSON.parse(localStorage.getItem(DB_SAVED_KEY) || "[]"); } catch { list = []; }
  const saved = [], skipped = [];
  for(const p of Array.isArray(list) ? list : []){
    if(!p || typeof p.slug !== "string" || builtinSlugs.has(p.slug)) continue;
    const type = kindOf(p);
    const gh = type === "github" ? (p.gh || parseGhId(p.slug)) : undefined;
    if(!type || (type === "github" && !gh)){ skipped.push(p.name || p.slug); continue; }
    saved.push({ slug: p.slug, name: p.name || p.slug, type, gh, formRef: p.formRef, saved: true });
  }
  return { saved, skipped };
}

async function loadCollections(){
  let builtin = [], error = null, source = null;
  try{
    const res = await fetch("collections.json", { cache: "no-cache" });
    if(!res.ok) throw new Error(`collections.json returned HTTP ${res.status}`);
    const data = await res.json();
    builtin = data.collections;
    source = data.source;
  } catch(err){ error = err.message; }
  const { saved, skipped } = readSaved(new Set(builtin.map(c => c.slug)));
  return { builtin, saved, skipped, source, error };
}

async function listGithub(gh){
  const path = gh.path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${path}?ref=${encodeURIComponent(gh.ref)}`,
                          { headers: { Accept: "application/vnd.github+json" } });
  if(res.status === 403) throw new Error("GitHub's anonymous rate limit (60 requests/hour) is used up — try again later");
  if(res.status === 404) throw new Error("folder not found on GitHub");
  if(!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const files = (await res.json()).filter(f => f.type === "file" && f.download_url);
  return {
    images: files.filter(f => DECODABLE.test(f.name)).map(f => ({ name: f.name, url: f.download_url })),
    skippedTiff: files.filter(f => TIFF.test(f.name)).length,
    skippedVideo: files.filter(f => VIDEO.test(f.name)).length,
    truncated: files.length >= 1000,                  // the contents API stops at 1000 entries
  };
}

async function listEc5(c){
  let url = `${EC5_BASE}/api/export/entries/${encodeURIComponent(c.slug)}?per_page=500&page=1&format=json`;
  if(c.formRef) url += `&form_ref=${encodeURIComponent(c.formRef)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if(res.status === 429) throw new Error("Epicollect5 rate limit (5 requests/minute) — wait a moment and pick it again");
  if(!res.ok) throw new Error(`Epicollect5 returned ${res.status}`);
  const j = await res.json();
  // Photo fields are auto-detected as media URLs, as the database does — but an
  // entry can hold several photos (nasa-roots has two each), so keep all of them.
  const seen = new Set(), images = [];
  for(const e of (j.data && j.data.entries) || []){
    for(const v of Object.values(e)){
      if(typeof v !== "string" || !v.includes("/api/media/") || !v.includes("type=photo")) continue;
      const name = new URL(v).searchParams.get("name") || `${e.ec5_uuid}.jpg`;
      if(seen.has(name) || !DECODABLE.test(name)) continue;
      seen.add(name);
      images.push({ name, url: v });
    }
  }
  return { images, skippedTiff: 0, skippedVideo: 0, truncated: !!(j.links && j.links.next) };
}

const listCache = new Map();
function listImages(c){
  if(!listCache.has(c.slug)){
    listCache.set(c.slug, (c.type === "github" ? listGithub(c.gh) : listEc5(c))
      .catch(err => { listCache.delete(c.slug); throw err; }));
  }
  return listCache.get(c.slug);
}

// Folder name under datasets/ that a collection's images are copied into when
// they're needed on disk (for the trainer). It must never change for a given
// collection — existing projects point at it — so it depends only on the slug,
// with a hash suffix so two collections can't collide.
function fnv1a(s){
  let h = 0x811c9dc5;
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function localFolderName(c){
  let short = c.slug;
  if(c.type === "github"){
    const segs = c.gh.path.split("/").filter(Boolean);
    let last = segs.pop();
    if(last && /^images?$/i.test(last) && segs.length) last = segs.pop();
    short = last || c.gh.repo;
  }
  return `db-${short.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40)}-${fnv1a(c.slug).slice(0, 6)}`;
}

const blobCache = new Map();
function fetchImageBlob(url){
  if(!blobCache.has(url)){
    blobCache.set(url, fetch(url)
      .then(r => { if(!r.ok) throw new Error(`download failed (HTTP ${r.status})`); return r.blob(); })
      .catch(err => { blobCache.delete(url); throw err; }));
  }
  return blobCache.get(url);
}

window.DbCollections = { loadCollections, listImages, localFolderName, fetchImageBlob, DECODABLE, TIFF };
