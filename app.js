// 블로그 사진 웹앱(핸드폰). 화면: 사진 올리기 · 진행 상황 · 고르기(필요할 때만) · 글 미리보기 (+ 처음 1번 로그인)
// - 공개용 값만 쓴다(config.js: Supabase 주소·공개 키·알림 공개 키). 비밀 키는 PC에만 있다.
// - 사진은 긴 변 2560px로 줄여 올리고, 줄이기 전에 촬영 시각만 읽어 함께 보낸다. 동영상은 1개, 45MB 이하 그대로.
// - '차종 패턴 색상' 한 줄(선택)은 parse.js로 나눠 answer에 담는다. 사장님 값은 AI 값보다 우선한다.
// - 읽기·올리기는 로그인한 본인 것만 된다(DB·저장소 RLS). 웹앱이 바꿀 수 있는 것은 '고르기 필요'일 때 answer뿐.
"use strict";

const C = window.NBM_CONFIG || {};
const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
const MAX = 20, LONG_EDGE = 2560, VIDEO_MAX = 45 * 1024 * 1024;
const STATUS = {
  uploaded: ["처리 중", "s-wait"], processing: ["처리 중", "s-wait"], needs_choice: ["고르기 필요", "s-ask"],
  written: ["글 완성", "s-done"], draft_saved: ["임시저장 완료", "s-saved"], failed: ["실패", "s-fail"],
};
let me = null, member = null, picked = [], timer = null, video = null, SAMPLES = null, hint = null, hintPick = null;
const samplesReady = fetch("samples/samples.json").then((r) => r.json())
  .then((j) => { SAMPLES = j.patterns; readHint(); }).catch(() => {});

function sampleOf(code) {
  for (const [p, v] of Object.entries(SAMPLES || {})) for (const c of v.colors) if (c.code === code) return { ...c, pattern: p, label: v.label };
  return null;
}

function tileButton(code, onPick) {
  const s = sampleOf(code);
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.code = code;
  const im = document.createElement("img");
  im.src = "samples/" + s.tile;
  im.alt = s.name;
  const t = document.createElement("span");
  t.textContent = `${s.pattern} ${s.name}`;
  b.append(im, t);
  b.addEventListener("click", () => onPick(code, b));
  return b;
}

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
  for (const s of ["login", "upload", "jobs", "choose", "preview"]) $("v-" + s).hidden = s !== v;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === v || ((v === "preview" || v === "choose") && a.dataset.v === "jobs")));
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
  updateSend();
});

// 한 줄 입력: 바로 나눠 보여 주고, 못 알아들으면 비슷한 견본 3~4개를 띄워 한 번 눌러 고르게 한다
$("hint").addEventListener("input", () => { clearTimeout(readHint.t); readHint.t = setTimeout(readHint, 250); });
$("hint").addEventListener("change", readHint);

function readHint() {
  const text = $("hint").value;
  hint = SAMPLES && window.NBM_parseLine ? window.NBM_parseLine(text, SAMPLES) : null;
  hintPick = null;
  const box = $("hint-pick"), msg = $("hint-msg");
  box.replaceChildren();
  box.hidden = true;
  msg.className = "muted";
  if (!text.trim()) msg.textContent = "비워 두면 AI가 사진과 견본으로 맞힙니다(선택 사항).";
  else if (!hint) msg.textContent = "견본 목록을 불러오는 중…";
  else if (hint.status === "ok") { msg.textContent = "✓ " + hint.message; msg.className = "ok"; }
  else {
    msg.textContent = hint.message;
    msg.className = "err";
    if (hint.suggestions.length) {
      box.hidden = false;
      box.append(...hint.suggestions.map((code) => tileButton(code, (c, b) => {
        hintPick = c;
        box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        const s = sampleOf(c);
        msg.textContent = `✓ ${hint.car ? "차종 " + hint.car + " · " : ""}${s.label} · ${s.name}`;
        msg.className = "ok";
        updateSend();
      })));
    }
  }
  updateSend();
}

function hintReady() {
  return !$("hint").value.trim() || (hint && (hint.status === "ok" || hintPick));
}

