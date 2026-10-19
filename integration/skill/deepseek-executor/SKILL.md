---
name: deepseek-executor
description: 调度已打开的 DeepSeek Harness 桌面版通过本地 MCP 执行通用调研、非 Unity 编码、文档和数据任务，由 Codex 设计与验收；Unity 项目与资产任务使用 codely-executor。
---

# Codex 指挥，Desktop 执行通用任务

## 先按任务选择执行器

- **Codex**：设计、决策、阶段调度和验收判断；实施、测试、取证交 Desktop。
- **DeepSeek Harness 桌面版（本技能）**：通用调研、非 Unity 项目编码、文档、数据处理和独立通用任务。
- **Codely**：Unity 项目内的代码、玩法/UI、场景、调试、运行验证、测试、打包，以及图片/精灵/动画/音效等资产；使用 [codely-executor](../codely-executor/SKILL.md)。

Unity 或资产任务一开始就用 Codely，不等 Harness 失败。Unity 项目中的纯 C# 核心逻辑也默认交 Codely，不因不引用 UnityEngine 就把开发流程交给 Harness。混合任务可把独立的通用调研/文档交 Harness、Unity 实现与资产交 Codely，并划定文件范围。用户明确指定执行器时优先遵从。Codely 不可用先排查并说明，不声称 Harness 完成过 Unity 编辑器或资产生成。

## 前提与固定路由

