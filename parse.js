// '차종 패턴 색상' 한 줄 나누기. PC의 core/samples.py parse_line과 같은 규칙(바꿀 때 둘 다, tests/test_samples.py가 비교).
// 순서·띄어쓰기가 달라도 되고, 색은 견본 이름으로 바꾼다(P3의 '아이보리' → '마일드아이보리').
"use strict";
(function (root) {
  const SYNONYMS = {
    "검정": "블랙", "검정색": "블랙", "검은색": "블랙", "까만색": "블랙", "빨강": "레드", "빨간색": "레드", "빨강색": "레드",
    "파랑": "블루", "파란색": "블루", "파랑색": "블루", "네이비": "블루", "남색": "블루", "회색": "그레이", "흰색": "화이트",
    "하얀색": "화이트", "주황": "주홍", "주황색": "주홍", "갈색": "브라운", "밤색": "브라운", "분홍": "핑크", "분홍색": "핑크",
    "보라": "퍼플", "보라색": "퍼플", "와인": "와인", "베이지": "아이보리", "크림": "아이보리", "카멜": "카라멜",
    "캐주얼레드": "레드",
  };
  const BASE_WORDS = ["블랙", "블루", "아이보리", "브라운", "그레이", "레드", "와인", "주홍", "오렌지", "핑크", "퍼플", "화이트",
    "라떼", "커피", "카라멜", "마일드", "럭셔리", "다크", "라이트", "시그니처"];
  const FILLER = new Set(["엠보싱", "카매트", "매트", "패턴", "색상", "색", "컬러", "시공"]);

  const allColors = (data) => Object.values(data).flatMap((v) => v.colors);

  function vocab(data) {
    return new Set([...allColors(data).map((c) => c.name), ...BASE_WORDS, ...Object.keys(SYNONYMS)]);
  }

  function colorMatches(word, colors) {
    const w = SYNONYMS[word] || word;
    const exact = colors.filter((c) => c.name === w);
    if (exact.length) return exact;
    return colors.filter((c) => c.name.endsWith(w) || c.name.startsWith(w) || (w.length >= 3 && c.name.includes(w))
      || (c.name.length >= 2 && (w.endsWith(c.name) || w.startsWith(c.name))));
  }

  function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out.size ? out : new Set([s]);
  }

  function similar(a, b) {
    const x = bigrams(a), y = bigrams(b);
    let inter = 0;
    for (const v of x) if (y.has(v)) inter++;
    return inter / new Set([...x, ...y]).size;
  }

  function nearest(colors, rgb, n = 4) {
    if (!rgb) return colors.slice(0, n);
    const d = (c) => c.rgb.reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
    return [...colors].sort((a, b) => d(a) - d(b)).slice(0, n);
  }

  function meanRgb(cs) {
    return cs.length ? [0, 1, 2].map((i) => cs.reduce((s, c) => s + c.rgb[i], 0) / cs.length) : null;
  }

  // P3 / p-3 / 패턴3 / 3번 패턴 (영문·숫자 바로 뒤의 p는 제외: PV5·EV9 같은 차 이름)
  const PAT_RE = /(^|[^a-z0-9])p\s*-?\s*(\d)(?!\d)|패턴\s*(\d)(?!\d)|(^|\D)(\d)\s*번?\s*패턴/;

  function parseLine(text, data) {
    const out = { status: "empty", car: null, pattern: null, color: null, code: null, suggestions: [], message: "" };
    let s = String(text || "").trim().split(/\s+/).filter(Boolean).join(" ");
    if (!s) return out;
    const m = PAT_RE.exec(s.toLowerCase());
    let badPattern = null;
    if (m) {
      const d = m[2] || m[3] || m[5];
      const start = m.index + (m[1] !== undefined ? m[1].length : m[4] !== undefined ? m[4].length : 0);
      const end = m.index + m[0].length;
      if (data["P" + d]) out.pattern = "P" + d; else badPattern = "P" + d;
      s = (s.slice(0, start) + " " + s.slice(end)).trim();
    }
    const vc = vocab(data);
    const tokens = s.split(/[\s,/·]+/).filter((t) => t && !FILLER.has(t))
      .map((t) => (t.endsWith("색") && !vc.has(t) && vc.has(t.slice(0, -1)) ? t.slice(0, -1) : t));
    const pool = out.pattern ? data[out.pattern].colors : allColors(data);
    const every = allColors(data);

    let colorWord = null, used = new Set();
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (vc.has(tokens[i] + tokens[i + 1])) { colorWord = tokens[i] + tokens[i + 1]; used = new Set([i, i + 1]); break; }
    }
    if (colorWord === null) {
      for (let i = 0; i < tokens.length; i++) if (vc.has(tokens[i])) { colorWord = tokens[i]; used = new Set([i]); break; }
    }
    let suspect = null;
    if (colorWord === null && out.pattern && tokens.length >= 2) {
      let best = [0, -1];
      tokens.forEach((t, i) => pool.forEach((c) => {
        const v = similar(t, c.name);
        if (v > best[0] || (v === best[0] && i > best[1])) best = [v, i];
      }));
      if (best[0] >= 0.3) { suspect = tokens[best[1]]; used = new Set([best[1]]); }
    }
    const car = tokens.filter((_, i) => !used.has(i)).join(" ").trim();
    out.car = car.slice(0, 40) || null;

    const ask = (cands, msg) => Object.assign(out, { status: "pick", suggestions: cands.slice(0, 4).map((c) => c.code), message: msg });

    if (badPattern) {
      out.status = "fix";
      out.message = `${badPattern}는 견본에 없습니다(P2 P3 P5 P7 P8 P9 중에서)`;
      if (colorWord) return ask(colorMatches(colorWord, every), out.message + " · 비슷한 견본을 눌러 고르세요");
      return out;
    }
    if (suspect) {
      const sims = [...pool].sort((a, b) => similar(suspect, b.name) - similar(suspect, a.name));
      return ask(sims, `'${suspect}'을(를) 못 알아들었습니다. ${out.pattern}에서 눌러 고르세요`);
    }
    if (colorWord) {
      const hits = colorMatches(colorWord, pool);
      if (out.pattern) {
        if (hits.length === 1) { out.color = hits[0].name; out.code = hits[0].code; }
        else if (hits.length) return ask(hits, `${out.pattern}에 '${colorWord}'이(가) 여러 개입니다. 눌러 고르세요`);
        else return ask(nearest(pool, meanRgb(colorMatches(colorWord, every))), `${out.pattern}에는 '${colorWord}'이(가) 없습니다. 비슷한 색을 눌러 고르세요`);
      } else {
        const names = [...new Set(hits.map((c) => c.name))].sort();
        if (names.length === 1) out.color = names[0];
        else if (names.length) return ask(hits, `'${colorWord}'이(가) 여러 색입니다. 눌러 고르세요`);
      }
    }
    out.status = "ok";
    out.message = [out.car ? `차종 ${out.car}` : "", out.pattern ? data[out.pattern].label : "", out.color || ""].filter(Boolean).join(" · ");
    return out;
  }

  root.NBM_parseLine = parseLine;
  if (typeof module !== "undefined" && module.exports) module.exports = { parseLine };
})(typeof window !== "undefined" ? window : globalThis);
