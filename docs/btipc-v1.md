# BTIPC v1 协议规格(本仓库实现口径)

> **状态:桥端已实现并离线验收(2026-10-09);游戏侧待实现。**
> 依据上游 BabelTower 的冻结规格 `docs/btipc-v1.md`(GPL-3.0)自行实现,不合并其代码。
> 桥端落地在 `core/btipc/{crc16,framer,window,transport}.js`,离线验收在 `tests/btipc/*.test.js`;
> 游戏侧客户端将落在 `mod/panorama/scripts/lingua_chat.js` 的 `State.btipc` 区块。
>
> **为什么需要它**:游戏 2026-10-01 的更新移除了 Panorama 的 HTTP 能力
> (`$.AsyncWebRequest` 调用即抛,隐藏 HTML 面板不再创建 CEF 实例),通过 HTTP/CEF 收发已不可能。
> 但**入站并非不可能** —— `<Image>` 面板的**加载状态**仍然可用作 1 bit 回读信道。
> 详见 [architecture.md](architecture.md) 第 9 节。

---

## 1. 设计原则(全部来自实测,不要再假设)

1. **只信两个符号**:`ImageLoaded` 事件到达 = 1;`T_CLOSE` 内未到达 = 0。
   **禁止用时延差异编码信息**(跨版本不稳定)。
2. **0 位不可早知**:某面板没 fire,要么是 0 位、要么是还没到的 1 位 —— 每轮闭合只能靠
   `T_CLOSE` + CRC 校验 + 重试。
3. **无推送**:桥 → 游戏没有主动通道,**轮询即请求**(`SetImage` 的 URL 本身就表示"给我第 r 帧")。
4. **隐式 ACK**:游戏把轮次号 `r` 前进 = 确认上一帧;重投同一 `r` = 要求桥幂等重发同一帧。
5. **与探针隔离**:面板前缀 `BTIPCD*`,路由 `/btipc/*`,不得与旧探针(`BTBIT*` / `BTD*` / `BTE*`)混用。

---

## 2. 信道拓扑

```text
┌──────────────────── 游戏(Panorama) ────────────────────┐
│ BTIPC Client                                             │
│  上行: console.log 行 "[LCT] BTIPC REQ/CAN ..."          │
│  下行: 128 个隐藏 Image 面板逐轮 SetImage 轮询           │
└───────────┬──────────────────────────────┬───────────────┘
            │ console.log tail(桥每秒尾随) │ GET /btipc/dl?w&r&p&t
            ▼                              ▼
┌──────────────────── 桥(Node :8791) ─────────────────────┐
│ REQ 行解析 → 翻译 → 帧队列(framer)                       │
│ /btipc/dl: 按 (w,r) 幂等发帧: bit=1 → 200 PNG / bit=0 → 404 │
└──────────────────────────────────────────────────────────┘
```

- **上行(游戏 → 桥)**:一行结构化文本,走 `console.log`。
  **硬依赖游戏带 `-condebug` 启动** —— 没有它游戏根本不写 `console.log`,上行全断。
- **下行(桥 → 游戏)**:HTTP 状态码即数据。

---

## 3. 帧格式(16 字节 = 128 bit,一帧一轮)

### 3.1 面板 ↔ 位映射

- 面板 `BTIPCD0 .. BTIPCD127`(隐藏,2×2,按需创建、跨轮复用)
- 字节 k(0..15)贡献 bit[k*8 .. k*8+7];**面板 p 携带全局第 p 位,LSB 在前**
  - 即 byte k 的 bit b → 面板 `k*8+b`
- 编码:**位 = 1 → 桥回 HTTP 200(带 PNG);位 = 0 → 桥回 404(空体)**

### 3.2 帧布局(冻结)

