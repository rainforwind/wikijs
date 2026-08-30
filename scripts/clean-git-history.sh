#!/bin/bash
# Wiki.js Git 历史清理脚本
# 用法: ./scripts/clean-git-history.sh
#
# ⚠️  警告: 这会重写 Git 历史，需要 force push!
# 建议先备份: git clone --mirror <repo-url> backup.git

set -e

echo "=== Wiki.js Git 历史清理 ==="
echo ""
echo "⚠️  警告: 此操作会重写 Git 历史!"
echo "   - 所有提交的 SHA 会改变"
echo "   - 需要 force push 到远程"
echo "   - 克隆者的本地仓库需要重新克隆"
echo ""
read -p "确认继续? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
fi

echo ""
echo "📋 需要清理的大文件:"
echo "   - assets/js/bundle.min.js (多次提交，每次 2-3.7MB)"
echo "   - assets/js/configure.min.js (~1.5MB)"
echo "   - assets/js/libs.js (~1MB)"
echo "   - client/fonts/icomoon-wikijs.json (~1MB)"
echo "   - client/static/svg/twemoji.asar (7.3MB) - 保留!"
echo ""

# 安装 git-filter-repo
if ! command -v git-filter-repo &> /dev/null; then
    echo "📦 安装 git-filter-repo..."
    pip3 install --user git-filter-repo 2>/dev/null || {
        echo "❌ 安装失败，请手动安装:"
        echo "   pip3 install git-filter-repo"
        echo "   或: brew install git-filter-repo"
        exit 1
    }
fi

echo "🧹 清理 Git 历史..."

# 创建需要删除的文件列表
cat > /tmp/files-to-remove.txt << 'EOF'
assets/js/bundle.min.js
assets/js/configure.min.js
assets/js/libs.js
client/fonts/icomoon-wikijs.json
EOF

# 使用 git filter-repo 清理
git filter-repo --invert-paths --paths-from-file /tmp/files-to-remove.txt --force

echo ""
echo "🗑️  清理旧的 Git 对象..."
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo ""
echo "📊 清理后的仓库大小:"
du -sh .git

echo ""
echo "✅ Git 历史清理完成!"
echo ""
echo "📝 下一步:"
echo "   1. 检查仓库是否正常: git status"
echo "   2. Force push 到远程:"
echo "      git push origin main --force"
echo "      git push origin main --force --tags"
echo "   3. 通知其他开发者重新克隆仓库"
echo ""
echo "💡 提示: 如果远程有保护分支，需要先临时关闭保护规则"
