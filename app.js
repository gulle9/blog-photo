// 블로그 사진 웹앱(핸드폰). 화면: 사진 올리기 · 진행 상황 · 예약 목록 · 고르기(필요할 때만) · 글 미리보기 (+ 처음 1번 로그인)
// - 네이버에는 자동으로 넣지 않는다(CLAUDE.md 2장 2번). 사장님이 복사·사진 저장 후 네이버 블로그 앱에서 직접 붙여 넣고 예약한다.
// - 공개용 값만 쓴다(config.js: Supabase 주소·공개 키·알림 공개 키). 비밀 키는 PC에만 있다.
// - 사진은 긴 변 2560px로 줄여 올리고, 줄이기 전에 촬영 시각만 읽어 함께 보낸다. 동영상은 1개, 45MB 이하 그대로.
// - '차종 패턴 색상' 한 줄(선택)은 parse.js로 나눠 answer에 담는다. 사장님 값은 AI 값보다 우선한다.
// - 읽기·올리기는 로그인한 본인 것만 된다(DB·저장소 RLS). 웹앱이 바꿀 수 있는 것은 '고르기 필요'일 때 answer, '글 완성'일 때 scheduled뿐.
"use strict";

const C = window.NBM_CONFIG || {};
const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
const MAX = 99, LONG_EDGE = 2560, VIDEO_MAX = 45 * 1024 * 1024;
const STATUS = {
  uploaded: ["처리 중", "s-wait"], processing: ["처리 중", "s-wait"], needs_choice: ["고르기 필요", "s-ask"],
  written: ["글 완성", "s-done"], draft_saved: ["임시저장 완료", "s-saved"], failed: ["실패", "s-fail"],
};
let topPick = null;
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
  if (h === "plan") return showPlan();
  if (h === "stats") return showStats();
  if (h === "guest") return showGuests();
  show("upload");
}

function show(v) {
  for (const s of ["login", "upload", "jobs", "choose", "preview", "plan", "stats", "guest"]) $("v-" + s).hidden = s !== v;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.v === v || ((v === "preview" || v === "choose") && a.dataset.v === "jobs")));
  if (timer) { clearInterval(timer); timer = null; }               // 화면마다 자기 새로고침만
  if (v === "upload") { $("ios-tip").hidden = !(isIOS() && !standalone()); loadTop5(); }
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
  $("up-msg").textContent = fs.length > MAX ? `한 번에 ${MAX}장까지 올라갑니다. 앞의 ${MAX}장만 올립니다.` : "";   // 저장 이름이 두 자리 번호(01~99)
  $("thumbs").replaceChildren(...picked.map((f) => { const im = document.createElement("img"); im.src = URL.createObjectURL(f); return im; }));
  $("pick-text").textContent = picked.length ? `📷 ${picked.length}장 선택됨 (다시 고르기)` : "📷 사진 고르기 (시공 1건)";
  updateSend();
});

// 한 줄 입력: 바로 나눠 보여 주고, 못 알아들으면 비슷한 견본 3~4개를 띄워 한 번 눌러 고르게 한다
$("hint").addEventListener("input", () => { clearTimeout(readHint.t); readHint.t = setTimeout(readHint, 250); });
$("hint").addEventListener("change", readHint);

function readHint() {
  const text = $("hint").value.split("/")[0];                  // '/' 뒤는 손님 사연(나누지 않음)
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
  const [head, ...rest] = $("hint").value.trim().split("/");
  const text = head.trim(), story = rest.join("/").trim();
  const only = $("only-blog").value;
  let a = null;
  if (!text && topPick) a = { keyword: topPick.keyword, car: topPick.car || undefined, from: "top5" };   // 한 줄이 비면 고른 추천으로
  else if (text && hint) {
    a = { text: text.slice(0, 40) };
    if (hint.car) a.car = hint.car;
    const code = hintPick || hint.code;
    if (code) { const s = sampleOf(code); Object.assign(a, { sample: code, pattern: s.pattern, color: s.name }); }
    else { if (hint.pattern) a.pattern = hint.pattern; if (hint.color) a.color = hint.color; }
  }
  if (story) (a ||= {}).story = story.slice(0, 60);            // 손님 사연: 적은 뜻 그대로만 글에 씀
  if (only) (a ||= {}).only_blog = only;                       // 이 건은 한 블로그만
  const size = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
  while (a && a.story && size(a) > 480) a.story = a.story.slice(0, -1);   // DB 한도 500바이트(한글 3바이트)
  return a;
}