```text
+----+----+----+----+----+----+------------+
| B0 | B1 | B2 | B3 |CRCH|CRCL|  Payload   |
+----+----+----+----+----+----+------------+
B0      : bit7 = END      bit0..6 = seq(0..127)
B1..B2  : request_id(16 bit,大端)
B3      : bit7 = VALID    bit0..6 = LEN(0..10)
B4..B5  : CRC-16/CCITT-FALSE(大端)
B6..B15 : payload(10 字节,LEN 不足处补 0x00)
```

- **CRC 覆盖范围(冻结)**:`CRC16(B0..B3 + B6..B15)` = 固定 **14 字节**(含 LEN 之后的 `0x00`
  填充),**不含 CRC 自身**。seq / id / VALID / LEN 全属协议控制信息 → 轮次错位、LEN 被改
  都会被 CRC 揪出,解码后无需再验字段。
- 掩码读写(Panorama JS):

```js
const end   = (b0 & 0x80) !== 0;  // bit7
const seq   =  b0 & 0x7f;         // bit0..6
const valid = (b3 & 0x80) !== 0;  // bit7
const len   =  b3 & 0x7f;         // bit0..6
// 编码对称:b0 = (end ? 0x80 : 0) | seq; b3 = (valid ? 0x80 : 0) | len
```

- 消息 = 帧 0..N 的 payload 按 `seq` 顺序拼接;`END=1` 的帧是最后一帧,其 `LEN` 给出有效尾长。
- **BUSY 帧固定格式(冻结,不随机)**:

```text
B0 = 0x00            (seq=0, END=0)
B1..B2 = request_id
B3 = 0x00            (VALID=0, LEN=0)
B4..B5 = CRC16       (输入 = B0..B3 + 全 0 payload,固定 14 字节)
B6..B15 = 全 0x00
```

  游戏侧只判 `VALID=0` → BUSY → 退避 `BUSY_BACKOFF_MS` → 轮次推进,**不跑重组逻辑**。
- **CRC16 两侧各自内联实现,逐字节一致**(游戏侧 Panorama 无模块系统)。
  桥端源:`core/btipc/crc16.js`。测试向量:
  - `"123456789"` → `0x29B1`(标准)
  - 空输入 → `0xFFFF`(初值,无 xorout)
  - 全 `0x00` × 16 → `0x6A0A`(本仓库实现基准,用于两侧互检)

### 3.3 位序例(正式例子,测试断言照此写)

设 `B0 = 0x01`、`B1 = 0xA5`:

```text
B0 = 0x01 = 0000 0001
  bit0=1   → 面板0 = 1     bit1..7=0 → 面板1..7 = 0
B1 = 0xA5 = 1010 0101
  bit0=1 → 面板8  = 1     bit4=0 → 面板12 = 0
  bit1=0 → 面板9  = 0     bit5=1 → 面板13 = 1
  bit2=1 → 面板10 = 1     bit6=0 → 面板14 = 0
  bit3=0 → 面板11 = 0     bit7=1 → 面板15 = 1
```

→ 本轮 fires = `{0, 8, 10, 13, 15}`(已在 `tests/btipc/frame.test.js` 固化)

---

## 4. 上行行格式(游戏 → 桥)

经 `console.log`(`[LCT]` 前缀,桥端 tail 解析):

```text
[LCT] BTIPC REQ w=<win> id=<id> len=<n> crc=<hex4> b64=<base64(payload)>
[LCT] BTIPC CAN w=<win>                       ← 取消/放弃窗口
```

- `<win>`:**6 位十六进制窗口号**(`nowMs` 低 24 位),一次传输一个窗口
- `<id>`:4 位十六进制 `request_id`(与帧 B1..B2 同值)
- `payload` = 请求文本的 UTF-8 字节;`len` = 字节数;`crc` = CRC16(payload) 大端 hex
- 长度预算:完整 console.log 行 ≤ 1000 字符 ⇒ **payload ≤ 680 字节**(按字节计,不按字符计)。
  超限时游戏侧应**立刻** reject(`too_long`),不要发出去。
- 桥端校验(§8 第 3 项)全过才受理;**同 `w` 重复 REQ = 幂等覆盖**(游戏超时重发是正常路径)。

