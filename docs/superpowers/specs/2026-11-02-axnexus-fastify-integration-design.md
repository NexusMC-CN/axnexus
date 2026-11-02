# axnexus Fastify 集成设计

日期：2026-11-02
状态：用户选择首版范围：Selection 路由与显式 Web Request/Response 桥接

## 目标

为 Fastify 5 服务提供可选的 `@nexusmc-cn/axnexus/fastify` 入口。应用注册插件后，由 Fastify 负责路由、现有钩子和身份上下文；Selection 处理器继续负责协议结构、预算、资源与字段权限。普通 axnexus HTTP 客户端已经能请求 Fastify REST API，适配器不接管或改写业务路由。

## 公开接口

- `createFastifySelectionPlugin({ resources, limits, plans?, allowDynamic?, endpoint?, getContext, createLoaders?, observe? })` 返回可传给 `fastify.register` 的普通封装插件。`endpoint` 默认 `/__axnexus/select`，允许 Fastify `prefix`，且与处理器的路径配置一致。
- `toWebRequest(fastifyRequest, { origin?, path?, body? })` 显式将一个已解析、持有原始字节的请求转换为 Web Request。非 GET/HEAD 请求若没有原始字节或显式 body，不自动把已解析对象重新序列化；调用方可为普通路由显式提供 body。
- `sendWebResponse(fastifyReply, response)` 映射状态、headers 和流式 body 到 Fastify Reply，保留 Fastify 的发送钩子可见的状态与响应头。
- `createSelectionHandler({ endpoint? })` 以同样的路径校验独立的 Web Request，默认路径保持不变。客户端仍通过既有 `createSelectionClient(http, { endpoint })` 配置发送地址。

## 请求与安全边界

插件只在自己的 Fastify 封装作用域内为 Selection POST 路由注册原始 JSON Buffer 解析，不修改其他路由的 JSON、multipart、文本或流处理。Fastify 先按请求体上限拒绝超量输入；Selection 处理器仍复核字节上限并返回协议错误。插件从 `getContext` 获取应用身份上下文，沿用上层认证、CSRF、限流等钩子，绝不自行读取数据库或替换业务鉴权。

插件不使用 `fastify-plugin` 打破封装，也不依赖 `@fastify/fetch`。`fastify` 为可选 peer dependency，支持 Fastify `>=5.7.3 <6`；核心入口不导入 Fastify 或 Node 专用模块。Fastify 子入口要求 Node 20+；既有核心与浏览器入口维持原兼容范围。

## 验证

测试覆盖：默认和自定义 endpoint、Fastify prefix、有效和无效 JSON、超量请求、身份上下文、取消信号、协议错误、Set-Cookie/响应头和流式 Response 桥接、普通路由不受插件 parser 影响。类型测试及打包消费检查验证可选入口；现有 Node、Bun、浏览器测试继续运行。

## 后续范围

先稳定单根资源模型。多个根资源同请求组合会引入跨资源授权、成本与失败语义，待真实页面需求确定后单独设计。数据库列投影也须先明确授权所需字段与数据映射，不能直接把客户端选择树拼成 SQL。分页结构目前由资源契约声明 `items/pageInfo`，可以后续抽成共享工厂，但本次不改 wire 协议。
