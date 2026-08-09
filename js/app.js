/* ============================================================
   主程式：斷詞 → 分組 → 查詞 → 顯示 → 翻譯
   ============================================================ */
(function(){
"use strict";

let tokenizerReady = false;
const $ = s => document.querySelector(s);
const statusEl = $("#status");

/* ---------- 工具 ---------- */
const kata2hira = s => (s||"").replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0)-0x60));
const hasKanji  = s => /[一-鿿㐀-䶿]/.test(s);
const isPunct   = t => t.pos === "記号";
const esc       = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ---------- 載入 kuromoji ----------
   kuromoji 內部用的 XHR 沒有設 timeout：只要 12 個詞典檔中有任何一個
   在行動網路上卡住，build() 的 callback 就永遠不會被呼叫——沒有錯誤、
   沒有進度，畫面就無限停在「正在載入」。
   所以這裡先自己把檔案抓下來（可顯示進度、可逾時、可重試），
   抓完才交給 kuromoji，它再讀取時會直接命中瀏覽器快取。            */
const DIC_PATHS = [
  "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/",
  "https://unpkg.com/kuromoji@0.1.2/dict/"
];
/* 網址加 ?src=unpkg 可強制改用備援來源（某些網路會擋 jsdelivr） */
if (/[?&]src=unpkg/.test(location.search)) DIC_PATHS.reverse();
/* 檔名與實測大小（bytes），用來算準確的進度百分比 */
const DIC_FILES = [
  ["base.dat.gz",       3953000],
  ["cc.dat.gz",         1688000],
  ["check.dat.gz",      3114000],
  ["tid.dat.gz",        1604000],
  ["tid_map.dat.gz",    1489000],
  ["tid_pos.dat.gz",    5914000],
  ["unk.dat.gz",           6000],
  ["unk_char.dat.gz",      1000],
  ["unk_compat.dat.gz",    1000],
  ["unk_invoke.dat.gz",    1000],
  ["unk_map.dat.gz",       1000],
  ["unk_pos.dat.gz",       7000]
];
const DIC_TOTAL = DIC_FILES.reduce((a, f) => a + f[1], 0);
const FILE_TIMEOUT = 60000;    // 單一檔案逾時
const BUILD_TIMEOUT = 90000;   // 解壓／建索引逾時

const MB = n => (n / 1048576).toFixed(1);

function setStatus(cls, html){
  statusEl.className = "status " + cls;
  statusEl.innerHTML = html;
}
function showProgress(done, total, note){
  const pct = Math.min(100, Math.round(done / total * 100));
  setStatus("loading",
    '<span>正在載入日文詞典 ' + MB(done) + " / " + MB(total) + " MB（" + pct + "%）" +
    (note ? "　" + esc(note) : "") + "</span>" +
    '<span class="bar"><i style="width:' + pct + '%"></i></span>');
}
function showError(msg, detail){
  setStatus("error",
    "<span>" + esc(msg) + "</span>" +
    (detail ? '<span class="detail">' + esc(detail) + "</span>" : "") +
    '<span><button type="button" id="retry-dict" class="ghost small">重新載入詞典</button></span>');
  const b = document.getElementById("retry-dict");
  if (b) b.onclick = () => { loadDictionary(0); };
}

/* 帶逾時的 fetch；回傳下載到的位元組數 */
function fetchWithTimeout(url, ms){
  return new Promise((resolve, reject) => {
    let settled = false;
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (ctrl) try{ ctrl.abort(); }catch(e){}
      reject(new Error("逾時（" + (ms/1000) + " 秒無回應）"));
    }, ms);
    fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(buf => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve(buf.byteLength);
      })
      .catch(e => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(e);
      });
  });
}

/* 依序抓完所有詞典檔，邊抓邊回報進度 */
function prefetchDict(base, onProgress){
  let done = 0;
  return DIC_FILES.reduce((chain, f) =>
    chain.then(() =>
      fetchWithTimeout(base + f[0], FILE_TIMEOUT)
        .catch(e => { throw new Error(f[0] + "：" + e.message); })
        .then(n => { done += (n || f[1]); onProgress(done); })
    ), Promise.resolve()).then(() => done);
}

function loadDictionary(idx){
  idx = idx || 0;
  if (idx >= DIC_PATHS.length){
    showError("詞典載入失敗，兩個來源都連不上。",
      "請確認網路連線；若使用行動網路或有廣告攔截器，請切換 Wi-Fi 或暫時停用後重試。");
    return;
  }
  const base = DIC_PATHS[idx];
  const host = base.split("/")[2];
  const t0 = Date.now();
  showProgress(0, DIC_TOTAL, "來源：" + host);

  prefetchDict(base, d => showProgress(d, DIC_TOTAL, "來源：" + host))
    .then(() => buildInWorker(base, t0))
    .then(() => {
      tokenizerReady = true;
      setStatus("ready", "詞典就緒，可以開始分析了（耗時 " +
        ((Date.now() - t0) / 1000).toFixed(1) + " 秒）");
      $("#analyze").disabled = false;
    })
    .catch(e => {
      console.warn("dict source failed:", base, e);
      if (idx + 1 < DIC_PATHS.length){
        showProgress(0, DIC_TOTAL, "來源 " + host + " 失敗，改試備援來源…");
        setTimeout(() => loadDictionary(idx + 1), 600);
      } else {
        showError("詞典載入失敗。", String(e.message || e));
      }
    });
}