### 4.1 上层信封(payload 首行)

传输层把 payload 当**不透明字节**;上层约定 payload 开头一行信封头 + `\n`:

```text
t=<target>[;tm=<ms>] \n <原文>    出站翻译(目标语言必须随请求走,否则桥按默认译反方向)
op=test[;tm=<ms>]    \n <JSON>    测试;载荷 {};响应 JSON(translation / error)
op=config            \n <JSON>    配置:读 = {};写 = {"config":{...}};响应 JSON
<裸文本>                          无换行 / 首行不匹配信封头 → 整条按原文翻译(默认目标语言)
```

- **白名单**(桥端实现在 `core/btipc/transport.js`):
  `op=config|test`、`t=[A-Za-z0-9-]{1,16}`、`tm=\d{1,7}`
- 未知 `op` / 未知键 / 不安全字符集 → 整条按裸文本处理(向后兼容老客户端与冒烟命令)
- 游戏侧在**目标语言不在 `[A-Za-z0-9-]{1,16}`** 时不要发信封,直接按裸文本发,免得桥端
  信封解析失败而译成错误方向

---

## 5. 下行轮次生命周期(游戏侧驱动)

```text
SHOT(r):  128 个面板 SetImage("/btipc/dl?w=<win>&r=<r>&p=<i>&t=<win>-<id>-<r>")
          t 必须随轮号变化 —— 同一 URL 撞引擎缓存会不再触发 ImageLoaded(实测)
收集:     ImageLoaded → 按 (r, 面板 id) 去重 → bit[p] = 1
闭合:     T_CLOSE 到点 → 读出 128 bit → 组 16 字节 → 校验 CRC
判定:     CRC ok & VALID=1 → 交付/按 seq 拼装;END=1 → 消息完成,停轮
          CRC ok & VALID=0 → BUSY:退避后 r++
          CRC fail         → 同 r 重投(≤ RETRY_MAX);连续 2 轮 fail → 风暴模式
          T_HARD 到点仍没收齐 → 强制闭合走 CRC 判定(通常 fail → 同 r 重试)
```

### 5.1 round 规则(写死,最易出 bug 处)

**游戏端**只维护一个整数 `r`(当前轮号),每轮闭合后:

| 判定 | `r` 的动作 |
| --- | --- |
| CRC ok, VALID=1, END=0 | `r++`(推进 = 隐式 ACK,取下一帧) |
| CRC ok, VALID=1, END=1 | 消息完成 → resolve,**停轮**(`r` 冻结) |
| CRC ok, VALID=0(BUSY) | 退避 `BUSY_BACKOFF_MS` 后 `r++` |
| CRC fail | **`r` 不动,同轮重投**(≤ RETRY_MAX;连续 2 轮 fail → 风暴) |
| T_HARD 到点仍没收齐 | 强制闭合 → 按上表判定(通常 fail → 同 r 重试) |

**桥端**不维护 `nextFrameIdx` 之类自增计数器(会与游戏脱步),帧号只由轮号现算:

```text
frameIndex      = round - frameStartRound
frameStartRound = 该窗口 frames[0] 首次被服务的轮号(锚定后不变)
⇒ 重投同一 round 天然得到同一帧,零额外状态
```

### 5.2 风暴模式(escalation)

- 触发:**连续 2 轮 CRC fail**(或单轮 dt 最大值 > 2× `T_CLOSE`)
- 动作:接下来 4 轮把 `T_CLOSE` 放宽到 `STORM_TCLOSE`,并插入轮间冷却
- 退出:任一轮 CRC ok 即恢复常规参数
- 依据:进图加载期实测 word 15~28s、零丢失 —— 风暴只慢不丢,宽闭合即可吸收

---

## 6. 桥端状态机(已实现,见 `core/btipc/window.js`)

