# axnexus Selection 协议设计

日期：2026-11-02
状态：待用户审查
范围：独立的按需读取协议及 TypeScript 客户端、服务端运行时

## 目标和边界

客户端为一次读取声明需要的字段。服务端验证请求与权限，只执行所选字段的读取逻辑，并返回相应形状。借鉴 GraphQL 的字段选择、类型契约和逐字段执行；不解析 GraphQL 文档，不实现 GraphQL 兼容接口。

首版支持：单个已注册资源、资源参数、标量字段、嵌套对象、有限长度的对象数组。首版不支持多个根资源组合、别名、片段、字段级参数、表达式、订阅、写操作、联合类型和自动批请求。筛选、排序和分页只能由某个资源在参数契约中显式声明。

现有 createHttpClient 和 defineEndpoint 保持原语义。defineEndpoint 的输出 schema 对应固定响应形状；Selection 的输出随选择而变，因此放在独立模块。

## 公开入口与共享契约

新增 @nexusmc-cn/axnexus/selection，包含共享契约、选择类型和客户端。新增 @nexusmc-cn/axnexus/selection/server，包含服务端资源实现及框架无关的 Web Request 到 Response 处理器。服务端代码不从包根入口或浏览器默认入口导出，不增加强制运行时依赖。

公开契约只包含资源标识、参数 Standard Schema、公开字段树、标量字段的值 schema、可空性和数组形态。它不包含数据库访问、服务端 resolver 或权限策略。资源名有版本控制；更改字段含义或不兼容的返回形状时升资源版本。

期望的使用形态（具体命名可在实现时统一）：

    const userContract = defineSelectionResource({
      resource: 'users.byId.v1',
      args: userArgsSchema,
      nullable: true,
      fields: {
        id: leaf(idSchema),
        name: leaf(nameSchema),
        email: leaf(emailSchema),
        profile: object({ avatar: leaf(avatarSchema) }, { nullable: true }),
      },
    });

    const users = implementSelection(userContract, {
      authorizeResource: ({ context }) => canReadUsers(context),
      load: ({ args, context }) => loadUserIdentity(args.id, context),
      fields: {
        id: { resolve: ({ parent }) => parent.id },
        name: { resolve: ({ parent, context }) => loadUserName(parent.id, context) },
        email: {
          authorize: ({ parent, context }) => canReadEmail(parent.id, context),
          resolve: ({ parent, context }) => loadUserEmail(parent.id, context),
        },
        profile: {
          resolve: ({ parent, context }) => loadProfile(parent.id, context),
          fields: { avatar: { resolve: ({ parent }) => parent.avatar } },
        },
      },
    });
    const handler = createSelectionHandler({ resources: [users], limits });
    const response = await handler(request, requestContext);

    const selection = createSelectionClient(http, { endpoint: '/__axnexus/select' });
    const user = await selection.select(userContract, {
      args: { id: '42' },
      select: { id: true, name: true, profile: { avatar: true } } as const,
    });
    // 结果：{ id: string; name: string; profile: { avatar: string } | null } | null

客户端永远不导入含服务端 resolver 或 authorize 函数的对象。leaf 从 Standard Schema 的输出推导类型；object 递归投影子字段；array 在投影元素后保留数组层；nullable 在相应节点增加 null。静态 const 选择精确推导这些类型。运行时动态选择只保证资源公开字段所构成的保守部分形状；当 TypeScript 无法证明选择树是固定字面量时，不承诺某个字段必有。首版不支持省略语义：已选字段必须出现，允许为空时显式返回 null。数组元素首版不可为 null；拒绝授权时不得通过省略字段伪装成功。客户端类型只是本地契约推导，服务端运行时校验才是权威。

## 请求、响应与执行

首版固定 POST /__axnexus/select，协议层使用 application/json，宿主服务端负责同源/跨源访问策略、认证及需要时的 CSRF 防护。请求体是版本化 JSON 结构：

    {
      "protocol": "axnexus.selection",
      "version": 1,
      "resource": "users.byId.v1",
      "args": { "id": "42" },
      "select": { "id": true, "name": true, "profile": { "avatar": true } }
    }

成功为 HTTP 200，响应体是包含 data 的对象；根对象不存在时 data 为 null。客户端先校验响应 envelope 再提取 data，不把整个 envelope 断言为选择结果；还要按共享契约递归校验所选字段及其值。协议调用显式覆盖客户端默认 schema 和 transformResponse，以免固定形状校验或转换破坏协议响应。错误为非 2xx，响应体包含稳定的 error.code 和安全的 error.message。首版采用整体成功或失败，不返回部分数据。格式或版本错误为 400，未知资源为 404，参数错误为 422，请求体或预算超限为 413，资源或字段拒绝访问为 403；resolver 和输出校验故障为 500，响应不暴露内部异常详情。