$("video").addEventListener("change", () => {
  const f = $("video").files[0] || null;
  video = null;
  $("video-msg").className = "muted";
  $("video-msg").textContent = "";
  $("video-text").textContent = "🎬 동영상 고르기 (1개, 선택 사항, 45MB 이하)";
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
    topPick = null;
    readHint();
    $("video-text").textContent = "🎬 동영상 고르기 (1개, 선택 사항, 45MB 이하)";
    $("thumbs").replaceChildren();
    $("pick-text").textContent = "📷 사진 고르기 (시공 1건)";
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
  $("sched").hidden = true;
  $("pv-tabs").hidden = true;
  let { data: j, error } = await sb.from("mobile_jobs").select("id,status,title,preview,note,choices,answer,scheduled").eq("id", id).maybeSingle();
  if (error) ({ data: j } = await sb.from("mobile_jobs").select("id,status,title,preview,note,choices,answer").eq("id", id).maybeSingle());
  if (!j) { $("pv-info").textContent = "글을 찾을 수 없습니다."; return; }
  if (j.status === "needs_choice") return showChoose(j);
  const pv = j.preview || {};
  if (!pv.title) { $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} ${j.note || ""}`; return; }
  const urls = {};
  if (pv.photos?.length && !pv.photos_removed) {
    const { data } = await sb.storage.from("previews").createSignedUrls(pv.photos, 3600);
    for (const x of data || []) if (x.signedUrl) urls[x.path] = x.signedUrl;
  }
  const posts = pv.posts?.length ? pv.posts : [pv];             // 블로그별 글(예전 글은 1편)
  const tabs = $("pv-tabs");
  tabs.replaceChildren(...posts.map((P, k) => {
    const b = el("button", `${k + 1}. ${P.site_name || pv.site_name || "블로그"}`, "tab");
    b.onclick = () => renderPost(j, pv, posts, k, urls);
    return b;
  }));
  tabs.hidden = posts.length < 2;
  renderPost(j, pv, posts, 0, urls);
}

function renderPost(j, pv, posts, k, urls) {
  const P = posts[k];
  const art = $("pv");
  art.replaceChildren();
  $("pv-tabs").querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === k));
  const L = layout(P, pv);
  const add = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; art.append(e); return e; };
  const paras = (text) => String(text || "").split("\n").filter((s) => s.trim()).forEach((s) => add("p", s));
  if (P.title_candidates?.length) add("p", "제목 후보: " + P.title_candidates.map((x, i) => `${i + 1}. ${x}`).join("  /  "), "tags");
  if (P.home_title) add("p", "홈판용 제목: " + P.home_title, "tags");
  add("h2", P.title);
  paras(P.intro);
  const photo = (p, ref) => {
    add("div", `[사진${L.order.indexOf(p) + 1}]` + (ref ? " 참고 사진(이번 손님 차 아님)" : ""), "photo-no");   // 본문 복사의 [사진n] = 저장되는 사진 n번
    if (!urls[p]) return;
    const im = document.createElement("img");
    im.src = urls[p];
    im.loading = "lazy";
    art.append(im);
  };
  for (const s of P.sections || []) {
    add("h3", s.heading);
    for (const p of s.refs || []) photo(p, true);
    for (const p of s.photos || []) photo(p, false);
    paras(s.body);
  }
  if (pv.video) add("div", "🎬 [동영상] 자리 — 올린 시공 동영상을 여기에 넣으세요. 동영상은 자동 가림이 안 되므로 번호판·얼굴이 보이면 넣지 마세요.", "video-slot");
  if (P.qna?.length) { add("h3", "자주 묻는 질문"); for (const q of P.qna) { add("p", "Q. " + q.q, "q"); add("p", "A. " + q.a); } }
  if (P.summary?.length) { add("h3", "한눈에 정리"); for (const r of P.summary) add("p", `${r.item}: ${r.value}`); }
  paras(P.outro);
  if (P.related_posts?.length) { add("h3", "함께 보면 좋은 글"); for (const r of P.related_posts) add("p", "· " + r.title); }
  paras(P.store_info);
  add("p", (P.tags || []).map((x) => "#" + String(x).replace(/^#/, "")).join(" "), "tags");
  $("pv-info").textContent = `${(STATUS[j.status] || [j.status])[0]} · ${posts.length > 1 ? `블로그별 글 ${posts.length}편 중 ${k + 1}번 · ` : ""}`
    + `블로그 ${P.site_name || pv.site_name || "-"} · 주 검색어 ${P.keyword || pv.keyword || "-"}`
    + (P.sub_keywords?.length ? ` · 보조 ${P.sub_keywords.join(", ")}` : "")
    + (P.grade ? ` · 점수 ${P.grade} ${Math.round(P.score)}점` : "")
    + (pv.cost_krw != null ? ` · 이 시공 건 AI 비용 약 ${Math.round(pv.cost_krw).toLocaleString()}원` : "")
    + (pv.left_out?.length ? ` · 확실하지 않아 뺀 것: ${pv.left_out.join(", ")}` : "")
    + (pv.photos_removed ? " · 사진 미리보기 기간(30일)이 지났습니다" : "");
  $("pv-draft").textContent = "붙여 넣기 순서: ① 사진 순서대로 저장 → ② 네이버 블로그 앱에서 제목·본문 붙여 넣기 → "
    + "③ 본문의 [사진1]·[사진2] 자리에 같은 번호 사진 넣기 → ④ 태그 붙여 넣기 → ⑤ 예약 발행 후 아래 '예약 완료'"
    + (posts.length > 1 ? " · 블로그마다 따로 붙여 넣고, 위 단추로 다른 블로그 글로 바꿉니다" : "");
  $("pv-draft").className = "draft";
  $("pv-draft").hidden = false;
  copyButton("cp-title", "📋 제목 복사", P.title);
  copyButton("cp-body", "📋 본문 복사", L.body);
  copyButton("cp-tags", "📋 태그 복사", L.tags);
  const order = L.order.filter((p) => urls[p]);
  const files = order.length === L.order.length ? prefetchPhotos(order.map((p) => urls[p]), j.id, k) : null;
  $("cp-photos").hidden = !files;
  $("cp-photos").textContent = `📷 사진 ${order.length}장 순서대로 저장`;
  $("cp-photos").onclick = () => savePhotos(files);
  $("copybar").hidden = false;
  showSchedule(j, P, k);
}

// 본문 복사용 글: 사진 자리는 [사진1]처럼(저장되는 사진 파일 번호와 같음). 사진 번호 = 글에 처음 나오는 순서(참고 사진 포함).
function layout(P, pv) {
  const order = [];
  for (const s of P.sections || []) for (const p of [...(s.refs || []), ...(s.photos || [])]) if (!order.includes(p)) order.push(p);
  const out = [P.intro || "", ""];
  for (const s of P.sections || []) {
    out.push(`■ ${s.heading}`);
    for (const p of s.refs || []) out.push(`[사진${order.indexOf(p) + 1}] (참고 사진)`);
    for (const p of s.photos || []) out.push(`[사진${order.indexOf(p) + 1}]`);
    out.push(s.body || "", "");
  }
  if (pv.video) out.push("[동영상] ← 올린 시공 동영상(번호판·얼굴 확인)", "");
  if (P.qna?.length) out.push("■ 자주 묻는 질문", ...P.qna.map((q) => `Q. ${q.q}\nA. ${q.a}`), "");
  if (P.summary?.length) out.push("■ 한눈에 정리", ...P.summary.map((r) => `${r.item}: ${r.value}`), "");
  out.push(P.outro || "", "");
  if (P.related_posts?.length) out.push("■ 함께 보면 좋은 글", ...P.related_posts.map((r) => `${r.title} ${r.url || ""}`.trim()), "");
  if (P.store_info) out.push(P.store_info);
  return { order, body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
           tags: (P.tags || []).map((x) => "#" + String(x).replace(/^#/, "")).join(" ") };
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

// 미리보기를 열 때 사진을 미리 받아 둔다(아이폰은 버튼을 누른 직후에만 저장 창을 열 수 있어서).
// 파일 이름 = 순서 번호: 블로그_<글번호 앞 6자리>_사진01.jpg …
function prefetchPhotos(list, jobId, k = 0) {
  return Promise.all(list.map(async (u, i) => {
    const blob = await (await fetch(u)).blob();
    return new File([blob], `블로그_${String(jobId).slice(0, 6)}${k ? "_" + (k + 1) : ""}_사진${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" });
  }));
}

