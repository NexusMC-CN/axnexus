# axnexus Selection 协议实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付独立于 GraphQL 的版本化 JSON 字段选择协议、类型化客户端与框架无关服务端。

**架构：** 共享契约只定义资源、参数 schema 和公开字段形状；服务端实现另外提供授权、根加载与字段 resolver。客户端经现有 HttpClient 发 POST，校验 envelope 和选择结果；服务端先验证请求、预算、参数与权限，再按字段执行。

**技术栈：** TypeScript 5.9、Node Web Request/Response、Standard Schema、node:test、pnpm。

---

## 文件职责

- `src/selection/contract.ts`：字段描述符、资源契约、静态选择与投影类型。
- `src/selection/validation.ts`：请求树检查、预算计算及选择结果运行时校验。
- `src/selection/client.ts`：协议 POST、envelope 拆封、协议错误映射及传输策略。
- `src/selection/server.ts`：实现注册、授权顺序、按需执行、Web Request 处理器。
- `src/selection/errors.ts`、`src/selection/index.ts`、`src/selection/server/index.ts`：错误和公开入口。
- `tests/selection/*.test.ts`、`tests/types/selection.ts`：回环、边界与类型测试。
- `package.json`、`README.md`：子路径导出及最小用法。

## 任务 1：共享契约与字段选择类型

- [ ] 写运行时测试：危险字段名、空资源名、未知或空选择被拒；写类型测试：嵌套对象/数组/null 精确投影、未知字段编译失败、动态选择保守。
- [ ] 运行 `pnpm run test:types` 与针对新测试的 Node 命令，确认因功能尚未实现失败。
- [ ] 实现 `leaf`、`object`、`array`、`defineSelectionResource` 与类型映射；共享入口不得导入 server。
- [ ] 重跑类型与运行时测试，提交本任务。

## 任务 2：服务端执行与安全预算

- [ ] 写处理器测试：成功只执行已选字段；未知资源/字段、参数错误、无权、根缺失、输出错误；请求体、深度、字段数、成本、数组长度越界；取消与危险键。
- [ ] 运行新测试确认失败；实现 `implementSelection` 和 `createSelectionHandler`，显式限制所有预算、逐级先授权后执行、通过 Web Request/Response 返回稳定错误 envelope。
- [ ] 运行新测试确认通过，再提交本任务。

## 任务 3：类型化客户端与完整回环

- [ ] 写回环测试：真实 HttpClient 适配 Web 处理器，覆盖成功、协议错误映射、畸形响应、schema/transform 默认值隔离、取消和不重试。
- [ ] 运行新测试确认失败；实现客户端的 POST、校验与错误类，保持原 HttpError 分类。
- [ ] 运行回环测试与类型测试确认通过，再提交本任务。

## 任务 4：公开包与交付验证

- [ ] 为 `package.json` 增加 `/selection` 和 `/selection/server` 导出；在 README 给出共享契约、服务端注册与客户端调用示例。
- [ ] 运行 `pnpm test`、`pnpm run test:types`、`pnpm run test:consumer`、`pnpm run test:browser` 和 `pnpm pack --dry-run`；检查浏览器入口未引入服务端代码。
- [ ] 修复发现的缺陷，核对 `git diff --check` 和分支状态，提交剩余改动。

## 自检

规格的协议格式、类型推导、授权顺序、静态预算、运行时数组界限、错误映射、缓存禁用、包入口和验证命令分别由任务 1–4 覆盖。每个实现任务先写测试、确认失败、实现、确认通过。