/* ---------- Worker：解壓、建索引、斷詞都在背景執行緒 ---------- */
const KUROMOJI_LIB = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";
let worker = null, workerSeq = 0, workerInit = null;
const pending = new Map();

function ensureWorker(){
  if (worker) return worker;
  worker = new Worker("js/dict-worker.js" + (window.__v || ""));
  worker.onmessage = e => {
    const d = e.data || {};
    if (d.type === "tokens"){
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d.results);
      return;
    }
    if (workerInit){
      if (d.type === "ready") workerInit.resolve();
      else if (d.type === "error") workerInit.reject(new Error(d.message));
    }
  };
  worker.onerror = () => {
    const err = new Error("無法載入 js/dict-worker.js");
    if (workerInit) workerInit.reject(err);
    pending.forEach(p => p.reject(err));
    pending.clear();
  };
  return worker;
}

function buildInWorker(dicPath, t0){
  return new Promise((resolve, reject) => {
    let done = false;
    const w = ensureWorker();
    /* Worker 不阻塞主執行緒，所以這個計時器與逾時保護真的排得進去 */
    const tick = setInterval(() => {
      showProgress(DIC_TOTAL, DIC_TOTAL,
        "解壓並建立索引中（背景執行，已 " + ((Date.now() - t0) / 1000).toFixed(0) + " 秒）…");
    }, 1000);
    const watchdog = setTimeout(() => finish(reject,
      new Error("建立索引逾時（" + (BUILD_TIMEOUT / 1000) + " 秒），裝置記憶體可能不足")), BUILD_TIMEOUT);
    function finish(fn, arg){
      if (done) return; done = true;
      clearInterval(tick); clearTimeout(watchdog); workerInit = null; fn(arg);
    }
    workerInit = { resolve: () => finish(resolve), reject: e => finish(reject, e) };
    showProgress(DIC_TOTAL, DIC_TOTAL, "解壓並建立索引中（背景執行）…");
    w.postMessage({ type:"init", dicPath: dicPath, libPath: KUROMOJI_LIB });
  });
}

/* 把多段文字一次送進 Worker 斷詞 */
function tokenizeAll(texts){
  if (!texts.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ type:"tokenize", id: id, texts: texts });
  });
}

if (typeof Worker === "undefined"){
  showError("這個瀏覽器不支援 Web Worker，無法載入詞典。", "請改用較新版本的瀏覽器。");
} else {
  loadDictionary(0);
}

/* ---------- 發音 ---------- */
const SPK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4zM14 1.2v2.1c3.4.9 6 4 6 7.7s-2.6 6.8-6 7.7v2.1c4.6-1 8-5 8-9.8s-3.4-8.8-8-9.8z"/></svg>';

function initSpeech(){
  const bar = $("#speech-bar");
  Speech.init(function(ok, list){
    if (!ok){
      bar.classList.add("off");
      bar.querySelectorAll("input,select,button").forEach(el => el.disabled = true);
      const note = document.createElement("div");
      note.className = "speech-note";
      note.textContent = "這台電腦的瀏覽器找不到日文語音，發音功能無法使用。" +
        "Windows 可到「設定 → 時間與語言 → 語言」新增日文並安裝語音套件，重開瀏覽器後即可使用。";
      bar.parentNode.insertBefore(note, bar.nextSibling);
      return;
    }
    const sel = $("#voice-pick");
    list.forEach(v => {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = v.name.replace(/^Microsoft /, "").replace(/ - Japanese \(Japan\)$/, "");
      sel.appendChild(o);
    });
    sel.value = Speech.getVoiceName();
    sel.onchange = () => { Speech.setVoice(sel.value); preview(); };

    const rate = $("#rate"), rateVal = $("#rate-val");
    const showRate = () => rateVal.textContent = (+rate.value).toFixed(2).replace(/0$/, "") + "×";
    rate.value = Speech.getRate();
    showRate();
    rate.oninput  = () => { Speech.setRate(parseFloat(rate.value)); showRate(); };
    rate.onchange = preview;

    const vol = $("#volume"), volVal = $("#volume-val");
    const showVol = () => volVal.textContent = Math.round(vol.value * 100) + "%";
    vol.value = Speech.getVolume();
    showVol();
    vol.oninput  = () => { Speech.setVolume(parseFloat(vol.value)); showVol(); };
    vol.onchange = preview;
  });
  $("#preview-speak").onclick = preview;
  $("#stop-speak").onclick = () => { Speech.stop(); clearPlaying(); };
}

