// 블로그 사진 웹앱(핸드폰). 화면 3개: 사진 올리기 · 진행 상황 · 글 미리보기 (+ 처음 1번 로그인)
// - 공개용 값만 쓴다(config.js: Supabase 주소·공개 키·알림 공개 키). 비밀 키는 PC에만 있다.
// - 사진은 긴 변 2560px로 줄여 올리고, 줄이기 전에 촬영 시각만 읽어 함께 보낸다.
// - 읽기·올리기는 로그인한 본인 것만 된다(DB·저장소 RLS). 상태 바꾸기는 PC만 한다.
"use strict";

const C = window.NBM_CONFIG || {};
const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
const MAX = 20, LONG_EDGE = 2560;
const STATUS = {
  uploaded: ["처리 중", "s-wait"], processing: ["처리 중", "s-wait"], written: ["글 완성", "s-done"],
  draft_saved: ["임시저장 완료", "s-saved"], failed: ["실패", "s-fail"],
};
let me = null, member = null, picked = [], timer = null;

// ---------------- 시작·화면 전환 ----------------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const { data: { session } } = await sb.auth.getSession();
  await onSession(session);
  sb.auth.onAuthStateChange((_e, s) => { if ((s?.user?.id || null) !== (me?.id || null)) onSession(s); });
  window.addEventListener("hashchange", route);
}

async function onSession(session) {
  me = session?.user || null;
  member = null;
  $("tabs").hidden = true;
  if (!me) return show("login");
  const { data } = await sb.from("app_members").select("org_id").eq("user_id", me.id).maybeSingle();
  member = data;
  if (!member) {
    show("login");
    $("login-msg").textContent = "이 계정은 업체에 연결되어 있지 않습니다.";
    return;
  }
  $("tabs").hidden = false;
  setupBell();
  route();
}

function route() {
  if (!me || !member) return;
  const h = location.hash.slice(1);
  if (h.startsWith("job=")) return openJob(h.slice(4));
  if (h === "jobs") return showJobs();
  show("upload");
}

function show(v) {
  for (const s of ["login", "upload", "jobs", "preview"]) $("v-" + s).hidden = s !== v;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === v || (v === "preview" && a.dataset.v === "jobs")));
  if (v !== "jobs" && timer) { clearInterval(timer); timer = null; }
  if (v === "upload") $("ios-tip").hidden = !(isIOS() && !standalone());
}

// ---------------- 로그인 ----------------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-msg").textContent = "";
  const { data, error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) $("login-msg").textContent = "로그인 실패: 이메일 또는 비밀번호를 확인하세요.";
  else await onSession(data.session);
});

// ---------------- ① 사진 올리기 ----------------
$("files").addEventListener("change", () => {
  const fs = [...$("files").files];
  picked = fs.slice(0, MAX);
  $("up-msg").textContent = fs.length > MAX ? `최대 ${MAX}장입니다. 앞의 ${MAX}장만 올립니다.` : "";
  $("thumbs").replaceChildren(...picked.map((f) => { const im = document.createElement("img"); im.src = URL.createObjectURL(f); return im; }));
  $("pick-text").textContent = picked.length ? `📷 ${picked.length}장 선택됨 (다시 고르기)` : "📷 사진 고르기 (시공 1건, 최대 20장)";
  $("send").disabled = !picked.length;
});

$("send").addEventListener("click", async () => {
  if (!picked.length) return;
  $("send").disabled = true;
  $("files").disabled = true;
  $("bar").hidden = false;
  $("bar").value = 0;
  const jobId = crypto.randomUUID();
  const paths = [], taken = [];
  try {
    for (let i = 0; i < picked.length; i++) {
      $("up-msg").textContent = `${i + 1} / ${picked.length}장 올리는 중…`;
      const { blob, takenAt } = await shrink(picked[i]);
      const path = `${me.id}/${jobId}/${String(i + 1).padStart(2, "0")}.jpg`;
      const { error } = await sb.storage.from("uploads").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      paths.push(path);
      taken.push(takenAt);
      $("bar").value = ((i + 1) / picked.length) * 100;
    }
    const { error } = await sb.from("mobile_jobs").insert({ id: jobId, org_id: member.org_id, user_id: me.id, photo_paths: paths, taken_at: taken });
    if (error) throw error;
    picked = [];
    $("files").value = "";
    $("thumbs").replaceChildren();
    $("pick-text").textContent = "📷 사진 고르기 (시공 1건, 최대 20장)";
    $("up-msg").textContent = "";
    location.hash = "#jobs";
  } catch (e) {
    $("up-msg").textContent = "올리기 실패: " + (e.message || e) + " — 다시 눌러 주세요";
    $("send").disabled = false;
  } finally {
    $("files").disabled = false;
    $("bar").hidden = true;
  }
});

async function shrink(file) {
  let takenAt = null;
  try { takenAt = await exifDate(file); } catch (_) { takenAt = null; }
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (_) { img = await loadImg(file); }
  const w0 = img.width, h0 = img.height, s = Math.min(1, LONG_EDGE / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * s);
  c.height = Math.round(h0 * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("사진 변환 실패"))), "image/jpeg", 0.85));
  return { blob, takenAt };
}

function loadImg(file) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("이 사진 형식은 열 수 없습니다(JPG로 바꿔 주세요)"));
    im.src = URL.createObjectURL(file);
  });
}

