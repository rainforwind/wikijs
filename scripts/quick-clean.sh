#!/bin/bash
# 快速清理 Git 历史中的大文件
# 用法: ./scripts/quick-clean.sh

set -e

echo "=== 快速清理 Git 大文件 ==="
echo ""
echo "将删除以下历史文件:"
echo "  - assets/js/bundle.min.js"
echo "  - assets/js/configure.min.js"  
echo "  - assets/js/libs.js"
echo "  - client/fonts/icomoon-wikijs.json"
echo "  - client/static/img/splash/1.jpg"
echo "  - client/static/img/splash/2.jpg"
echo ""
echo "预计耗时: 3-5 分钟"
echo ""

# 创建文件列表
cat > /tmp/big-files.txt << 'EOF'
assets/js/bundle.min.js
assets/js/configure.min.js
assets/js/libs.js
client/fonts/icomoon-wikijs.json
client/static/img/splash/1.jpg
client/static/img/splash/2.jpg
EOF

# 执行清理
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch \
  --force \
  --index-filter 'git rm --cached --ignore-unmatch $(cat /tmp/big-files.txt)' \
  --prune-empty \
  -- --all

# 清理引用
rm -rf .git/refs/original/
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo ""
echo "✅ 清理完成!"
du -sh .git
echo ""
echo "下一步: git push origin main --force"