/* 試聽：調整語音包／語速／音量後馬上聽得到效果 */
const PREVIEW_TEXT = "こんにちは。にほんごのべんきょうをがんばりましょう。";
function preview(){
  if (!Speech.available()) return;
  clearPlaying();
  Speech.speak(PREVIEW_TEXT);
}

function clearPlaying(){
  document.querySelectorAll(".spk.playing").forEach(b => b.classList.remove("playing"));
}

/* 按下喇叭按鈕：播放 / 再按一次停止 */
function bindSpeak(btn, getText){
  btn.innerHTML = SPK_SVG + (btn.dataset.label || "");
  btn.onclick = e => {
    e.stopPropagation();
    const wasPlaying = btn.classList.contains("playing");
    Speech.stop(); clearPlaying();
    if (wasPlaying) return;
    btn.classList.add("playing");
    Speech.speak(getText(), () => btn.classList.remove("playing"));
  };
}
function makeSpkBtn(label, getText){
  const b = document.createElement("button");
  b.className = "spk";
  b.type = "button";
  b.title = "朗讀";
  if (label) b.dataset.label = label;
  bindSpeak(b, getText);
  return b;
}

/* 活用表裡的形態轉成可朗讀的文字：「来ます（きます）」→ きます */
function speakableForm(v){
  const m = v.match(/^(.+?)（([ぁ-んァ-ヶー]+)）$/);
  if (m) return m[2];
  return v.replace(/＋名詞/g, "").split("／")[0].trim();
}

/* ---------- 詞性中文名 ---------- */
const POS_ZH = {
  "名詞":"名詞","動詞":"動詞","形容詞":"い形容詞","副詞":"副詞","助詞":"助詞","助動詞":"助動詞",
  "連体詞":"連體詞","接続詞":"接續詞","感動詞":"感嘆詞","接頭詞":"接頭詞","記号":"標點符號",
  "フィラー":"填充詞","その他":"其他"
};
const POS_DETAIL_ZH = {
  "格助詞":"格助詞","係助詞":"係助詞","副助詞":"副助詞","接続助詞":"接續助詞","終助詞":"終助詞",
  "並立助詞":"並列助詞","連体化":"連體化","副詞化":"副詞化","代名詞":"代名詞","固有名詞":"專有名詞",
  "サ変接続":"サ変名詞（可＋する）","形容動詞語幹":"な形容詞語幹","副詞可能":"可作副詞的名詞",
  "接尾":"接尾詞","非自立":"形式／補助用法","自立":"獨立詞","数":"數詞","一般":"一般"
};

/* 顯示用色系 */
function cssClass(t){
  if (isPunct(t)) return "punct";
  switch(t.pos){
    case "動詞": return "v";
    case "形容詞": return "a";
    case "名詞": return (t.pos_detail_1 === "形容動詞語幹") ? "a" : "n";
    case "助詞": case "助動詞": return "p";
    default: return "o";
  }
}

/* ---------- 分組：把用言與其後接的助動詞黏成一個「詞塊」 ---------- */
/* 只有實詞（用言／體言）才能當詞塊的中心並吸收後續成分，
   否則像「ば」這種助詞會把後面整串動詞吃掉。 */
const HEAD_OK = { "動詞":1, "形容詞":1, "名詞":1, "接頭詞":1, "副詞":1 };

function isAttachment(t, headPos){
  if (!HEAD_OK[headPos]) return false;
  if (t.pos === "助動詞") return true;
  if (t.pos === "動詞"   && (t.pos_detail_1 === "接尾" || t.pos_detail_1 === "非自立")) return true;
  if (t.pos === "形容詞" && t.pos_detail_1 === "非自立") return true;
  if (t.pos === "助詞"   && t.pos_detail_1 === "接続助詞" && /^(て|で|たり|ちゃ|じゃ|ば)$/.test(t.surface_form)) return true;
  if (t.pos === "名詞"   && t.pos_detail_1 === "接尾" && headPos === "名詞") return true;
  return false;
}