function isAndroid() { return /Android/i.test(navigator.userAgent); }

async function savePhotos(filesP) {
  const b = $("cp-photos");
  const label = b.textContent;
  let files;
  try { files = await filesP; } catch (_) { b.textContent = "사진을 받지 못했습니다 — 화면을 새로 열어 주세요"; return; }
  try {
    if (!isAndroid() && navigator.canShare && navigator.canShare({ files })) {
      // 아이폰: 공유 창에서 '이미지 n개 저장' → 사진 앱에 순서대로 저장
      await navigator.share({ files });
      b.textContent = "저장 완료 — 사진 앱 최근 항목에 순서대로 있습니다";
    } else {
      // 안드로이드·PC: 다운로드로 저장(갤러리 'Download' 앨범, 이름 순 = 글 순서). 처음 한 번 '여러 파일 다운로드 허용'
      for (const f of files) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(f);
        a.download = f.name;
        document.body.append(a);
        a.click();
        a.remove();
        await new Promise((r) => setTimeout(r, 350));
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      b.textContent = `${files.length}장 저장 — 갤러리 'Download' 앨범`;
    }
  } catch (e) {
    if (e && e.name === "AbortError") b.textContent = label;
    else if (e && e.name === "NotAllowedError") b.textContent = "준비됐습니다 — 한 번 더 눌러 주세요";
    else b.textContent = "사진 저장 실패 — 사진을 길게 눌러 저장하세요";
  }
  setTimeout(() => { b.textContent = label; }, 5000);
}

