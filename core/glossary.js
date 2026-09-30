"use strict";
// Deadlock game-term glossary for translation quality.
// Hero CN names are generated from the mod's ZH_HERO_TO_EN (kept in sync automatically).
module.exports = {
  heroNames: ["Abrams", "Akimbo", "Apollo", "Bebop", "Billy", "Boho", "Calico", "Celeste", "Drifter", "Dynamo", "Fathom", "Graves", "Grey Talon", "Haze", "Holliday", "Infernus", "Ivy", "Kelvin", "Lady Geist", "Lash", "Mcginnis", "Mina", "Mirage", "Mo & Krill", "Paige", "Paradox", "Pocket", "Raven", "Rem", "Seven", "Shiv", "Silver", "Sinclair", "Skyrunner", "Swan", "The Doorman", "Trapper", "Venator", "Victor", "Vindicta", "Viscous", "Vyper", "Warden", "Wraith", "Wrecker", "Yamato"],
  heroCnToEn: {"沃督": "Warden", "大和": "Yamato", "炽焱": "Infernus", "柒": "Seven", "薇妲": "Vindicta", "灰爪": "Grey Talon", "盖斯特夫人": "Lady Geist", "亚伯兰": "Abrams", "灵魅": "Wraith", "麦金妮": "Mcginnis", "悖论": "Paradox", "奇能": "Dynamo", "开尔文": "Kelvin", "魔液": "Viscous", "岚梦": "Haze", "哈雷黛": "Holliday", "比波普": "Bebop", "卡厉可": "Calico", "莫克双雄": "Mo & Krill", "希弗": "Shiv", "青藤": "Ivy", "破坏王": "Wrecker", "劳什": "Lash", "阿金驳": "Akimbo", "口袋": "Pocket", "蜃景": "Mirage", "海魇": "Fathom", "蝰邪": "Vyper", "无双魔术师": "Sinclair", "陷阱师": "Trapper", "渡鸦": "Raven", "维克多": "Victor", "米娜": "Mina", "孤猎": "Drifter", "诛邪者": "Venator", "佩吉": "Paige", "波米": "Boho", "门侍": "The Doorman", "天鹅舞伶": "Swan", "御空行者": "Skyrunner", "比利": "Billy", "雷姆": "Rem", "赛凌": "Celeste", "阿波罗": "Apollo", "格瑞墓": "Graves", "西尔芙": "Silver", "女巫": "Vindicta", "老七": "Seven"},
  termsCnToEn: {"兵线": "creep wave", "黄路": "yellow lane", "蓝路": "blue lane", "绿路": "green lane", "紫路": "purple lane", "推塔": "push tower", "回城": "teleport back", "买装备": "buy items", "商店": "shop", "大招": "ultimate", "技能": "ability", "天赋": "upgrades", "中路": "mid lane", "一塔": "first tower", "二塔": "second tower", "三塔": "third tower", "大野": "big jungle camp", "小野": "small jungle camp", "补刀": "last hit", "集合": "group up", "撤退": "retreat", "进攻": "push", "守家": "defend base", "基地": "base", "出装": "item build"},
  buildHint: function (targetLang) {
    var heroLines = [];
    var zh = this.heroCnToEn;
    var cnKeys = Object.keys(zh).slice(0, 60);
    for (var i = 0; i < cnKeys.length; i += 1) heroLines.push(cnKeys[i] + "=" + zh[cnKeys[i]]);
    var termLines = [];
    var tk = Object.keys(this.termsCnToEn);
    for (var j = 0; j < tk.length; j += 1) termLines.push(tk[j] + "=" + this.termsCnToEn[tk[j]]);
    return [
      "This is Deadlock (a MOBA) in-game chat. The following are game terms.",
      "Heroes (keep official English hero names; never translate hero names as common words): " + this.heroNames.join(", ") + ".",
      "Chinese hero nicknames: " + heroLines.join(", ") + ".",
      "Common terms: " + termLines.join(", ") + ".",
      "Rules: keep hero/ability/item names in English; translate the ENTIRE message completely; never truncate, never omit any part of the meaning."
    ].join(" ");
  },
  fixHeroTerms: function (source, translation, targetLang) {
    var src = String(source || "");
    var out = String(translation || "");
    var t = String(targetLang || "").toLowerCase();
    if (t.indexOf("en") !== 0 || !out) return out;
    var generic = {
      "\u5973\u5deb": ["witch"],
      "\u7075\u9b45": ["ghost", "spirit"],
      "\u7099\u7131": ["flame", "inferno", "blazing"],
      "\u7070\u722a": ["grey claw", "gray claw", "claw"],
      "\u8001\u4e03": ["old seven"],
      "\u8730\u90aa": ["viper"]
    };
    for (var cn in generic) {
      if (!Object.prototype.hasOwnProperty.call(generic, cn)) continue;
      if (src.indexOf(cn) === -1) continue;
      var official = this.heroCnToEn[cn] || cn;
      var words = generic[cn];
      for (var w = 0; w < words.length; w += 1) {
        var re = new RegExp("\\b" + words[w] + "\\b", "gi");
        if (re.test(out)) { out = out.replace(re, official); break; }
      }
    }
    return out;
  }
};