function groupTokens(tokens){
  const groups = [];
  let i = 0;
  while (i < tokens.length){
    const t = tokens[i];
    if (isPunct(t)){ groups.push({ head:t, tokens:[t], punct:true }); i++; continue; }

    const g = { head:t, tokens:[t], punct:false };
    i++;

    /* 接頭詞：吸收下一個實詞 */
    if (t.pos === "接頭詞" && i < tokens.length && !isPunct(tokens[i])){
      g.tokens.push(tokens[i]); g.head = tokens[i]; g.prefix = t; i++;
    }

    /* 連續數字合併：三 + 十 → 三十（之後再吸收量詞「分」） */
    if (t.pos === "名詞" && t.pos_detail_1 === "数"){
      while (i < tokens.length && tokens[i].pos === "名詞" && tokens[i].pos_detail_1 === "数"){
        g.tokens.push(tokens[i]); i++;
      }
      g.numBase = g.tokens.map(x => x.surface_form).join("");
    }

    /* サ変名詞 + する → 合併成一個動詞 */
    if (i < tokens.length && tokens[i].pos === "動詞" && tokens[i].basic_form === "する"
        && g.head.pos === "名詞" && g.head.pos_detail_1 === "サ変接続"){
      const noun = g.head.surface_form;
      g.tokens.push(tokens[i]);
      g.suruHead = {
        pos:"動詞", pos_detail_1:"自立", conjugated_type:"サ変・スル",
        basic_form: noun + "する", surface_form: noun + tokens[i].surface_form,
        reading: (g.head.reading||"") + (tokens[i].reading||"")
      };
      i++;
    }

    /* 吸收後接的助動詞等 */
    const headPos = (g.suruHead || g.head).pos;
    while (i < tokens.length && isAttachment(tokens[i], headPos)){
      if (tokens[i].pos === "名詞" && tokens[i].pos_detail_1 === "接尾")
        g.nounSuffix = (g.nounSuffix || "") + tokens[i].surface_form;
      g.tokens.push(tokens[i]); i++;
    }

    g.surface = g.tokens.map(x => x.surface_form).join("");
    /* 外來語維持片假名，其餘轉平假名 */
    g.reading = g.tokens.map(x => {
      const r = x.reading || x.surface_form;
      return /^[ァ-ヶー]+$/.test(x.surface_form) ? r : kata2hira(r);
    }).join("");
    /* 朗讀用：pronunciation 才是真正的唸法（は→ワ、へ→エ） */
    g.speech = g.tokens.map(x => x.pronunciation || x.reading || x.surface_form).join("");
    groups.push(g);
  }
  return groups;
}

/* ---------- 查詞 ---------- */
const onlineCache = new Map();
try{
  const saved = JSON.parse(localStorage.getItem("jp_word_cache") || "{}");
  Object.keys(saved).forEach(k => onlineCache.set(k, saved[k]));
}catch(e){}
function saveCache(){
  try{
    const o = {}; onlineCache.forEach((v,k) => o[k] = v);
    localStorage.setItem("jp_word_cache", JSON.stringify(o));
  }catch(e){}
}

function baseOf(t){
  return (t.basic_form && t.basic_form !== "*") ? t.basic_form : t.surface_form;
}

/* 辭書形的平假名讀音。斷詞在 Worker 裡，所以這裡只讀快取；
   需要的詞會在 render() 之前先批次送去 Worker 補齊。 */
const kanaCache = new Map();
function kanaOf(word){
  return (word && kanaCache.has(word)) ? kanaCache.get(word) : null;
}
function kanaFromTokens(ts){
  if (!ts || !ts.length) return null;
  for (let i = 0; i < ts.length; i++) if (!ts[i].reading) return null;
  const out = kata2hira(ts.map(t => t.reading).join(""));
  return /^[ぁ-んー]+$/.test(out) ? out : null;
}
/* 一次補齊多個詞的讀音 */
function fillKana(words){
  const need = [];
  words.forEach(w => { if (w && !kanaCache.has(w) && need.indexOf(w) < 0) need.push(w); });
  if (!need.length) return Promise.resolve();
  return tokenizeAll(need)
    .then(lists => { need.forEach((w, i) => kanaCache.set(w, kanaFromTokens(lists[i]))); })
    .catch(() => { need.forEach(w => kanaCache.set(w, null)); });
}

/* 動詞連用形（ます形語幹）被當成名詞時，還原成辭書形：泳ぎ→泳ぐ、食べ→食べる */
const REN_TO_U = {"い":"う","き":"く","ぎ":"ぐ","し":"す","ち":"つ","に":"ぬ","び":"ぶ","み":"む","り":"る"};
/* 可能形（え段＋る）還原成辭書形：話せる→話す */
const E_TO_U   = {"え":"う","け":"く","げ":"ぐ","せ":"す","て":"つ","ね":"ぬ","べ":"ぶ","め":"む","れ":"る"};
/* 使役／他動詞（あ段＋す）還原：待たす→待つ、動かす→動く */
const A_TO_U   = {"わ":"う","か":"く","が":"ぐ","た":"つ","な":"ぬ","ば":"ぶ","ま":"む","ら":"る"};
const HONORIFIC = {"さん":1,"様":1,"君":1,"ちゃん":1,"氏":1};
function stemToDict(s){
  const u = REN_TO_U[s.slice(-1)];
  if (u && JDICT[s.slice(0,-1) + u]) return s.slice(0,-1) + u;
  if (JDICT[s + "る"]) return s + "る";
  return null;
}