// 촬영 시각(EXIF DateTimeOriginal). 줄이면 사라지므로 먼저 읽는다. 시간대 정보가 없어 한국 시간으로 본다.
async function exifDate(file) {
  const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 10 < v.byteLength) {
    const m = v.getUint16(o), len = v.getUint16(o + 2);
    if ((m & 0xff00) !== 0xff00) return null;
    if (m === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return readTiffDate(v, o + 10);
    o += 2 + len;
  }
  return null;
}

function readTiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const ifd = (off) => { const n = u16(t + off), out = {}; for (let i = 0; i < n; i++) { const e = t + off + 2 + i * 12; out[u16(e)] = e; } return out; };
  const str = (e) => { const n = u32(e + 4), p = n > 4 ? t + u32(e + 8) : e + 8; let s = ""; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
  const ifd0 = ifd(u32(t + 4));
  let d = null;
  if (ifd0[0x8769]) { const ex = ifd(u32(ifd0[0x8769] + 8)); if (ex[0x9003]) d = str(ex[0x9003]); }
  if (!d && ifd0[0x0132]) d = str(ifd0[0x0132]);
  const m = d && d.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00` : null;
}

// ---------------- ② 진행 상황 ----------------
async function showJobs() {
  show("jobs");
  await loadJobs();
  if (!timer) timer = setInterval(() => { if (!document.hidden) loadJobs(); }, 5000);
}

async function loadJobs() {
  const { data, error } = await sb.from("mobile_jobs").select("id,status,title,note,created_at,photo_paths")
    .order("created_at", { ascending: false }).limit(30);
  if (error) return;
  $("jobs-empty").hidden = data.length > 0;
  $("jobs").replaceChildren(...data.map((j) => {
    const [label, cls] = STATUS[j.status] || [j.status, "s-wait"];
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const when = document.createElement("span");
    when.className = "muted";
    when.textContent = `${new Date(j.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · 사진 ${j.photo_paths.length}장`;
    const badge = document.createElement("span");
    badge.className = "badge " + cls;
    badge.textContent = label;
    row.append(when, badge);
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = j.title || (j.status === "failed" ? j.note || "" : "AI가 사진을 보고 글을 쓰는 중입니다");
    li.append(row, title);
    if (j.title) li.addEventListener("click", () => { location.hash = "#job=" + j.id; });
    return li;
  }));
}

// ---------------- ③ 글 미리보기 ----------------
async function openJob(id) {
  show("preview");
  const art = $("pv");
  art.replaceChildren();
  $("pv-info").textContent = "불러오는 중…";
  $("copy").hidden = true;
  const { data: j } = await sb.from("mobile_jobs").select("status,title,preview,note").eq("id", id).maybeSingle();
  if (!j) { $("pv-info").textContent = "글을 찾을 수 없습니다."; return; }
  const pv = j.preview || {};
  if (!pv.title) { $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} ${j.note || ""}`; return; }
  const urls = {};
  if (pv.photos?.length && !pv.photos_removed) {
    const { data } = await sb.storage.from("previews").createSignedUrls(pv.photos, 3600);
    for (const x of data || []) if (x.signedUrl) urls[x.path] = x.signedUrl;
  }
  const add = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; art.append(el); return el; };
  const paras = (text) => String(text || "").split("\n").filter((s) => s.trim()).forEach((s) => add("p", s));
  add("h2", pv.title);
  paras(pv.intro);
  for (const s of pv.sections || []) {
    add("h3", s.heading);
    for (const p of s.photos || []) {
      if (!urls[p]) continue;
      const im = document.createElement("img");
      im.src = urls[p];
      im.loading = "lazy";
      art.append(im);
    }
    paras(s.body);
  }
  paras(pv.outro);
  add("p", (pv.tags || []).map((t) => "#" + String(t).replace(/^#/, "")).join(" "), "tags");
  $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} · 담당 블로그 ${pv.site_name || "-"} · 검색어 ${pv.keyword || "-"}`
    + (pv.left_out?.length ? ` · 확실하지 않아 뺀 것: ${pv.left_out.join(", ")}` : "")
    + (pv.photos_removed ? " · 사진 미리보기 기간(30일)이 지났습니다" : "");
  $("copy").hidden = false;
  $("copy").textContent = "📋 글 복사";
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(pv.plain_text || ""); $("copy").textContent = "복사됨 ✓"; }
    catch (_) { $("copy").textContent = "복사 실패 — 길게 눌러 직접 복사하세요"; }
  };
}

// ---------------- 핸드폰 알림 ----------------
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
function standalone() { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
function canPush() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!C.vapidPublicKey; }

async function setupBell() {
  if (!canPush()) { $("bell").hidden = true; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") { await saveSub(sub); $("bell").hidden = true; return; }
  $("bell").hidden = false;
}

$("bell").addEventListener("click", async () => {
  try {
    const p = await Notification.requestPermission();
    if (p !== "granted") { alert("알림이 꺼져 있습니다. 휴대폰 설정에서 이 앱의 알림을 허용해 주세요."); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(C.vapidPublicKey) });
    await saveSub(sub);
    $("bell").hidden = true;
  } catch (e) {
    alert("알림 켜기 실패: " + (e.message || e));
  }
});

async function saveSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").insert({ user_id: me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  if (error && error.code !== "23505") throw error;            // 이미 등록된 주소는 그대로 둔다
}

function b64u(s) {
  const b = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

boot();
