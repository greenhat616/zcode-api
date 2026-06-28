# Release CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push 一个 `v*` tag 时,自动交叉编译 5 平台二进制、生成 GitHub 原生 changelog 创建 Release,并构建多架构 Docker 镜像发布到 ghcr.io。

**Architecture:** 单一 workflow `.github/workflows/release.yml`,4 个 job:`detect`(算预发布标志与版本号)、`build-binaries`(ubuntu 单机 Bun 交叉编译 5 平台 matrix)、`release`(聚合二进制 + 自动 notes)、`docker`(多架构镜像,与 binaries 并行)。Dockerfile 用 oven/bun 多阶段。

**Tech Stack:** GitHub Actions、Bun 1.x(`bun build --compile --target`)、Docker Buildx、ghcr.io、`softprops/action-gh-release`、`docker/*-action`。

## Global Constraints

- 触发:`push` tag `v*`。
- 预发布判定:tag 名匹配 `alpha|beta|rc`(忽略大小写)→ Pre-release;Docker 该情况不打 `latest`。
- 版本号:`version = github.ref_name 去掉前导 v`(如 `v2.0.6.alpha` → `2.0.6.alpha`)。不使用 `type=semver`(点分隔预发布非合法 semver)。
- Changelog:GitHub 原生自动生成(`generate_release_notes: true`),不引入第三方工具。
- 二进制平台 5 个,产物命名(复刻上游)严格如下:
  - `bun-windows-x64` → `zcode-proxy.exe`
  - `bun-linux-x64` → `zcode-proxy-linux-x64`
  - `bun-linux-arm64` → `zcode-proxy-linux-arm64`
  - `bun-darwin-x64` → `zcode-proxy-darwin-x64`
  - `bun-darwin-arm64` → `zcode-proxy-darwin-arm64`
- 构建命令统一带 `--define "require.resolve=undefined"`(与现有脚本一致)。
- Docker 镜像名:`ghcr.io/<owner 小写>/zcode-proxy`,平台 `linux/amd64,linux/arm64`,容器跑 `bun run src/index.ts serve`,监听 8080,非 root `bun` 用户。
- 不生成 checksums、不签名、不发 npm。
- 权限最小化:workflow 顶层 `contents: read`;`release` job 加 `contents: write`;`docker` job 加 `packages: write`。

---

### Task 1: package.json 构建脚本 + .gitignore(darwin 产物)

补齐 darwin 两个本地构建脚本,使本地与 CI 一致;并让新增 darwin 产物被 git 忽略。

**Files:**
- Modify: `package.json`(`scripts` 段)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无。
- Produces: `bun run build:darwin-x64` / `bun run build:darwin-arm64` 两个脚本,产物名 `zcode-proxy-darwin-x64` / `zcode-proxy-darwin-arm64`。CI 的 build-binaries(Task 4)复用相同的 target 与产物命名约定。

- [ ] **Step 1: 在 `package.json` 的 `scripts` 中,`build:linux-arm64` 之后追加两行**

把 `package.json` 现有:

```json
    "build:linux-arm64": "bun build --compile --target bun-linux-arm64 --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-linux-arm64"
```

改为(注意上一行结尾加逗号):

```json
    "build:linux-arm64": "bun build --compile --target bun-linux-arm64 --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-linux-arm64",
    "build:darwin-x64": "bun build --compile --target bun-darwin-x64 --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-darwin-x64",
    "build:darwin-arm64": "bun build --compile --target bun-darwin-arm64 --define \"require.resolve=undefined\" src/index.ts --outfile zcode-proxy-darwin-arm64"
```

- [ ] **Step 2: 在 `.gitignore` 末尾追加 darwin 产物忽略**

现有结尾为:

```
/zcode-proxy.exe
/zcode-proxy-linux-*
```

追加一行:

```
/zcode-proxy-darwin-*
```

- [ ] **Step 3: 验证 package.json 仍是合法 JSON**

