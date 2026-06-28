# Release CI 设计文档

- **日期**: 2026-06-28
- **项目**: zcode-proxy (`greenhat616/zcode-api`, fork of `TriDefender/zcode-api`)
- **目标**: 基于 GitHub Actions 的发布流水线 —— push `v*` tag 时,自动构建多平台二进制、生成项目风格的 changelog 并创建 GitHub Release,同时构建多架构 Docker 镜像发布到 GitHub Packages (ghcr.io)。

## 背景与约束

- **构建工具**: Bun 1.x(`bun build --compile`),产出单文件可执行二进制。`package.json` 现有 3 个构建脚本:默认(`zcode-proxy.exe`)、`linux-x64`、`linux-arm64`。
- **入口**: `src/index.ts`,默认子命令 `serve`;配置路径 `arg → ZCODE_PROXY_CONFIG → config.yaml`,缺失时从内置模板自动生成。`ZCODE_*` 环境变量可覆盖配置字段(见 README 配置表)。
- **Release 风格(参考上游)**: 上游无 CI、无 Dockerfile,但有手动 release。最近的 v2.0.4 / v2.0.5 正文采用 **GitHub 原生 "What's Changed" 自动生成 notes**(PR 列表 + `**Full Changelog**` compare 链接)。Tag 格式 `vX.Y.Z`,预发布用 `vX.Y.Z.alpha` 并标记 Pre-release。Release 名称 = tag 名。历史二进制资产命名:`zcode-proxy.exe`、`zcode-proxy-linux-x64`、`zcode-proxy-linux-arm64`。
- **当前版本**: `2.0.5.alpha`。

## 决策汇总

| 维度 | 决策 |
|---|---|
| 触发 | push tag `v*` |
| 预发布判定 | tag 名匹配 `alpha\|beta\|rc`(忽略大小写)→ Pre-release |
| Changelog | GitHub 原生自动生成 notes(`generate_release_notes: true`),配合 `.github/release.yml` 分类 |
| 二进制平台 | 5 个:win-x64、linux-x64、linux-arm64、darwin-x64、darwin-arm64 |
| checksums | 不生成 |
| Docker | oven/bun 多阶段构建,多架构 `linux/amd64,linux/arm64`,推 ghcr.io |
| Docker `latest` | 仅正式版(非预发布)才打 |
| 测试 | 直接在本 fork 用预发布 tag 验证 |

## 总体架构

单一 workflow 文件 `.github/workflows/release.yml`:

```
push tag v*
   │
   ├─→ job: detect        (输出 is_prerelease)
   │
   ├─→ job: build-binaries  (needs: detect; matrix × 5, ubuntu 交叉编译)
   │        └─→ job: release  (needs: build-binaries + detect; 聚合二进制 + 自动 notes)
   │
   └─→ job: docker        (needs: detect; 多架构镜像 → ghcr.io, 与 binaries 并行)
```

**核心优势**: Bun `--compile --target` 支持从单台 `ubuntu-latest` 交叉编译全部 5 个平台(含 Windows / macOS),无需 macOS/Windows runner。

## 组件设计

### Job: detect

- 用正则判定预发布:`is_prerelease = (tag =~ /alpha|beta|rc/i)`。
- 同步计算 `version = tag 去掉前导 v`(如 `v2.0.6.alpha` → `2.0.6.alpha`)。
- 通过 `outputs.is_prerelease` 与 `outputs.version` 暴露给 `release` 与 `docker` job 共用,避免重复逻辑。
- 输入:`github.ref_name`(tag 名)。

### Job: build-binaries

- `needs: detect`
- `runs-on: ubuntu-latest`
- `strategy.fail-fast: false`,`matrix.include` 列出 5 个目标:

  | matrix target | outfile |
  |---|---|
  | `bun-windows-x64` | `zcode-proxy.exe` |
  | `bun-linux-x64` | `zcode-proxy-linux-x64` |
  | `bun-linux-arm64` | `zcode-proxy-linux-arm64` |
  | `bun-darwin-x64` | `zcode-proxy-darwin-x64` |
  | `bun-darwin-arm64` | `zcode-proxy-darwin-arm64` |

- 步骤:`actions/checkout` → `oven-sh/setup-bun` → `bun install --frozen-lockfile` → `bun build --compile --target=${{ matrix.target }} --define "require.resolve=undefined" src/index.ts --outfile ${{ matrix.outfile }}` → `actions/upload-artifact`(每个产物一份)。

### Job: release

