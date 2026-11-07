# 发布 npm 包

[返回项目首页](../README.zh-CN.md) · [English](./releasing.md)

发布目标为公开包 `@nexusmc-cn/axnexus`。推送 `v*` tag 后，[发布工作流](../.github/workflows/release.yml)会验证、打包并发布该 tag 对应的提交。合并此工作流本身不会发布包。

## 日常开发继续使用 pnpm

构建、测试与打包仍使用项目固定版本的 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run test:types
pnpm run test:consumer
pnpm pack
```

`prepack` 使用 `npm run build`，让 `npm pack` 和 `npm publish` 无需额外安装全局 pnpm；开发者不需要改用 npm，`pnpm pack` 同样会执行该构建钩子。

## 首次启用：配置 npm Trusted Publisher

包维护者需要在 npm 网站的包设置中添加 GitHub Actions Trusted Publisher。此项为 npm 侧的一次性配置，提交仓库文件不会自动完成它。

| npm 设置 | 值 |
| --- | --- |
| Organization or user | `NexusMC-CN` |
| Repository | `axnexus` |
| Workflow filename | `release.yml`，只填文件名 |
| Environment name | 留空；当前工作流没有配置 GitHub environment |
| Allowed actions | 允许 `npm publish` |

只允许默认的 `npm stage publish` 不足以运行本工作流。新建 Trusted Publisher 后，需要在 2 天内完成首次成功发布；过期后应删除并重新配置。具体要求见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

工作流使用 GitHub 托管的 Ubuntu runner、Node.js 24 和 npm 11，并授予 `contents: read`、`id-token: write`。npm OIDC 发布要求 Node.js 至少为 22.14.0、npm 至少为 11.5.1；升级发布工具时应继续满足此要求。发布过程使用短期 OIDC 凭据，无需添加 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` secret。

仓库和 npm 包必须保持公开，`package.json` 的 `repository` 必须与实际仓库对应，才能生成来源证明。工作流显式传入 `--provenance`；这会公开关联源码提交和工作流运行记录，详见 [npm provenance 文档](https://docs.npmjs.com/generating-provenance-statements/)。

## 准备稳定版本

1. 更新 `package.json` 的版本及 `CHANGELOG.md`，提交本次发布的全部变更。
2. 使用 `packageManager` 声明的 pnpm 版本，执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm run test:types` 和 `pnpm run test:consumer`。
3. 确认目标提交的常规 CI 检查通过，其中还包括浏览器、Bun 与 Nuxt 消费验证。发布工作流单独重跑 Node.js 测试、类型检查和实际发布 tarball 的消费验证。
4. 将审查后的发布提交合并到主分支，确认其中包含 `release.yml`，并确认 npm 侧的 Trusted Publisher 已正确配置。

此工作流只支持严格的 `X.Y.Z` 稳定版本，各段不得包含前导零。tag 必须与包版本完全对应，例如版本 `0.4.0` 对应 `v0.4.0`。预发布版本和 build metadata 均会被拒绝；发布使用 npm 默认的 `latest` dist-tag，因此不能用此流程发布 `-beta` 等预发布包。需要预发布时，应先为它设计独立的 dist-tag 流程。

## 创建 tag 并检查结果

在已确认的发布提交上创建 tag，并只推送该 tag。下列 `X.Y.Z` 需要替换为 `package.json` 中的目标版本：

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

工作流禁用依赖缓存，以 frozen lockfile 安装依赖。测试通过后，`pnpm pack --json` 正常执行 `prepack`，在独立临时目录生成唯一 tarball。消费测试接收这个已有 tarball，检查包内容并在临时项目中安装、验证；发布步骤随后将同一路径传给 `npm publish`，不会重新打包工作区。

在 GitHub Actions 中检查本次 Release 运行，确认最后的发布步骤成功，再检查 npm 上的版本、`latest` 指向和 provenance 记录。可查询版本元数据：

```bash
npm view @nexusmc-cn/axnexus@X.Y.Z version dist.integrity dist.attestations --json
npm view @nexusmc-cn/axnexus dist-tags --json
```

本地打包、消费测试或 `npm publish --dry-run` 成功，只能证明本地检查结果；它们不能确认 npm OIDC 身份绑定、发布权限或远端发布成功。

如果发布失败，先根据 Actions 日志确认失败阶段。认证失败时核对 npm 配置中的组织、仓库、工作流文件名、Allowed actions 和首次发布有效期。重跑前先查询该版本是否已存在；npm 不允许重复使用已发布的包名与版本组合。已存在的版本应检查远端结果，不要通过移动 tag 或覆盖版本来重试，参见 [npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。