/* 回傳 {text, src}；src: dict / gram / affix / kanji / online / none */
function lookup(g){
  const head = g.suruHead || g.head;
  const base = baseOf(head);
  const surf = g.surface || head.surface_form;
  const hira = kata2hira(head.reading || "");

  if ((head.pos_detail_1 === "接尾" || head.pos === "接頭詞") && head.pos_detail_2 !== "助動詞語幹"){
    if (window.JAFFIX[base]) return { text: JAFFIX[base], src:"affix" };
  }
  if (head.pos === "助詞" || head.pos === "助動詞"){
    const gr = JGRAM[surf] || JGRAM[base] || JGRAM[head.surface_form] || JGRAM[hira];
    if (gr) return { text: gr.zh, src:"gram", note: gr.note };
  }
  /* 助動詞語幹（そう／よう／みたい）：そうだ 依 IPADIC 的細分辨傳聞或樣態 */
  if (head.pos_detail_2 === "助動詞語幹"){
    if (base === "そう"){
      return (head.pos_detail_1 === "特殊")
        ? { text:"聽說…（傳聞）", src:"gram", note:"接普通形，轉述聽來的訊息：〜そうだ。" }
        : { text:"看起來…（樣態）", src:"gram", note:"接ます形語幹或形容詞語幹，就外觀所做的推測：〜そうだ。" };
    }
    const gr = JGRAM[surf] || JGRAM[base + "だ"] || JGRAM[base];
    if (gr) return { text: gr.zh, src:"gram", note: gr.note };
  }

  /* 名詞＋接尾（例：職員＋室、三十＋分）先整串查，再組合 */
  if (head.pos === "名詞" && surf !== base && JDICT[surf]) return { text: JDICT[surf], src:"dict" };
  if (head.pos === "名詞" && g.nounSuffix){
    const stem = g.numBase || base;
    const sfx  = g.nounSuffix;
    if (surf === stem + sfx){
      if (HONORIFIC[sfx])
        return { text: (JDICT[stem] || window.toTraditional(stem) || stem) + "（敬稱：" + sfx + "）", src:"dict" };
      const sfxZh = JAFFIX[sfx] ? JAFFIX[sfx].replace(/^…/, "") : (window.toTraditional(sfx) || sfx);
      const kanjiStem = /^[一-鿿㐀-䶿々]+$/.test(stem);
      const stemZh = JDICT[stem] ||
        ((head.pos_detail_1 === "数" || head.pos_detail_1 === "固有名詞" || kanjiStem)
          ? (window.toTraditional(stem) || stem) : null);
      if (stemZh) return { text: stemZh + sfxZh, src:"dict" };
    }
  }
  if (JDICT[base]) return { text: JDICT[base], src:"dict" };
  /* サ変動詞：勉強する → 查「勉強」 */
  if (/する$/.test(base) && base.length > 2 && JDICT[base.slice(0,-2)])
    return { text: JDICT[base.slice(0,-2)] + "（〜する：做…）", src:"dict" };
  if (JGRAM[base]) return { text: JGRAM[base].zh, src:"gram", note: JGRAM[base].note };
  if (hira && JDICT[KANA_ALIAS[hira]]) return { text: JDICT[KANA_ALIAS[hira]], src:"dict" };
  if (hira && JDICT[hira]) return { text: JDICT[hira], src:"dict" };
  if (window.JAFFIX[base]) return { text: JAFFIX[base], src:"affix" };

  /* 動詞連用形當名詞用：泳ぎ → 泳ぐ */
  if (head.pos === "名詞"){
    const dic = stemToDict(base);
    if (dic) return { text: JDICT[dic] + "（動詞「" + dic + "」的名詞用法）", src:"dict", altBase: dic };
  }
  /* 可能動詞被當成獨立詞條：話せる → 話す */
  if (head.pos === "動詞" && /る$/.test(base) && base.length > 2){
    const u = E_TO_U[base.slice(-2, -1)];
    const cand = u && base.slice(0, -2) + u;
    if (cand && JDICT[cand])
      return { text: "能夠" + JDICT[cand] + "（「" + cand + "」的可能形）", src:"dict", altBase: cand };
  }
  /* 使役／他動詞被當成獨立詞條：待たす → 待つ、動かす → 動く */
  if (head.pos === "動詞" && /す$/.test(base) && base.length > 2){
    const u = A_TO_U[base.slice(-2, -1)];
    const cand = u && base.slice(0, -2) + u;
    if (cand && JDICT[cand])
      return { text: "使…" + JDICT[cand] + "（「" + cand + "」的使役／他動詞形）", src:"dict", altBase: cand };
  }
  /* 專有名詞 */
  if (head.pos_detail_1 === "固有名詞"){
    const kind = {"人名":"人名","地域":"地名","組織":"組織名"}[head.pos_detail_2] || "專有名詞";
    return { text: (window.toTraditional(surf) || surf) + "（" + kind + "）", src:"kanji" };
  }
  /* 線上補查的關鍵字：用言查原型，其餘查表面形 */
  const qkey = (head.pos === "動詞" || head.pos === "形容詞") ? base : surf;

  if (onlineCache.has(qkey)) return { text: onlineCache.get(qkey), src:"online" };

  if (/^[一-鿿㐀-䶿]+$/.test(qkey)){
    const tr = window.toTraditional(qkey);
    return { text: (tr || qkey) + "（漢字對應）", src:"kanji", needOnline: qkey };
  }
  return { text:"", src:"none", needOnline: qkey };
}

