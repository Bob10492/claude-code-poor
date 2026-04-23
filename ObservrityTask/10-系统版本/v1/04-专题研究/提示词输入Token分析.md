# 提示词输入 Token 分析

## 1. 结论先说

当前这部分埋点 **还没有算“完全做完”**，但已经从“只能看到整包 request”推进到了“可以拆出 prompt 主要组成部分”的阶段。

截至目前：

- 已完成：
  - 每轮 `prompt.build.started`
  - 每轮 `prompt.snapshot.stored`
  - 每轮 `prompt.build.completed`
  - 完整 request snapshot 落盘，可回放 `systemPrompt + messages + thinkingConfig + toolNames`
- 新增完成：
  - `prompt.build.completed` 中补充了 prompt 分段账单
  - 可直接看到：
    - `system_prompt_section_labels`
    - `system_prompt_chars_by_section`
    - `system_context_*`
    - `user_context_*`
    - `claude_md_chars`
    - `current_date_chars`
    - `base_messages_chars_total`
    - `prepended_context_message_chars`
    - `request_messages_chars_total`
- 尚未完成：
  - 工具 schema 的逐工具精确 token 账单并入 harness 日志
  - 真正按 provider 返回值拆出“system/tools/messages 各自实际 input token”的最终口径
  - 与 prompt cache 命中/失效原因做逐段关联

所以，对“系统提示词构建埋点有没有做完”的准确回答是：

**没有完全做完，但已经足够解释当前 input token 偏高的主要原因，并且比之前多了一层真正可用的分段观测。**

## 2. 当前一条 input token 实际包含什么

从源码看，一次主请求并不只是“system prompt + 用户本轮输入”，而是至少包含以下几层：

### 2.1 system prompt 主体

来源：

- [src/constants/prompts.ts](/abs/path/E:/claude-code/src/constants/prompts.ts:452)
- [src/utils/systemPrompt.ts](/abs/path/E:/claude-code/src/utils/systemPrompt.ts:29)

主要组成：

- 静态主提示词
  - intro
  - system
  - doing tasks
  - actions
  - using your tools
  - tone and style
  - output efficiency
- 动态 section
  - session guidance
  - memory prompt
  - environment
  - language
  - output style
  - MCP instructions
  - scratchpad
  - function result clearing
  - summarize tool results
  - token budget / brief / 其他 feature-gated section
- agent / customSystemPrompt / appendSystemPrompt 覆盖或追加

### 2.2 systemContext

来源：

- [src/context.ts](/abs/path/E:/claude-code/src/context.ts:116)
- [src/utils/api.ts](/abs/path/E:/claude-code/src/utils/api.ts:437)

这部分不是 prompt.ts 主体里写死的，而是在请求前被附加到 system prompt 末尾：

- `gitStatus`
- `cacheBreaker`（若开启）

也就是说，**system prompt 实际发送值 = prompt 主体 + systemContext**

### 2.3 userContext

来源：

- [src/context.ts](/abs/path/E:/claude-code/src/context.ts:155)
- [src/utils/api.ts](/abs/path/E:/claude-code/src/utils/api.ts:449)

当前会被 prepend 到消息列表最前面，包成一个 `<system-reminder>` user message：

- `claudeMd`
- `currentDate`

这非常关键：

**CLAUDE.md 不是并入 system prompt，而是作为一条额外 user meta message 插入到 messages 最前面。**

### 2.4 messages 历史

来源：

- [src/query.ts](/abs/path/E:/claude-code/src/query.ts:687)
- [src/query.ts](/abs/path/E:/claude-code/src/query.ts:954)

进入 API 前，messages 还会经历：

- compact boundary 截断
- tool result budget 替换
- history snip
- microcompact
- autocompact
- context collapse 投影（当前仓库里实际是 stub）

即便做了这些，保留下来的历史、工具调用、工具结果、附件引用，仍然会进入 request。

### 2.5 tools schema

来源：