```text
winMap[<win>] = { id, payload, tReq, frames|null, frameStartRound|null, tEndServed, tLast }

GET /btipc/dl?w&r&p&t:
  0. p 非法 / 缺失            → 404
  1. win 不存在 / w 格式非法   → 404(游戏侧视为 BUSY 等价,继续轮询)
  2. frames 未就绪             → 按 BUSY 固定帧的第 p 位回答(与 r 无关)
  3. frameStartRound === null  → frameStartRound = r;serve frames[0]
  4. r >= frameStartRound      → idx = r - frameStartRound
       idx < frames.length     → serve frames[idx]
       idx >= frames.length    → serve 末帧(END)again(游戏正常已停轮,兜底)
  最后:对该帧取第 p 位 —— 位=1 → 200 + PNG;位=0 → 404
REQ 行到达:同 w → 重置窗口(幂等覆盖);新 w → 建窗
翻译完成:  framer.encode(id, text) → frames[]
翻译失败:  回原文(游戏侧表现为"未翻译",不会卡死)—— 桥端现状
GC:        末帧被服务后 END_GC_MS,或窗口 WINDOW_TTL_MS 无活动 → 删除
```

> ⚠️ **状态码是逐面板的**:同一轮的 128 个面板**必须**拿到各自不同的状态码 —— 面板 p 拿
> 选中帧的第 p 位,位=1 才回 `200`。若整轮都回 `200`(例如"帧已就绪就回 200"的简化实现),
> 游戏侧会把 16 字节全读成 1、CRC 必然不过 → 看起来像"信道不通"。
> 回归护栏:`tests/btipc/live_http.test.js` 在**真实监听端口的桥进程**上断言一轮内 200 与 404
> 并存并逐位拼出正确文本(`transport.test.js` / `e2e_tail.test.js` 也有同样断言)。

- **`END_GC_MS` 必须 > 客户端最长重试跨度**(`T_HARD` + 9×(`STORM_TCLOSE` + 冷却) ≈ 40s,
  现取 **45s**)。否则窗口会在客户端仍在重试时自删 → 128 面板全 404 → 全零位 → CRC 必败
  → 误报 `crc_dead`。已有测试护栏。
- `framer`:文本 UTF-8 → 每 10B 一帧 → 末帧 `len=余数` + `END=1`;空译文 = 单帧 `len=0` + `END`。

---

## 7. 游戏侧 API(待实现,`State.btipc` 命名空间)

```js
BTIPC.request({ windowId, text, timeoutMs })
  .then(resultText => { /* 成功:译文文本 string */ })
  .catch(err       => { /* err = { kind, message } */ });
BTIPC.cancel();        // 放弃在途窗口 → reject({ kind:'cancelled' })
BTIPC.busy();          // → bool,有在途传输?
```

- `windowId`:6 位 hex(调用方生成 = `nowMs` 低 24 位);上层串行,同一时间仅一个在途
- `text`:待译原文(UTF-8 字节即 REQ payload);`timeoutMs` 缺省 `REQ_TIMEOUT`
- `err.kind`:`timeout` / `crc_dead` / `bridge_down` / `cancelled` / `too_long` / `busy` / `bad_args`
- **分层铁律**:业务代码 → `BTIPC` API → panel transport。业务代码禁止直接拼 `/btipc` URL。
- 游戏侧状态机:

```text
IDLE → REQ_SENT(发 REQ 行 + 启动轮询 r=1)
     → POLLING(T_CLOSE 闭合循环;BUSY → 退避;DATA → 拼装)
     → DONE(resolve)/ FAIL(reject)
```

- 轮询面板:`BTIPCD0..127`
- **首拍延迟 `INITIAL_SHOT_DELAY`**:桥 tail 轮询间隔 1s,REQ 行可能晚于首拍到达 →
  首轮全 404 → 误触风暴。故延迟 1.2s 再 SHOT(实车校准值)。
- 每帧服务日志(低频,供验收对账):
  `BTIPC: r=<r> seq=<s> len=<l> dt=<ms> <OK|RETRY|BUSY|END>` → 走 `console.log` tail

---

## 8. 校验与安全(`core/btipc/transport.js`)

