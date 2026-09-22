#!/usr/bin/env bash
#==============================================================================
# sync.sh — dsh-qoder-connect 上游同步脚本
#==============================================================================
#
# 功能：
#   将本地定制修改同步到上游（upstream/main）最新代码。
#   采用 **Patch-First, Smart-Merge** 策略：
#   - 当无本地定制（sync.patch 为空）时，直接拉取上游并对齐分支。
#   - 当有本地定制（sync.patch 非空）时，优先使用 patch 保持干净历史，冲突时回退到智能合并。
#
# 依赖与前提：
#   - remote 配置：upstream（原上游）、origin（个人 fork）
#   - 分支约定：custom（本地定制修改分支）、main（跟踪 upstream/main）
#   - 文件：sync.patch（定制修改的干净快照，已排除 sync.patch/sync.sh 自身）
#
# 同步策略：
#   ── 场景 A：无自定义修改（sync.patch 为空）─────────────────────
#     直接将 custom 分支对齐至 upstream/main 最新提交，保持零差异。
#
#   ── 场景 B：有自定义修改（sync.patch 非空）─────────────────────
#     ── 策略 1：Patch Apply（优先）
#       1. 备份 sync.patch 与 sync.sh 到临时目录
#       2. 重置 main 分支到 upstream/main
#       3. 从 main 检出临时分支并测试应用 patch
#       4. 若无冲突，直接基于最新上游应用定制修改并更新 custom 分支
#
#     ── 策略 2：Smart Merge（回退，按文件类型智能处理）
#       1. 将 main 分支合并到 custom 分支
#       2. 对 README*.md：保留 Fork 说明（> [!NOTE] 块），其余使用上游最新内容
#       3. 对其它冲突文件：列出差异并以本地版本（--ours）为准
#       4. 提交合并结果
#
#   ── 收尾工作：
#     1. 重新生成干净的 sync.patch（自动排除 sync.patch 与 sync.sh）
#     2. 运行自动化测试与构建校验（若环境支持）
#     3. 提示或执行推送到 origin/custom 和 origin/main
#==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REPO_NAME="$(basename "$SCRIPT_DIR")"
PATCH_FILE="$SCRIPT_DIR/sync.patch"

AUTO_YES=false
SKIP_TEST=false

for arg in "$@"; do
    case "$arg" in
        -y|--yes) AUTO_YES=true ;;
        --skip-test) SKIP_TEST=true ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo "选项:"
            echo "  -y, --yes      非交互模式，自动确认推送"
            echo "  --skip-test    跳过 pnpm 编译与测试验证"
            echo "  -h, --help     显示帮助信息"
            exit 0
            ;;
    esac
done

echo "=================================================="
echo "  同步 $REPO_NAME (Patch-First, Smart-Merge)"
echo "=================================================="

# 检查 git remote
if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "❌ 错误: 未配置 upstream 远程仓库。"
    echo "💡 请先运行: git remote add upstream https://github.com/masknull/dsh-qoder-connect.git"
    exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
    echo "❌ 错误: 未配置 origin 远程仓库。"
    exit 1
fi

# Step 0: 创建安全临时备份目录
TMP_DIR="$(mktemp -d /tmp/dsh_qoder_connect_sync_XXXXXX)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if [ -f "$PATCH_FILE" ]; then
    cp "$PATCH_FILE" "$TMP_DIR/sync.patch"
fi
if [ -f "$SCRIPT_DIR/sync.sh" ]; then
    cp "$SCRIPT_DIR/sync.sh" "$TMP_DIR/sync.sh"
fi

# Step 1: 拉取上游与远端
echo "[1/4] 拉取 upstream 与 origin 最新提交..."
git fetch upstream --tags 2>/dev/null || git fetch upstream
git fetch origin 2>/dev/null || true

# 暂存本地未提交的修改（如果有）
STASHED=false
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    echo "📦 检测到工作区未提交修改，正在暂存..."
    git stash push -u -m "sync.sh-auto-stash-$(date +%s)" 2>/dev/null || true
    STASHED=true
fi

# Step 2: 重置 main 分支到 upstream/main
echo "[2/4] 更新 local main 分支到 upstream/main..."
if git show-ref --verify --quiet refs/heads/main; then
    git branch -f main upstream/main
else
    git branch main upstream/main
fi

# Step 3: 应用同步策略
echo "[3/4] 应用同步策略..."
APPLIED_VIA_PATCH=false

if [ ! -s "$TMP_DIR/sync.patch" ]; then
    # 场景 A：无自定义修改（sync.patch 为空），直接对齐 upstream/main
    echo "   ℹ️  当前无自定义修改（sync.patch 为空），直接对齐上游最新提交..."
    git checkout custom --quiet
    git reset --hard upstream/main --quiet
    cp "$TMP_DIR/sync.sh" "$SCRIPT_DIR/sync.sh"
    chmod +x "$SCRIPT_DIR/sync.sh"
    touch "$PATCH_FILE"
    echo "   ✅ 已与上游 upstream/main 完全对齐"