function updateSend() {
  $("send").disabled = !picked.length || !hintReady();
}

function answerFromHint() {
  const text = $("hint").value.trim();
  if (!text || !hint) return null;
  const a = { text: text.slice(0, 50) };                       // DB 한도 500바이트(한글 3바이트) 안에 들게
  if (hint.car) a.car = hint.car;
  const code = hintPick || hint.code;
  if (code) { const s = sampleOf(code); Object.assign(a, { sample: code, pattern: s.pattern, color: s.name }); }
  else { if (hint.pattern) a.pattern = hint.pattern; if (hint.color) a.color = hint.color; }
  return a;
}

$("video").addEventListener("change", () => {
  const f = $("video").files[0] || null;
  video = null;
  $("video-msg").className = "muted";
  $("video-msg").textContent = "";
  $("video-text").textContent = "🎬 동영상 1개 (선택 사항, 45MB 이하)";
  if (!f) return;
  const ext = /\.mov$/i.test(f.name) || f.type === "video/quicktime" ? "mov" : /\.mp4$/i.test(f.name) || f.type === "video/mp4" ? "mp4" : null;
  const mb = (f.size / 1024 / 1024).toFixed(1);
  if (!ext) {
    $("video-msg").className = "err";
    $("video-msg").textContent = "mp4·mov 동영상만 올릴 수 있습니다.";
  } else if (f.size > VIDEO_MAX) {
    $("video-msg").className = "err";
    $("video-msg").textContent = `동영상이 ${mb}MB라서 너무 큽니다(45MB 이하). 핸드폰 사진 앱에서 앞뒤를 잘라 짧게(약 30초) 만든 뒤 다시 골라 주세요.`;
  } else {
    video = { file: f, ext };
    $("video-text").textContent = `🎬 동영상 선택됨 (${mb}MB, 다시 고르기)`;
  }
  if (!video) $("video").value = "";
});

$("send").addEventListener("click", async () => {
  if (!picked.length || !hintReady()) return;
  $("send").disabled = true;
  $("files").disabled = true;
  $("bar").hidden = false;
  $("bar").value = 0;
  const jobId = crypto.randomUUID();
  const paths = [], taken = [];
  const steps = picked.length + (video ? 1 : 0);
  try {
    for (let i = 0; i < picked.length; i++) {
      $("up-msg").textContent = `${i + 1} / ${picked.length}장 올리는 중…`;
      const { blob, takenAt } = await shrink(picked[i]);
      const path = `${me.id}/${jobId}/${String(i + 1).padStart(2, "0")}.jpg`;
      const { error } = await sb.storage.from("uploads").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      paths.push(path);
      taken.push(takenAt);
      $("bar").value = ((i + 1) / steps) * 100;
    }
    let videoPath = null;
    if (video) {
      $("up-msg").textContent = "동영상 올리는 중… (와이파이에서 더 빠릅니다)";
      videoPath = `${me.id}/${jobId}/video.${video.ext}`;
      const { error } = await sb.storage.from("videos").upload(videoPath, video.file,
        { contentType: video.ext === "mov" ? "video/quicktime" : "video/mp4", upsert: false });
      if (error) throw error;
      $("bar").value = 100;
    }
    const row = { id: jobId, org_id: member.org_id, user_id: me.id, photo_paths: paths, taken_at: taken, video_path: videoPath };
    const answer = answerFromHint();
    if (answer) row.answer = answer;
    const { error } = await sb.from("mobile_jobs").insert(row);
    if (error) throw error;
    picked = [];
    video = null;
    $("files").value = "";
    $("video").value = "";
    $("hint").value = "";
    readHint();
    $("video-text").textContent = "🎬 동영상 1개 (선택 사항, 45MB 이하)";
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
  const { data, error } = await sb.from("mobile_jobs").select("id,status,title,note,created_at,photo_paths,video_path")
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
    when.textContent = `${new Date(j.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · 사진 ${j.photo_paths.length}장${j.video_path ? " · 동영상" : ""}`;
    const badge = document.createElement("span");
    badge.className = "badge " + cls;
    badge.textContent = label;
    row.append(when, badge);
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = j.title || (j.status === "failed" || j.status === "needs_choice" ? `${j.status === "needs_choice" ? "👉 " : ""}${j.note || ""}`
      : "AI가 사진을 보고 글을 쓰는 중입니다");
    li.append(row, title);
    if (j.title || j.status === "needs_choice") li.addEventListener("click", () => { location.hash = "#job=" + j.id; });
    return li;
  }));
}

