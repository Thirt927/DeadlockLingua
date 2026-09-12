# 日志分析快照(2026-08-25 22:17)

用于分析最近一次对局的桥日志与聊天日志。以下内容来自本地运行目录,已做 apiKey 等敏感信息扫描(无匹配)。

> 以下两个日志快照已从 Git 版本控制移除,仅保留在本地分析目录;仓库中不再包含真实玩家昵称/聊天内容。

## 文件说明
- bridge_tail_3000.log:本地 logs/bridge.log 的最后 3000 行(截取自 2026-08-25 22:17 前)。
  包含桥端与游戏内 mod 的交互记录,如 topbar identity scan / steamid roster / rowdiag / translate ok 等。
- chat_<matchId>.jsonl:logs/chat/<matchId>.jsonl 原样复制(2026-08-25 22:17 结束的对局)。
  格式:type=meta/player/msg 的 JSONL,msg 含 t/kind/sender/hero/channel/isOwn/text。

## 注意
- 日志中可能包含游戏内玩家昵称、SteamID、聊天原文与译文,仅用于本项目分析,勿外传。
- bridge_tail_3000.log 尾部可见:topbar scan: 0 entries(match ongoing)与 rowdiag 中部分行 hero/steamid 为空,
  是当前要排查的顶栏身份扫描问题。
