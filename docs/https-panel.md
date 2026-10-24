# https 面板通道（下行 ≈ 一个 RTT）

> 状态：2026-10-24 落地（桥侧 `core/bridge_https.js` + 证书脚本 + 游戏侧探针/降级）。
> **实车尚未验收**：本机没有游戏，只能用离线测试覆盖 TLS 终结、代理、探针判死与降级逻辑；
> 真机需要按下面「启用三步」跑一次，看日志里有没有 `https panel: ALIVE`。

## 1. 为什么加它

BTIPC 位信道是"算术上必然慢"的：10 字节/帧、每帧 T_CLOSE 600ms，60 字节译文要 6 帧
（≈4s），长句 17~38 帧（12~25s）。而这段慢**不来自网络**——`dt ≈ T_CLOSE` 说明每帧都在
等客户端的闭合窗口。

https 面板通道把"搬运"交给桥：隐藏 HTML 面板加载 `https://localhost:8792/bridge?id=..&op=..`，
页面在**同源**下 `fetch('/api/v1/translate')` 拿到整条结果，一次写进 `document.title`；
游戏侧只做"导航 + 读 title"。下行只剩 **一个 RTT + 翻译耗时**，实测 <1s
（上游同局对照：位泵 3.0~27.4s → 面板 <1s）。

## 2. 来源与归属