### 8.1 REQ 行校验(全部通过才受理,任一不过**静默 drop** + 一行 WARN)

| 检查 | 规则 |
| --- | --- |
| 行长 | ≤ 1000 字符 |
| 行尾锚定 | 从 `[LCT] BTIPC` 起整体匹配到行尾(允许尾随 `\r`)→ 防拼接注入 |
| `w` | `/^[0-9a-f]{6}$/` |
| `id` | `/^[0-9a-f]{4}$/` |
| `len` | 十进制 0..680,且 **== base64 解码后的字节数** |
| `crc` | 4 位 hex == `CRC16(payload)`(桥侧重算比对) |
| `b64` | 严格 base64(字符集 + 长度 mod 4 + 解码不抛) |

**静默 drop = 不回、不建窗、不把错误回显到任何游戏可见通道。**

### 8.2 窗口隔离

- 所有传输状态只经 `Map<window_id, Transfer>`;窗口 A 的 req/frames/frameStartRound/tLast
  不得被 B 覆盖;同 `id` 不同 `w` = 两个独立传输
- `/btipc/dl?w=...` 只命中自己的窗口;未知 `w` → 404(不枚举、不提示存在性)

### 8.3 桥的边界

仅监听 `127.0.0.1`;请求体 ≤ 64KB;单文本 ≤ 4000 字符;无任意 URL 代理;日志不含 apiKey。

---

## 9. 参数表(冻结值)

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `WINDOW_PANELS` | 128 | 实测 256 仅 +2.4% 吞吐、延迟 ×2.2 |
| `FRAME_BYTES` | 16 | 128 bit = 一帧 |
| `PAYLOAD_PER_FRAME` | 10 | 6 B 帧头(seq1 + id2 + len1 + crc2) |
| `BIT1` / `BIT0` | 200 PNG / 404 | 200 必 fire;404 全静默 |
| `T_CLOSE_MS` | 600 | 单 bit 延迟 P50 31 / P95 161 / Max 522 |
| `STORM_TCLOSE_MS` | 2500 | 风暴期宽闭合 |
| `STORM_TRIGGER` | 2 | 连续 CRC fail 轮数 |
| `STORM_ROUNDS` | 4 | 风暴持续轮数 |
| `T_HARD_MS` | 12000 | 单轮硬超时 |
| `RETRY_MAX` | 3 | 同一帧重投上限 |
| `CRC_DEAD` | 8 | 同帧累计 fail 超过即放弃 |
| `BUSY_BACKOFF_MS` | 500 | BUSY 轮询节奏 |
| `REQ_MAX_PAYLOAD` | 680 B | 受整行 ≤1000 字符约束;680B = 68 帧 ≤ 128 |
| `REQ_TIMEOUT_MS` | 30000 | 从 REQ 发出起算 |
| `WINDOW_TTL_MS` | 60000 | 桥端无活动 GC |
| `END_GC_MS` | 45000 | 末帧服务后保留(**必须 > 客户端最长重试跨度**) |
| `INITIAL_SHOT_DELAY` | 1200 ms | 等桥 tail 读到 REQ 行 |
| `CRC16` | CCITT-FALSE | poly 0x1021 / init 0xFFFF |

---

## 10. 吞吐与延迟预算(诚实数字)

```text
原始位吞吐     ≈ 128 bit / (T_CLOSE 600ms + SHOT 开销 ~50ms) ≈ 197 bit/s
有效载荷吞吐   = 每帧 10 字节 / ~0.65s ≈ 123 bit/s
典型译文回程   30B = 3 帧 ≈ 2.0s;60B = 6 帧 ≈ 3.9s;120B = 12 帧 ≈ 7.8s
端到端         + 翻译服务耗时(0.5~2s)→ 发送前翻译总延迟 ≈ 2.5~6s(60B 级)
```

> 想要 ≤2s 的 60B 回程需要 v1.1(精确闭合 + CONT 紧缩帧),v1.0 先不做;
> 机制位已在 `B3` 的 VALID 语义上预留,升级不动参数表与 API。