/* ---------- 線上翻譯 (MyMemory) ---------- */
function mmTranslate(text){
  const url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) + "&langpair=ja|zh-TW";
  return fetch(url).then(r => r.json()).then(j => {
    if (j && j.responseData && j.responseData.translatedText){
      const t = j.responseData.translatedText;
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) throw new Error(t);
      return t;
    }
    throw new Error("no translation");
  });
}
/* 依句尾標點斷句，並把標點留在句子裡。
   刻意不用 regex lookbehind：Safari 16.4 以前不支援，而且那是「解析期」錯誤，
   會讓整個 js 檔案無法執行（畫面正常但所有功能失效）。 */
function splitAfter(text, marks){
  const out = []; let cur = "";
  for (let i = 0; i < text.length; i++){
    cur += text.charAt(i);
    if (marks.indexOf(text.charAt(i)) >= 0){ out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}
function chunkSentences(text, max){
  const parts = splitAfter(text, "。．！？!?").filter(s => s.trim());
  const out = []; let cur = "";
  for (const p of parts){
    if ((cur + p).length > max){ if (cur) out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}
function translateParagraph(text){
  const chunks = chunkSentences(text, 400);
  return chunks.reduce((chain, c) =>
    chain.then(acc => mmTranslate(c).then(t => acc + t)), Promise.resolve(""));
}

/* ---------- 渲染 ---------- */
const output = $("#output");
let GROUP_STORE = [];   // 供詳細面板取用

/* 斷詞在 Worker，所以分兩步：先把整篇送去斷詞並補齊讀音，回來再一次畫完。 */
function render(text){
  const paragraphs = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!paragraphs.length){ output.innerHTML = ""; return; }

  tokenizeAll(paragraphs)
    .then(tokenLists => {
      const groupLists = tokenLists.map(groupTokens);
      /* 活用表需要辭書形的讀音；サ変名詞另外需要「〜する」的讀音 */
      const words = [];
      groupLists.forEach(gs => gs.forEach(g => {
        if (g.punct) return;
        const head = g.suruHead || g.head;
        words.push(baseOf(head));
        if (head.pos === "名詞" && head.pos_detail_1 === "サ変接続") words.push(g.surface + "する");
      }));
      return fillKana(words).then(() => paint(paragraphs, groupLists));
    })
    .catch(e => {
      output.innerHTML = '<div class="para"><b>分析失敗：</b>' + esc(e.message || String(e)) + "</div>";
    });
}

function paint(paragraphs, groupLists){
  output.innerHTML = "";
  GROUP_STORE = [];
  const wantOnline = $("#online").checked;
  const showRuby   = $("#furigana").checked;
  const unknown    = new Map();   // base -> [gloss element,…]

  paragraphs.forEach((para, pi) => {
    const groups = groupLists[pi];

    const card = document.createElement("div");
    card.className = "para";
    const headEl = document.createElement("div");
    headEl.className = "para-head";
    headEl.innerHTML = "<span>第 " + (pi+1) + " 段</span>";
    if (Speech.available()) headEl.appendChild(makeSpkBtn("朗讀整段", () => para));
    card.appendChild(headEl);

    const line = document.createElement("div");
    line.className = "sentence";

    groups.forEach(g => {
      const head = g.suruHead || g.head;
      const gid  = GROUP_STORE.length;
      g.gloss = g.punct ? {text:"",src:"none"} : lookup(g);
      g.conj  = g.punct ? null : window.conjugate(head, kanaOf(baseOf(head)));
      GROUP_STORE.push(g);

      const el = document.createElement("span");
      el.className = "w " + cssClass(head) + (g.punct ? " punct" : "");
      el.dataset.gid = gid;

      if (g.punct){
        el.innerHTML = '<span class="surf">' + esc(g.head.surface_form) + '</span>';
        line.appendChild(el); return;
      }

      const ruby = (showRuby && hasKanji(g.surface) && g.reading) ? esc(g.reading) : "";
      const conjChanged = g.conj && g.surface !== g.conj.base;
      el.innerHTML =
        '<span class="ruby">' + ruby + '</span>' +
        '<span class="surf">' + esc(g.surface) + '</span>' +
        '<span class="gloss">' + esc(g.gloss.text || "…") + '</span>' +
        (conjChanged ? '<span class="conj-flag">原型 ' + esc(g.conj.base) + '</span>' : '');

      if (g.gloss.needOnline && wantOnline){
        const key = g.gloss.needOnline;
        if (!unknown.has(key)) unknown.set(key, []);
        unknown.get(key).push(el.querySelector(".gloss"));
      }
      line.appendChild(el);
    });
    card.appendChild(line);

    /* 段落翻譯 */
    const tr = document.createElement("div");
    tr.className = "trans";
    tr.innerHTML = '<b>段落翻譯</b><span class="pending">' +
      (wantOnline ? "翻譯中…" : "（已關閉線上翻譯）") + "</span>";
    card.appendChild(tr);

    /* 單字表 */
    const toggle = document.createElement("span");
    toggle.className = "toggle-list";
    toggle.textContent = "▸ 顯示本段單字表";
    const tbl = document.createElement("div");
    tbl.className = "tblwrap";
    tbl.style.display = "none";
    tbl.innerHTML = wordTable(groups);
    toggle.onclick = () => {
      const on = tbl.style.display === "none";
      tbl.style.display = on ? "block" : "none";
      toggle.textContent = (on ? "▾ 收合" : "▸ 顯示") + "本段單字表";
    };
    tbl.querySelectorAll("tr.speakable").forEach(tr => {
      tr.onclick = () => { Speech.stop(); clearPlaying(); Speech.speak(tr.dataset.speak); };
    });
    card.appendChild(toggle);
    card.appendChild(tbl);

    output.appendChild(card);

    if (wantOnline){
      translateParagraph(para)
        .then(t => { tr.innerHTML = '<b>段落翻譯</b>' + esc(t); })
        .catch(e => { tr.innerHTML = '<b>段落翻譯</b><span class="pending">翻譯失敗（' + esc(e.message) + '）</span>'; });
    }
  });

  /* 補查不認識的單字（節流＋上限，避免耗盡免費額度） */
  if (wantOnline){
    const keys = Array.from(unknown.keys()).slice(0, 40);
    keys.reduce((chain, k) => chain.then(() =>
      mmTranslate(k).then(t => {
        onlineCache.set(k, t); saveCache();
        unknown.get(k).forEach(el => { el.textContent = t; el.title = t; });
      }).catch(()=>{})
    ), Promise.resolve()).then(saveCache);
  }
}

function wordTable(groups){
  let h = '<table class="wl"><tr><th>單字</th><th>讀音</th><th>原型</th><th>詞性</th><th>中文</th></tr>';
  const seen = new Set();
  groups.forEach(g => {
    if (g.punct) return;
    if (seen.has(g.surface)) return;
    seen.add(g.surface);
    const head = g.suruHead || g.head;
    const base = g.conj ? g.conj.base : baseOf(head);
    h += "<tr" + (Speech.available()
          ? ' class="speakable" data-speak="' + esc(g.speech || g.surface) + '"' : "") + ">" +
      '<td class="jp">' + esc(g.surface) + "</td>" +
      "<td>" + esc(g.reading || "") + "</td>" +
      '<td class="base">' + (base !== g.surface ? esc(base) : "—") + "</td>" +
      "<td>" + esc(POS_ZH[head.pos] || head.pos) + "</td>" +
      '<td class="zh">' + esc((g.gloss && g.gloss.text) || "") + "</td></tr>";
  });
  return h + "</table>";
}

/* ---------- 詳細面板 ---------- */
const panel = $("#panel"), backdrop = $("#backdrop"), panelBody = $("#panel-body");
function closePanel(){
  panel.classList.add("hidden"); backdrop.classList.add("hidden");
  Speech.stop(); clearPlaying();
}
$("#panel-close").onclick = closePanel;
backdrop.onclick = closePanel;
document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });

output.addEventListener("click", e => {
  if (e.target.closest(".spk")) return;          // 喇叭按鈕自己處理
  const el = e.target.closest(".w");
  if (!el || el.classList.contains("punct")) return;
  const g = GROUP_STORE[+el.dataset.gid];
  showDetail(g);
  if ($("#autospeak").checked && Speech.available()){
    clearPlaying();
    Speech.speak(g.speech || g.surface);
  }
});

function showDetail(g){
  const head = g.suruHead || g.head;
  const base = g.conj ? g.conj.base : (g.gloss && g.gloss.altBase) || baseOf(head);
  let h = "";

  h += '<div class="p-surf"><span>' + esc(g.surface) + "</span>" +
       (Speech.available() ? '<button type="button" class="spk" data-speak="' + esc(g.speech || g.surface) + '"></button>' : "") +
       "</div>";
  if (g.reading) h += '<div class="p-read">' + esc(g.reading) + "</div>";
  h += '<span class="p-tag">' + esc(POS_ZH[head.pos] || head.pos) + "</span>";
  if (head.pos_detail_1 && head.pos_detail_1 !== "*" && head.pos_detail_1 !== "一般")
    h += '<span class="p-tag">' + esc(POS_DETAIL_ZH[head.pos_detail_1] || head.pos_detail_1) + "</span>";
  if (g.conj) h += '<span class="p-tag">' + esc(g.conj.label) + "</span>";

  const srcName = {dict:"內建詞典",gram:"文法說明",affix:"接辭",kanji:"漢字推測",online:"線上翻譯",none:""};
  h += '<div class="p-sec"><h3>意思</h3><div class="p-mean">' +
       esc(g.gloss.text || "（查無資料）") +
       '<span class="src">' + (srcName[g.gloss.src] || "") + "</span></div>";
  if (g.gloss.note) h += '<div style="font-size:13.5px;color:var(--muted);margin-top:6px">' + esc(g.gloss.note) + "</div>";
  h += "</div>";

  /* 原型：只有用言（會活用的詞）才有意義 */
  if ((g.conj || (g.gloss && g.gloss.altBase)) && base !== g.surface){
    h += '<div class="p-sec"><h3>原型（辭書形）</h3><div class="p-base"><span>' + esc(base) +
         (JDICT[base] ? '<span class="src" style="font-size:13px;color:var(--muted)">　' + esc(JDICT[base]) + "</span>" : "") +
         "</span>" +
         (Speech.available()
           ? '<button type="button" class="spk" data-speak="' + esc(kanaOf(base) || base) + '"></button>' : "") +
         "</div>";
    const cf = head.conjugated_form && CONJ_FORM_ZH[head.conjugated_form];
    if (cf) h += '<div style="font-size:13px;color:var(--muted);margin-top:4px">目前是：' + esc(cf) + "</div>";
    h += "</div>";
  }

  /* 附加成分 */
  const extras = g.tokens.filter(t => t !== g.head && !(g.suruHead && t.basic_form === "する"));
  if (extras.length){
    h += '<div class="p-sec"><h3>附加成分（變化來源）</h3><ul class="parts">';
    extras.forEach(t => {
      const b = baseOf(t);
      const gr = JGRAM[b] || JGRAM[t.surface_form] || JDICT[b];
      const zh = typeof gr === "string" ? gr : (gr ? gr.zh : "");
      const note = (gr && gr.note) ? gr.note : "";
      h += "<li><b>" + esc(t.surface_form) + "</b>" +
           (b !== t.surface_form ? '<span style="color:var(--muted)">（' + esc(b) + "）</span>" : "") +
           " " + esc(zh) + (note ? '<div style="color:var(--muted);font-size:12.5px">' + esc(note) + "</div>" : "") +
           "</li>";
    });
    h += "</ul></div>";
  }

  /* 活用表 */
  let conj = g.conj;
  let conjTitle = "活用變化表";
  if (!conj && head.pos === "名詞" && head.pos_detail_1 === "サ変接続"){
    const sv = g.surface + "する";
    conj = window.conjugate({ pos:"動詞", conjugated_type:"サ変・スル", basic_form: sv }, kanaOf(sv));
    conjTitle = "加上「する」後的活用變化表";
  }
  if (conj){
    h += '<div class="p-sec"><h3>' + conjTitle + "（" + esc(conj.label) + "）" +
         (Speech.available() ? '<span style="font-weight:400;letter-spacing:0"> — 點任一行可聽發音</span>' : "") +
         "</h3><table class=\"ctable\">";
    Object.keys(conj.table).forEach(k => {
      const v    = conj.table[k];
      const kana = conj.kana ? conj.kana[k] : null;
      const cls  = [(v === g.surface) ? "cur" : "", Speech.available() ? "speakable" : ""].filter(Boolean).join(" ");
      h += "<tr" + (cls ? ' class="' + cls + '"' : "") +
           ' data-speak="' + esc(speakableForm(kana || v)) + '">' +
           "<td>" + esc(k) + "</td><td>" + esc(v) +
           (kana && kana !== v ? '<span class="kana">' + esc(kana) + "</span>" : "") +
           "</td></tr>";
    });
    h += "</table></div>";
  }

  panelBody.innerHTML = h;
  /* 綁定面板內的朗讀 */
  panelBody.querySelectorAll("button.spk").forEach(b => bindSpeak(b, () => b.dataset.speak));
  panelBody.querySelectorAll("tr.speakable").forEach(tr => {
    tr.onclick = () => { Speech.stop(); clearPlaying(); Speech.speak(tr.dataset.speak); };
  });
  panel.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  panel.scrollTop = 0;
}

/* ---------- 事件 ---------- */
initSpeech();

$("#analyze").onclick = () => {
  const text = $("#input").value.trim();
  if (!text){ output.innerHTML = ""; return; }
  if (!tokenizerReady) return;
  Speech.stop();
  output.innerHTML = '<div class="para">分析中…</div>';
  render(text);
};
$("#clear").onclick = () => { $("#input").value = ""; output.innerHTML = ""; Speech.stop(); };
$("#sample").onclick = () => {
  $("#input").value =
"昨日は友達と新しくできたレストランへ食事に行きました。\n" +
"店員さんがとても親切で、料理も想像していたより美味しかったです。\n" +
"混んでいたので少し待たされましたが、また行きたいと思っています。";
};
$("#input").addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("#analyze").click();
});

})();
