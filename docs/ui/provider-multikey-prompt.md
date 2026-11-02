# 提示词:多 Key 服务商管理设计(Provider Multi-Key)

> 本文档是给「做原型的人」的执行指令。按它执行一遍,产出一个可交互的 HTML 原型给用户过目。

## 1. 背景(现状)

- 项目:DeadlockLingua(聊天翻译 mod),配置在 `config/config.json`,桥端 `core/config.js`。
- 现状是**每个服务商类别只有一套凭证**:`openai.apiKey / openai.baseUrl / openai.model` 各一个字段。
- 用户当前 openai 类填的是 DeepSeek;想再加一个(另一个 DeepSeek Key、Ollama、OpenAI 官方等)时,**旧值被顶掉,只能保留一个**。
- 已有 `fallbackProviders`(回退服务商数组),但回退粒度是「服务商类别」,不是「Key」。

## 2. 需求(用户原话要点)

- "对于我 mod 里面的翻译服务供应商,我想做一些改变,现在对于某一类只能加一个,类似 openai 支持的我现在是 deepseek,我想加个别的就会把这个顶掉。"
- "参考现在的一些 agent 或者有添加 key 的那种功能的设计"(即 ChatGPT/Claude 客户端式:一组 Key 列表,可增删、切换、设默认)。
- 先出**原型**(HTML),用户看过再谈落地。

## 3. 设计目标(提示词核心)

1. **凭证变成条目列表**:每个服务商类别(重点 `openai` 兼容类,可推广到 microsoft/deepl/google)持有 `[]` 个「Key 条目」。
   每条 = `{ name, baseUrl, model, apiKey }`(bing 免 Key,天然一条)。
2. **条目操作齐全**:添加 / 删除 / 改昵称 / 调顺序(顺序 = 回退优先级)/ 激活为当前使用。
3. **一键切换**当前条目:替代现在"填新 Key 就顶掉旧 Key"的体验。
4. **状态可见**:每个条目有「已配置 / 测试通过 / 测试失败」状态点(可点「测试」按钮探活,参考现有 Web 设置页的绿点逻辑)。
5. **回退语义升级**:类别内按条目顺序自动回退(DeepSeek-A 挂了 → DeepSeek-B → Ollama → 下一类别),`fallbackProviders` 继续管「跨类别」顺序。
6. **向后兼容**:老配置 `{openai:{apiKey,baseUrl,model}}` 读进来时包装成单元素列表 `[{name:"默认", ...}]`,不丢数据。

## 4. 视觉与交互约束

- 风格必须沿用现有游戏 UI 设计令牌(深底 `#0e1318` 系 + 金色 `#e7b96b` + 铜绿点缀,Art Deco 标题 Poiret One,正文 ≥10.5px,控件 30-34px 高、圆角 4-6px,1px 描边,间距 8px 节奏)——参考 `docs/ui/settings-prototypes.html`。
- 出**两个视图**:
  - ① **Web 设置页版**:完整字段(每条目四行:昵称 / Base URL / 模型 / Key(secret,可显示/隐藏)),右侧「↑↓ 调序、ⓧ 删除、● 激活、测试」。
  - ② **游戏内 /tr 紧凑版**:条目卡片列表(每条一行:状态点 + 昵称 + 端点缩写),点卡片即激活,底部「+ 添加 Key」按钮;新条目就地展开成四输入行。
- 原型必须**可交互**(纯前端假数据即可,不发请求):增删、调序、激活、测试状态切换都要能点。
- 单文件 `provider-multikey-prototype.html`,顶部 tab 切换两个视图。

## 5. 产出与验收

- 文件:`docs/ui/provider-multikey-prototype.html`
- 验收:浏览器打开,两个 tab 都能点;添加 Key 不顶掉旧 Key;删光列表要有空态提示;激活项有金色描边高亮。
