# axnexus Nuxt 4 接入设计

日期：2026-11-02  
状态：用户确认“接入说明＋Nitro 测试”；覆盖 Nuxt 4.5 与 4.6+

## 目标与边界

证明现有 axnexus HTTP 客户端和 Selection 服务端处理器能在 Nuxt 4 的 Nitro 路由与 SSR 中使用。提供版本对应的示例和可重复的真实 Nuxt/Nitro 冒烟验证。本轮不发布 `./nuxt` 运行时入口或自动注册模块，也不重写 Nuxt 的数据获取机制。

## 服务端路由

- 在 `server/api/__axnexus/select.post.ts` 挂载时，实际路径是 `/api/__axnexus/select`；`createSelectionHandler({ endpoint })` 与客户端 `createSelectionClient(..., { endpoint })` 都使用该路径。
- Nuxt 4.6+ 的 `nuxt/server` 处理器接收标准 Web Request 并可返回 Response；显式从 `nuxt/server` 导入 `defineEventHandler`，直接调用框架无关的 Selection handler。
- Nuxt 4.5 使用 H3 v1 的 `toWebRequest(event)` 和 `sendWebResponse(event, response)`。只在旧版本示例中使用该桥接，不把 H3 v1 类型带入 axnexus 包。
- H3 v1 文档把 `toWebRequest` 标为不稳定；所以对 4.5 的兼容结论以固定版本的真实 Nitro 测试为界，不把旧桥接承诺为所有 Nuxt 版本通用。
- 用户身份由应用从可信服务端请求上下文建立，字段授权仍由 Selection 实现决定；客户端请求体不能决定身份。

## SSR 客户端

- 服务端每个 SSR 请求新建 axnexus 客户端，明确转发需要的 Cookie 或令牌，并在工作结束时关闭。浏览器端另建客户端；不共享带用户头或缓存的服务端实例。
- 内部调用可使用当前事件的 fetch，但要把 axnexus 传入的 Headers 规范化为普通键值对象，避免 H3 v1 展开对象时丢失 Content-Type 等头。Nuxt 的 `useAsyncData` 继续负责 SSR payload、水合、key 与取消语义。
- 普通 REST 路由仍可由 axnexus 客户端直接调用；Nuxt 的 `useFetch` 也是可用选择，尤其适合无需 axnexus 特性的简单相对路径请求。

## 验证

- 用打包后的本地 axnexus 构建独立临时 Nuxt 4.5.2 和 4.6.3 应用，运行 Nitro 服务并实际 POST Selection 路由。
- 两个版本分别检查有效请求、协议错误、路径一致性与身份隔离；SSR 页面两次使用不同 Cookie，确认 HTML/payload 不串用户，并确认请求头到达 Selection 处理器。
- 验证脚本在本地和 CI 可重复执行，不把 Nuxt 增加为 axnexus 的运行时 peer，也不把临时应用打进 npm 包。
- Nuxt 4.6.3 的 Node engine 下限是 22.22.3 或 24.15.0；测试环境必须满足这个下限，不能把 axnexus 核心的较低 Node 支持误写成 Nuxt 的支持范围。

## 官方依据

- Nuxt 4.6 服务端 Web API：https://github.com/nuxt/nuxt/blob/main/docs/3.guide/6.going-further/5.server-imports.md
- Nuxt 路由目录：https://nuxt.com/docs/4.x/guide/directory-structure/server
- Nuxt 数据获取和 SSR：https://github.com/nuxt/nuxt/blob/main/docs/1.getting-started/10.data-fetching.md
- H3 v1 请求与响应桥接：https://v1.h3.dev/utils/request ，https://v1.h3.dev/utils/response