else
    # 场景 B：有自定义修改，走 Patch Apply / Smart Merge
    echo "   正在测试 Patch 是否适用于最新 upstream/main..."
    git checkout main --quiet
    if git apply --check "$TMP_DIR/sync.patch" 2>/dev/null; then
        echo "   ✅ Patch 校验通过，应用干净线性历史（策略 1）..."
        git checkout -B custom main --quiet
        git apply "$TMP_DIR/sync.patch"
        cp "$TMP_DIR/sync.sh" "$SCRIPT_DIR/sync.sh"
        chmod +x "$SCRIPT_DIR/sync.sh"
        git add -A
        git commit -m "sync: align with upstream/main $(date +%Y-%m-%d)" --quiet || true
        APPLIED_VIA_PATCH=true
        echo "   ✅ 策略 1 应用成功"
    else
        echo "   ⚠️  Patch 与上游存在变动冲突，切换到 Smart Merge（策略 2）..."
        git checkout custom --quiet
        cp "$TMP_DIR/sync.sh" "$SCRIPT_DIR/sync.sh"
        chmod +x "$SCRIPT_DIR/sync.sh"

        echo "   执行 Smart Merge..."
        git merge main --no-commit --no-ff 2>/dev/null || true
        CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null || true)

        if [ -z "$CONFLICTS" ]; then
            git add -A
            git commit -m "merge: sync upstream/main $(date +%Y-%m-%d)" --quiet 2>/dev/null || true
        else
            for f in $CONFLICTS; do
                case "$f" in
                    README*|readme*)
                        echo "   📄 $f: 保留本地 Fork 头部说明 + 结合上游内容"
                        FORK_HEADER=$(awk '/^> \[!NOTE\]/{p=1} p{print} /^$/{if(p)exit}' "$f" 2>/dev/null || true)
                        if [ -n "$FORK_HEADER" ]; then
                            git show "upstream/main:$f" > "$f.upstream"
                            printf '%s\n\n' "$FORK_HEADER" > "$f.header"
                            cat "$f.header" "$f.upstream" > "$f"
                            rm -f "$f.upstream" "$f.header"
                        else
                            git checkout upstream/main -- "$f"
                        fi
                        git add "$f"
                        ;;
                    sync.sh|sync.patch)
                        git checkout --ours "$f" 2>/dev/null || cp "$TMP_DIR/$f" "$SCRIPT_DIR/$f"
                        git add "$f"
                        ;;
                    *)
                        echo "   📄 $f: 冲突文件以本地定制优先（ours）"
                        git checkout --ours "$f"
                        git add "$f"
                        ;;
                esac
            done
            git add -A
            git commit -m "merge: sync upstream/main (smart merge, $(date +%Y-%m-%d))" --quiet 2>/dev/null || true
            echo "   ✅ Smart Merge 完成"
        fi
    fi
fi

# 恢复此前暂存的内容
if [ "$STASHED" = true ]; then
    echo "📦 恢复此前暂存的工作区改动..."
    git stash pop --quiet 2>/dev/null || true
fi

# Step 4: 重新生成干净的 sync.patch（排除 sync.patch 和 sync.sh 自身）
echo "[4/4] 重新生成干净的 sync.patch..."
git diff upstream/main...custom ':!sync.patch' ':!sync.sh' > "$PATCH_FILE"
PATCH_LINES=$(wc -l < "$PATCH_FILE" | tr -d ' ')
if [ "$PATCH_LINES" -eq 0 ]; then
    echo "✅ sync.patch 为空（当前代码与上游 main 一致，无额外定制修改）"
else
    echo "✅ sync.patch 生成完毕 (共 $PATCH_LINES 行，已排除同步脚本与快照自身)"
fi

# 确保 sync.sh 和 sync.patch 都被暂存并提交
git add sync.patch sync.sh

if ! git diff --cached --quiet; then
    git commit -m "chore: update sync.patch and sync.sh ($(date +%Y-%m-%d))" --quiet || true
fi

# 自动测试与检查
if [ "$SKIP_TEST" = false ]; then
    if command -v pnpm >/dev/null 2>&1; then
        echo ""
        echo "🔍 正在运行项目测试与构建验证..."
        if pnpm run check; then
            echo "✅ 测试与构建验证全部通过！"
        else
            echo "❌ 警告: 测试或构建失败，请检查代码！"
        fi
    fi
fi

# 推送到 origin/custom 与 origin/main
echo ""
DO_PUSH=false
if [ "$AUTO_YES" = true ]; then
    DO_PUSH=true
elif [ -t 0 ]; then
    read -p "是否推送到 origin (main & custom)? [y/N] " -n 1 -r < /dev/tty
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        DO_PUSH=true
    fi
fi

if [ "$DO_PUSH" = true ]; then
    echo "🚀 正在推送到 origin..."
    git push origin main
    if [ "$APPLIED_VIA_PATCH" = true ] || [ ! -s "$TMP_DIR/sync.patch" ]; then
        git push --force-with-lease origin custom
    else
        git push origin custom
    fi
    echo "✅ 已成功推送到 origin"
else
    echo "ℹ️  跳过远程推送（可稍后手动执行 git push origin main && git push origin custom）"
fi

echo "🎉 $REPO_NAME 同步流程全部完成！"
