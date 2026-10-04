# 未实现功能与待优化项(UNIMPLEMENTED & ROADMAP)

> 本文件记录当前版本尚未完成/明确不做/待验证的功能与优化方向,便于后续迭代对照。
> 现状前提(2026-10-01 起):游戏移除了全部网络能力,游戏内既收不到也发不出数据;
> "游戏内显示译文"与"游戏内出站翻译"均已不可行。译文改由**游戏外悬浮窗**显示,
> 发消息改走**剪贴板**(详见 docs/architecture.md)。

## 一、未实现 / 待完善

### 1. 全队 SteamID 自动无感采集(已由桥端 API 补全)
- **现状**:游戏内仍保持被动采集;桥端新增 `core/steamid_enrich.js`,比赛结束后通过公开 API 拉取整局 roster 与 Steam 档案,补写 `identity_cache.json`。
- **已确认的事实**:
  - 顶栏条目本身**不含** steamid(无 accountid/steamid 属性或对话框变量),盲试字段无效;
  - steamid 只存在于悬停资料卡(ProfileCard)上;
  - 主动悬停模拟/自动打开资料卡会抢走鼠标控制(用户反馈卡顿),已按用户要求移除。
- **待办**:继续观察公开 API 对新比赛的入库延迟,必要时增加更稳健的重试/本地缓存策略。

### 2. 战绩 / 比赛数据汇总
- **明确不做**(用户 2026-08-22 指示):不实现赛后战绩、KDA 统计等功能。scoreboard 扫描仅保留最小结构,不扩展。

### 3. 出站翻译(中文 -> 英文)
- 现状:出站改走**游戏外悬浮窗** —— 输入中文 → `/api/v1/overlay/translate` 译成英文 →
  写系统剪贴板 → 用户回游戏 Ctrl+V 手动粘贴。
- 游戏内原有的"发送前翻译"(接管 chat.xml 的 oninputsubmit)随网络能力一并失效,已移除;
  快捷指令轮盘消息(撤退/谢了,kind=quick)本就由游戏客户端本地化,不涉及出站翻译。
- **待验证**:高峰期主服务商(如 DeepSeek)慢时,悬浮窗出站是否稳定回退到 bing 译文。

### 4. 消息行 hero 读取稳定性
- 聊天行 HeroImage 的 hero_id 对话框变量当前为空(heroimg probe hero_id=0/-1/-1),依赖顶栏昵称->英雄映射回填(第十三轮已加兜底,待实战验证)。

## 二、已实现优化(摘要)

- **翻译提速**:DeepSeek 关闭思考模式(thinking:{type:"disabled"}),单条翻译 0.6~1.0s。
- **回退链**:主服务商 20s 上限 + Bing 免 Key 自动回退(fallbackProviders)。
- **日志单文件化**:赛后 120s 宽限期保留比赛 id + session 文件 5 分钟新鲜度迁移守卫,修复"一场两文件/旧场误并入新场"。
- **日志字段精简**:消息行去掉重复 matchId/heroId/steamid,身份抽离为一次性 player 记录(按 name+steamid+hero 去重)。
- **游戏术语表**:core/glossary.js(英雄中英名 + 常用术语)已接入 OpenAI 兼容 provider,翻译后修正英雄名/术语(女巫->Vindicta、老七->Seven 等)。
- **本机身份回填**:从 console.log 连接行(UDP steamid:xxx@ip '昵称')解析本机 steamid。
- **游戏外悬浮窗通道**:游戏移除 HTTP 能力后,唯一可用通道改为单向 `console.log` 的
  `[LCT-CHAT]` 行 + 原生 WPF 悬浮窗(见 docs/architecture.md)。

## 三、已知限制

- 译文只能在**游戏外悬浮窗**显示:游戏内既无入站通道,也无法把文字注入游戏输入框;这是引擎层面的限制,非本项目的选择。
- 游戏内 Panorama 仍无法直接拿全队 SteamID;全队信息依赖桥端公开 API,新比赛可能需等待 API 入库后才能补全。
- 翻译质量依赖服务商;高峰期主服务商可能超时,自动回退 Bing(免 Key,质量略低)。
- 顶栏/资料卡布局随游戏版本可能变化,mod 覆盖版依赖 Source 2 Viewer 重建结构,数据绑定可能失效(account 字段即为此类)。