- 当前任务派发到**已经打开的 Desktop**：必须已打开且启用 `deepseek-desktop-mcp` 桥插件；不启动 headless、不新建 Host、不安装/重载插件。
- 固定路由 `deepseek-official` / `deepseek-flash` / `reasoningEffort: max`；不切模型、不改全局权限、不复制凭据。路由不符时报告阻碍，不自动回退账户或模型。
- 制作和独立 QA 均由桥显式 `agentPreset: standard` 创建；不依赖新任务默认 agent，不改全局默认。续接/恢复核对实际 preset，非 standard 或未知即拒绝，不静默切换旧会话。标准模式不加载 Dudu 提示词，所需任务约束须写入任务书。
- 派发前先只读自检（不提交任务）：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "<skill>\scripts\invoke-desktop.ps1" -Check
  ```
  期望输出含 `bridge.protocol = deepseek-desktop-mcp/bridge/2`、`workspacePath` 与 `standardMode: true` 能力。`stale_bridge` 表示已加载的桥缺少所需能力，必须重载桥后再派发；**绝不**退回默认 cwd 继续。`DISPATCH_ERROR desktop_unreachable` 表示 Desktop 未打开或桥未启用。

### 项目身份与工作区路由

- **项目身份只来自可信的项目上下文**：只有 Codex 已配置项目的真实项目根目录（由任务书明确给出）才能作为 `-Workspace`。Codex 为无项目会话生成的 cwd（如 `.../Codex/<日期>/<任务>`）、任务书目录、日志目录和产物目录都只是执行位置，**不是**项目身份；启动器也绝不把自身 process cwd 当项目。
- **无项目的新任务省略 `-Workspace`**：启动器用已连接桥的只读 `diagnostics.workspace` 解析 **Harness/Desktop 已配置的默认工作区**（不是 Codex 项目配置），`submit_task` 不传 `workspacePath`，`ADMITTED`/`RESULT` 返回 `workspaceSource:"default"`。这条路径不登记任何目录（连默认目录也不登记），也不创建新工作区。
- **显式 `-Workspace <真实项目目录>`** 仍是项目映射的显式开关：先登记该精确目录的本地允许列表，再由桥在提交时解析/复用对应 workspace，返回 `workspaceSource:"explicit"`。根目录、父目录、通配符、无关目录、生成 cwd 都不得作为项目目录。
- 默认工作区**不是**项目失败后的兜底：显式项目路径无效、路由不符或未授权仍明确失败，不静默转到默认工作区或推断目录。
- 无项目任务在默认工作区执行。任务书中凡是要写回 Codex 目录的**工作文件、临时产物、结果和日志一律给绝对路径**；相对路径会落到默认工作区，不能用它表达 Codex 侧位置。

## 调度

沿既定阶段及验收单元派发；续接、补充、返修不另拆阶段。执行器在边界内自主完成，仅阻塞、异常或需决策时提前回报。

1. Codex 写任务书 `work/harness/<task>/task.md`：目标、上下文、工作目录、允许操作、约束、产物路径、验收标准、需要回交 Codex 决策的问题；适用仓库 AGENTS.md、技能要求应传入或要求执行者先读取。任务书先关联项目**正式任务记录**与版本化输入：任务 ID/父目标与必须保留行为、输入版本（commit/文档/规范/原型）、允许修改范围、验收单元、实际消费位置与检查命令覆盖。关键任务定义、采用决定与批准依据不能只留在 `work/` 忽略区：任务书记录正式任务记录路径，`work/` 只存任务书副本、运行日志、state 与回执。
2. 运行启动器（首次新会话）：
   ```powershell
   # 无项目会话的新任务：省略 -Workspace，进入已配置的默认工作区
   powershell -NoProfile -ExecutionPolicy Bypass -File "<skill>\scripts\invoke-desktop.ps1" `
     -TaskFile <task.md> -LogFile work/harness/<task>/run-<时间戳>.log

   # Codex 已配置项目：显式传真实项目根目录
   powershell -NoProfile -ExecutionPolicy Bypass -File "<skill>\scripts\invoke-desktop.ps1" `
     -TaskFile <task.md> -Workspace <真实项目目录> -LogFile work/harness/<task>/run-<时间戳>.log
   ```
   - `-Workspace` 可选。省略时使用默认工作区；显式项目目录必须已存在，启动器先将其登记到本地精确目录允许列表，再由 Desktop 桥在提交时解析/复用 workspace。拒绝根目录、父目录、通配符或无关路径，也不接受生成的 cwd、任务书目录、日志目录。
   - 启动器立即输出 `ADMITTED {sessionId, requestId, workspaceId, workspacePath, workspaceSource, stateFile}`，随后有限等待并输出 `RESULT {...}`；日志为 UTF-8 JSONL，只含有限长度的可见输出。`workspaceSource` 为 `default`（默认工作区）、`explicit`（显式项目）或 `session`（续接派生）。
   - 退出码：`0` 完成成功；`2` 任务失败或本轮 turn 以 max-tokens 等非成功状态结束；`3` 阻塞/等待用户输入（保留 inbox/提问等待可用 `-ResumeState` 继续轮询；真正的 Host turn-end blocked 会立即复报）；`4` 已取消；`5` 仍在运行或等待超时（可恢复）；`6` 派发/预检/状态/网络错误；`130` 被中断（Desktop 任务仍在运行）。`ADMITTED` 和退出码 5/130 都不是完成。
3. 续接同一任务：加 `-SessionId <已核实的 sessionId>`。`-Workspace` 可省略：启动器用只读 `get_task` 派生该 session 的实际工作区（`workspaceSource:"session"`），不搬迁会话、不登记目录；显式传 `-Workspace` 时其必须与会话现有工作区一致，不一致会在 `continue_task` 之前明确拒绝（`workspace_path_mismatch`）。新请求会记录提交前 `latestSeq` 基线和本轮 requestId；只有同时出现“携带该 requestId 的真实 user_message”且完成证据（`status.completion.seq`）晚于该输入，才可能算本轮完成，旧一轮的 finished 不会被当作本轮完成。
4. 网络不确定、中断或等待超时/队列 pending 后重试：**保留原 requestId**。使用上次输出的 `-ResumeState <stateFile>` 和**新的** `-LogFile`，`-TaskFile` 仍需是同一任务书。resume 锁定原 requestId、目标 session 与已存储工作区：默认省略 `-Workspace`，显式传不同目录会被拒绝（`resume_workspace_mismatch`）；即使配置的默认工作区之后变化，也不会被重定向或重新派发；已完成的终态离线缓存直接返回，已有 state 的 request id/路径保持原义。启动器核对任务哈希、存储工作区和目标 session，绝不静默生成新 request id。退出码 `5`（超时/仍在运行）与 `3`（inbox/提问等待）都是**可恢复的轮询状态**：再次用 `-ResumeState` 继续等待同一 request/cursor，不重复派发新请求；续接类 resume 需同时重复 `-SessionId`。
5. 终态失败（如退出码 2、已消费输入后 `finished+success=false`）先诊断，再给明确修正任务；新尝试在正式任务记录关联原 requestId、原 state/回执路径与保留产物，保留旧失败记录与原 state，不手工覆盖或删除调度器状态文件。新尝试使用启动器生成的独立 state 路径（新的 `-LogFile`），不重用或改写原 state；未知/超时仍按上一条用 `-ResumeState` 续接原 request，不因终态失败连带盲重发。
6. 取消：`-Cancel -StateFile <stateFile>`。取消是立即动作，不等待 dispatcher 的 lifetime lock；Host 回执写入独立原子文件 `<stateFile>.cancel.json`（`RESULT.cancelReceiptPath`），不覆盖执行状态。Ctrl-C / 超时不会自动杀死 Desktop 任务，也不会删除状态。不要删除 state 文件来“清理”。
7. 同一 `stateFile` 同时只允许一个 dispatch。沿用启动器有界等待和 cursor 增量返回，等待中不另用 `get_task`、日志或文件探测反复盯进度；超时按第4条恢复，不重复派发。只在启动核验、阻塞/异常、决策或完成时分析回执。

## 验收

- 任务书预定本次改动的必要测试、预期、关键边界和取证方式。自查保可验收；新独立会话核查实际产物、关键行为及证据缺口，中间只测修改及必要直接关联，返修定点复验，最终检查整合与完整路径；复用有效证据，不机械重测，原定审查、提交节点不变。
- 集中交摘要、变更清单、测试结论、证据索引及未解决项；详报留文件。Codex 按疑点读段落或差异，不在审查途中追读零散材料或重跑整套测试；已审版本、结论、证据位置及疑点存既有交接记录，续接复用，不重复建账。
- 以 `RESULT` 中的 `outcome/exitCode`、`inputConsumed` 与 `consumedInputSeq`、`status.completion.seq`（必须晚于本轮基线和已消费输入）、`pendingAction/pendingInbox`、`workspaceSource/workspacePath`、实际产物、变更范围和测试结果为准；assistant 摘要、idle、`ADMITTED`、或“上一轮 turn 完成”都不等于本轮完成。**新建**任务的 `workspaceSource:"default"` 表示无项目任务，不能当成已进入某个 Codex 项目工作区；新建任务只有 `workspaceSource:"explicit"` 才映射项目工作区。续接的 `workspaceSource:"session"` 只是该会话原有工作区（可能本来就是项目工作区），不能据此当作新的项目映射，也不能把该会话改判为无项目。若 `inputConsumed=false` 或出现 `sawCompletionWithoutConsumedInput=true`，不得声称任务已执行。`status.state=finished` 且 `success=false`（如 max-tokens）是已消费输入后的**终态非成功**（退出码 2），不是仍在运行；`note` 与 `inputConsumed` 字段必须一致。
- 验收先对照上游（正式任务、批准范围与输入版本）再核对实际产物与完整差异；运行失败保留真实回执和可用产物，但独立核验前不计完成。交独立 QA 时，输入应含上游任务、任务书与真实产物；只复述 assistant 摘要或制作者自述不算验收。
- 失败先诊断，再给明确修正任务；连续两次同一原因失败时改变方法或向用户说明阻碍。
- 保存 `work/harness/<task>/state.json`：目标、工作目录、**实际** sessionId、报告/产物路径、状态、验证结果、下一步；它只是执行事实与指针（正式任务记录、requestId、产物、回执），不是任务业务当前状态，任务当前状态与下一步回写项目正式任务记录。跨项目以任务书传递上下文，不假定自动共享记忆。

## 故障与恢复

- `stale_bridge` 含标准模式能力缺失：加载当前桥后再派发；`agent_preset_mismatch`：非标准或无法核实的会话，不继续、不自动换 preset。
- Desktop 关闭、桥不可达、`stale_bridge`、模型路由不符：按错误码如实报告，等待用户/协调者处理；不更换传输、不更换模型、不改全局权限。
- 路由错误一律明确失败，不换目录兜底：`default_workspace_unavailable` / `default_workspace_invalid`（诊断缺失或默认工作区不可用，不猜 cwd）、`default_workspace_changed`（待派发请求的默认工作区已变化，resume 不重定向）、`workspace_path_not_found` / `workspace_path_invalid`（显式项目目录无效）、`workspace_path_mismatch`（续接项目与会话实际工作区不符，已在 `continue_task` 前拒绝）、`resume_workspace_mismatch`（resume 与已存储目标不符）、`workspace_not_enrolled`、`session_cwd_mismatch`、`session_workspace_unavailable` / `session_workspace_invalid`（无法确认现有会话工作区）。
- 旧 headless 执行器只作为**用户明确要求**时的恢复路径，脚本为 `scripts/invoke-harness-recovery.ps1`，必须同时给出 `-IUnderstandRecovery`。它不自动兜底，也不得在未说明时调用。
- 日志可能包含完整推理或敏感内容：不整段转发，不打印/复制 token 或凭据。
