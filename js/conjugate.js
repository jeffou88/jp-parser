/* ============================================================
   活用（變化形）推導
   輸入：辭書形 + 動詞類別，輸出常見變化形表
   ============================================================ */
(function(){

const ROWS = {
  "う":{a:"わ",i:"い",e:"え",o:"お"}, "く":{a:"か",i:"き",e:"け",o:"こ"},
  "ぐ":{a:"が",i:"ぎ",e:"げ",o:"ご"}, "す":{a:"さ",i:"し",e:"せ",o:"そ"},
  "つ":{a:"た",i:"ち",e:"て",o:"と"}, "ぬ":{a:"な",i:"に",e:"ね",o:"の"},
  "ぶ":{a:"ば",i:"び",e:"べ",o:"ぼ"}, "む":{a:"ま",i:"み",e:"め",o:"も"},
  "る":{a:"ら",i:"り",e:"れ",o:"ろ"}
};
// 五段動詞的音便（て形／た形）
const ONBIN = {
  "う":"っ","つ":"っ","る":"っ","ぬ":"ん","ぶ":"ん","む":"ん","く":"い","ぐ":"い","す":"し"
};
const VOICED = {"ぬ":1,"ぶ":1,"む":1,"ぐ":1};

/* 依 kuromoji 的「活用型」欄位判斷動詞類別 */
function classify(token){
  const pos  = token.pos || "";
  const ctype= token.conjugated_type || "";
  const base = token.basic_form || token.surface_form;

  if (pos === "形容詞") return "i-adj";
  if (ctype.indexOf("形容詞") === 0) return "i-adj";
  if (ctype.indexOf("特殊・ダ") === 0 || ctype.indexOf("特殊・デス") === 0) return "copula";
  if (ctype.indexOf("一段") === 0) return "ichidan";
  if (ctype.indexOf("サ変") === 0) return "suru";
  if (ctype.indexOf("カ変") === 0) return "kuru";
  if (ctype.indexOf("五段") === 0) return "godan";
  if (pos === "動詞"){
    // 沒有活用型資訊時的保守推測
    if (/[えけげせてねべめれ]る$|[いきぎしちにびみり]る$/.test(base)) return "ichidan";
    return "godan";
  }
  if (pos === "名詞" && (token.pos_detail_1||"").indexOf("形容動詞語幹") >= 0) return "na-adj";
  return null;
}

const CLASS_LABEL = {
  "godan":"五段動詞（Ⅰ類）","ichidan":"一段動詞（Ⅱ類）","suru":"サ変動詞（する類）",
  "kuru":"カ変動詞（来る）","i-adj":"い形容詞","na-adj":"な形容詞","copula":"斷定助動詞"
};

function godanTable(base){
  const last = base.slice(-1), stem = base.slice(0,-1), r = ROWS[last];
  if (!r) return null;
  const neg = (base === "ある") ? "ない" : stem + r.a + "ない";
  let te, ta;
  if (base === "行く" || base === "いく"){ te = stem + "って"; ta = stem + "った"; }
  else {
    const o = ONBIN[last];
    te = stem + o + (VOICED[last] ? "で" : "て");
    ta = stem + o + (VOICED[last] ? "だ" : "た");
  }
  return {
    "辭書形（原型）": base,
    "ます形（禮貌）": stem + r.i + "ます",
    "ます形否定":     stem + r.i + "ません",
    "ない形（否定）": neg,
    "た形（過去）":   ta,
    "なかった形":     neg.slice(0,-1) + "かった",
    "て形（連接）":   te,
    "可能形（能）":   stem + r.e + "る",
    "受身形（被）":   stem + r.a + "れる",
    "使役形（讓）":   stem + r.a + "せる",
    "意向形（吧）":   stem + r.o + "う",
    "條件形（ば）":   stem + r.e + "ば",
    "命令形":         stem + r.e,
    "禁止形":         base + "な",
    "希望形（想）":   stem + r.i + "たい"
  };
}

function ichidanTable(base){
  const s = base.slice(0,-1);
  return {
    "辭書形（原型）": base,
    "ます形（禮貌）": s + "ます",
    "ます形否定":     s + "ません",
    "ない形（否定）": s + "ない",
    "た形（過去）":   s + "た",
    "なかった形":     s + "なかった",
    "て形（連接）":   s + "て",
    "可能形（能）":   s + "られる",
    "受身形（被）":   s + "られる",
    "使役形（讓）":   s + "させる",
    "意向形（吧）":   s + "よう",
    "條件形（ば）":   s + "れば",
    "命令形":         s + "ろ",
    "禁止形":         base + "な",
    "希望形（想）":   s + "たい"
  };
}

function suruTable(base){
  // 名詞＋する（例：勉強する）
  const p = base.length > 2 ? base.slice(0, -2) : (base === "する" ? "" : base.replace(/する$/,""));
  return {
    "辭書形（原型）": p + "する",
    "ます形（禮貌）": p + "します",
    "ます形否定":     p + "しません",
    "ない形（否定）": p + "しない",
    "た形（過去）":   p + "した",
    "なかった形":     p + "しなかった",
    "て形（連接）":   p + "して",
    "可能形（能）":   p + "できる",
    "受身形（被）":   p + "される",
    "使役形（讓）":   p + "させる",
    "意向形（吧）":   p + "しよう",
    "條件形（ば）":   p + "すれば",
    "命令形":         p + "しろ",
    "禁止形":         p + "するな",
    "希望形（想）":   p + "したい"
  };
}

function kuruTable(){
  return {
    "辭書形（原型）":"来る（くる）","ます形（禮貌）":"来ます（きます）","ます形否定":"来ません（きません）",
    "ない形（否定）":"来ない（こない）","た形（過去）":"来た（きた）","なかった形":"来なかった（こなかった）",
    "て形（連接）":"来て（きて）","可能形（能）":"来られる（こられる）","受身形（被）":"来られる（こられる）",
    "使役形（讓）":"来させる（こさせる）","意向形（吧）":"来よう（こよう）","條件形（ば）":"来れば（くれば）",
    "命令形":"来い（こい）","禁止形":"来るな（くるな）","希望形（想）":"来たい（きたい）"
  };
}

function iAdjTable(base){
  const s = base.slice(0,-1);                    // 去掉い
  const irregular = (base === "いい" || base === "良い");
  const ks = irregular ? (base === "いい" ? "よ" : "良") : s;
  return {
    "辭書形（原型）": base,
    "丁寧形":         base + "です",
    "否定形":         ks + "くない",
    "過去形":         ks + "かった",
    "過去否定":       ks + "くなかった",
    "て形（連接）":   ks + "くて",
    "副詞形（連用）": ks + "く",
    "條件形（ば）":   ks + "ければ",
    "樣態（好像）":   ks + "そう",
    "名詞化（〜さ）": ks + "さ",
    "推測":           base + "だろう"
  };
}

function naAdjTable(base){
  return {
    "語幹（原型）":   base,
    "斷定形":         base + "だ",
    "丁寧形":         base + "です",
    "連體形（修飾名詞）": base + "な＋名詞",
    "否定形":         base + "じゃない／ではない",
    "過去形":         base + "だった",
    "過去否定":       base + "じゃなかった",
    "て形（連接）":   base + "で",
    "副詞形":         base + "に",
    "條件形":         base + "なら",
    "名詞化（〜さ）": base + "さ"
  };
}

function buildTable(cls, base){
  if (cls === "godan")   return godanTable(base);
  if (cls === "ichidan") return ichidanTable(base);
  if (cls === "suru")    return suruTable(base);
  if (cls === "kuru")    return kuruTable();
  if (cls === "i-adj")   return iAdjTable(base);
  if (cls === "na-adj")  return naAdjTable(base);
  return null;
}

/* kanaBase：辭書形的平假名讀音。給了就同時產生一份純假名的活用表，
   用於朗讀（避免「行った」被唸成「おこなった」）與標注讀音。 */
window.conjugate = function(token, kanaBase){
  const cls = classify(token);
  if (!cls || cls === "copula") return null;
  const base = token.basic_form && token.basic_form !== "*" ? token.basic_form : token.surface_form;
  const table = buildTable(cls, base);
  if (!table) return null;

  let kana = null;
  if (cls !== "kuru" && kanaBase && kanaBase !== base && /^[ぁ-ん]+$/.test(kanaBase)){
    const kt = buildTable(cls, kanaBase);
    if (kt && Object.keys(kt).length === Object.keys(table).length) kana = kt;
  }
  return { cls, label: CLASS_LABEL[cls], base, kanaBase: kanaBase || null, table, kana };
};
window.classifyWord = classify;
window.CLASS_LABEL = CLASS_LABEL;

/* kuromoji 的「活用形」→ 中文說明 */
window.CONJ_FORM_ZH = {
  "基本形":"辭書形（原型）","未然形":"未然形（接否定等）","未然ウ接続":"未然形（接う）",
  "未然ヌ接続":"未然形（接ぬ）","未然レル接続":"未然形（接れる）","未然特殊":"未然形",
  "連用形":"連用形（接ます等）","連用タ接続":"連用形（接た／て）","連用テ接続":"連用形（接て）",
  "連用ゴザイ接続":"連用形（接ございます）","連用デ接続":"連用形（接で）","連用ニ接続":"連用形（接に）",
  "仮定形":"假定形（接ば）","仮定縮約１":"假定縮約形","仮定縮約２":"假定縮約形",
  "命令ｅ":"命令形","命令ｉ":"命令形","命令ｒｏ":"命令形","命令ｙｏ":"命令形",
  "体言接続":"連體形（修飾名詞）","体言接続特殊":"連體形","体言接続特殊２":"連體形",
  "文語基本形":"文語基本形","現代基本形":"現代基本形","音便基本形":"音便形","ガル接続":"接がる形"
};

})();