| 来源 | 用到的内容 |
| --- | --- |
| [BabelTower `docs/btipc-https-v1.md`](https://github.com/c1375rick/BabelTower/blob/main/docs/btipc-https-v1.md) | 协议语义：TLS 终结独立进程、`/bridge` 页面同源 fetch 写 `document.title`、探针定生死、硬/软失败分类、三次连击降级、curl 实测数据 |
| 上游文档转述的 DeadlockTranslate 0.6.19 | 「自签证书 + 写入 `CurrentUser\Root` + 完全重启 Steam」这一方案的最初实机先例与 SAN 布局（`DNS:localhost` + `IP:127.0.0.1` + `IP:::1`） |
| 本仓库 | 实现：`core/bridge_https.js`、`scripts/gen_bridge_cert.ps1`、游戏侧 `lingua_chat.js` 的 `HTTPS_PANEL_*` 区块；**未复制上游代码** |

## 3. 拓扑

```
游戏内隐藏面板 <── https ──> core/bridge_https.js (8792, TLS 终结) ── http ──> core/bridge_server.js (8791)
     │                          独立进程                                     │
     │ 导航 /bridge?id=..&op=..                    原样转发 /bridge 与 /api/v1/* │
     └─ 页面同源 fetch /api/v1/translate → document.title ────────────────────┘

BTIPC 位泵 ────────────────────────────────────────────────────────────────┘（兜底，全程保留）
```

拆独立进程的四个理由：

1. 证书缺失/过期/握手失败不能连带 BTIPC 一起死；
2. `bridge_server.js` 只保留一处 `listen`（安全护栏），不内联第二个绑定；
3. 页面同源 fetch 由它原样转发，桥的路由/状态零改动；
4. 它的失败是"可丢弃"的：退出码 3 = 证书不可用，启动器跳过即可。

## 4. 启用三步（顺序不能换）

```powershell
# ① 生成本机自签证书并信任（幂等；普通权限即可，不用管理员）
powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
# ② 完全退出 Steam（托盘图标也要退），再重新打开
# ③ 启动游戏，进对局 —— 看 console.log 里有没有 "https panel: ALIVE"
```

三个必须知道的坑（都有实机/上游依据）：

- **IP 必须用 IP SAN**：把 `127.0.0.1` 写成 `DNS:127.0.0.1` 不算，证书校验照旧失败；
- **信任库写入必须用 `certutil -user -addstore Root`**：非交互进程里 `Import-Certificate`
  会报 `UI is not allowed in this operation`；撤销同理（`certutil -user -delstore Root`）；
- **信任后必须完全重启 Steam**：信任决定缓存在 Steam 宿主进程里，只重启游戏不生效。
  （上游 §4.1 做了 A/B 对照；这也是最容易误判成"证书方案不可行"的一步。）

不跑 ①② 也能用：桥端 `httpsPanel:false`，游戏侧连探针都不发，整局留在 BTIPC，
体感与加这条通道之前完全一致。

## 5. 通道怎么选（客户端逻辑）

```
开机 op=ui 从桥拿到 httpsPanel:true（= 证书存在 && https.enabled）
  └─ 1.2s 后探针：导航 https://localhost:8792/bridge?...&op=health
       ├─ 3s 内读到 ok              → 本会话走 https 面板（日志：https panel: ALIVE）
       └─ 超时 / 页面没 alive       → 本会话全程 BTIPC（日志：https panel: not usable (...)）
```

- **探一次定生死**：证书没信任时每条请求都先撞一次超时，比 BTIPC 还慢；所以只探一次；
- **硬失败**（页面没加载 / 面板不可用 / `bad_bridge_payload`）→ 该 job **原样交回 BTIPC**
  重做，不消耗 `attempts`；交接前撤销出站超时句柄，避免二次 `done` 击穿单槽；
- **软失败**（页面活了但慢：`bridge_timeout`）→ 按既有语义结算（出站发原文），不再拖十几秒；
- **连续 3 次硬失败** → `httpsPanelOk=false`，本会话只走 BTIPC，并告警一次；
- 现场排障可把 `lingua_chat.js` 的 `HTTPS_PANEL_ENABLED` 改成 `false`，一键全量退回 BTIPC。

## 6. 排障

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| `https panel: ALIVE` | 通道可用 | 无需处理 |
| `https panel: not usable (bridge_nav_failed)` | 页面从未加载 | 没跑 `-Trust`，或没完全重启 Steam |
| `https panel: hard fail #n/3` | 单次硬失败，已交回 BTIPC | 观察是否到 3 |
| `https panel: dead (3 consecutive hard fails)` | 本会话退 BTIPC | 修好后重进游戏即恢复 |
| `logs/bridge_https.log` 里 `TLS 被客户端拒绝 (ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN)` | 引擎用证书告警拒了自签证书 = 没信任的**正面证据** | 跑 `-Trust` 并完全重启 Steam |
| `bridge.log` 里 `https panel: cert missing` | 桥没找到 pfx，子进程未启动 | 跑证书脚本，或检查 `config.https.pfx` |

跨文件对时序注意时区：`bridge.log` 是 UTC，`bridge_https.log` 用本地时间（有意的，便于人读）。

## 7. 安全边界

- 只监听 `127.0.0.1` 与 `[::1]`，不对外暴露；
- 不做鉴权——它存在的唯一目的是让引擎的证书校验通过，不是服务；
- 只转发 `/bridge` 与 `/api/v1/*`，不是通用代理；不记录请求体（可能含聊天原文）；
- 证书只签给 `localhost` / `127.0.0.1` / `::1`，私钥留本机 `config/certs/`（已 gitignore）；
- 撤销：`scripts\gen_bridge_cert.ps1 -Untrust` + 完全重启 Steam（同样要重启 Steam 才生效）。

## 8. 与 BTIPC 的分工

| | https 面板 | BTIPC 位泵 |
| --- | --- | --- |
| 下行延迟 | 一个 RTT + 翻译（<1s） | N 帧 × 600ms（3~27s） |
| 前提 | 证书被信任 + 完全重启 Steam | 游戏带 `-condebug` |
| 承载 | 全部 op（translate / config / test / log） | 同样全部 op，但大包会超时 |
| 角色 | 主通道 | **兜底**（证书不可用 / 探针判死 / 连续硬失败） |

## 9. 未验证（如实记录）

- 真机端到端：导航 → 页面加载 → fetch → 出译文，本机没有游戏，未跑；
- `document.title` 的长度上限（上游按约 512 字符处理）：超长译文可能被截断，
  已按硬失败交回 BTIPC，但阈值未实测；
- WebKit 页面加载耗时、`HTMLChangedTitle` 事件与 `panel.title` 属性的一致性
  （上游 §9.1 指出属性可能读到旧值，本实现同时挂事件与轮询，实机需确认）；
- 多显示器/全屏/输入法对面板导航的影响（这条通道只读 title，理论无关）。
