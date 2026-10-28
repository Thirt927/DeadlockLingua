# 未实现功能与待优化项(UNIMPLEMENTED & ROADMAP)

> 本文件记录当前版本尚未完成/明确不做/待验证的功能与优化方向,便于后续迭代对照。
> 现状前提(**2026-10-09 更新;2026-10-24 更正「面板已死」的结论**):游戏 2026-10-01 的更新
> 移除了 `$.AsyncWebRequest`;隐藏面板对 `http://` / `data:` / `file://` 均不加载,但真因是
> 证书链(受信任 https 可加载,上游已实车,见「一、6」),**不是引擎删了 CEF**。
> 但**入站并非不可能** —— 上游 BabelTower 用 `<Image>` 面板加载状态 + `ImageLoaded` 事件
> 做出了 1 bit 入站通道(BTIPC),本仓库已按该规格自行实现(见「一、5」)。
> v2.1.0(2026-10-09)起译文主显示路径为**游戏内**(BTIPC 双向信道,已落地并实车验收);
> 游戏外悬浮窗自 v2.0.1 起归档为 legacy(代码保留可用),出站发消息也可走剪贴板路线。
> 详见 docs/architecture.md 第 9 节。

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

### 3. 出站翻译(中文 -> 英文)—— 已于 2026-10-09 恢复游戏内路径
- 现状:**回到游戏内** —— 输入框回车 → 经 BTIPC 译成英文 → 走原版发送链路发出。
  (v2.0.x 期间的「悬浮窗译好写剪贴板、用户回游戏 Ctrl+V」仍可用,属备选路径。)
- 快捷指令轮盘消息(撤退/谢了,kind=quick)本就由游戏客户端本地化,不涉及出站翻译。
- **待验证**:高峰主服务商慢时,出站翻译的降级(超时按原文发送)是否及时。

### 4. 消息行 hero 读取稳定性
- 聊天行 HeroImage 的 hero_id 对话框变量当前为空(heroimg probe hero_id=0/-1/-1),依赖顶栏昵称->英雄映射回填(第十三轮已加兜底,待实战验证)。

### 5. BTIPC 双向信道 / 游戏内译文显示(**已于 v2.1.0 落地,实车验收通过**)
- **目标**:恢复 v2.0.0 之前的游戏内体验 —— 译文直接追加在聊天行下方,发送前翻译走原版发送链路。
- **方案**(按上游 `docs/btipc-v1.md` 冻结规格**自行实现**,不合并上游代码):
  - 上行:`console.log` 结构化单行 `[LCT] BTIPC REQ w=.. id=.. len=.. crc=.. b64=..`;
    **硬依赖游戏带 `-condebug` 启动**(否则不写 `console.log`)
  - 下行:128 个隐藏 2×2 `<Image>` 面板逐轮 `SetImage("/btipc/dl?w&r&p&t")`;
    桥端 bit=1 回 `200`+PNG、bit=0 回 `404`;`ImageLoaded` fire=1 / `T_CLOSE`(600ms)内静默=0
  - 帧:16 字节 = 128 bit,载荷 10 字节/帧(6 字节帧头);CRC-16/CCITT-FALSE 覆盖固定 14 字节;
    轮号 `r` 前进即隐式 ACK,重投同一 `r` 要求桥幂等重发同帧
  - 上层信封:`t=<target>\n<原文>` / `op=config` / `op=test`;payload 上限 680 字节
- **已落地(第六十四/六十五轮,2026-10-09)**:桥端 `core/btipc/{crc16,framer,window,transport}.js` + `GET /btipc/dl` 路由 + `overlay.js` 的 `onLine` 钩子 + 5s GC 定时器;游戏侧 `lingua_chat.js` 的 BTIPC 客户端(128 个隐藏 Image 面板 + `ImageLoaded` 轮次状态机 + 内联 crc16/UTF-8/base64 副本)+ `dispatchJob -> dispatchViaBtipc`;译文 Label 追加到聊天行;发送前翻译经 BTIPC 译成目标语言后回填原版提交链路。
- **离线验证**:`tests/btipc/*` 五套(crc/frame/transport/e2e_tail/route,其中 `live_http` 起真实监听端口)全绿;`scripts/lingua_chat_simtest.js` PASS 58/0(模拟器用真实桥端 framer 编码、游戏侧内联副本解码,跨实现漂移会被 CRC 抓到)。
- **仍未完成**:上游**实车验收**(关游戏 → 部署 `dist/pak22_dir.vpk` → 带 `-condebug` 启动 → 对局内看译文直接出现在聊天行下方)。实车通过后把 AGENTS.md §2 里「尚未实车验收」的注记移除。
- **已知坑(来自上游实车)**:同 `r` 重投的 URL 必须变化(否则撞引擎缓存不触发 `ImageLoaded`);
  桥端窗口 GC 必须晚于客户端最长重试跨度;同轮位到达乱序,须按面板 id 定位位值而非到达序;
  存在迟到整轮重放,须按 `(id, round)` 幂等去重。