Run: `bun -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: 输出 `ok`(无解析错误)

- [ ] **Step 4: 本地跑一个 darwin 交叉编译,确认脚本可用**

Run: `bun install --frozen-lockfile && bun run build:darwin-arm64`
Expected: 当前目录生成可执行文件 `zcode-proxy-darwin-arm64`(`ls -la zcode-proxy-darwin-arm64` 可见,体积数十 MB)

- [ ] **Step 5: 确认产物被 gitignore,然后清理**

Run: `git status --porcelain zcode-proxy-darwin-arm64; rm -f zcode-proxy-darwin-arm64`
Expected: `git status` 对该文件**无输出**(已被忽略);随后删除该二进制

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore
git commit -m "build: add macOS cross-compile scripts and ignore darwin artifacts"
```

---

### Task 2: Dockerfile(oven/bun 多阶段)

容器化 zcode-proxy,`bun run src/index.ts serve` 启动,监听 8080,非 root 运行。

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: 仓库根的 `package.json`、`bun.lock`、`tsconfig.json`、`src/`。
- Produces: 一个可 `docker build` 的镜像,`EXPOSE 8080`,默认 `CMD` 启动 serve。Task 4 的 docker job 用 `context: .` 构建本文件。

- [ ] **Step 1: 创建 `.dockerignore`**

```
node_modules
dist
.git
.github
*.log
config.yaml
.DS_Store
zcode-proxy.exe
zcode-proxy-linux-*
zcode-proxy-darwin-*
docs
_reverse
.omo
```

- [ ] **Step 2: 创建 `Dockerfile`**

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

> 关键:必须 COPY `config.example.yaml`(`src/config/template.ts` 用 `import ... with { type: "text" }` 引用它,解释执行时运行时从文件系统解析,缺失则启动崩溃);config 写到 `/data`(非 root `bun` 用户对 `/app` 只读)。

- [ ] **Step 3: 本地构建镜像(host 架构,冒烟用)**

Run: `docker build -t zcode-proxy:test .`
Expected: 构建成功,最后输出 `naming to docker.io/library/zcode-proxy:test`

- [ ] **Step 4: 冒烟启动并验证 /health**

Run:
```bash
docker run --rm -d --name zcode-test -p 8080:8080 zcode-proxy:test
sleep 3
curl -fsS -H "x-api-key: your-proxy-secret" http://localhost:8080/health; echo
docker logs zcode-test | tail -5
docker stop zcode-test
```
Expected: `curl` 返回 `{"status":"ok",...}`(HTTP 200);日志显示服务已监听 `0.0.0.0:8080`(无配置时从模板自动写入 `/data` 属正常)。注:`/health` 在 server 中位于 proxy-api-key 校验之后,故需带 `x-api-key`(= 模板默认 `your-proxy-secret`)

- [ ] **Step 5: 清理测试镜像**

Run: `docker rmi zcode-proxy:test`
Expected: 镜像删除成功

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: add oven/bun multi-stage Dockerfile"
```

---

### Task 3: `.github/release.yml`(自动 notes 分类)

让 GitHub 自动生成的 release notes 按 PR label 分组。

**Files:**
- Create: `.github/release.yml`

**Interfaces:**
- Consumes: 无。
- Produces: GitHub Release 自动 notes 的分类配置。被 Task 4 的 `generate_release_notes: true` 隐式读取(GitHub 约定路径,无需在 workflow 显式引用)。

- [ ] **Step 1: 创建 `.github/release.yml`**

```yaml
changelog:
  categories:
    - title: Features
      labels:
        - feat
        - feature
        - enhancement
    - title: Bug Fixes
      labels:
        - fix
        - bug
    - title: Other Changes
      labels:
        - "*"
```

- [ ] **Step 2: 验证 YAML 合法**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/release.yml')); print('ok')"`
Expected: 输出 `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/release.yml
git commit -m "ci: add release notes categorization config"
```

---

### Task 4: `.github/workflows/release.yml`(发布流水线)

核心 workflow:detect → build-binaries(matrix×5)→ release;docker 并行。

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1 的 target/产物命名约定、Task 2 的 `Dockerfile`、Task 3 的 `.github/release.yml`。
- Produces: 完整发布流水线。`detect` job 输出 `is_prerelease`(`'true'`/`'false'` 字符串)与 `version`(去 `v` 前缀)。

