// Babel Tower - 英雄名简写表(从游戏官方本地化提取)
"use strict";
const HERO_ZH = {
  "Abrams": "亚伯兰", "Apollo": "阿波罗", "Baba": "婆婆", "Bebop": "比波普", "Billy": "比利", "Boho": "波米", "Calico": "卡厉可", "Celeste": "赛凌",
  "Deadman Danny": "空骨丹尼", "Drifter": "孤猎", "Dynamo": "奇能", "Fathom": "海魇", "Graves": "格瑞墓", "Grey Talon": "灰爪", "Haze": "岚梦", "Holliday": "哈雷黛",
  "Infernus": "炽焱", "Ivy": "青藤", "Kelvin": "开尔文", "Lady Geist": "盖斯特夫人", "Lash": "劳什", "McGinnis": "麦金妮", "Mina": "米娜", "Mirage": "蜃景",
  "Mo & Krill": "莫克双雄", "Nurse Harrow": "亥芮护士", "Paige": "佩吉", "Paradox": "悖论", "Pocket": "口袋", "Rat King": "鼠王", "Raven": "渡鸦", "Rem": "雷姆",
  "Seven": "柒", "Shield Guy": "盾男", "Shiv": "希弗", "Silver": "西尔芙", "Sinclair": "无双魔术师", "Skyrunner": "御空行者", "Solomon": "所罗门", "Swan": "天鹅舞伶",
  "The Doorman": "门侍", "Trapper": "陷阱师", "Venator": "诛邪者", "Victor": "维克多", "Vindicta": "薇妲", "Violet": "阿紫", "Viscous": "魔液", "Vyper": "蝰邪",
  "Warden": "沃督", "Wraith": "灵魅", "Wrecker": "破坏王", "Yamato": "大和"
};

// 前缀简写(3+ 字母且唯一匹配)+多词名首字母缩写
const HERO_ABBR = {};
const HERO_ABBR_OWNER = {};
(function () {
  for (const name of Object.keys(HERO_ZH)) {
    const zh = HERO_ZH[name];
    const hn = name.toLowerCase();
    const compact = hn.replace(/[^a-z]/g, "");
    const parts = hn.split(/[^a-z]+/);
    let initials = "";
    for (const p of parts) if (p) initials += p[0];
    if (initials.length >= 2 && initials.length < hn.length) {
      if (HERO_ABBR[initials] === undefined) { HERO_ABBR[initials] = zh; HERO_ABBR_OWNER[initials] = name; }
    }
    for (let L = 3; L < compact.length; L++) {
      const pre = compact.slice(0, L);
      if (HERO_ABBR[pre] === undefined) { HERO_ABBR[pre] = zh; HERO_ABBR_OWNER[pre] = name; }
    }
    if (HERO_ABBR[compact] === undefined) { HERO_ABBR[compact] = zh; HERO_ABBR_OWNER[compact] = name; }
  }
})();

function lookupHeroAbbr(w) {
  if (typeof w !== "string" || w.length < 2) return "";
  return HERO_ABBR[w.toLowerCase()] || "";
}

function isHeroAbbr(w) {
  return typeof w === "string" && Object.prototype.hasOwnProperty.call(HERO_ABBR, w.toLowerCase());
}

module.exports = { HERO_ZH, HERO_ABBR, lookupHeroAbbr, isHeroAbbr };