- `needs: [build-binaries, detect]`
- 权限:`contents: write`
- 步骤:`actions/download-artifact`(合并所有产物到一个目录)→ `softprops/action-gh-release`:
  - `generate_release_notes: true`
  - `name: ${{ github.ref_name }}`
  - `prerelease: ${{ needs.detect.outputs.is_prerelease }}`
  - `files`:5 个二进制

### Job: docker

- `needs: detect`
- 权限:`contents: read`、`packages: write`
- 镜像名:`ghcr.io/${{ github.repository_owner }}/zcode-proxy`(小写;fork 友好)
- 步骤:`actions/checkout` → `docker/setup-qemu-action`(arm64 仿真)→ `docker/setup-buildx-action` → `docker/login-action`(`ghcr.io`,用 `GITHUB_TOKEN`)→ `docker/metadata-action` → `docker/build-push-action`:
  - `platforms: linux/amd64,linux/arm64`
  - tags(由 metadata-action 生成):
    - `type=raw,value=${{ needs.detect.outputs.version }}`(始终,如 `2.0.6` / `2.0.6.alpha`)
    - `type=raw,value=latest,enable=${{ needs.detect.outputs.is_prerelease == 'false' }}`(仅正式版)
  - `flavor: latest=false`(显式关闭默认 latest,由上面的 raw 规则控制)
  - 说明:不用 `type=semver`,因上游预发布 tag 为点分隔(`v2.0.5.alpha`),非合法 semver 会解析失败。

### Dockerfile(仓库根目录)

oven/bun 多阶段构建:

```dockerfile
# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json config.example.yaml ./
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
ENV ZCODE_PROXY_PORT=8080
ENV ZCODE_PROXY_CONFIG=/data/config.yaml
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/index.ts", "serve"]
```

- 配置策略:env 变量(`ZCODE_API_KEY` 等)驱动,或运行时挂载 config 到 `/data/config.yaml`;无配置时由入口逻辑从内置模板写入 `/data`(因 `bun` 用户对 `/app` 只读)。
- **必须 COPY `config.example.yaml`**:`src/config/template.ts` 以 `import ... with { type: "text" }` 引用它;解释执行(`bun run`,非编译)时该 import 在运行时从文件系统解析,缺失会导致容器启动即崩溃。
- `/health` 等所有路由在 server 中位于 proxy-api-key 校验之后,因此**健康检查也需带 `x-api-key`**(等于 `ZCODE_PROXY_API_KEY`)。
- 以非 root `bun` 用户运行。

### package.json 调整

补齐 darwin 两个 build 脚本,使本地与 CI 一致:

```jsonc
"build:darwin-x64":   "bun build --compile --target bun-darwin-x64   --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-darwin-x64",
"build:darwin-arm64": "bun build --compile --target bun-darwin-arm64 --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-darwin-arm64"
```

### .github/release.yml(自动 notes 分类)

按 PR label 分组:`Features`(`feat`/`enhancement`)、`Bug Fixes`(`fix`/`bug`)、`Other Changes`(`*`)。无 label 的 PR 归入 Other。

### .gitignore 调整

补充忽略新增的 darwin 产物:`/zcode-proxy-darwin-*`(现有已忽略 `/zcode-proxy.exe`、`/zcode-proxy-linux-*`)。

## 边界与错误处理

- **预发布隔离**: 预发布 tag 仍正常出产物与 Release,只是标 Pre-release 且 Docker 不打 `latest`。
- **单平台失败不阻断**: `build-binaries` 用 `fail-fast: false`。
- **权限最小化**: 各 job 单独声明所需 `permissions`,不在 workflow 顶层放开全部。
- **并行**: `docker` 与 `build-binaries`/`release` 链并行,互不阻塞。

## 测试策略

- 本地 `act` 难以验证 Bun 交叉编译与多架构 buildx,主要靠真实 tag 验证。
- 在本 fork(`greenhat616/zcode-api`)push 一个预发布 tag(如 `v0.0.0-test.alpha`)跑通完整流水线:
  - 确认 5 个二进制均产出并挂到 Release
  - 确认 Release 标记为 Pre-release、notes 为自动生成格式
  - 确认 ghcr.io 镜像推送成功、`latest` 未被预发布污染
- 验证后删除测试 tag 与对应 Release / 预发布镜像。

## 不做(YAGNI)

- 不生成 checksums。
- 不做二进制/镜像签名(cosign 等)。
- 不发布到 npm。
- 不引入 git-cliff 等第三方 changelog 工具(用 GitHub 原生)。

## 交付物清单

1. `.github/workflows/release.yml`
2. `Dockerfile`
3. `.github/release.yml`
4. `package.json`(补 2 个 build 脚本)
5. `.gitignore`(补 darwin 产物忽略)