- [src/utils/api.ts](/abs/path/E:/claude-code/src/utils/api.ts:119)
- [src/services/api/claude.ts](/abs/path/E:/claude-code/src/services/api/claude.ts:1250)
- [src/utils/toolSchemaCache.ts](/abs/path/E:/claude-code/src/utils/toolSchemaCache.ts:1)

这是 input token 偏高的另一大来源。

注意：

- 模型看到的不只是工具名
- 还包括每个 tool 的：
  - name
  - description
  - input schema
  - 某些 beta/cache 字段
- MCP tools 也会一起算进去

所以“工具很多”时，即使用户问题很短，input token 也会很高。

## 3. 为什么现在 input token 会这么高

不是单点问题，而是多层叠加：

### 3.1 主 system prompt 本身就很长

`prompts.ts` 的静态主提示词已经很重，尤其包含：

- 行为规范
- 安全规范
- 工具使用规范
- 输出风格规范
- 交互规范

这些段落本身就是长期常驻成本。

### 3.2 CLAUDE.md 会被额外再塞进 messages

当前逻辑不是“让模型去引用一份外部规则文件”，而是把内容直接注入到 request。

而且它走的是：

- `userContext.claudeMd`
- `prependUserContext(...)`
- 生成 `<system-reminder>` user message

这意味着只要 `CLAUDE.md` 大，**每轮首部都会额外多一大段 message 内容**。

### 3.3 历史消息远比表面看到的多

用户肉眼看到的是“对话”，模型收到的是：

- 经过若干压缩后仍保留的 assistant/user 历史
- tool_use blocks
- tool_result blocks
- attachment messages
- 可能的 memory / invoked_skills / nested_memory 等附件

所以“我只问了一句话，为什么 input token 这么高”通常是错觉。

真实情况是：

**本轮用户输入只占很小一部分，历史与系统层常常才是大头。**

### 3.4 tool schemas 非常贵

从 [src/utils/analyzeContext.ts](/abs/path/E:/claude-code/src/utils/analyzeContext.ts:363) 可以看出，仓库作者本身就把 tools 单独当成一大类 context 成本去算。

这说明工具 schema 在设计上就被视为主要 token 消耗项，而不是边角料。

### 3.5 “重叠内容”不会自动去重

这点是最容易误解的。

即使 cc 源码提示词 PDF 中有很多内容和当前系统提示词“语义上重叠”，只要最终发送到 API 的字节串里：

- 出现在不同 section
- 出现在不同 role（system vs user）
- 换了措辞
- 换了顺序
- 包在不同 wrapper 里

它们都仍然会计入 input token。

模型不会因为“这两段意思差不多”就免费去重。

## 4. 为什么不能直接“复用 cc 源码提示词里的重叠部分”

这里要把“逻辑复用”和“token 计费复用”分开。

### 4.1 逻辑上可以参考，但 token 上不会自动复用

如果你的意思是：

- “能不能发现 cc PDF 里已有同类规则，就不要重复发了”

那答案是：

**只有在本地组装 request 时主动删掉一份，才会减少 token。**

否则只要两份内容都进入 request，哪怕高度重叠，token 还是照算。

### 4.2 当前实现里 system prompt 和 userContext 走的是两条不同通道

源码上已经分开：

- system prompt 主体：`getSystemPrompt(...)`
- systemContext：`appendSystemContext(...)`
- userContext：`prependUserContext(...)`

对应代码：

- [src/utils/queryContext.ts](/abs/path/E:/claude-code/src/utils/queryContext.ts:44)
- [src/query.ts](/abs/path/E:/claude-code/src/query.ts:831)
- [src/query.ts](/abs/path/E:/claude-code/src/query.ts:1084)

这意味着即使内容重叠，只要一个在 system，一个在 prepended user meta message，当前实现也不会自动做 cross-channel dedupe。

### 4.3 prompt cache 也不是“语义缓存”

从：

- [src/constants/prompts.ts](/abs/path/E:/claude-code/src/constants/prompts.ts:109)
- [src/utils/toolSchemaCache.ts](/abs/path/E:/claude-code/src/utils/toolSchemaCache.ts:1)

可以看出，这套优化更多是：