// ---------------- ③ 글 미리보기 ----------------
async function openJob(id) {
  show("preview");
  const art = $("pv");
  art.replaceChildren();
  $("pv-info").textContent = "불러오는 중…";
  $("copybar").hidden = true;
  $("pv-draft").hidden = true;
  const { data: j } = await sb.from("mobile_jobs").select("id,status,title,preview,note,choices,answer").eq("id", id).maybeSingle();
  if (!j) { $("pv-info").textContent = "글을 찾을 수 없습니다."; return; }
  if (j.status === "needs_choice") return showChoose(j);
  const pv = j.preview || {};
  if (!pv.title) { $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} ${j.note || ""}`; return; }
  const urls = {};
  if (pv.photos?.length && !pv.photos_removed) {
    const { data } = await sb.storage.from("previews").createSignedUrls(pv.photos, 3600);
    for (const x of data || []) if (x.signedUrl) urls[x.path] = x.signedUrl;
  }
  const add = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; art.append(el); return el; };
  const paras = (text) => String(text || "").split("\n").filter((s) => s.trim()).forEach((s) => add("p", s));
  if (pv.title_candidates?.length) add("p", "제목 후보: " + pv.title_candidates.map((t, i) => `${i + 1}. ${t}`).join("  /  "), "tags");
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
  if (pv.video) add("div", "🎬 [동영상] 자리 — 올린 시공 동영상을 여기에 넣으세요. 동영상은 자동 가림이 안 되므로 번호판·얼굴이 보이면 넣지 마세요.", "video-slot");
  paras(pv.outro);
  add("p", (pv.tags || []).map((t) => "#" + String(t).replace(/^#/, "")).join(" "), "tags");
  $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} · 담당 블로그 ${pv.site_name || "-"} · 검색어 ${pv.keyword || "-"}`
    + (pv.cost_krw != null ? ` · 이 글 AI 비용 약 ${Math.round(pv.cost_krw).toLocaleString()}원` : "")
    + (pv.left_out?.length ? ` · 확실하지 않아 뺀 것: ${pv.left_out.join(", ")}` : "")
    + (pv.photos_removed ? " · 사진 미리보기 기간(30일)이 지났습니다" : "");
  showDraft(pv.draft);
  const tags = (pv.tags || []).map((t) => "#" + String(t).replace(/^#/, "")).join(" ");
  const body = pv.body_text || String(pv.plain_text || "").split("\n").slice(1).filter((l) => l !== tags).join("\n").trim();
  copyButton("cp-title", "📋 제목 복사", pv.title);
  copyButton("cp-body", "📋 본문 복사", body);
  copyButton("cp-tags", "📋 태그 복사", tags);
  const order = (pv.photos || []).filter((p) => urls[p]);
  $("cp-photos").hidden = !order.length;
  $("cp-photos").textContent = `📷 사진 ${order.length}장 모두 저장`;
  $("cp-photos").onclick = () => savePhotos(order.map((p) => urls[p]));
  $("copybar").hidden = false;
}

function showDraft(d) {
  const box = $("pv-draft");
  if (!d || !d.status) { box.hidden = true; return; }
  const msg = {
    auto: ["⏳ PC가 네이버에 자동 임시저장할 차례를 기다리는 중입니다.", ""],
    saved: ["✅ 네이버에 임시저장했습니다. 네이버 블로그 앱 > 글쓰기 > 임시저장 글에서 확인 후 발행하세요." + (d.note ? ` (${d.note})` : ""), "ok"],
    failed: [`⚠ 자동 임시저장 실패(${d.step || "-"}) — 아래 복사 버튼으로 올려 주세요.`, "bad"],
    copy: ["이 블로그는 복사 방식입니다: 제목·본문·태그를 복사해 네이버 앱에 붙여넣고, 사진은 저장해 순서대로 넣으세요.", ""],
  }[d.status] || [d.status, ""];
  box.textContent = msg[0];
  box.className = "draft " + msg[1];
  box.hidden = false;
}

function copyButton(id, label, text) {
  const b = $(id);
  b.textContent = label;
  b.hidden = !text;
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text || ""); b.textContent = "복사됨 ✓"; }
    catch (_) { b.textContent = "복사 실패"; }
    setTimeout(() => { b.textContent = label; }, 2000);
  };
}