### 6. https 面板通道 —— **已于 2026-10-24 落地**(待实车验收)
- **事实更正**:本仓库此前把"面板对 http/data/file 不加载"写成"引擎不再为 HTML 面板创建浏览器实例 / 面板已死",**不成立**。上游 BabelTower 2026-10-15 实车证实:引擎在 LoadPage 之前按**证书链**拒绝(`error:-202` = `ERR_CERT_AUTHORITY_INVALID`);本机自签证书(CN=BabelTower-localhost,SAN=`DNS:localhost` + `IP:127.0.0.1` + `IP:::1`)加入 `CurrentUser\Root` 并**完全退出重启 Steam** 后,隐藏面板可加载 `https://localhost:8792`,页面同源 fetch 取整条译文写 `document.title`,下行 **<1s**(位泵 3~27s)。证据/步骤见 https://github.com/c1375rick/BabelTower/blob/main/docs/btipc-https-v1.md。
- **本仓库现状**:已实现。`core/bridge_https.js`(8792 TLS 终结,独立进程)、`scripts/gen_bridge_cert.ps1`(生成/信任/撤销)、`config.https`、桥端 `op=ui` 的 `httpsPanel` 能力位、游戏侧探针与降级(`lingua_chat.js` 的 `HTTPS_PANEL_*`)。
- **设计/排障/安全边界**:见 [`docs/https-panel.md`](https-panel.md);用户侧启用三步见 README「安装」。
- **仍未验证**:真机端到端(本机没有游戏)、`document.title` 长度上限、WebKit 页面加载耗时、`HTMLChangedTitle` 与 `panel.title` 属性的一致性。
- **兜底不变**:证书没装 / Steam 没重启 / 探针判死 / 连续 3 次硬失败 → 自动整局退回 BTIPC,无需用户切换。
- **安全边界**:证书只写**当前用户**根证书库(SAN 仅 localhost/127.0.0.1/::1,冒充不了公网域名);`-Trust` 需显式执行,`-Untrust` 可撤销(两者都要完全重启 Steam 才生效)。

### 7. 队友语音字幕(语音识别 B 专线)—— 方案稿,未实现(2026-10-24)
- **用户 2026-10-24 决定:只做"队友语音 → 中文字幕";语音输入(A,自己说话→聊天)暂缓。**
- 能借的游戏内信号:①**说话图标** = 游戏自己的每玩家语音活动 → 可用于"谁在说"归属 + 只在这段做识别(减少
  英雄台词/音效幻觉);②**单独静音** = 本地混音增益,不能当音轨隔离,只能用来做校准实验。
- 硬限制:不注入就拿不到每位玩家的独立语音流;Deadlock 无独立"语音输出设备",虚拟声卡分流不成立。
  所以只能抓**游戏整局混音**(进程 loopback 可排除 Discord/浏览器,但排不掉音效),定位是"混音字幕"。
- 架构:游戏外 C# 助手(NAudio WASAPI loopback)→ 16k mono → 桥(Silero VAD → sherpa-onnx SenseVoice /
  腾讯云 ASR → 现有翻译链)→ 显示 MVP 复用 WPF 字幕层(kind=voice,Borderless 下可用);V2 游戏内 Panorama
  字幕条(https 面板 `op=voice` 下行;BTIPC 16 B/s 不够)。
- **待验证的官方捷径(2026-10-24 追加)**:Deadlock 有开发者控制台(Settings 开启);Source 系 cvar
  `voice_recordtofile` 会把"解码后的远端语音"录成 wav(不含游戏音效)。若存在且未被封禁,采集源直接换成
  tail 该 wav——无注入、无 ban 风险,优于 loopback(先跑 `find voice` / `cvarlist voice`)。
- **注入方案(用户提出"只读抓取")已评估**:技术上可行(挂语音包/Opus 解码可拿到每玩家 PCM),但 VAC 检测面
  覆盖注入模块/hook/线程/内存页异常,"只读"不构成豁免;ban 为账号级永久、Deadlock 周更导致维护成本极高。
  因此只作为"用户明确接受风险"的私有实验,不进公开 Release。详见 voice-asr-plan.md §0.1。
- 工作量:MVP ≈2~3 天(复用 WPF 显示),游戏内字幕条约 4~5 天。详细路线/验证清单/风险:[`docs/voice-asr-plan.md`](voice-asr-plan.md);
  引擎/价格:[`docs/STT-research-2026-10.md`](STT-research-2026-10.md);
  采集/全屏显示:[`docs/audio-voice-stt-research.md`](audio-voice-stt-research.md)。

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

- ~~译文只能在**游戏外悬浮窗**显示:游戏内既无入站通道~~ → **已更正(2026-10-09)**:
  游戏内**存在**入站通道(`<Image>` 面板加载状态位元轮询 + `ImageLoaded` 事件),原结论
  「不存在任何可用入站通道」来自覆盖不全的探针(只测了「JS 能主动发起」那一类路径,
  漏了「引擎为渲染会自己去取什么」)。恢复游戏内译文显示已列入开发计划(见「一、5」);
  在实现落地前,译文仍由游戏外悬浮窗显示。把文字注入游戏输入框同样将成为可能
  (改写 `TextEntry.text` 后走原版发送链路,上游已实测成立)。
- 游戏内 Panorama 仍无法直接拿全队 SteamID;全队信息依赖桥端公开 API,新比赛可能需等待 API 入库后才能补全。
- 翻译质量依赖服务商;高峰期主服务商可能超时,自动回退 Bing(免 Key,质量略低)。
- 顶栏/资料卡布局随游戏版本可能变化,mod 覆盖版依赖 Source 2 Viewer 重建结构,数据绑定可能失效(account 字段即为此类)。