// ---------------- 예약(사장님이 네이버 앱에서 직접 예약한 것을 기록) ----------------
const RECO_HOUR = 9;          // 추천 시각 고정(매일 오전 9시). 일부러 섞지 않는다.
const DAY = 864e5;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localIso = (d) => `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const fmt = (s) => new Date(s).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });

// 예약 기록: 예전 {blog, at, marked_at}(글 1편) 또는 {v: {"0": {at, m}, "1": {...}}}(블로그별 글 번호마다). DB 한도 300바이트.
function schedOf(j, k) {
  const s = j.scheduled;
  if (!s) return null;
  if (s.v) return s.v[k] || null;
  return k === 0 && s.at ? s : null;
}
function withSched(j, k, val) {
  const v = j.scheduled?.v ? { ...j.scheduled.v } : (j.scheduled?.at ? { 0: { at: j.scheduled.at, m: j.scheduled.marked_at?.slice(0, 16) } } : {});
  if (val) v[k] = val; else delete v[k];
  return Object.keys(v).length ? { v } : null;
}

// 추천 날짜(PC 설정 policy_rules.json publishing): 블로그별 하루 1편, 같은 시공 건의 블로그별 글은 앞 글보다 2~3일 뒤,
// 블로그별 처음 2주는 주 2~3편만, 그 뒤 주 5편까지. 이미 예약한 날·주 편수는 건너뛴다.
function planSchedule(items) {
  const R = items.find((x) => x.rules)?.rules || { case_gap_days: [2, 3], ramp_weeks: 2, ramp_per_week: 3, after_per_week: 5 };
  const taken = {}, start = {}, plan = {};
  const day0 = new Date(); day0.setHours(RECO_HOUR, 0, 0, 0);
  for (const x of items) if (x.at) {
    (taken[x.site] ||= new Set()).add(x.at.slice(0, 10));
    const d = new Date(x.at.slice(0, 10) + "T00:00");
    if (!start[x.site] || d < start[x.site]) start[x.site] = d;
  }
  const weekOf = (site, d) => Math.floor((d - start[site]) / (7 * DAY));
  const cap = (site, d) => (d - start[site] < R.ramp_weeks * 7 * DAY ? R.ramp_per_week : R.after_per_week);
  const count = (site, w) => [...(taken[site] || [])].filter((s) => weekOf(site, new Date(s + "T00:00")) === w).length;
  const first = {};
  for (const x of [...items].filter((y) => !y.at).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.k - b.k)) {
    const base = x.k > 0 && first[x.job] ? new Date(first[x.job].getTime() + (x.offset || R.case_gap_days[0]) * DAY) : new Date(day0.getTime() + DAY);
    let d = base < day0 ? new Date(day0.getTime() + DAY) : base;
    const used = (taken[x.site] ||= new Set());
    for (let n = 0; n < 120; n++, d = new Date(d.getTime() + DAY)) {
      if (!start[x.site]) start[x.site] = new Date(ymd(d) + "T00:00");
      if (!used.has(ymd(d)) && count(x.site, weekOf(x.site, new Date(ymd(d) + "T00:00"))) < cap(x.site, new Date(ymd(d) + "T00:00"))) break;
    }
    used.add(ymd(d));
    if (x.k === 0) first[x.job] = d;
    plan[x.key] = localIso(d);
  }
  return plan;
}

// 완성 글 → 블로그별 글 목록(글 1편 = 항목 1개). 미리보기 전체 대신 요약(post_meta)만 받는다.
async function writtenItems() {
  let { data, error } = await sb.from("mobile_jobs")
    .select("id,title,created_at,scheduled,site:preview->>site_name,meta:preview->post_meta,rules:preview->schedule_rules")
    .eq("status", "written").order("created_at", { ascending: true }).limit(200);
  if (error) return { items: null, error };
  const items = [];
  for (const j of data) {
    const metas = j.meta?.length ? j.meta : [{ site_name: j.site, title: j.title, offset_days: 0 }];
    metas.forEach((m, k) => {
      const s = schedOf(j, k);
      items.push({ key: `${j.id}:${k}`, job: j.id, k, site: m.site_name || "담당 블로그 미정", title: m.title || j.title,
                   created_at: j.created_at, offset: m.offset_days || 0, at: s?.at || null, rules: j.rules, j });
    });
  }
  return { items };
}

async function showSchedule(j, P, k) {
  const box = $("sched");
  box.hidden = false;
  const { items, error } = await writtenItems();
  if (error || !("scheduled" in j)) { $("sched-msg").textContent = "예약 기록은 DB 준비 후 켜집니다."; $("sched-at").hidden = $("sched-done").hidden = true; return; }
  $("sched-at").hidden = $("sched-done").hidden = false;
  const reco = planSchedule(items)[`${j.id}:${k}`] || localIso(new Date(Date.now() + DAY));      // 예약 목록 화면과 같은 추천
  const render = () => {
    const s = schedOf(j, k);
    $("sched-msg").textContent = s?.at ? `✅ 예약됨: ${P.site_name || ""} ${fmt(s.at)}`
      : `추천: ${P.site_name || ""} ${fmt(reco)} (같은 블로그 하루 1편${k ? ", 같은 시공 건 앞 글보다 2~3일 뒤" : ""})`;
    $("sched-done").textContent = s?.at ? "예약 취소 기록" : "✅ 예약 완료";
  };
  $("sched-at").value = schedOf(j, k)?.at || reco;
  render();
  $("sched-done").onclick = async () => {
    const cur = schedOf(j, k);
    const at = $("sched-at").value;
    if (!cur?.at && !at) return;
    const val = withSched(j, k, cur?.at ? null : { at, m: new Date().toISOString().slice(0, 16) });
    const { error: e } = await sb.from("mobile_jobs").update({ scheduled: val }).eq("id", j.id);
    if (e) { $("sched-msg").textContent = "기록 실패 — 잠시 뒤 다시 눌러 주세요"; return; }
    j.scheduled = val;
    render();
  };
}

// 이번 주 예약 목록: 아직 예약 안 한 블로그별 글을, 추천 날짜와 함께
async function showPlan() {
  show("plan");
  const list = $("plan-list");
  list.replaceChildren();
  const { items, error } = await writtenItems();
  if (error) { $("plan-msg").textContent = "예약 목록은 DB 준비 후 켜집니다."; return; }
  const plan = planSchedule(items);
  const weekEnd = Date.now() + 7 * DAY;
  const sites = [...new Set(items.map((x) => x.site))];
  $("plan-msg").textContent = items.some((x) => !x.at)
    ? `추천 시각은 매일 ${RECO_HOUR}시(고정). 블로그마다 하루 1편, 처음 2주는 주 2~3편, 같은 시공 건은 2~3일씩 띄웁니다. 글을 눌러 붙여 넣고 예약한 뒤 '예약 완료'를 누르세요.`
    : "예약할 글이 없습니다.";
  for (const site of sites) {
    const mine = items.filter((x) => x.site === site);
    const todo = mine.filter((x) => !x.at).sort((a, b) => plan[a.key].localeCompare(plan[b.key]));
    const done = mine.filter((x) => x.at && new Date(x.at) >= new Date(Date.now() - DAY) && new Date(x.at) <= weekEnd);
    if (!todo.length && !done.length) continue;
    const h = document.createElement("h3");
    h.textContent = `${site} — 예약할 글 ${todo.length}편`;
    list.append(h);
    for (const x of [...todo, ...done]) {
      const li = document.createElement("li");
      const when = document.createElement("span");
      when.className = "badge " + (x.at ? "s-done" : "s-ask");
      when.textContent = x.at ? `예약됨 ${fmt(x.at)}` : `추천 ${fmt(plan[x.key])}`;
      const tt = document.createElement("div");
      tt.className = "title";
      tt.textContent = x.title || "(제목 없음)";
      li.append(when, tt);
      li.addEventListener("click", () => { location.hash = "#job=" + x.job; });
      list.append(li);
    }
  }
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

// ---------------- 다음 글 추천 TOP 5(PC가 매일 계산) ----------------
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

async function loadTop5() {
  const box = $("top5");
  const { data, error } = await sb.from("mobile_suggestions").select("rank,car,keyword,site_name,grade,reason,facts,updated_at").order("rank");
  if (error || !data || !data.length) { box.hidden = true; return; }
  box.hidden = false;
  const sel = $("only-blog");                                    // 글을 쓸 블로그(이 건은 한 블로그만) 목록
  for (const name of [...new Set(data.map((s) => s.site_name).filter(Boolean))]) {
    if (![...sel.options].some((o) => o.value === name)) sel.append(new Option(`${name}만`, name));
  }
  const list = $("top5-list");
  const items = [];
  let site = null;
  for (const s of data) {                                        // 블로그별로 나눠서
    if (s.site_name !== site) { site = s.site_name; items.push(el("h4", `📝 ${site || "담당 블로그 미정"}`, "top-site")); }
    items.push(s);
  }
  list.replaceChildren(...items.map((s) => {
    if (s instanceof HTMLElement) return s;
    const li = el("li", null, "top");
    const head = el("div", null, "row");
    head.append(el("b", `${s.facts?.site_rank || s.rank}. ${s.keyword}`), el("span", `기회 ${s.grade || "-"} (추정치)`, "badge s-ask"));
    li.append(head, el("div", `${s.car || ""} · 담당 ${s.site_name || "-"}`, "muted"), el("div", s.reason, "why"));
    li.classList.toggle("on", topPick?.keyword === s.keyword);
    li.addEventListener("click", () => {
      topPick = topPick?.keyword === s.keyword ? null : s;
      list.querySelectorAll("li.top").forEach((x) => x.classList.toggle("on", x === li && !!topPick));
      $("top5-msg").textContent = topPick ? `✓ '${s.keyword}'로 씁니다(한 줄 입력이 비어 있을 때). 같은 차 사진을 올려 주세요.` : "";
    });
    return li;
  }));
  $("top5-when").textContent = `계산 ${new Date(data[0].updated_at).toLocaleDateString("ko-KR")} · (실제)=네이버 API 값, (추정치)=계산값`;
}

// ---------------- 통계 올리기(네이버 블로그 앱 통계 > 유입분석 캡처) ----------------
const TSTATUS = { uploaded: ["읽는 중", "s-wait"], reading: ["읽는 중", "s-wait"], needs_blog: ["블로그 고르기", "s-ask"],
  confirm: ["숫자 확인", "s-ask"], duplicate: ["덮어쓸까요?", "s-ask"], saved: ["저장됨", "s-done"], failed: ["실패", "s-fail"] };

$("stat-files").addEventListener("change", () => {
  const fs = [...$("stat-files").files].slice(0, 10);
  $("stat-send").disabled = !fs.length;
  $("stat-msg").textContent = fs.length ? `캡처 ${fs.length}장 선택됨` : "";
});

$("stat-send").addEventListener("click", async () => {
  const fs = [...$("stat-files").files].slice(0, 10);
  if (!fs.length) return;
  $("stat-send").disabled = true;
  const id = crypto.randomUUID(), paths = [];
  try {
    for (let i = 0; i < fs.length; i++) {
      $("stat-msg").textContent = `${i + 1} / ${fs.length}장 올리는 중…`;
      const { blob } = await shrink(fs[i]);
      const path = `${me.id}/${id}/${String(i + 1).padStart(2, "0")}.jpg`;
      const { error } = await sb.storage.from("stats").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      paths.push(path);
    }
    const { error } = await sb.from("traffic_uploads").insert({ id, org_id: member.org_id, user_id: me.id, image_paths: paths });
    if (error) throw error;
    $("stat-files").value = "";
    $("stat-msg").textContent = "올렸습니다. PC가 읽으면 아래에 표가 나옵니다.";
    loadStats();
  } catch (e) {
    $("stat-msg").textContent = "올리기 실패: " + (e.message || e);
    $("stat-send").disabled = false;
  }
});

async function showStats() {
  show("stats");
  await loadStats();
  if (!timer) timer = setInterval(() => { if (!document.hidden) loadStats(); }, 6000);
}

async function answerStat(id, answer) {
  const { error } = await sb.from("traffic_uploads").update({ answer }).eq("id", id);
  $("stat-msg").textContent = error ? "기록 실패 — 다시 눌러 주세요" : "전달했습니다. PC가 곧 처리합니다.";
  loadStats();
}

function statTable(ex) {
  const t = el("table", null, "stat");
  const add = (title, rows) => {
    if (!rows?.length) return;
    const h = el("tr"); h.append(el("th", title), el("th", "수"), el("th", "%")); t.append(h);
    for (const r of rows) { const tr = el("tr"); tr.append(el("td", r.name), el("td", r.count ?? "-"), el("td", r.share ?? "-")); t.append(tr); }
  };
  add("유입경로", ex.sources);
  add("검색어", ex.keywords);
  return t;
}

async function loadStats() {
  const { data, error } = await sb.from("traffic_uploads").select("id,status,period_start,period_end,extracted,choices,answer,note,created_at")
    .order("created_at", { ascending: false }).limit(10);
  if (error) return;
  $("stat-list").replaceChildren(...data.map((j) => {
    const [label, cls] = TSTATUS[j.status] || [j.status, "s-wait"];
    const li = el("li");
    const row = el("div", null, "row");
    row.append(el("span", `${new Date(j.created_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
      + (j.period_start ? ` · ${j.period_start}~${j.period_end}` : ""), "muted"), el("span", label, "badge " + cls));
    li.append(row);
    if (j.note) li.append(el("div", j.note, "title"));
    const ex = j.extracted || {};
    const waiting = j.answer != null;
    if (j.status === "confirm" || j.status === "duplicate") li.append(el("div", `블로그: ${ex.blog_name || "-"} · 기간: ${ex.period_label || "-"}`, "muted"), statTable(ex));
    const bar = el("div", null, "btns");
    if (!waiting && j.status === "needs_blog") for (const s of j.choices?.sites || []) {
      const b = el("button", s.name, "primary"); b.onclick = () => answerStat(j.id, { site_id: s.id }); bar.append(b);
    }
    if (!waiting && j.status === "confirm") {
      const ok = el("button", "✅ 맞음", "primary"); ok.onclick = () => answerStat(j.id, { confirm: true });
      const no = el("button", "틀림(저장 안 함)", "ghost"); no.onclick = () => answerStat(j.id, { confirm: false });
      bar.append(ok, no);
    }
    if (!waiting && j.status === "duplicate") {
      const ow = el("button", "새 캡처로 덮어쓰기", "primary"); ow.onclick = () => answerStat(j.id, { overwrite: true });
      const keep = el("button", "기존 것 그대로", "ghost"); keep.onclick = () => answerStat(j.id, { overwrite: false });
      bar.append(ow, keep);
    }
    if (waiting) bar.append(el("span", "PC가 처리하는 중…", "muted"));
    if (bar.childNodes.length) li.append(bar);
    return li;
  }));
}