- [ ] **Step 1: 创建 `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      is_prerelease: ${{ steps.check.outputs.is_prerelease }}
      version: ${{ steps.check.outputs.version }}
    steps:
      - name: Determine version and prerelease
        id: check
        run: |
          TAG="${GITHUB_REF_NAME}"
          echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"
          if echo "$TAG" | grep -qiE 'alpha|beta|rc'; then
            echo "is_prerelease=true" >> "$GITHUB_OUTPUT"
          else
            echo "is_prerelease=false" >> "$GITHUB_OUTPUT"
          fi

  build-binaries:
    needs: detect
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: bun-windows-x64
            outfile: zcode-proxy.exe
          - target: bun-linux-x64
            outfile: zcode-proxy-linux-x64
          - target: bun-linux-arm64
            outfile: zcode-proxy-linux-arm64
          - target: bun-darwin-x64
            outfile: zcode-proxy-darwin-x64
          - target: bun-darwin-arm64
            outfile: zcode-proxy-darwin-arm64
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Build binary
        run: >-
          bun build --compile --target=${{ matrix.target }}
          --define "require.resolve=undefined"
          src/index.ts --outfile ${{ matrix.outfile }}
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.outfile }}
          path: ${{ matrix.outfile }}
          if-no-files-found: error

  release:
    needs: [detect, build-binaries]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true
      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          name: ${{ github.ref_name }}
          generate_release_notes: true
          prerelease: ${{ needs.detect.outputs.is_prerelease }}
          files: dist/*

  docker:
    needs: detect
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - name: Compute lowercase image name
        id: img
        run: echo "name=ghcr.io/${GITHUB_REPOSITORY_OWNER@L}/zcode-proxy" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ steps.img.outputs.name }}
          flavor: latest=false
          tags: |
            type=raw,value=${{ needs.detect.outputs.version }}
            type=raw,value=latest,enable=${{ needs.detect.outputs.is_prerelease == 'false' }}
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

> 说明:`${GITHUB_REPOSITORY_OWNER@L}` 是 bash 4+ 的小写参数展开(ubuntu runner 自带 bash 5),把 owner 转小写以满足 ghcr 镜像名规范。

- [ ] **Step 2: 验证 YAML 合法**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"`
Expected: 输出 `ok`

- [ ] **Step 3: 用 actionlint 静态校验(若已安装)**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/release.yml || echo "actionlint not installed — skipping (install: brew install actionlint)"`
Expected: 无错误输出,或打印 skip 提示。若 actionlint 报错则按提示修正后重跑

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow (binaries + ghcr image)"
```

---

### Task 5: README 容器用法文档

在 README 增加容器使用说明(env 清单 + `docker run` / compose 示例)。

**Files:**
- Modify: `README.md`(在 `## Development` 之后、`## Available Models` 之前插入新章节)

**Interfaces:**
- Consumes: Task 4 的镜像名约定 `ghcr.io/<owner>/zcode-proxy`、Task 2 的容器端口 8080。
- Produces: 文档,无代码接口。

- [ ] **Step 1: 在 `README.md` 的 `## Available Models` 行之前插入以下章节**

```markdown
## Docker

Pull the multi-arch image from GitHub Packages (ghcr.io):

```bash
docker pull ghcr.io/greenhat616/zcode-proxy:latest
```

Run with env-var configuration (no config file needed):

```bash
docker run --rm -p 8080:8080 \
  -e ZCODE_API_KEY="yourApiKey.yourSecretKey" \
  -e ZCODE_PROVIDER=zai \
  -e ZCODE_PROXY_API_KEY="your-proxy-secret" \
  ghcr.io/greenhat616/zcode-proxy:latest
```

Or mount a config file:

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)/config.yaml:/data/config.yaml:ro" \
  ghcr.io/greenhat616/zcode-proxy:latest
```

> Note: `/health` and all routes sit behind the proxy-API-key check, so health probes must send `x-api-key: <ZCODE_PROXY_API_KEY>`.

Common environment variables (see the Configuration table above for the full list):

| Env Var | Description |
|---------|-------------|
| `ZCODE_API_KEY` | Upstream API key (`{apiKey}.{secretKey}` for Z.AI, `{apiKey}` for Bigmodel) |
| `ZCODE_PROVIDER` | `zai` or `bigmodel` |
| `ZCODE_PROXY_API_KEY` | Client auth shared secret |
| `ZCODE_PROXY_PORT` | Listen port (default `8080`) |

docker-compose:

```yaml
services:
  zcode-proxy:
    image: ghcr.io/greenhat616/zcode-proxy:latest
    ports:
      - "8080:8080"
    environment:
      ZCODE_API_KEY: "yourApiKey.yourSecretKey"
      ZCODE_PROVIDER: zai
      ZCODE_PROXY_API_KEY: "your-proxy-secret"
    restart: unless-stopped
```
```

> 注:外层用 ```` ```markdown ```` 包裹仅为本计划展示;实际写入 README 时直接写正文(内层的 ` ``` ` 代码块照常)。

- [ ] **Step 2: 验证 README 渲染无明显断裂**

Run: `grep -n "## Docker" README.md && grep -n "ghcr.io/greenhat616/zcode-proxy" README.md`
Expected: 找到 `## Docker` 章节标题,且镜像引用存在

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Docker / GitHub Packages usage section"
```

---

### Task 6: 端到端验证(本 fork 真实 tag)

在 `greenhat616/zcode-api` fork 上 push 预发布 tag 跑通整条流水线,验证后清理。

**Files:** 无(仅操作 git/GitHub)。

**Interfaces:**
- Consumes: Task 1–5 全部产物。
- Produces: 验证证据;成功后删除测试 tag/Release/镜像。

- [ ] **Step 1: 推送前确认所有改动已提交并推到 fork**

Run: `git status --porcelain && git push origin master`
Expected: 工作区干净;push 成功

- [ ] **Step 2: 打并推送预发布测试 tag**

Run:
```bash
git tag v0.0.0-test.alpha
git push origin v0.0.0-test.alpha
```
Expected: tag 推送成功,触发 `Release` workflow

- [ ] **Step 3: 观察 workflow 运行**

Run: `gh run watch $(gh run list --workflow=Release --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`
Expected: 4 个 job(detect/build-binaries/release/docker)全部成功

- [ ] **Step 4: 验证 Release 与资产**

Run: `gh release view v0.0.0-test.alpha --json isPrerelease,assets --jq '{prerelease:.isPrerelease, assets:[.assets[].name]}'`
Expected: `prerelease: true`;assets 含全部 5 个:`zcode-proxy.exe`、`zcode-proxy-linux-x64`、`zcode-proxy-linux-arm64`、`zcode-proxy-darwin-x64`、`zcode-proxy-darwin-arm64`

- [ ] **Step 5: 验证 ghcr 镜像(预发布不应有 latest)**

Run: `gh api "users/greenhat616/packages/container/zcode-proxy/versions" --jq '[.[].metadata.container.tags[]]' 2>&1 | head`
Expected: 含 `0.0.0-test.alpha`;**不含** `latest`(预发布不打 latest)

- [ ] **Step 6: 清理测试产物**

Run:
```bash
gh release delete v0.0.0-test.alpha --cleanup-tag --yes
git push origin :refs/tags/v0.0.0-test.alpha 2>/dev/null || true
git tag -d v0.0.0-test.alpha
```
Expected: Release 与 tag 删除。容器镜像版本可在 GitHub Packages 页面手动删除(`gh api -X DELETE users/greenhat616/packages/container/zcode-proxy/versions/<id>` 按需)

---

## 自检结果

**Spec 覆盖:**
- 触发 `v*` → Task 4 detect/`on.push.tags` ✅
- 预发布判定 → Task 4 detect 正则 + release `prerelease` + docker `latest` 条件 ✅
- GitHub 原生 changelog → Task 4 `generate_release_notes` + Task 3 分类 ✅
- 5 平台二进制(命名复刻)→ Task 1 脚本 + Task 4 matrix ✅
- Docker oven/bun 多阶段 + 多架构 + ghcr → Task 2 + Task 4 docker job ✅
- `latest` 仅正式版 → Task 4 `enable=...== 'false'` ✅
- package.json/.gitignore 调整 → Task 1 ✅
- README 容器用法(新增交付物)→ Task 5 ✅
- 测试在本 fork → Task 6 ✅
- 不做 checksums/签名/npm → 计划中均未引入 ✅

**占位符扫描:** 无 TBD/TODO;所有步骤含具体内容与命令。

**类型/命名一致性:** `is_prerelease` 与 `version` 在 detect 输出、release、docker 三处引用一致;产物 5 个命名在 Task 1/4/6 完全一致。