async function savePhotos(list) {
  const b = $("cp-photos");
  const label = b.textContent;
  b.textContent = "사진 받는 중…";
  try {
    const files = [];
    for (const [i, u] of list.entries()) {
      const blob = await (await fetch(u)).blob();
      files.push(new File([blob], `${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
    }
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: "블로그 사진" });         // 공유 창에서 '이미지 저장'(글 순서대로 01, 02…)
    } else {
      for (const f of files) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(f);
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    }
    b.textContent = "저장 창을 열었습니다 ✓";
  } catch (e) {
    b.textContent = e && e.name === "AbortError" ? label : "사진 저장 실패 — 사진을 길게 눌러 저장하세요";
  }
  setTimeout(() => { b.textContent = label; }, 3000);
}

// ---------------- 고르기(AI가 확실하지 않을 때만) ----------------
async function showChoose(j) {
  show("choose");
  await samplesReady;                                          // 알림을 눌러 바로 열어도 견본 이름표가 있게
  const ch = j.choices || {};
  const pickedNow = {};
  const done = j.answer && j.answer.picked;
  $("ch-msg").textContent = done ? "고른 것으로 PC가 글을 쓰는 중입니다." : "";
  $("ch-send").hidden = !!done;
  $("ch-photo").hidden = true;
  if (ch.photo) {
    const { data } = await sb.storage.from("previews").createSignedUrl(ch.photo, 3600);
    if (data?.signedUrl) { $("ch-photo").src = data.signedUrl; $("ch-photo").hidden = false; }
  }
  const ready = () => { $("ch-send").disabled = (ch.sample && !pickedNow.sample) || (ch.car && !pickedNow.car); };
  const mark = (box, b) => box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));

  $("ch-sample").hidden = !ch.sample;
  $("ch-tiles").replaceChildren();
  if (ch.sample) {
    $("ch-sample-q").textContent = ch.sample.question;
    const box = $("ch-tiles");
    for (const o of ch.sample.options) {
      if (!sampleOf(o.code)) continue;
      box.append(tileButton(o.code, (code, b) => { pickedNow.sample = code; mark(box, b); ready(); }));
    }
    const none = document.createElement("button");
    none.type = "button";
    none.className = "none";
    none.textContent = "여기에 없음 (패턴·색상 빼고 쓰기)";
    none.addEventListener("click", () => { pickedNow.sample = "none"; mark(box, none); ready(); });
    box.append(none);
  }
  $("ch-car").hidden = !ch.car;
  $("ch-cars").replaceChildren();
  if (ch.car) {
    $("ch-car-q").textContent = ch.car.question;
    const box = $("ch-cars");
    for (const name of [...ch.car.options, "none"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name === "none" ? "모름 (차종 빼고 쓰기)" : name;
      b.addEventListener("click", () => { pickedNow.car = name; mark(box, b); ready(); });
      box.append(b);
    }
  }
  ready();
  $("ch-send").onclick = async () => {
    $("ch-send").disabled = true;
    const answer = { ...(j.answer || {}), ...pickedNow, picked: true };
    if (pickedNow.sample && pickedNow.sample !== "none") {
      const s = sampleOf(pickedNow.sample);
      Object.assign(answer, { pattern: s.pattern, color: s.name });
    }
    const { error } = await sb.from("mobile_jobs").update({ answer }).eq("id", j.id);
    if (error) { $("ch-msg").textContent = "저장 실패: " + (error.message || error) + " — 다시 눌러 주세요"; ready(); return; }
    location.hash = "#jobs";
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