- 稳定 prefix 字节
- 减少 cache bust
- 让相同前缀可复用

它依赖的是 **稳定字节序列**，不是“意思差不多”。

因此：

- 如果两段内容只是语义重叠，但文本不同，不会合并
- 如果本来相同，但位置/顺序/包裹结构变了，也可能失去 cache 价值

## 5. “cc 源码提示词 PDF” 和当前实现的关系

我已经确认该 PDF 在当前环境下没有现成文本提取器，低层扫描也没有稳定抽出正文，所以这里不能负责任地给出“逐段一一对应”的精确对照表。

但按当前源码可以确定：

- 当前请求确实不是“只发一份系统提示词”
- 而是“系统提示词主体 + systemContext + prepended userContext + 历史消息 + tools schema + 附件/工具结果”

所以即使 PDF 与 `prompts.ts` 大量重叠，也仍然无法直接推出“那应该天然省 token”。

因为真正计费对象是 **最终序列化 request**，不是“源码里有哪些文字看起来像重复”。

## 6. 应该怎么优化

### 6.1 第一优先级：先看账单，不要凭感觉删

现在建议先观察新的 harness 字段：

- `system_prompt_chars_by_section`
- `system_context_value_chars_by_key`
- `user_context_value_chars_by_key`
- `claude_md_chars`
- `prepended_context_message_chars`
- `base_messages_chars_total`

这样可以先确认：

- 是 `CLAUDE.md` 太大
- 还是 system prompt 主体太长
- 还是 message history 太长
- 还是 tools 太多

### 6.2 第二优先级：避免同一规则在两条通道重复注入

最值得先查的是：

- `prompts.ts` 已经表达过的规则
- `CLAUDE.md` 又重复表达了一遍

典型重复包括：

- 输出风格
- 工具使用方式
- 代码修改原则
- 风险操作确认原则

如果一条规则已经是全局系统规则，就不要再让项目 `CLAUDE.md` 重复写成长段版本。

### 6.3 第三优先级：压缩 CLAUDE.md

当前 `CLAUDE.md` 直接进入 userContext，是非常昂贵的。

适合优化为：

- 保留真正项目特有的内容
- 删除已经被全局 system prompt 覆盖的通用行为规范
- 删除冗长解释，改成短规则
- 把 rarely-needed 的长篇说明拆出，只在必要时作为附件或技能加载

### 6.4 第四优先级：缩小常驻 tools 集

若工具很多，tools schema 会很重。

可考虑：

- 更积极地 defer 不常用工具
- 减少默认常驻 MCP tools
- 缩短工具 description
- 收紧 schema 中冗长字段说明

### 6.5 第五优先级：把“长期不变的大块”稳定下来

想吃到 prompt cache 红利，需要让 prefix 尽量稳定：

- 不要每轮改变 section 顺序
- 不要让动态字段混进静态大段
- 不要让会频繁变化的说明插在高价值 prefix 前面

这个方向当前仓库其实已经在做，只是还可以更激进。

## 7. 我建议的具体动作

### 立刻可做

1. 先用新增的 prompt 分段埋点跑几轮真实请求
2. 看 `.observability/events-*.jsonl` 里 `prompt.build.completed`
3. 确认前 3 大成本来源
4. 优先删掉 `CLAUDE.md` 中与全局 prompt 明显重复的规则

### 下一步值得实现

1. 在 harness 中新增 `tool_schema.*` 专项事件
2. 把 `analyzeContext.ts` 的分类能力接到 harness 日志里
3. 在 `prompt.snapshot.stored` 旁边追加 `prompt.composition.snapshot`
4. 加一个“重复规则检测”脚本，对 `prompts.ts` 和 `CLAUDE.md` 做近似重复扫描

## 8. 最短答案

如果只要一句话：

**当前 input token 高，不是因为“用户这句话太长”，而是因为请求里长期常驻了很重的 system prompt、CLAUDE.md 注入、历史消息和工具 schema；语义上重叠的内容不会自动去重，只有在本地组装 request 时主动删除其中一份，token 才会真的下降。**