// ---------------- 블로그 보고 온 손님(문의 기록) ----------------
async function showGuests() {
  show("guest");
  $("g-date").value = ymd(new Date());
  const { jobs } = await writtenJobs();
  $("g-job").replaceChildren(el("option", "(모름)"), ...(jobs || []).slice().reverse().map((j) => { const o = el("option", j.title || "(제목 없음)"); o.value = j.id; return o; }));
  $("g-job").options[0].value = "";
  await loadGuests();
}

$("g-save").addEventListener("click", async () => {
  const row = { org_id: member.org_id, user_id: me.id, inquired_on: $("g-date").value || ymd(new Date()),
                car: $("g-car").value.trim().slice(0, 40) || null, job_id: $("g-job").value || null };
  const { error } = await sb.from("inquiries").insert(row);
  $("g-msg").textContent = error ? "기록 실패: " + error.message : "✅ 기록했습니다. 시공하면 아래에서 체크하세요.";
  if (!error) { $("g-car").value = ""; loadGuests(); }
});

async function loadGuests() {
  const { data, error } = await sb.from("inquiries").select("id,inquired_on,car,installed,job_id").order("inquired_on", { ascending: false }).limit(30);
  if (error) { $("g-msg").textContent = "문의 기록을 불러오지 못했습니다."; return; }
  const month = ymd(new Date()).slice(0, 7);
  const mine = data.filter((x) => x.inquired_on.startsWith(month));
  $("g-sum").textContent = `이번 달 문의 ${mine.length}건 · 시공 ${mine.filter((x) => x.installed).length}건`;
  $("g-list").replaceChildren(...data.map((q) => {
    const li = el("li", null, "row");
    li.append(el("span", `${q.inquired_on} · ${q.car || "차종 모름"}`));
    const lab = el("label", null, "chk");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!q.installed;
    cb.onchange = async () => { await sb.from("inquiries").update({ installed: cb.checked }).eq("id", q.id); loadGuests(); };
    lab.append(cb, document.createTextNode(" 시공함"));
    li.append(lab);
    return li;
  }));
}

boot();
