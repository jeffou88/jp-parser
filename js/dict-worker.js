/* ============================================================
   詞典 Worker
   kuromoji 的解壓與建索引是同步的重工作（桌機數秒、手機可達數分鐘）。
   放在主執行緒會凍結整個分頁：進度條不會重繪、setTimeout 排不進去，
   連逾時保護都無法執行，iOS 還可能因為無回應而直接終止分頁。
   因此把 tokenizer 整個放進 Worker，主執行緒只負責傳文字、收 token。
   token 是純物件，可以直接結構化複製回主執行緒。
   ============================================================ */
"use strict";

var tokenizer = null;

function post(msg){ self.postMessage(msg); }

self.onmessage = function(e){
  var d = e.data || {};

  if (d.type === "init"){
    if (tokenizer){ post({ type:"ready", reused:true }); return; }
    try {
      importScripts(d.libPath);
    } catch (err){
      post({ type:"error", stage:"lib", message:"載入 kuromoji.js 失敗：" + (err.message || err) });
      return;
    }
    post({ type:"stage", stage:"build" });
    try {
      kuromoji.builder({ dicPath: d.dicPath }).build(function(err, tk){
        if (err){
          post({ type:"error", stage:"build", message:(err.message || String(err)) });
          return;
        }
        tokenizer = tk;
        post({ type:"ready" });
      });
    } catch (err){
      post({ type:"error", stage:"build", message:(err.message || String(err)) });
    }
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