---

## 11. 错误处理与边界

| 场景 | 行为 |
| --- | --- |
| 桥进程挂 | `/btipc/dl` 连接拒绝 → 面板不 fire → `T_HARD` 强制闭合 → CRC fail ×N → `REQ_TIMEOUT` 兜底 |
| 桥重启(窗口丢失) | 404/BUSY 循环 → `REQ_TIMEOUT` → reject(`timeout`);重试策略由上层定 |
| 200 丢失(引擎丢载) | fires 不足 → 闭合后 CRC fail → 同 `r` 重投;桥幂等重发同帧 |
| 风暴(进图/卡顿) | 升级宽闭合;实测只慢不丢 |
| CRC 连续死 | 8 次 → `crc_dead` → 上层降级(按原文发送) |
| 文本 > 680B | request 立即 reject(`too_long`)→ 上层按原文发送 |
| 已有在途 / `windowId` 非法 | reject(`busy` / `bad_args`),上层排队或修正参数 |
| 游戏重开 | 一切内存态归零,窗口号换新,无跨会话状态 |

---

## 12. 验收标准

1. **CRC 测试向量** — ✅ 已固化(`tests/btipc/crc.test.js`)
2. **framer 往返 + §3.3 位序例 + §3.2 BUSY 固定帧** — ✅ 已固化(`tests/btipc/frame.test.js`)
3. **桥端传输层**(校验 / 轮次 / GC 不变量) — ✅ 已固化(`tests/btipc/transport.test.js`)
4. **接线**(tail → onLine → 建窗 → 取帧;**/btipc/dl 路由状态码与响应头) — ✅ 已固化
   (`tests/btipc/e2e_tail.test.js`、`tests/btipc/route.test.js`)
4b. **真实 HTTP 端到端**(真实监听端口的桥进程 + 真实 tail + 逐面板状态码 → 逐位拼装) — ✅ 已固化
   (`tests/btipc/live_http.test.js`;它抓到过"桥端忽略 `p`、整轮回 200"的实现缺陷)
5. **游戏侧客户端** — ✅ 已实现并离线验收(`lingua_chat.js` 的 `BTIPC` 区块;
   模拟器用真实桥端 framer 编码、游戏侧内联副本解码,往返零错)
6. **实车回声 conformance**:游戏内命令发一次传输 → 桥侧回声,解出与发送一致;
   ≥20 连发零 fail —— ⬜ 待实现(上游口径)
7. **实车端到端**:真实对局开「发送前翻译」/ 入站译文,聊天行显示译文,
   日志含逐帧 `BTIPC: r=.. seq=.. OK` 全序列 —— ⬜ 待实现

> 上游(BabelTower 1.0.7)已用同一套协议完成第 6、7 项实车验收,
> 可直接作为本仓库游戏侧实现的对标基线。

## 13. 与上游 v1.0 的两处有意偏离

1. **每次 SHOT 的 URL 都带自增 `shotSeq`**(`t=<win>-<id>-<round>-<shotSeq>`)。
   上游 v1.0 的 `t` 只到轮号,同 `r` 重投时 128 个 URL 逐字节相同 —— 撞引擎缓存后
   不再 fire `ImageLoaded`,他们会踩到 `frameFails 1→9` 的死循环。本仓库把「同轮重投
   也要换 URL」做进第一版,已用测试钉住(`lingua_chat_simtest.js` `[19]`)。
2. **「连续全 0 轮」判 `bridge_down`**。合法 BUSY 帧带 `request_id` 与 CRC 位,
   不可能全 0;所以全 0 ⇒ 桥端没有这个窗口(没收到 REQ,或桥不在)。连续 4 轮即放弃
   (4 轮余量覆盖"桥的 tail 还没读到 REQ 行"的窗口期),约 3.6s 收口;
   上游靠 `CRC_DEAD`(8 轮 + 风暴 ≈ 13s)兜底,会把单槽队列堵死。
