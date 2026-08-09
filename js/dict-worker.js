/* ============================================================
   詞典 Worker
   ------------------------------------------------------------
   兩個效能問題都在這裡處理：

   1. kuromoji 的解壓與建索引是同步重工作（17MB → 95.6MB）。
      放在主執行緒會凍結整個分頁，連 setTimeout 都排不進去，
      iOS 可能直接終止無回應的分頁。所以整個 tokenizer 放在 Worker。

   2. kuromoji 內建的解壓是純 JS 的 zlib（BrowserDictionaryLoader
      裡的 Zlib.Gunzip），在較慢的裝置上要好幾分鐘。瀏覽器其實內建了
      原生的 gzip 解壓（DecompressionStream），速度是數量級的差距。
      但 kuromoji 只匯出 builder，BrowserDictionaryLoader 被包在
      browserify 閉包裡拿不到，所以這裡先抓原始碼、在
      loadArrayBuffer 進入點注入一行掛鉤，再執行。
      注入失敗就退回原版行為，不會壞掉。
   ============================================================ */
"use strict";

var tokenizer = null;
var HOOK_ANCHOR = "BrowserDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {";
var HOOK_INJECT = HOOK_ANCHOR + " if (self.__fastLoad) { self.__fastLoad(url, callback); return; }";

function post(msg){ self.postMessage(msg); }

var canNativeGunzip = (typeof DecompressionStream !== "undefined") &&
                      (typeof Response !== "undefined");

/* 原生解壓：瀏覽器用 C++ 做，比純 JS 的 zlib 快一個數量級 */
function nativeGunzip(buf){
  var stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

var FILE_TIMEOUT = 90000;
var bytesTotal = 0, filesDone = 0;

/* 邊下載邊回報位元組數，讓進度條反映真實進度（最大的檔案有 5.9MB） */
function fetchWithProgress(url){
  return fetch(url).then(function(r){
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (!r.body || !r.body.getReader) return r.arrayBuffer();   // 舊瀏覽器：無串流
    var reader = r.body.getReader(), chunks = [], size = 0;
    return (function pump(){
      return reader.read().then(function(res){
        if (res.done){
          var out = new Uint8Array(size), at = 0;
          for (var i = 0; i < chunks.length; i++){ out.set(chunks[i], at); at += chunks[i].length; }
          return out.buffer;
        }
        chunks.push(res.value); size += res.value.length;
        bytesTotal += res.value.length;
        post({ type:"stage", stage:"download", bytes:bytesTotal });
        return pump();
      });
    })();
  });
}

function withTimeout(promise, ms, label){
  return new Promise(function(resolve, reject){
    var t = setTimeout(function(){ reject(new Error(label + "：逾時（" + (ms/1000) + " 秒無回應）")); }, ms);
    promise.then(function(v){ clearTimeout(t); resolve(v); },
                 function(e){ clearTimeout(t); reject(e); });
  });
}

function installFastLoad(){
  self.__fastLoad = function(url, callback){
    var name = url.split("/").pop();
    withTimeout(fetchWithProgress(url), FILE_TIMEOUT, name)
      .then(nativeGunzip)
      .then(function(buf){
        filesDone++;
        post({ type:"stage", stage:"file", done:filesDone, file:name, bytes:bytesTotal });
        callback(null, buf);
      })
      .catch(function(err){ callback(err, null); });
  };
}

/* 抓原始碼、注入掛鉤、執行。回傳實際採用的模式。 */
function loadKuromoji(libPath){
  if (!canNativeGunzip){
    importScripts(libPath);          // 舊瀏覽器：退回原版純 JS 解壓
    return Promise.resolve("legacy");
  }
  return fetch(libPath)
    .then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(function(src){
      if (src.indexOf(HOOK_ANCHOR) < 0){
        importScripts(libPath);       // 版本對不上：安全退回
        return "legacy-no-anchor";
      }
      installFastLoad();
      // eslint-disable-next-line no-new-func
      (new Function(src.replace(HOOK_ANCHOR, HOOK_INJECT)))();
      return "native";
    })
    .catch(function(){
      importScripts(libPath);
      return "legacy-fetch-failed";
    });
}

self.onmessage = function(e){
  var d = e.data || {};

  if (d.type === "init"){
    if (tokenizer){ post({ type:"ready", reused:true }); return; }
    loadKuromoji(d.libPath)
      .then(function(mode){
        if (typeof kuromoji === "undefined")
          throw new Error("kuromoji 未載入");
        post({ type:"stage", stage:"build", mode:mode });
        return new Promise(function(resolve, reject){
          kuromoji.builder({ dicPath: d.dicPath }).build(function(err, tk){
            if (err) reject(new Error(err.message || String(err))); else resolve(tk);
          });
        });
      })
      .then(function(tk){
        tokenizer = tk;
        post({ type:"ready" });
      })
      .catch(function(err){
        post({ type:"error", message:(err.message || String(err)) });
      });
    return;
  }

  if (d.type === "tokenize"){
    if (!tokenizer){ post({ type:"tokens", id:d.id, error:"tokenizer 尚未就緒" }); return; }
    try {
      var out = [];
      for (var i = 0; i < d.texts.length; i++) out.push(tokenizer.tokenize(d.texts[i]));
      post({ type:"tokens", id:d.id, results:out });
    } catch (err){
      post({ type:"tokens", id:d.id, error:(err.message || String(err)) });
    }
    return;
  }
};
