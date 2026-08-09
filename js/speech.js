/* ============================================================
   發音（Web Speech API）
   使用瀏覽器內建的日文語音，離線可用、不需要金鑰
   ============================================================ */
window.Speech = (function(){
"use strict";

const synth = window.speechSynthesis;
let jaVoices = [];
let current  = null;          // 選定的 voice
let rate     = 0.9;
let volume   = 1;
let queue    = [];            // 待唸的句子
let onDone   = null;
let keepAlive = null;         // 繞過 Chrome 長文停住的 bug

const LS_VOICE = "jp_voice", LS_RATE = "jp_rate", LS_VOL = "jp_volume";

function loadVoices(){
  if (!synth) return;
  jaVoices = synth.getVoices().filter(v => /^ja/i.test(v.lang));
  const saved = localStorage.getItem(LS_VOICE);
  current = jaVoices.find(v => v.name === saved) || jaVoices[0] || null;
}

function init(cb){
  if (!synth){ cb(false, []); return; }
  const r = parseFloat(localStorage.getItem(LS_RATE));
  if (!isNaN(r)) rate = r;
  const v = parseFloat(localStorage.getItem(LS_VOL));
  if (!isNaN(v)) volume = v;
  loadVoices();
  if (jaVoices.length){ cb(true, jaVoices); return; }
  /* 有些瀏覽器語音清單是非同步載入的 */
  let fired = false;
  const done = () => { if (fired) return; fired = true; loadVoices(); cb(jaVoices.length > 0, jaVoices); };
  synth.addEventListener("voiceschanged", done);
  setTimeout(done, 1500);
}

function available(){ return !!synth && jaVoices.length > 0; }
function voices(){ return jaVoices; }
function getVoiceName(){ return current ? current.name : ""; }
function setVoice(name){
  current = jaVoices.find(v => v.name === name) || current;
  if (current) localStorage.setItem(LS_VOICE, current.name);
}
function getRate(){ return rate; }
function setRate(r){ rate = r; localStorage.setItem(LS_RATE, String(r)); }
function getVolume(){ return volume; }
function setVolume(v){ volume = v; localStorage.setItem(LS_VOL, String(v)); }

function stop(){
  queue = [];
  onDone = null;
  clearInterval(keepAlive); keepAlive = null;
  if (synth) synth.cancel();
}

function speakNext(){
  if (!queue.length){
    clearInterval(keepAlive); keepAlive = null;
    if (onDone){ const f = onDone; onDone = null; f(); }
    return;
  }
  const u = new SpeechSynthesisUtterance(queue.shift());
  u.lang = "ja-JP";
  if (current) u.voice = current;
  u.rate   = rate;
  u.volume = volume;
  u.onend   = speakNext;
  u.onerror = speakNext;
  synth.speak(u);
}

/* 長文在 Chrome 系瀏覽器約 15 秒後會自己停住，定期 resume 可避免 */
function startKeepAlive(){
  clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    if (!synth.speaking){ clearInterval(keepAlive); keepAlive = null; return; }
    synth.pause(); synth.resume();
  }, 9000);
}

/* 依標點斷句、標點留在句尾。
   不用 regex lookbehind：Safari 16.4 以前不支援，且屬解析期錯誤，會讓整個檔案失效。 */
function splitAfter(text, marks){
  const out = []; let cur = "";
  for (let i = 0; i < text.length; i++){
    cur += text.charAt(i);
    if (marks.indexOf(text.charAt(i)) >= 0){ out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

/* text 可以是字串；長句會依標點切開分段唸，避免被截斷 */
function speak(text, done){
  if (!available() || !text) return false;
  stop();
  queue = splitAfter(String(text), "。．！？!?、，,")
    .map(s => s.trim())
    .filter(Boolean);
  if (!queue.length) queue = [String(text)];
  onDone = done || null;
  speakNext();
  startKeepAlive();
  return true;
}

function speaking(){ return !!synth && (synth.speaking || synth.pending); }

return { init, available, voices, setVoice, getVoiceName,
         getRate, setRate, getVolume, setVolume, speak, stop, speaking };
})();