客户端将格式正确的协议错误 envelope 映射为 SelectionError，保留协议 code、HTTP status 和安全 message。非 2xx 响应若没有有效协议 envelope，则保留 axnexus 原有 HttpError 及其 status；网络错误、超时和取消也保持原有分类，不伪造协议 code。响应 envelope 或所选数据不符合契约时抛出独立协议/校验错误，不断言结果类型。

服务端处理顺序：请求体大小限制与 JSON 解析 → 协议结构和版本校验 → 资源及字段注册表匹配 → 静态深度、字段数和成本预算 → 参数 schema 校验 → 资源授权 → 加载根对象的最小身份数据 → 每个已选字段授权 → 仅执行所选 resolver → 校验字段值 → 组装结果。根加载器不接收选择树，避免在字段授权前预取敏感数据。需要依赖资源身份的字段授权，在最小根数据加载后执行；父对象字段的授权先于该对象 resolver，子字段的授权在取得父对象后、子字段 resolver 前执行。字段未声明 authorize 时只受资源级授权保护。未知字段一律拒绝，不能隐式展开对象。契约初始化拒绝 __proto__、constructor 等危险字段名及重复资源名。根加载器和父对象 resolver 只应读取其已授权阶段需要的数据，不能用整对象预取绕过字段边界。

请求的 AbortSignal 传入参数校验、加载和 resolver 上下文，客户端的总超时覆盖完整协议调用。数组设置元素数上限；资源实现可对已授权字段使用批量加载来避免 N+1。具体性能收益由资源实现负责，不能依赖最终序列化裁剪完整对象。

## 安全、预算和缓存

处理器必须显式配置请求体字节上限、最大深度、最大字段数、最大成本和数组元素上限；初始化校验正整数。注册字段可声明正整数成本；未声明时成本为 1。静态预算按嵌套数组的最大元素数计算保守上界，在任何 resolver 前拒绝超限选择。每层数组 resolver 产生结果后、执行任何元素的子字段 resolver 前检查实际长度；超限立即拒绝整次请求。成本预算不替代数据库超时、后端批量加载和资源级节流。宿主应用创建身份上下文，服务端每次请求校验字段权限。日志和错误消息不包含 token、内部 SQL 或敏感字段值。

客户端复用注入的 HttpClient、headers、AbortSignal、timeout、totalTimeout、maxBodySize 和错误分类。协议调用强制设置 retry: 0、cache: false、responseType: json，拒绝或覆盖会改变协议结果的请求级 schema、transformResponse 和状态策略；本地 context、headers、signal 及传输时限仍可传入。请求/响应拦截器属于注入的 HttpClient，若改写协议包体或返回值，客户端的 envelope 和字段校验必须拒绝无效结果。服务端默认 Cache-Control: no-store。首版不实现结果缓存。未来若缓存，key 必须包含协议版本、资源、规范化参数、规范化选择及租户/身份授权分区，不得跨授权主体复用。

## 与现有代码的关系

- src/core/client.ts 继续负责通用 HTTP，普通客户端实例不新增 select 方法。
- src/core/schema.ts 的 Standard Schema 可用于参数与字段输出校验；现有响应 schema 只在数据到达后工作，不控制服务端执行。
- src/contracts/endpoint.ts 继续服务固定端点，Selection 不改变它的输入输出约定。
- src/cache/policy.ts 的 GET 缓存不用于首版 POST 协议调用。
- src/server/json.ts 是出站 fetchJson，不是入站路由；新增处理器独立实现。

## 验收标准

1. 编译时拒绝未知字段；静态选择的返回类型只包含所选字段，保留嵌套、数组与 null；动态选择不作不安全的精确断言。伪造、不完整或多出字段的响应不可被断言成成功结果。
2. 未选字段的 resolver 不执行；未知字段、超预算和无权字段不会触发敏感字段读取。
3. 客户端至处理器的回环测试覆盖正常选择、参数错误、版本错误、未知字段、权限、根对象缺失、取消、resolver 故障及字段输出校验故障。
4. 现有 HTTP 客户端、端点契约、缓存及浏览器入口行为不变；验证构建、类型测试、Node 测试、浏览器入口和打包内容。

## 方案取舍

在 REST 端点加 fields 参数适合少量接口，但会重复字段白名单、权限与类型逻辑。自定义文本查询语言需要解析器、错误定位和更大的输入攻击面。独立的版本化 JSON 协议保留按需执行能力，并把首版范围控制在资源契约和服务端执行器内。
