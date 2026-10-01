"use strict";
// Deadlock game-term glossary for translation quality.
// Hero CN names are generated from the mod's ZH_HERO_TO_EN (kept in sync automatically).
module.exports = {
  heroNames: ["Abrams", "Akimbo", "Apollo", "Bebop", "Billy", "Boho", "Calico", "Celeste", "Drifter", "Dynamo", "Fathom", "Graves", "Grey Talon", "Haze", "Holliday", "Infernus", "Ivy", "Kelvin", "Lady Geist", "Lash", "Mcginnis", "Mina", "Mirage", "Mo & Krill", "Paige", "Paradox", "Pocket", "Raven", "Rem", "Seven", "Shiv", "Silver", "Sinclair", "Skyrunner", "Swan", "The Doorman", "Trapper", "Venator", "Victor", "Vindicta", "Viscous", "Vyper", "Warden", "Wraith", "Wrecker", "Yamato"],
  heroCnToEn: {"沃督": "Warden", "大和": "Yamato", "炽焱": "Infernus", "柒": "Seven", "薇妲": "Vindicta", "灰爪": "Grey Talon", "盖斯特夫人": "Lady Geist", "亚伯兰": "Abrams", "灵魅": "Wraith", "麦金妮": "Mcginnis", "悖论": "Paradox", "奇能": "Dynamo", "开尔文": "Kelvin", "魔液": "Viscous", "岚梦": "Haze", "哈雷黛": "Holliday", "比波普": "Bebop", "卡厉可": "Calico", "莫克双雄": "Mo & Krill", "希弗": "Shiv", "青藤": "Ivy", "破坏王": "Wrecker", "劳什": "Lash", "阿金驳": "Akimbo", "口袋": "Pocket", "蜃景": "Mirage", "海魇": "Fathom", "蝰邪": "Vyper", "无双魔术师": "Sinclair", "陷阱师": "Trapper", "渡鸦": "Raven", "维克多": "Victor", "米娜": "Mina", "孤猎": "Drifter", "诛邪者": "Venator", "佩吉": "Paige", "波米": "Boho", "门侍": "The Doorman", "天鹅舞伶": "Swan", "御空行者": "Skyrunner", "比利": "Billy", "雷姆": "Rem", "赛凌": "Celeste", "阿波罗": "Apollo", "格瑞墓": "Graves", "西尔芙": "Silver", "女巫": "Vindicta", "老七": "Seven"},
  termsCnToEn: {"兵线": "creep wave", "黄路": "yellow lane", "蓝路": "blue lane", "绿路": "green lane", "紫路": "purple lane", "推塔": "push tower", "回城": "teleport back", "买装备": "buy items", "商店": "shop", "大招": "ultimate", "技能": "ability", "天赋": "upgrades", "中路": "mid lane", "一塔": "first tower", "二塔": "second tower", "三塔": "third tower", "大野": "big jungle camp", "小野": "small jungle camp", "补刀": "last hit", "集合": "group up", "撤退": "retreat", "进攻": "push", "守家": "defend base", "基地": "base", "出装": "item build"},
  itemEnToCn: {"Extended Magazine":"扩容弹匣", "Monster Rounds":"猎怪弹", "Cultist Sacrifice":"特异供奉", "Ammo Scavenger":"拾弹能手", "Tesla Bullets":"特斯拉弹", "Capacitor":"积雷电容", "Hollow Point":"空尖弹", "Opening Rounds":"先发强袭", "High-Velocity Rounds":"高速弹", "Melee Lifesteal":"近战疗法", "Rebuttal":"对等还击", "Counterspell":"法术反制", "Weighted Shots":"重压射击", "Ancient Shield":"远古战盾", "Close Quarters":"近身决斗", "Long Range":"远击威力", "Slowing Bullets":"减速弹", "Inhibitor":"抑制术", "Spirit Shredder":"碎灵子弹", "Heroic Aura":"英雄光环", "Silence Wave":"沉默之潮", "Haunting Scream":"作祟尖叫", "Silencer":"沉默子弹", "Silencer":"沉默子弹", "Berserker":"狂战士", "Frenzy":"狂乱", "Siphon Bullets":"虹吸弹", "Headshot Booster":"头弹奖励", "Weakening Headshot":"头弹弱防", "Sharpshooter":"弹无虚发", "Headhunter":"猎头", "Spirit Rend":"元灵撕裂", "Crippling Headshot":"头弹破防", "Mystic Shot":"秘术射击", "Lucky Shot":"幸运一击", "Point Blank":"近身猛击", "Toxic Bullets":"毒弹", "Ricochet":"跳弹射击", "Apex Combat":"巅峰之战", "Extra Health":"额外生命", "Toughness":"坚韧", "Bullet Armor":"子弹护甲", "Spirit Armor":"元灵护甲", "Bullet Lifesteal":"子弹回复", "Debuff Reducer":"减益缩短", "Dispel Magic":"驱散魔法", "Spirit Resilience":"元灵护体", "Bullet Resilience":"子弹坚甲", "Metal Skin":"铜皮铁骨", "Healing Booster":"治疗强化", "Fortitude":"坚毅之心", "Leech":"赤蟥", "Sprint Boots":"疾跑靴", "Trophy Collector":"寻猎季节", "Enduring Speed":"疾速不怠", "Stamina Mastery":"跑酷大师", "Aerial Supremacy":"空中霸权", "Rapid Rounds":"快手连发", "Extra Stamina":"耐力补给", "Hunter's Aura":"猎人光环", "Grit":"刚毅", "Weapon Shielding":"武器防护", "Spirit Shielding":"元灵防护", "Battle Vest":"战斗背心", "Enchanter's Emblem":"附魔师纹章", "Extra Spirit":"灵力扩增", "Mystic Regeneration":"秘术愈疗", "Improved Spirit":"灵力高涨", "Spiritual Overflow":"元灵漫溢", "Return Fire":"回应射击", "Greater Expansion":"强效扩张", "Mystic Expansion":"秘术扩张", "Extra Charge":"额外充能", "Spirit Lifesteal":"元灵吸收", "Bullet Resist Shredder":"粉碎护甲", "Mystic Reverb":"秘术余波", "Mystic Burst":"秘术爆发", "Tankbuster":"重装克星", "Mystic Vulnerability":"秘术脆弱", "Healbane":"不治魔咒", "Mystic Slow":"秘术缓速", "Escalating Exposure":"伤上加伤", "Rapid Recharge":"火速充能", "Omnicharge Signet":"跃升之印", "Compress Cooldown":"冷却压缩", "Superior Cooldown":"超速冷却", "Transcendent Cooldown":"超凡冷却", "Timeless Emblem":"永恒纹章", "Shadow Step":"幽影瞬步", "Slowing Hex":"减速魔咒", "Spirit Sap":"元灵衰竭", "Focus Lens":"聚焦透镜", "Rusted Barrel":"锈蚀枪管", "Disarming Hex":"缴械魔咒", "Rescue Beam":"营救光束", "Rebirth":"重生", "Soul Rebirth":"原地复活", "Decay":"衰变", "Scourge":"敌之灾患", "Knockdown":"天锤压顶", "Phantom Strike":"幻影突袭", "Warp Stone":"传送石", "Vortex Web":"雷织漩涡", "Refresher":"刷新环", "Echo Shard":"回音碎片", "Torment Pulse":"痛苦脉冲", "Cheat Death":"幸免于难", "Shadow Weave":"来去无踪", "Majestic Leap - Disabled":"升空飞跃 - 已禁用", "Majestic Leap":"升空飞跃", "Healing Nova":"治疗之环", "Restorative Locket":"疗愈护符", "Healing Rite":"治疗仪式", "Shrink Ray":"缩小射线", "Infuser":"灵力灌注", "Guardian Ward":"护卫结界", "Divine Barrier":"神圣屏障", "Alchemical Fire":"炼金之火", "Blood Tribute":"殷红贡礼", "Fleetfoot":"轻盈飞步", "Kinetic Dash":"动能冲刺", "Arcane Surge":"秘法涌动", "Unstoppable":"势不可挡", "Colossus":"巨人", "Cold Front":"冰天雪地", "Arctic Blast":"极地冰暴", "Ethereal Shift":"身躯虚化", "Cursed Relic":"天谴圣物", "Duration Extender":"余威回荡", "Superior Duration":"余威久久", "Glass Cannon":"玻璃大炮", "Fury Trance":"怒意之潮", "Vampiric Burst":"疗愈爆发", "Lifestrike":"生命打击", "Spirit Strike":"大伤元气", "Spirit Snatch":"元灵收割", "Melee Charge":"近战蓄力", "Crushing Fists":"粉碎重拳", "Diviner's Kevlar":"金刚宝衫", "Radiant Regeneration":"容光焕发", "Boundless Spirit":"灵力无边", "Burst Fire":"健步疾射", "Enduring Spirit":"元灵常驻", "Extra Regen":"加速回复", "Surge of Power":"灵能涌动", "Suppressor":"元灵压制", "Quicksilver Reload":"魔力装填", "Mercurial Magnum":"水银重弹", "Intensifying Magazine":"火力渐升", "Escalating Resilience":"层层防御", "Swift Striker":"迅捷突击", "Veil Walker":"穿幕行者", "Reactive Barrier":"应急屏障", "Indomitable":"不屈之志", "Restorative Shot":"疗愈子弹", "Titanic Magazine":"巨型弹匣", "Split Shot":"裂光射击", "Active Reload":"高速装填", "Magic Carpet":"魔毯", "Hexafoil Ward":"六叶结界", "Hex-Sealed Knuckles":"咒印铁拳", "Conjure Missiles":"召唤导弹", "Patron's Healing":"守护神的治疗", "Spirit Burn":"元灵燃烧", "Lightning Scroll":"雷鸣卷轴", "Soul Explosion":"灵魂爆炸", "Witchmail":"巫师护甲", "Healing Tempo":"治疗律动", "Endless Magazine":"无尽弹匣", "Glass Cannon v2":"玻璃大炮 v2", "Armor Piercer":"穿甲弹", "Infinite Rounds":"无限弹匣", "Plated Armor":"铁板重甲", "Spellbreaker":"破咒护符", "Juggernaut":"破阵之势", "Spellslinger":"施术之手", "Stalker":"追猎", "Express Shot":"疾速射击", "Seraphim Wings":"炽天使之翼", "Mystical Piano":"神秘钢琴", "Nullification Burst":"否决爆发", "Celestial Blessing":"上界福佑", "Eternal Gift":"天赐之礼", "Mystic Conduit":"秘术管道", "Haunting Shot":"灵异子弹", "Cloak of Opportunity":"机遇斗篷", "Runed Gauntlets":"符文手套", "Electric Slippers":"霹雳便鞋", "Prism Blast":"棱镜冲击", "Unstable Concoction":"不稳定化合物", "Frostbite Charm":"寒霜护符", "Shadow Strike":"暗影突袭", "Ballistic Enchantment":"弹道附魔", "Recharging Rush":"能量迸发", "Golden Goose Egg":"金鹅蛋"},
  buildHint: function (targetLang) {
    var heroLines = [];
    var zh = this.heroCnToEn;
    var cnKeys = Object.keys(zh).slice(0, 60);
    for (var i = 0; i < cnKeys.length; i += 1) heroLines.push(cnKeys[i] + "=" + zh[cnKeys[i]]);
    var itemLines = [];
    var ik = Object.keys(this.itemEnToCn);
    for (var k = 0; k < ik.length; k += 1) itemLines.push(ik[k] + "=" + this.itemEnToCn[ik[k]]);
    var termLines = [];
    var tk = Object.keys(this.termsCnToEn);
    for (var j = 0; j < tk.length; j += 1) termLines.push(tk[j] + "=" + this.termsCnToEn[tk[j]]);
    return [
      "This is Deadlock (a MOBA) in-game chat. The following are game terms.",
      "Heroes (keep official English hero names; never translate hero names as common words): " + this.heroNames.join(", ") + ".",
      "Chinese hero nicknames: " + heroLines.join(", ") + ".",
      "Common terms: " + termLines.join(", ") + ".",
      "Items (official EN->CN shop names; when the source names an item, use its official Chinese name): " + itemLines.join(", ") + ".",
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
