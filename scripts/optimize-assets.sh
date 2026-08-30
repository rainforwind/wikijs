#!/bin/bash
# Wiki.js 资源优化脚本
# 用法: ./scripts/optimize-assets.sh

set -e

echo "=== Wiki.js 资源优化 ==="
echo ""

# 检查工具
check_tool() {
    if ! command -v $1 &> /dev/null; then
        echo "❌ 未找到 $1，请先安装:"
        echo "   brew install $2"
        exit 1
    fi
}

echo "📋 检查依赖工具..."
check_tool "cwebp" "webp"
check_tool "jpegoptim" "jpegoptim"
check_tool "svgo" "svgo"

echo ""
echo "🖼️  优化 splash 图片..."

# 优化 JPEG
echo "   - 压缩 splash/1.jpg..."
jpegoptim --strip-all --max=80 --quiet client/static/img/splash/1.jpg

# 转换为 WebP
echo "   - 转换为 WebP..."
cwebp -q 80 client/static/img/splash/1.jpg -o client/static/img/splash/1.webp 2>/dev/null

# 生成响应式尺寸
echo "   - 生成响应式尺寸..."
cwebp -q 80 -resize 1280 0 client/static/img/splash/1.jpg -o client/static/img/splash/1@1280.webp 2>/dev/null
cwebp -q 75 -resize 640 0 client/static/img/splash/1.jpg -o client/static/img/splash/1@640.webp 2>/dev/null

echo ""
echo "📐 压缩 SVG 文件..."
svgo --folder=client/static/svg --quiet 2>/dev/null || echo "   ⚠️  svgo 批量压缩失败，跳过"

echo ""
echo "📊 优化结果:"
echo "   原始大小: $(du -sh client/static/img/splash/1.jpg | cut -f1)"
echo "   WebP 大小: $(du -sh client/static/img/splash/1.webp | cut -f1)"
echo ""
echo "✅ 资源优化完成!"
echo ""
echo "📝 下一步:"
echo "   1. 修改 login.vue 使用 WebP:"
echo "      将 background-image 改为使用 <picture> 标签或 CSS image-set"
echo "   2. 提交更改: git add -A && git commit -m 'perf: optimize images for weak networks'"
echo "   3. 清理 Git 历史 (可选): ./scripts/clean-git-history.sh"
